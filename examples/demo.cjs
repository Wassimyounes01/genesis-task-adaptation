'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAdaptationStore } = require('../index.cjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-adaptation-demo-'));
try {
  const store = createAdaptationStore({ stateDir: dir });
  store.registerPlan({ planId: 'demo-plan', planHash: 'pre-registered-plan-hash', taskIds: ['demo-task'] });
  const { revision } = store.checkpoint({ planId: 'demo-plan', eventId: 'demo-event', kind: 'check-failure', summary: 'The acceptance check failed.', taskId: 'demo-task', changes: [{ taskId: 'demo-task', action: 'rerun-check', requireRecheck: true }], sourceRefs: [{ id: 'demo-source', version: '1' }] });
  console.log(store.resolve(revision.revisionId, { decision: 'accept', actor: 'offline-demo', reason: 'revalidate and rerun', revalidateSource: source => source.version === '1' }));
  console.log('recheck required:', store.isRecheckRequired('demo-plan', 'demo-task', 0));
  store.markRechecked('demo-plan', 'demo-task', { evidenceSequence: 3, revisionId: revision.revisionId, evidence: { receipt: 'fresh' }, validateEvidence: evidence => evidence.receipt === 'fresh' });
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
