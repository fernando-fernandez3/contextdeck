import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as core from '../src/index.js';

const tmpDirs: string[] = [];

async function makeTempDir(prefix = 'cdeck-store-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  delete process.env.CONTEXTDECK_FAULT;
  delete process.env.CONTEXTDECK_LOCK_STALE_MS;
  while (tmpDirs.length > 0) {
    await fs.rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

// Fsync-heavy transactional storage tests run real temp-file fsync, txn.json fsync,
// events fdatasync, and cross-process locking. Under virtualized CI disk contention
// (e.g. GitHub ubuntu-latest), multi-mutation tests need headroom beyond vitest's 5s default.
const FSYNC_TEST_TIMEOUT_MS = 20_000;

describe('E1 safe concurrent storage engine', () => {
  it('refuses to overwrite an existing board in createBoard', async () => {
    const dir = await makeTempDir();
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Original', slug: 'main' });
    await store.recordDecision('main', { title: 'Keep Me' });

    await expect(store.createBoard({ title: 'Overwrite', slug: 'main' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    const snap = await store.getSnapshot('main');
    expect(snap.config.title).toBe('Original');
    expect(snap.decisions).toHaveLength(1);
  }, FSYNC_TEST_TIMEOUT_MS);

  it('distinguishes ENOENT from corrupt files and keeps corrupt files untouched', async () => {
    const dir = await makeTempDir();
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Main', slug: 'main' });

    await expect(store.getSnapshot('missing-board')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    // Corrupt a decision file
    const badDecPath = path.join(store.boardPath('main'), 'decisions', 'dec_999.md');
    const badContent = '---\nnot: [valid: yaml\n---\nbody\n';
    await fs.writeFile(badDecPath, badContent, 'utf8');

    await expect(store.listDecisions('main')).rejects.toMatchObject({
      code: 'CORRUPT_DATA',
    });
    expect(await fs.readFile(badDecPath, 'utf8')).toBe(badContent);

    // Clean decision file and corrupt board.yaml
    await fs.rm(badDecPath);
    const boardYamlPath = path.join(store.boardPath('main'), 'board.yaml');
    const corruptBoard = 'slug: main\nrevision: "not-a-number"\n';
    await fs.writeFile(boardYamlPath, corruptBoard, 'utf8');

    await expect(store.getSnapshot('main')).rejects.toMatchObject({
      code: 'CORRUPT_DATA',
    });
    expect(await fs.readFile(boardYamlPath, 'utf8')).toBe(corruptBoard);
  }, FSYNC_TEST_TIMEOUT_MS);

  it('enforces brief baseRevision conflicts with currentBrief included', async () => {
    const dir = await makeTempDir();
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Main', slug: 'main', brief: '# Initial\n' });

    // Update at rev 1 -> rev 2
    const r1 = await store.updateBrief('main', '# V2\n', undefined, { baseRevision: 1 });
    expect(r1.revision).toBe(2);

    // Non-brief mutation bumps board to rev 3
    await store.upsertTask('main', { title: 'Unrelated task' });

    // Brief did NOT change between rev 2 and rev 3, so baseRevision: 2 succeeds -> rev 4
    const r2 = await store.updateBrief('main', '# V3\n', undefined, { baseRevision: 2 });
    expect(r2.revision).toBe(4);

    // Stale writer with baseRevision: 2 MUST fail with conflict including currentBrief '# V3\n'
    let caught: unknown;
    try {
      await store.updateBrief('main', '# Stale overwrite\n', undefined, { baseRevision: 2 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(core.ConflictError);
    const conflict = caught as core.ConflictError;
    expect(conflict.details?.currentBrief).toBe('# V3\n');
    expect(conflict.details?.currentRevision).toBe(4);
  }, FSYNC_TEST_TIMEOUT_MS);

  it('preserves both edits under conflicting concurrent PATCHes of the same task', async () => {
    const dir = await makeTempDir();
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Main', slug: 'main' });
    const task = await store.upsertTask('main', {
      title: 'Shared task',
      column: 'backlog',
      priority: 'low',
    });

    await Promise.all([
      store.patchTask('main', task.id, { column: 'in_progress' }),
      store.patchTask('main', task.id, { priority: 'urgent' }),
      store.patchTask('main', task.id, { assignee: 'claude-code' }),
    ]);

    const snap = await store.getSnapshot('main');
    const updated = snap.tasks.find((t) => t.id === task.id)!;
    expect(updated.column).toBe('in_progress');
    expect(updated.priority).toBe('urgent');
    expect(updated.assignee).toBe('claude-code');
  }, FSYNC_TEST_TIMEOUT_MS);

  it('rejects storage fields on updateMedia (Bug 8 core defense)', async () => {
    const dir = await makeTempDir();
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Main', slug: 'main', brief: '# Safe Brief\n' });
    const media = await store.addMedia('main', {
      title: 'Doc',
      kind: 'doc',
      content: 'hello',
    });

    await expect(
      store.updateMedia(
        'main',
        media.id,
        { filePath: '../brief.md', content: 'OVERWRITTEN' } as unknown as Record<string, unknown>,
      ),
    ).rejects.toThrow();

    const snap = await store.getSnapshot('main');
    expect(snap.brief).toBe('# Safe Brief\n');
  }, FSYNC_TEST_TIMEOUT_MS);

  it('guards submitQuizAttempt against zero-question quizzes (AC1.5)', async () => {
    const dir = await makeTempDir();
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Main', slug: 'main' });

    await expect(
      store.createQuiz('main', { title: 'Empty', questions: [] }),
    ).rejects.toThrow();

    // Manually write a zero-question quiz file on disk
    const quizPath = path.join(store.boardPath('main'), 'quizzes', 'quiz_zero.quiz.json');
    await fs.writeFile(
      quizPath,
      JSON.stringify({
        id: 'quiz_zero',
        title: 'Corrupt Zero Quiz',
        topic: '',
        description: '',
        questions: [],
        attempts: [],
        basedOnDecisions: [],
        boardRevisionAtUpdate: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
      'utf8',
    );

    await expect(
      store.submitQuizAttempt('main', 'quiz_zero', { answers: {} }),
    ).rejects.toThrow();
  }, FSYNC_TEST_TIMEOUT_MS);

  it('recovers cleanly via roll-forward journal when killed mid-commit (after-rename-1 and after-event)', async () => {
    const dir = await makeTempDir();
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Main', slug: 'main' });
    const d1 = await store.recordDecision('main', { title: 'First Decision' });

    // Inject fault right after first entity rename during superseding decision (writes dec_002 AND updates dec_001)
    process.env.CONTEXTDECK_FAULT = 'after-rename-1';
    await expect(
      store.recordDecision('main', { title: 'Second Decision', supersedes: d1.id }),
    ).rejects.toThrow(/fault/i);
    delete process.env.CONTEXTDECK_FAULT;

    // txn.json must exist and board.yaml revision must still be 2 (not bumped before crash)
    const txnPath = path.join(store.runtimeDir, 'txn.json');
    expect(await fs.stat(txnPath)).toBeTruthy();

    // Next mutation acquires lock, rolls forward txn.json, then commits its own task
    await store.upsertTask('main', { title: 'Post-crash task' });

    // txn.json deleted, dec_002 committed, dec_001 superseded, task_001 committed, revisions unique
    await expect(fs.stat(txnPath)).rejects.toThrow();
    const snap = await store.getSnapshot('main');
    expect(snap.decisions).toHaveLength(2);
    expect(snap.decisions.find((d) => d.id === d1.id)?.status).toBe('superseded');
    expect(snap.tasks).toHaveLength(1);
    expect(snap.config.revision).toBe(4);
    const revs = snap.events.map((e) => e.revision);
    expect(revs).toEqual([1, 2, 3, 4]);

    // Now test fault AFTER event append, BEFORE board.yaml commit
    process.env.CONTEXTDECK_FAULT = 'after-event';
    await expect(
      store.recordDecision('main', { title: 'Third Decision' }),
    ).rejects.toThrow(/fault/i);
    delete process.env.CONTEXTDECK_FAULT;

    // Reader must ignore uncommitted event with revision > config.revision (D1)
    const midSnap = await store.getSnapshot('main');
    expect(midSnap.config.revision).toBe(4);
    expect(midSnap.events.every((e) => e.revision <= 4)).toBe(true);

    // Next write rolls forward WITHOUT duplicating the event
    await store.upsertTask('main', { title: 'Task after after-event fault' });
    const finalSnap = await store.getSnapshot('main');
    expect(finalSnap.config.revision).toBe(6);
    expect(finalSnap.events.map((e) => e.revision)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(finalSnap.events.map((e) => e.id)).size).toBe(6);
  }, FSYNC_TEST_TIMEOUT_MS);

  it('aborts mutation without writing when lock is compromised', async () => {
    const dir = await makeTempDir();
    process.env.CONTEXTDECK_LOCK_STALE_MS = '300';
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Main', slug: 'main' });

    const beforeSnap = await store.getSnapshot('main');

    await expect(
      store.mutate('main', { type: 'system', label: 'test' }, async (tx) => {
        // Simulate external lock removal while paused so proper-lockfile compromise triggers
        const lockDir = path.join(store.runtimeDir, 'lock.lock');
        await fs.rm(lockDir, { recursive: true, force: true });
        await new Promise((r) => setTimeout(r, 450));
        tx.stageFile(path.join(store.boardPath('main'), 'brief.md'), '# SHOULD NOT COMMIT\n');
        tx.addEvent({ kind: 'brief.updated', summary: 'Should never commit' });
      }),
    ).rejects.toMatchObject({
      code: 'LOCK_COMPROMISED',
    });

    const afterSnap = await store.getSnapshot('main');
    expect(afterSnap.config.revision).toBe(beforeSnap.config.revision);
    expect(afterSnap.brief).toBe(beforeSnap.brief);
  }, FSYNC_TEST_TIMEOUT_MS);

  it('runs applyContextUpdate and refreshArtifactDecisions without re-entrant lock deadlock', async () => {
    const dir = await makeTempDir();
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Main', slug: 'main' });
    const d1 = await store.recordDecision('main', { title: 'Old choice' });
    const diag = await store.upsertDiagram('main', {
      title: 'Arch',
      kind: 'mermaid',
      content: 'flowchart LR\nA-->B',
      basedOnDecisions: [d1.id],
    });

    const res = await store.applyContextUpdate('main', {
      sessionTitle: 'Web Chat',
      harness: 'grok',
      brief: '# Updated via Context Update\n',
      decisions: [{ title: 'New choice', summary: 's', rationale: 'r', supersedes: d1.id }],
      tasks: [{ title: 'Follow-up task' }],
    });

    expect(res.appliedCount).toBe(4);
    expect(res.snapshot.drift.staleArtifacts).toHaveLength(1);

    await store.refreshArtifactDecisions('main', 'diagram', diag.id);
    const refreshed = await store.getSnapshot('main');
    expect(refreshed.drift.staleArtifacts).toHaveLength(0);
  }, FSYNC_TEST_TIMEOUT_MS);
});
