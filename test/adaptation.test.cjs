'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAdaptationStore } = require('../index.cjs');

function fixture() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-adaptation-')); return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }; }
function setup(dir) { const store = createAdaptationStore({ stateDir: dir }); store.registerPlan({ planId: 'plan-1', planHash: 'hash-1', taskIds: ['task-a'] }); return store; }

test('accepted source-backed revision requires revalidation and persists recheck after resolution', () => {
  const f = fixture();
  try {
    const store = setup(f.dir);
    const { revision } = store.checkpoint({ planId: 'plan-1', eventId: 'event-1', kind: 'check-failure', summary: 'check failed', taskId: 'task-a', changes: [{ taskId: 'task-a', action: 'rerun', requireRecheck: true }], sourceRefs: [{ id: 'source-a', version: 'v1' }] });
    assert.throws(() => store.resolve(revision.revisionId, { decision: 'accept', actor: 'coordinator', reason: 'needs fresh check' }), /revalidation hook/);
    const accepted = store.resolve(revision.revisionId, { decision: 'accept', actor: 'coordinator', reason: 'needs fresh check', revalidateSource: source => source.version === 'v1' });
    assert.equal(accepted.revision.status, 'accepted');
    assert.equal(store.isRecheckRequired('plan-1', 'task-a', 0), true);
    const reloaded = createAdaptationStore({ stateDir: f.dir });
    assert.equal(reloaded.isRecheckRequired('plan-1', 'task-a', 1), true);
    assert.throws(() => reloaded.markRechecked('plan-1', 'task-a', 3), /evidence hook/);
    reloaded.markRechecked('plan-1', 'task-a', { evidenceSequence: 3, revisionId: revision.revisionId, evidence: { receipt: 'fresh-check' }, validateEvidence: evidence => evidence.receipt === 'fresh-check' });
    assert.equal(reloaded.isRecheckRequired('plan-1', 'task-a', 3), false);
    assert.equal(reloaded.isRecheckRequired('plan-1', 'task-a'), false);
    assert.throws(() => reloaded.markRechecked('plan-1', 'task-a', { evidenceSequence: 3, revisionId: revision.revisionId, evidence: { receipt: 'replayed' }, validateEvidence: () => true }), /stale recheck/);
    assert.equal(reloaded.requirements('plan-1')[0].recheckRequired, false);
  } finally { f.cleanup(); }
});

test('rejects stale source acceptance and preserves original plan binding', () => {
  const f = fixture();
  try {
    const store = setup(f.dir);
    const { revision } = store.checkpoint({ planId: 'plan-1', eventId: 'event-2', kind: 'evidence', summary: 'new source', taskId: 'task-a', changes: [{ taskId: 'task-a', action: 'use-source', requireRecheck: false }], sourceRefs: [{ id: 'source-a', version: 'v1' }] });
    assert.throws(() => store.resolve(revision.revisionId, { decision: 'accept', actor: 'coordinator', reason: 'source is stale', revalidateSource: () => false }), /revalidation failed/);
    const rejected = store.resolve(revision.revisionId, { decision: 'reject', actor: 'coordinator', reason: 'source is stale' });
    assert.equal(rejected.revision.status, 'rejected');
    assert.throws(() => store.registerPlan({ planId: 'plan-1', planHash: 'changed', taskIds: ['task-a'] }), /immutable/);
  } finally { f.cleanup(); }
});

test('deduplicates repeated events', () => {
  const f = fixture();
  try {
    const store = setup(f.dir);
    const first = store.checkpoint({ planId: 'plan-1', eventId: 'event-3', kind: 'worker-result', summary: 'done', taskId: 'task-a' });
    const second = store.checkpoint({ planId: 'plan-1', eventId: 'event-3', kind: 'worker-result', summary: 'changed text', taskId: 'task-a' });
    assert.equal(second.duplicate, true); assert.equal(second.revision.revisionId, first.revision.revisionId);
  } finally { f.cleanup(); }
});

test('scopes event and recheck keys as tuples when IDs contain separators', () => {
  const f = fixture();
  try {
    const store = createAdaptationStore({ stateDir: f.dir });
    store.registerPlan({ planId: 'alpha:beta', planHash: 'hash-a', taskIds: ['task'] });
    store.registerPlan({ planId: 'alpha', planHash: 'hash-b', taskIds: ['beta:task'] });
    const first = store.checkpoint({ planId: 'alpha:beta', eventId: 'event', kind: 'check-failure', summary: 'first', taskId: 'task', changes: [{ taskId: 'task', action: 'rerun', requireRecheck: true }] });
    const second = store.checkpoint({ planId: 'alpha', eventId: 'beta:event', kind: 'check-failure', summary: 'second', taskId: 'beta:task', changes: [{ taskId: 'beta:task', action: 'rerun', requireRecheck: true }] });
    assert.notEqual(first.revision.revisionId, second.revision.revisionId);
    store.resolve(first.revision.revisionId, { decision: 'accept', actor: 'reviewer', reason: 'accept first' });
    store.resolve(second.revision.revisionId, { decision: 'accept', actor: 'reviewer', reason: 'accept second' });
    assert.equal(store.requirements('alpha:beta').length, 1);
    assert.equal(store.requirements('alpha').length, 1);
    assert.equal(store.isRecheckRequired('alpha:beta', 'task'), true);
    assert.equal(store.isRecheckRequired('alpha', 'beta:task'), true);
  } finally { f.cleanup(); }
});

test('rejects over-bounded change and source lists before creating an event', () => {
  const f = fixture();
  try {
    const store = setup(f.dir);
    assert.throws(() => store.checkpoint({ planId: 'plan-1', eventId: 'too-many-changes', kind: 'worker-result', summary: 'bounded', taskId: 'task-a', changes: Array.from({ length: 21 }, (_, index) => ({ taskId: 'task-a', action: `change-${index}`, requireRecheck: false })) }), /20 changes/);
    assert.throws(() => store.checkpoint({ planId: 'plan-1', eventId: 'too-many-sources', kind: 'worker-result', summary: 'bounded', taskId: 'task-a', sourceRefs: Array.from({ length: 21 }, (_, index) => ({ id: `source-${index}` })) }), /20 source/);
    assert.equal(Object.keys(store.snapshot().events).length, 0);
  } finally { f.cleanup(); }
});

test('restores memory when checkpoint persistence fails', () => {
  const f = fixture(); const originalRename = fs.renameSync;
  try {
    const store = setup(f.dir);
    fs.renameSync = () => { throw new Error('injected rename failure'); };
    assert.throws(() => store.checkpoint({ planId: 'plan-1', eventId: 'persist-failure', kind: 'worker-result', summary: 'should rollback', taskId: 'task-a' }), /injected rename failure/);
    assert.equal(Object.keys(store.snapshot().events).length, 0);
  } finally { fs.renameSync = originalRename; f.cleanup(); }
});
