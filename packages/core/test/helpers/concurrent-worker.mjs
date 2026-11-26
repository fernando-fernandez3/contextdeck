import { ContextDeckStore } from '../../dist/index.js';

const [deckDir, projectRoot, workerIndex] = process.argv.slice(2);
const store = new ContextDeckStore({ deckDir, projectRoot });

const dec = await store.recordDecision(
  'main',
  { title: `Concurrent decision ${workerIndex}` },
  { type: 'agent', harness: 'test', label: `worker-${workerIndex}` },
);

const task = await store.upsertTask(
  'main',
  { title: `Concurrent task ${workerIndex}` },
  { type: 'agent', harness: 'test', label: `worker-${workerIndex}` },
);

let briefStatus = 'ok';
let conflictHasCurrentBrief = false;
try {
  await store.updateBrief(
    'main',
    `# Brief updated by worker ${workerIndex}\n`,
    { type: 'agent', harness: 'test', label: `worker-${workerIndex}` },
    { baseRevision: 1 },
  );
} catch (err) {
  if (err && typeof err === 'object' && 'code' in err && err.code === 'CONFLICT') {
    briefStatus = 'conflict';
    const details = 'details' in err ? err.details : undefined;
    conflictHasCurrentBrief = Boolean(
      details && typeof details === 'object' && typeof details.currentBrief === 'string',
    );
  } else {
    throw err;
  }
}

process.stdout.write(
  JSON.stringify({
    workerIndex,
    decisionId: dec.id,
    taskId: task.id,
    briefStatus,
    conflictHasCurrentBrief,
  }),
);
