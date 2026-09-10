'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const EVENT_KINDS = new Set(['evidence', 'user-feedback', 'check-failure', 'worker-result']);

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function id(value, label) { if (typeof value !== 'string' || !ID.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) throw new Error(`${label} must be a simple identifier`); return value; }
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function tupleKey(...parts) { return JSON.stringify(parts); }

class AdaptationStore {
  constructor(options = {}) {
    if (typeof options.stateDir !== 'string' || !options.stateDir.trim()) throw new Error('stateDir is required and must be caller-supplied');
    this.stateDir = path.resolve(options.stateDir);
    this.file = path.join(this.stateDir, 'adaptations.json');
    this.clock = options.clock || (() => Date.now());
    this.maxEvents = Number.isInteger(options.maxEvents) ? Math.max(1, Math.min(1000, options.maxEvents)) : 200;
    this.maxPlans = Number.isInteger(options.maxPlans) ? Math.max(1, Math.min(200, options.maxPlans)) : 100;
    this._state = this._load();
  }

  _load() {
    fs.mkdirSync(this.stateDir, { recursive: true });
    if (!fs.existsSync(this.file)) return { version: 1, sequence: 0, plans: Object.create(null), revisions: Object.create(null), requirements: Object.create(null), events: Object.create(null) };
    if (fs.statSync(this.file).size > 2 * 1024 * 1024) throw new Error('adaptation state exceeds size bound');
    const state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (!state || state.version !== 1 || !Number.isSafeInteger(state.sequence) || state.sequence < 0 || !state.plans || !state.revisions || !state.requirements || !state.events) throw new Error('invalid adaptation state');
    return state;
  }

  _save() {
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    const serialized = JSON.stringify(this._state, null, 2) + '\n';
    if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) throw new Error('adaptation state exceeds size bound');
    try { fs.writeFileSync(temporary, serialized, { mode: 0o600 }); fs.renameSync(temporary, this.file); }
    catch (error) { try { fs.rmSync(temporary, { force: true }); } catch {} throw error; }
  }

  registerPlan(plan) {
    if (!plan || typeof plan !== 'object') throw new Error('plan object required');
    const planId = id(plan.planId || plan.id, 'plan id');
    if (typeof plan.planHash !== 'string' || !plan.planHash.trim()) throw new Error('planHash required to bind adaptation to the original plan');
    const record = { planId, planHash: plan.planHash.slice(0, 256), taskIds: Array.isArray(plan.taskIds) ? plan.taskIds.slice(0, 100).map(taskId => id(taskId, 'task id')) : [], registeredAt: new Date(this.clock()).toISOString() };
    const existing = this._state.plans[planId];
    if (existing) {
      if (existing.planHash !== record.planHash || JSON.stringify(existing.taskIds) !== JSON.stringify(record.taskIds)) throw new Error('registered plan binding is immutable');
      return { plan: clone(existing), duplicate: true };
    }
    if (Object.keys(this._state.plans).length >= this.maxPlans) throw new Error('plan registry capacity reached');
    const before = clone(this._state);
    try { this._state.plans[planId] = record; this._save(); }
    catch (error) { this._state = before; throw error; }
    return { plan: clone(record), duplicate: false };
  }

  checkpoint(input) {
    if (!input || typeof input !== 'object') throw new Error('checkpoint object required');
    const planId = id(input.planId, 'plan id');
    const plan = this._state.plans[planId];
    if (!plan) throw new Error('plan must be registered before checkpoint');
    const eventId = id(input.eventId, 'event id');
    if (!EVENT_KINDS.has(input.kind) || typeof input.summary !== 'string' || !input.summary.trim()) throw new Error('supported event kind and bounded summary required');
    if (input.taskId != null && (!plan.taskIds.length || !plan.taskIds.includes(id(input.taskId, 'task id')))) throw new Error('checkpoint task is outside the registered plan');
    const eventKey = tupleKey(planId, eventId);
    if (Object.hasOwn(this._state.events, eventKey)) return { revision: clone(this._state.revisions[this._state.events[eventKey]]), duplicate: true };
    if (Object.keys(this._state.events).length >= this.maxEvents) throw new Error('checkpoint capacity reached; resolve or curate old events');
    const rawChanges = Array.isArray(input.changes) ? input.changes : (input.taskId ? [{ taskId: input.taskId, action: input.kind, requireRecheck: input.kind === 'check-failure' || input.kind === 'user-feedback' }] : []);
    if (rawChanges.length > 20) throw new Error('at most 20 changes per checkpoint');
    const changes = rawChanges.map(change => ({ taskId: change.taskId, action: String(change.action || '').slice(0, 240), requireRecheck: change.requireRecheck === true }));
    for (const change of changes) {
      if (!change || !plan.taskIds.includes(id(change.taskId, 'change task id')) || typeof change.action !== 'string' || !change.action.trim() || typeof change.requireRecheck !== 'boolean') throw new Error('changes need a known task, action and requireRecheck boolean');
    }
    const revisionId = `revision-${digest({ planId, eventId }).slice(0, 24)}`;
    if (Array.isArray(input.sourceRefs) && input.sourceRefs.length > 20) throw new Error('at most 20 source references per checkpoint');
    const sourceRefs = Array.isArray(input.sourceRefs) ? input.sourceRefs.map(source => ({ id: String(source?.id || '').slice(0, 160), version: String(source?.version || '').slice(0, 160), sha256: typeof source?.sha256 === 'string' ? source.sha256.slice(0, 128) : undefined })).map(source => Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined))) : [];
    if (sourceRefs.some(source => !source.id)) throw new Error('source references need bounded ids');
    const revision = { revisionId, planId, planHash: plan.planHash, eventId, kind: input.kind, summary: input.summary.trim().slice(0, 1000), taskId: input.taskId || null, changes: clone(changes), sourceRefs, status: changes.length ? 'proposed' : 'observed', createdAt: new Date(this.clock()).toISOString(), sequence: ++this._state.sequence };
    if (JSON.stringify(revision).length > 50000) throw new Error('checkpoint payload exceeds bound');
    const before = clone(this._state);
    try { this._state.revisions[revisionId] = revision; this._state.events[eventKey] = revisionId; this._save(); }
    catch (error) { this._state = before; throw error; }
    return { revision: clone(revision), duplicate: false };
  }

  _find(revisionId) {
    id(revisionId, 'revision id');
    const revision = this._state.revisions[revisionId];
    if (!revision) throw new Error('revision not found');
    const plan = this._state.plans[revision.planId];
    if (!plan || plan.planHash !== revision.planHash) throw new Error('revision no longer matches registered plan');
    return revision;
  }

  resolve(revisionId, decision) {
    const input = typeof decision === 'string' ? { decision } : decision;
    if (!input || !['accept', 'reject'].includes(input.decision) || typeof input.actor !== 'string' || !input.actor.trim() || typeof input.reason !== 'string' || !input.reason.trim()) throw new Error('accept/reject, actor and reason are required');
    const revision = this._find(revisionId);
    if (revision.status !== 'proposed') return { revision: clone(revision), duplicate: true };
    if (input.decision === 'accept' && revision.sourceRefs.length) {
      if (typeof input.revalidateSource !== 'function') throw new Error('source revalidation hook required before accepting source-backed changes');
      for (const source of revision.sourceRefs) {
        let result;
        try { result = input.revalidateSource(clone(source), clone(revision)); } catch (error) { throw new Error(`source revalidation failed: ${error.message}`); }
        if (!(result === true || result?.valid === true)) throw new Error(`source revalidation failed for ${source.id || 'source'}`);
      }
    }
    const before = clone(this._state);
    try {
      revision.status = input.decision === 'accept' ? 'accepted' : 'rejected';
      revision.actor = input.actor.trim().slice(0, 160); revision.reason = input.reason.trim().slice(0, 1000); revision.resolvedAt = new Date(this.clock()).toISOString(); revision.decisionSequence = ++this._state.sequence;
      if (revision.status === 'accepted') {
        for (const change of revision.changes) if (change.requireRecheck) {
          const key = tupleKey(revision.planId, change.taskId);
          const prior = this._state.requirements[key];
          if (!prior || prior.decisionSequence < revision.decisionSequence) this._state.requirements[key] = { planId: revision.planId, taskId: change.taskId, revisionId: revision.revisionId, decisionSequence: revision.decisionSequence, recheckedAtSequence: 0 };
        }
      }
      this._save();
    } catch (error) { this._state = before; throw error; }
    return { revision: clone(revision), duplicate: false };
  }

  requirements(planId) {
    id(planId, 'plan id');
    return Object.values(this._state.requirements).filter(item => item.planId === planId).map(item => ({ ...clone(item), recheckRequired: !(item.recheckedAtSequence > item.decisionSequence) }));
  }

  isRecheckRequired(planId, taskId, evidenceSequence) {
    const key = tupleKey(id(planId, 'plan id'), id(taskId, 'task id'));
    const requirement = this._state.requirements[key];
    if (!requirement) return false;
    const sequence = evidenceSequence == null ? (requirement.recheckedAtSequence || 0) : evidenceSequence;
    return !(Number.isSafeInteger(sequence) && sequence > requirement.decisionSequence && sequence >= (requirement.recheckedAtSequence || 0));
  }

  markRechecked(planId, taskId, evidenceInput) {
    const key = tupleKey(id(planId, 'plan id'), id(taskId, 'task id'));
    const requirement = this._state.requirements[key];
    if (!requirement) throw new Error('no persistent recheck requirement for task');
    const input = evidenceInput && typeof evidenceInput === 'object' ? evidenceInput : {};
    if (typeof input.validateEvidence !== 'function') throw new Error('evidence hook (validateEvidence) is required for recheck evidence');
    if (!Number.isSafeInteger(input.evidenceSequence) || input.evidenceSequence <= requirement.decisionSequence) throw new Error('fresh evidence sequence must exceed the adaptation decision');
    if (input.evidenceSequence <= (requirement.recheckedAtSequence || 0)) throw new Error('stale recheck evidence replay');
    if (input.revisionId !== requirement.revisionId) throw new Error('evidence must bind the current accepted revision');
    let valid;
    try { valid = input.validateEvidence(clone(input.evidence), clone(requirement)); } catch (error) { throw new Error(`evidence validation failed: ${error.message}`); }
    if (!(valid === true || valid?.valid === true)) throw new Error('evidence validation failed');
    if (input.evidence == null) throw new Error('evidence receipt is required');
    if (JSON.stringify(input.evidence).length > 20000) throw new Error('evidence receipt exceeds bound');
    const before = clone(this._state);
    try { requirement.recheckedAtSequence = Math.max(requirement.recheckedAtSequence || 0, input.evidenceSequence); requirement.evidenceDigest = digest(input.evidence); requirement.recheckedAt = new Date(this.clock()).toISOString(); this._save(); }
    catch (error) { this._state = before; throw error; }
    return clone(requirement);
  }

  getRevision(revisionId) { return clone(this._find(revisionId)); }
  snapshot() { return clone(this._state); }
}

function createAdaptationStore(options) { return new AdaptationStore(options); }

module.exports = { AdaptationStore, createAdaptationStore, digest };
