import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ContextDeckStore,
  generateContextPack,
  parseContextUpdatePayload,
  seedDemoBoard,
} from '../src/index.js';

const tmpDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'contextdeck-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('@contextdeck/core', () => {
  it('initializes boards, tracks decision supersession, and flags stale artifacts & drifted sessions', async () => {
    const dir = await makeTempDir();
    const store = new ContextDeckStore(dir);

    await store.createBoard({ title: 'Auth Redesign', slug: 'auth-redesign' });

    const s1 = await store.registerSession('auth-redesign', {
      title: 'Cursor Planning',
      harness: 'cursor',
    });

    const d1 = await store.recordDecision('auth-redesign', {
      title: 'Use Session Cookies',
      summary: 'Store sessions in Redis with HTTP-only cookies.',
      sessionId: s1.id,
    });

    const diag = await store.upsertDiagram('auth-redesign', {
      title: 'Auth Flow',
      kind: 'mermaid',
      content: 'flowchart LR\n  A[Browser] --> B[Redis Session]',
      basedOnDecisions: [d1.id],
    });

    const s2 = await store.registerSession('auth-redesign', {
      title: 'Claude Code Implementation',
      harness: 'claude-code',
      parentSessionId: s1.id,
    });

    const d2 = await store.recordDecision('auth-redesign', {
      title: 'Switch to Stateless Signed JWTs',
      supersedes: d1.id,
      sessionId: s2.id,
    });

    const snapshot = await store.getSnapshot('auth-redesign');
    const oldDec = snapshot.decisions.find((d) => d.id === d1.id);
    expect(oldDec?.status).toBe('superseded');
    expect(oldDec?.supersededBy).toBe(d2.id);

    // Diagram referencing d1 must be flagged stale
    expect(snapshot.drift.staleArtifacts).toHaveLength(1);
    expect(snapshot.drift.staleArtifacts[0].artifactId).toBe(diag.id);
    expect(snapshot.drift.staleArtifacts[0].reasons[0]).toContain(d2.id);

    // Cursor session s1 should be drifted behind current revision
    const driftedS1 = snapshot.drift.driftedSessions.find((s) => s.sessionId === s1.id);
    expect(driftedS1).toBeDefined();
    expect(driftedS1!.behindBy).toBeGreaterThan(0);

    // Refreshing diagram aligns it to d2 and clears staleness
    await store.refreshArtifactDecisions('auth-redesign', 'diagram', diag.id);
    const afterRefresh = await store.getSnapshot('auth-redesign');
    expect(afterRefresh.drift.staleArtifacts).toHaveLength(0);

    // Syncing session clears drift for s1
    const syncResult = await store.syncSession('auth-redesign', s1.id);
    expect(syncResult.missedEvents.length).toBeGreaterThan(0);
    const afterSync = await store.getSnapshot('auth-redesign');
    expect(afterSync.drift.driftedSessions.find((s) => s.sessionId === s1.id)).toBeUndefined();
  });

  it('scores interactive quiz attempts and applies web-chat Context Pack updates', async () => {
    const dir = await makeTempDir();
    const store = new ContextDeckStore(dir);
    await seedDemoBoard(store, 'demo');

    const snapshot = await store.getSnapshot('demo');
    const pack = generateContextPack(snapshot);
    expect(pack).toContain('ContextDeck Shared Context');
    expect(pack).toContain('dec_003');

    const quiz = snapshot.quizzes[0];
    const { attempt } = await store.submitQuizAttempt('demo', quiz.id, {
      answers: { q1: 1, q2: 1, q3: 1 },
      confidence: 5,
    });
    expect(attempt.score).toBe(3);
    expect(attempt.percentage).toBe(100);

    const parsed = parseContextUpdatePayload(`Here is the update from Grok:
\`\`\`json
{
  "sessionTitle": "Grok Follow-up",
  "harness": "grok",
  "sessionSummary": "Proposed adding audio chapter timestamps.",
  "tasks": [
    { "title": "Add keyboard shortcuts for video chapters", "column": "backlog", "priority": "low" }
  ]
}
\`\`\`
`);
    const result = await store.applyContextUpdate('demo', parsed);
    expect(result.appliedCount).toBe(2);
    expect(result.snapshot.sessions.some((s) => s.title === 'Grok Follow-up')).toBe(true);
    expect(result.snapshot.tasks.some((t) => t.title.includes('keyboard shortcuts'))).toBe(true);
  });
});
