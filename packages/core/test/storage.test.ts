import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('guards submitQuizAttempt against zero-question quizzes (AC1.5 / H11)', async () => {
    const dir = await makeTempDir();
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Main', slug: 'main' });

    await expect(
      store.createQuiz('main', { title: 'Empty', questions: [] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    // Pure scoring helper must directly guard divide-by-zero
    expect(() => core.scoreQuizAttempt([], {})).toThrow(core.ValidationError);
    expect(() => core.scoreQuizAttempt([], {})).toThrow(/zero questions/i);

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
    ).rejects.toMatchObject({ code: 'CORRUPT_DATA' });
    await expect(
      store.submitQuizAttempt('main', 'quiz_zero', { answers: {} }),
    ).rejects.toBeInstanceOf(core.CorruptDataError);
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

    const beforeApply = await store.getSnapshot('main');
    const res = await store.applyContextUpdate('main', {
      baseRevision: beforeApply.config.revision,
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

  it('H1: rejects txn.json containing arbitrary absolute paths and leaves outside files + txn.json intact', async () => {
    const root = await makeTempDir('cdeck-h1-');
    const deck = path.join(root, 'repo', '.contextdeck');
    const store = new core.ContextDeckStore({ deckDir: deck, projectRoot: path.join(root, 'repo') });
    await store.createBoard({ title: 'Main', slug: 'main' });

    const victim = path.join(root, 'outside-victim.txt');
    await fs.writeFile(victim, 'precious', 'utf8');
    const planted = path.join(root, 'repo', 'planted.txt');
    await fs.writeFile(planted, 'attacker content', 'utf8');
    const overwritten = path.join(root, 'outside-overwrite.txt');
    await fs.writeFile(overwritten, 'original', 'utf8');

    const txnPath = path.join(store.runtimeDir, 'txn.json');
    await fs.mkdir(store.runtimeDir, { recursive: true });
    await fs.writeFile(
      txnPath,
      JSON.stringify({
        id: 'evil',
        ops: [
          { kind: 'unlink', finalPath: victim },
          { kind: 'rename', tmpPath: planted, finalPath: overwritten },
        ],
        events: [],
      }),
      'utf8',
    );

    await expect(
      store.recordDecision('main', { title: 'x', summary: 'y' }),
    ).rejects.toMatchObject({ code: 'CORRUPT_DATA' });

    expect(await fs.readFile(victim, 'utf8')).toBe('precious');
    expect(await fs.readFile(overwritten, 'utf8')).toBe('original');
    await expect(fs.stat(txnPath)).resolves.toBeTruthy();
  }, FSYNC_TEST_TIMEOUT_MS);

  it('H1: rejects txn.json escaping via symlinked boards/<slug> directory and executes zero ops', async () => {
    const root = await makeTempDir('cdeck-h1-sym-');
    const outside = await makeTempDir('cdeck-h1-out-');
    const store = new core.ContextDeckStore(root);
    await store.createBoard({ title: 'Main', slug: 'main' });

    // Create a symlinked board directory pointing outside the workspace
    const evilBoardLink = path.join(store.boardsDir, 'evil');
    await fs.mkdir(path.join(outside, 'tasks'), { recursive: true });
    const outsideTarget = path.join(outside, 'tasks', 'task_001.md');
    await fs.writeFile(outsideTarget, 'KEEP_ME', 'utf8');
    await fs.symlink(outside, evilBoardLink);

    const txnPath = path.join(store.runtimeDir, 'txn.json');
    await fs.writeFile(
      txnPath,
      JSON.stringify({
        id: 'txn_sym_escape',
        boardSlug: 'evil',
        ops: [
          { kind: 'unlink', finalPath: 'boards/evil/tasks/task_001.md' },
        ],
        events: [],
      }),
      'utf8',
    );

    await expect(
      store.upsertTask('main', { title: 'Trigger recovery' }),
    ).rejects.toMatchObject({ code: 'CORRUPT_DATA' });

    expect(await fs.readFile(outsideTarget, 'utf8')).toBe('KEEP_ME');
    await expect(fs.stat(txnPath)).resolves.toBeTruthy();
  }, FSYNC_TEST_TIMEOUT_MS);

  it('R3-3: rejects txn.json when in-deck symlink aliases another board config and executes zero ops', async () => {
    const root = await makeTempDir('cdeck-r3-3-');
    const store = new core.ContextDeckStore(root);
    await store.createBoard({ title: 'Main', slug: 'main' });
    await store.createBoard({ title: 'Other', slug: 'other' });

    const otherBoardYaml = path.join(store.boardPath('other'), 'board.yaml');
    const otherBefore = await fs.readFile(otherBoardYaml, 'utf8');

    // Real in-deck symlink: boards/main/media/art_test.mp4 -> ../../other/board.yaml
    const aliasLink = path.join(store.boardPath('main'), 'media', 'art_test.mp4');
    await fs.symlink(path.join('..', '..', 'other', 'board.yaml'), aliasLink);

    // Also include a legitimate task file in op 0 to prove ZERO ops run when op 1 is an alias
    const legitTask = await store.upsertTask('main', { title: 'Survive rejected txn' });
    const legitTaskPath = path.join(store.boardPath('main'), 'tasks', `${legitTask.id}.md`);

    const txnPath = path.join(store.runtimeDir, 'txn.json');
    await fs.writeFile(
      txnPath,
      JSON.stringify({
        id: 'txn_r3_3_alias',
        boardSlug: 'main',
        ops: [
          { kind: 'unlink', finalPath: `boards/main/tasks/${legitTask.id}.md` },
          { kind: 'unlink', finalPath: 'boards/main/media/art_test.mp4' },
        ],
        events: [],
      }),
      'utf8',
    );

    await expect(
      core.recoverPendingTxn(store.runtimeDir, undefined, store.deckDir),
    ).rejects.toBeInstanceOf(core.CorruptDataError);

    expect(await fs.readFile(otherBoardYaml, 'utf8')).toBe(otherBefore);
    expect(await fs.stat(legitTaskPath)).toBeTruthy();
    expect(await fs.stat(txnPath)).toBeTruthy();
  }, FSYNC_TEST_TIMEOUT_MS);

  it('H1: stores relative paths inside txn.json during faulted writes', async () => {
    const dir = await makeTempDir('cdeck-h1-rel-');
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Main', slug: 'main' });

    process.env.CONTEXTDECK_FAULT = 'after-txn-write';
    await expect(store.upsertTask('main', { title: 'Check relative journal' })).rejects.toThrow(/fault/i);
    delete process.env.CONTEXTDECK_FAULT;

    const raw = await fs.readFile(path.join(store.runtimeDir, 'txn.json'), 'utf8');
    const txn = JSON.parse(raw) as core.TxnJournal;
    for (const op of txn.ops) {
      expect(path.isAbsolute(op.finalPath)).toBe(false);
      if (op.kind !== 'unlink') {
        expect(path.isAbsolute(op.tmpPath)).toBe(false);
      }
    }
    for (const ev of txn.events) {
      expect(path.isAbsolute(ev.eventsPath)).toBe(false);
    }
    if (txn.boardCommit) {
      expect(path.isAbsolute(txn.boardCommit.tmpPath)).toBe(false);
      expect(path.isAbsolute(txn.boardCommit.finalPath)).toBe(false);
    }
  }, FSYNC_TEST_TIMEOUT_MS);

  it('H2: recovers missing media blob op without wedging the board and keeps metadata consistent', async () => {
    const dir = await makeTempDir('cdeck-h2-blob-');
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Main', slug: 'main' });

    process.env.CONTEXTDECK_FAULT = 'after-txn-write';
    await expect(
      store.addMedia('main', {
        title: 'Clip',
        kind: 'video',
        fileName: 'clip.mp4',
        fileBuffer: Buffer.from('video-bytes'),
      }),
    ).rejects.toThrow(/fault/i);
    delete process.env.CONTEXTDECK_FAULT;

    // Simulate external deletion of the staged media blob temp file before recovery
    const txnPath = path.join(store.runtimeDir, 'txn.json');
    const txn = JSON.parse(await fs.readFile(txnPath, 'utf8')) as core.TxnJournal;
    const blobOp = txn.ops.find(
      (o): o is Extract<core.TxnOp, { kind: 'rename' }> =>
        o.kind === 'rename' && o.finalPath.endsWith('.mp4'),
    );
    expect(blobOp).toBeDefined();
    const blobTmpAbs = path.isAbsolute(blobOp!.tmpPath)
      ? blobOp!.tmpPath
      : path.resolve(store.deckDir, blobOp!.tmpPath);
    await fs.rm(blobTmpAbs, { force: true });

    // Next mutation must recover instead of wedging forever
    const task = await store.upsertTask('main', { title: 'After missing blob' });
    expect(task.title).toBe('After missing blob');
    const snap = await store.getSnapshot('main');
    expect(snap.tasks).toHaveLength(1);
    const clip = snap.media.find((m) => m.title === 'Clip');
    expect(clip).toBeDefined();
    expect(clip!.filePath).toBeUndefined();
  }, FSYNC_TEST_TIMEOUT_MS);

  it('H3: truncates torn partial event line on crash recovery so snapshot loads with event once', async () => {
    const dir = await makeTempDir('cdeck-h3-');
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Main', slug: 'main', brief: '# V1\n' });

    process.env.CONTEXTDECK_FAULT = 'after-renames';
    await expect(
      store.updateBrief('main', '# V2\n', undefined, { baseRevision: 1 }),
    ).rejects.toThrow(/fault/i);
    delete process.env.CONTEXTDECK_FAULT;

    const txnPath = path.join(store.runtimeDir, 'txn.json');
    const txn = JSON.parse(await fs.readFile(txnPath, 'utf8')) as core.TxnJournal;
    expect(txn.events).toHaveLength(1);
    const eventsPath = path.join(store.boardPath('main'), 'events.jsonl');
    // Simulate mid-append crash: first 40 bytes without trailing newline
    await fs.appendFile(eventsPath, txn.events[0].line.slice(0, 40), 'utf8');

    const recovered = await core.recoverPendingTxn(store.runtimeDir);
    expect(recovered).toBe(true);

    const snap = await store.getSnapshot('main');
    expect(snap.brief).toBe('# V2\n');
    const briefEvents = snap.events.filter((e) => e.id === txn.events[0].eventId);
    expect(briefEvents).toHaveLength(1);
  }, FSYNC_TEST_TIMEOUT_MS);

  it('H6: rejects NaN, float, and negative baseRevision / ackRevision without corrupting state', async () => {
    const dir = await makeTempDir('cdeck-h6-');
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Main', slug: 'main', brief: '# Original\n' });
    await store.updateBrief('main', '# Human Edit\n', undefined, { baseRevision: 1 });
    const sess = await store.registerSession('main', { title: 'S1', harness: 'codex' });

    for (const bad of [Number.NaN, 1.5, -1, 0, Number.POSITIVE_INFINITY]) {
      await expect(
        store.updateBrief('main', '# Overwrite\n', undefined, { baseRevision: bad }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    expect((await store.getSnapshot('main')).brief).toBe('# Human Edit\n');

    for (const bad of [Number.NaN, 1.5, -1, Number.POSITIVE_INFINITY]) {
      await expect(
        store.syncSession('main', sess.id, { ackRevision: bad }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    // Session YAML must remain valid and loadable (no .nan written)
    const snap = await store.getSnapshot('main');
    const loadedSess = snap.sessions.find((s) => s.id === sess.id);
    expect(loadedSess?.lastSyncedRevision).toBe(sess.lastSyncedRevision);
  }, FSYNC_TEST_TIMEOUT_MS);

  it('H7: applyContextUpdate requires baseRevision for brief updates, enforces brief conflicts, and pack protocol includes baseRevision', async () => {
    const dir = await makeTempDir('cdeck-h7-');
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Main', slug: 'main', brief: '# Initial\n' });

    const snapBefore = await store.getSnapshot('main');
    const pack = core.generateContextPack(snapBefore, { includeUpdateProtocol: true });
    expect(pack).toContain(`"baseRevision": ${snapBefore.config.revision}`);

    // Brief update without baseRevision -> ValidationError naming baseRevision
    await expect(
      store.applyContextUpdate('main', { brief: 'NO BASE REVISION' }),
    ).rejects.toThrow(/baseRevision/);
    await expect(
      store.applyContextUpdate('main', { brief: 'NO BASE REVISION' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    // Human edits brief at rev 1 -> rev 2
    await store.updateBrief('main', '# Human Newer Brief\n', { type: 'human', label: 'user' }, { baseRevision: 1 });

    // Stale chat payload with baseRevision: 1 -> ConflictError with currentBrief, brief unchanged
    let caught: unknown;
    try {
      await store.applyContextUpdate('main', {
        brief: 'STALE CHAT COPY',
        baseRevision: 1,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(core.ConflictError);
    expect((caught as core.ConflictError).details?.currentBrief).toBe('# Human Newer Brief\n');
    expect((await store.getSnapshot('main')).brief).toBe('# Human Newer Brief\n');

    // Fresh baseRevision: 2 succeeds (even combined with sessionTitle)
    const ok = await store.applyContextUpdate('main', {
      sessionTitle: 'Grok Sync',
      baseRevision: 2,
      brief: '# Merged Fresh Brief\n',
    });
    expect(ok.snapshot.brief).toBe('# Merged Fresh Brief\n');
    expect(ok.appliedCount).toBe(2);

    // Non-brief context updates still work without baseRevision
    const nonBrief = await store.applyContextUpdate('main', {
      tasks: [{ title: 'Follow-up without brief' }],
    });
    expect(nonBrief.appliedCount).toBe(1);
  }, FSYNC_TEST_TIMEOUT_MS);

  it('H9: updateDecision marks superseded target, emits supersession details, and rejects self-supersede and cycles', async () => {
    const dir = await makeTempDir('cdeck-h9-');
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Main', slug: 'main' });

    const d1 = await store.recordDecision('main', { title: 'Choice One', summary: 'First' });
    const d2 = await store.recordDecision('main', { title: 'Choice Two', summary: 'Second' });
    const d3 = await store.recordDecision('main', { title: 'Choice Three', summary: 'Third' });

    // Self-supersede rejected on both recordDecision and updateDecision
    await expect(
      store.recordDecision('main', { id: 'dec_self', title: 'Self', supersedes: 'dec_self' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      store.updateDecision('main', d1.id, { supersedes: d1.id }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    // updateDecision with supersedes marks d1 superseded and emits supersession event details
    await store.updateDecision('main', d2.id, { supersedes: d1.id });
    const snap = await store.getSnapshot('main');
    const updatedD1 = snap.decisions.find((d) => d.id === d1.id)!;
    expect(updatedD1.status).toBe('superseded');
    expect(updatedD1.supersededBy).toBe(d2.id);

    const supEvent = snap.events.find(
      (e) => e.kind === 'decision.superseded' && e.entityId === d2.id,
    );
    expect(supEvent).toBeDefined();
    expect(supEvent?.details?.supersedes).toBe(d1.id);
    expect(supEvent?.details?.before).toMatchObject({ id: d1.id, status: 'accepted' });
    expect(supEvent?.details?.after).toMatchObject({ id: d2.id, status: 'accepted' });

    // Cycle detection: d2 -> d1 and d3 -> d2, so d1 -> d3 (and d1 -> d2) must be rejected
    await store.updateDecision('main', d3.id, { supersedes: d2.id });
    await expect(
      store.updateDecision('main', d1.id, { supersedes: d2.id }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      store.updateDecision('main', d1.id, { supersedes: d3.id }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  }, FSYNC_TEST_TIMEOUT_MS);

  it('R3-5: clears and reassigns supersedes cleanly, restoring old targets and emitting events', async () => {
    const dir = await makeTempDir('cdeck-r3-5-');
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Main', slug: 'main' });

    // 1. Null clear: B supersedes A, then clear B.supersedes -> null
    const a = await store.recordDecision('main', { title: 'A auth', summary: 'jwt' });
    const b = await store.recordDecision('main', {
      title: 'B auth',
      summary: 'sessions',
      supersedes: a.id,
    });
    const revBeforeClear = (await store.getSnapshot('main')).config.revision;

    await store.updateDecision('main', b.id, { supersedes: null });
    const snapAfterClear = await store.getSnapshot('main');
    const aAfterClear = snapAfterClear.decisions.find((d) => d.id === a.id)!;
    const bAfterClear = snapAfterClear.decisions.find((d) => d.id === b.id)!;

    expect(bAfterClear.supersedes).toBeNull();
    expect(aAfterClear.status).toBe('accepted');
    expect(aAfterClear.supersededBy).toBeNull();

    const clearEvents = snapAfterClear.events.filter((e) => e.revision > revBeforeClear);
    expect(
      clearEvents.some((e) => e.kind === 'decision.updated' && e.entityId === a.id),
    ).toBe(true);
    expect(
      clearEvents.some((e) => e.kind === 'decision.updated' && e.entityId === b.id),
    ).toBe(true);

    // 2. Reassignment: D supersedes C, then reassign D -> E
    const c = await store.recordDecision('main', { title: 'C cache', summary: 'redis' });
    const d = await store.recordDecision('main', {
      title: 'D cache',
      summary: 'memcached',
      supersedes: c.id,
    });
    const eDec = await store.recordDecision('main', { title: 'E cache', summary: 'in-memory' });
    const revBeforeReassign = (await store.getSnapshot('main')).config.revision;

    // Self-supersede / cycle during reassignment must fail without restoring C
    await expect(
      store.updateDecision('main', d.id, { supersedes: d.id }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const snapAfterRejected = await store.getSnapshot('main');
    expect(snapAfterRejected.decisions.find((x) => x.id === c.id)?.status).toBe('superseded');
    expect(snapAfterRejected.decisions.find((x) => x.id === c.id)?.supersededBy).toBe(d.id);

    await store.updateDecision('main', d.id, { supersedes: eDec.id });
    const snapAfterReassign = await store.getSnapshot('main');
    const cAfter = snapAfterReassign.decisions.find((x) => x.id === c.id)!;
    const dAfter = snapAfterReassign.decisions.find((x) => x.id === d.id)!;
    const eAfter = snapAfterReassign.decisions.find((x) => x.id === eDec.id)!;

    expect(dAfter.supersedes).toBe(eDec.id);
    expect(cAfter.status).toBe('accepted');
    expect(cAfter.supersededBy).toBeNull();
    expect(eAfter.status).toBe('superseded');
    expect(eAfter.supersededBy).toBe(d.id);

    const reassignEvents = snapAfterReassign.events.filter((e) => e.revision > revBeforeReassign);
    expect(
      reassignEvents.some((e) => e.kind === 'decision.updated' && e.entityId === c.id),
    ).toBe(true);
    const supEvt = reassignEvents.find(
      (e) => e.kind === 'decision.superseded' && e.entityId === d.id,
    );
    expect(supEvt).toBeDefined();
    expect(supEvt?.details?.supersedes).toBe(eDec.id);

    // 3. Deprecated old target keeps deprecated status when un-superseded
    const dep = await store.recordDecision('main', { title: 'Deprecated base', summary: 'old' });
    const rep = await store.recordDecision('main', {
      title: 'Replacement',
      summary: 'new',
      supersedes: dep.id,
    });
    await store.updateDecision('main', dep.id, { status: 'deprecated' });
    await store.updateDecision('main', rep.id, { supersedes: null });
    const snapDep = await store.getSnapshot('main');
    const depAfter = snapDep.decisions.find((x) => x.id === dep.id)!;
    expect(depAfter.supersededBy).toBeNull();
    expect(depAfter.status).toBe('deprecated');
  }, FSYNC_TEST_TIMEOUT_MS);

  it('H15: retries transient EBUSY/EPERM/EACCES errors in retryOnTransientFsError and linkCreateAtomic', async () => {
    let calls = 0;
    const result = await core.retryOnTransientFsError(
      async () => {
        calls += 1;
        if (calls < 3) {
          const err = new Error('busy') as NodeJS.ErrnoException;
          err.code = calls === 1 ? 'EBUSY' : 'EPERM';
          throw err;
        }
        return 'ok';
      },
      { attempts: 5, initialDelayMs: 1 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);

    // Non-transient errors fail immediately on attempt 1
    let nonTransientCalls = 0;
    await expect(
      core.retryOnTransientFsError(
        async () => {
          nonTransientCalls += 1;
          const err = new Error('missing') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        },
        { attempts: 5, initialDelayMs: 1 },
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(nonTransientCalls).toBe(1);

    // linkCreateAtomic retries transient EBUSY on link and unlink
    const dir = await makeTempDir('cdeck-h15-');
    const src = path.join(dir, '.tmp-item');
    const dst = path.join(dir, 'item.md');
    await fs.writeFile(src, 'payload', 'utf8');

    const origLink = fs.link.bind(fs);
    const origUnlink = fs.unlink.bind(fs);
    let linkTries = 0;
    let unlinkTries = 0;
    const linkSpy = vi.spyOn(fs, 'link').mockImplementation(async (existingPath, newPath) => {
      linkTries += 1;
      if (linkTries === 1) {
        const err = new Error('transient link busy') as NodeJS.ErrnoException;
        err.code = 'EBUSY';
        throw err;
      }
      return origLink(existingPath, newPath);
    });
    const unlinkSpy = vi.spyOn(fs, 'unlink').mockImplementation(async (target) => {
      unlinkTries += 1;
      if (unlinkTries === 1) {
        const err = new Error('transient unlink perm') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return origUnlink(target);
    });

    try {
      await core.linkCreateAtomic(src, dst);
      expect(linkTries).toBe(2);
      expect(unlinkTries).toBe(2);
      expect(await fs.readFile(dst, 'utf8')).toBe('payload');
      await expect(fs.stat(src)).rejects.toThrow();
    } finally {
      linkSpy.mockRestore();
      unlinkSpy.mockRestore();
    }
  });

  it('R3-4: throws CorruptDataError on corrupt task patch and quiz refresh, and allows deleteTask on corrupt task', async () => {
    const dir = await makeTempDir('cdeck-r3-4-');
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Main', slug: 'main' });

    const badTaskPath = path.join(store.boardPath('main'), 'tasks', 'task_bad.md');
    await fs.writeFile(badTaskPath, '---\nnot: [valid: yaml\n---\n', 'utf8');

    const badQuizPath = path.join(store.boardPath('main'), 'quizzes', 'quiz_bad.quiz.json');
    await fs.writeFile(badQuizPath, '{not-json', 'utf8');

    const badSchemaQuizPath = path.join(
      store.boardPath('main'),
      'quizzes',
      'quiz_bad_schema.quiz.json',
    );
    await fs.writeFile(
      badSchemaQuizPath,
      JSON.stringify({ id: 'quiz_bad_schema', title: 'Bad', questions: [] }),
      'utf8',
    );

    await expect(
      store.patchTask('main', 'task_bad', { title: 'Updated' }),
    ).rejects.toBeInstanceOf(core.CorruptDataError);
    await expect(
      store.patchTask('main', 'task_bad', { title: 'Updated' }),
    ).rejects.toMatchObject({ code: 'CORRUPT_DATA' });

    await expect(
      store.refreshArtifactDecisions('main', 'quiz', 'quiz_bad'),
    ).rejects.toBeInstanceOf(core.CorruptDataError);
    await expect(
      store.refreshArtifactDecisions('main', 'quiz', 'quiz_bad'),
    ).rejects.toMatchObject({ code: 'CORRUPT_DATA' });

    await expect(
      store.refreshArtifactDecisions('main', 'quiz', 'quiz_bad_schema'),
    ).rejects.toBeInstanceOf(core.CorruptDataError);

    // Deleting a corrupt task file must succeed and log task.deleted with entityId only
    await expect(store.deleteTask('main', 'task_bad')).resolves.toBeUndefined();
    await expect(fs.stat(badTaskPath)).rejects.toThrow();

    const events = await store.readEvents('main');
    const delEvt = events.find((e) => e.kind === 'task.deleted' && e.entityId === 'task_bad');
    expect(delEvt).toBeDefined();
    expect(delEvt?.details).toEqual({ before: null, after: null });
  }, FSYNC_TEST_TIMEOUT_MS);
});
