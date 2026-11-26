import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as core from '../src/index.js';

const tmpDirs: string[] = [];

async function makeTempDir(prefix = 'cdeck-b2-core-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    await fs.rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('D11 workspace-scoped sessions, runtime cursors, externalRef dedupe, and migration', () => {
  it('stores session metadata in <deck>/sessions/<id>.yaml and volatile sync state in .runtime/cursors/<id>.json', async () => {
    const dir = await makeTempDir();
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Main', slug: 'main' });

    const sess = await store.registerSession(
      'main',
      {
        title: 'Claude Backend',
        harness: 'claude-code',
        externalRef: 'claude-code:ext_001',
      },
      { type: 'agent', harness: 'claude-code' },
    );

    expect(sess.board).toBe('main');

    // Workspace-scoped YAML exists under <deck>/sessions/ (NOT boards/main/sessions/)
    const metaPath = path.join(store.deckDir, 'sessions', `${sess.id}.yaml`);
    const rawMeta = await fs.readFile(metaPath, 'utf8');
    const parsedMeta = yaml.load(rawMeta) as Record<string, unknown>;
    expect(parsedMeta.id).toBe(sess.id);
    expect(parsedMeta.board).toBe('main');
    expect(parsedMeta.externalRef).toBe('claude-code:ext_001');
    // Volatile sync state must NOT be written into git-tracked session YAML
    expect(parsedMeta.lastSyncedRevision).toBeUndefined();

    const legacyPath = path.join(store.deckDir, 'boards', 'main', 'sessions', `${sess.id}.yaml`);
    await expect(fs.stat(legacyPath)).rejects.toThrow();

    // Cursor file exists under <deck>/.runtime/cursors/
    const cursorPath = path.join(store.runtimeDir, 'cursors', `${sess.id}.json`);
    const cursor = JSON.parse(await fs.readFile(cursorPath, 'utf8')) as {
      sessionId: string;
      syncedRevisions: Record<string, number>;
      lastActiveAt: string;
    };
    expect(cursor.sessionId).toBe(sess.id);
    expect(cursor.syncedRevisions.main).toBe(sess.lastSyncedRevision);
    expect(typeof cursor.lastActiveAt).toBe('string');

    // Another session records a decision, then syncSession advances ONLY the cursor (never dirtying sessions/<id>.yaml)
    await store.recordDecision(
      'main',
      { title: 'Use workspace sessions' },
      { type: 'agent', harness: 'codex', sessionId: 'sess_other' },
    );
    const metaBeforeSync = await fs.readFile(metaPath, 'utf8');
    const boardBeforeSync = await fs.readFile(path.join(store.boardPath('main'), 'board.yaml'), 'utf8');

    const synced = await store.syncSession(undefined, sess.id);
    expect(synced.behindBy).toBe(1);
    expect(synced.session.lastSyncedRevision).toBe(synced.currentRevision);

    const metaAfterSync = await fs.readFile(metaPath, 'utf8');
    const boardAfterSync = await fs.readFile(path.join(store.boardPath('main'), 'board.yaml'), 'utf8');
    expect(metaAfterSync).toBe(metaBeforeSync);
    expect(boardAfterSync).toBe(boardBeforeSync);

    const cursorAfter = JSON.parse(await fs.readFile(cursorPath, 'utf8')) as {
      syncedRevisions: Record<string, number>;
    };
    expect(cursorAfter.syncedRevisions.main).toBe(synced.currentRevision);
  });

  it('deduplicates sessions by externalRef instead of creating duplicate records', async () => {
    const dir = await makeTempDir();
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Main', slug: 'main' });

    const first = await store.registerSession('main', {
      title: 'Initial Title',
      harness: 'antigravity',
      externalRef: 'antigravity:thread-42',
    });
    const second = await store.registerSession('main', {
      title: 'Resumed Title',
      harness: 'antigravity',
      externalRef: 'antigravity:thread-42',
      summary: 'Continued work',
    });

    expect(second.id).toBe(first.id);
    expect(second.summary).toBe('Continued work');

    const all = await store.listSessions('main');
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(first.id);

    const found = await store.findSessionByExternalRef('antigravity:thread-42');
    expect(found?.id).toBe(first.id);
  });

  it('migrates legacy fabf58c board-scoped session files on first write while keeping reads strictly read-only', async () => {
    const dir = await makeTempDir();
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Legacy Board', slug: 'legacy' });
    await store.recordDecision('legacy', { title: 'Decision 1' });
    await store.recordDecision('legacy', { title: 'Decision 2' });

    // Simulate a fabf58c board-scoped session YAML directly on disk
    const legacyDir = path.join(store.boardPath('legacy'), 'sessions');
    await fs.mkdir(legacyDir, { recursive: true });
    const legacyFile = path.join(legacyDir, 'sess_legacy_01.yaml');
    const now = new Date().toISOString();
    await fs.writeFile(
      legacyFile,
      yaml.dump({
        id: 'sess_legacy_01',
        title: 'Old Cursor Thread',
        harness: 'cursor',
        externalRef: 'cursor:old-conv',
        parentSessionId: null,
        relatedSessionIds: [],
        status: 'active',
        summary: 'From v0.1',
        focusFiles: ['src/index.ts'],
        lastSyncedRevision: 1,
        createdAt: now,
        updatedAt: now,
      }),
      'utf8',
    );

    // Read-only getSnapshot sees the legacy session AND does NOT mutate disk (D8)
    const snapBefore = await store.getSnapshot('legacy');
    expect(snapBefore.sessions.map((s) => s.id)).toContain('sess_legacy_01');
    const legacySessBefore = snapBefore.sessions.find((s) => s.id === 'sess_legacy_01')!;
    expect(legacySessBefore.board).toBe('legacy');
    expect(legacySessBefore.lastSyncedRevision).toBe(1);
    expect(snapBefore.drift.driftedSessions.some((d) => d.sessionId === 'sess_legacy_01')).toBe(true);
    await expect(fs.stat(legacyFile)).resolves.toBeDefined();
    await expect(fs.stat(path.join(store.deckDir, 'sessions', 'sess_legacy_01.yaml'))).rejects.toThrow();

    // First write triggers migration without adding spurious revision bumps
    const revBeforeWrite = snapBefore.config.revision;
    await store.recordDecision('legacy', { title: 'Decision 3' });

    // Legacy file is gone, workspace-scoped YAML + cursor file now exist
    await expect(fs.stat(legacyFile)).rejects.toThrow();
    const migratedRaw = await fs.readFile(
      path.join(store.deckDir, 'sessions', 'sess_legacy_01.yaml'),
      'utf8',
    );
    const migratedMeta = yaml.load(migratedRaw) as Record<string, unknown>;
    expect(migratedMeta.board).toBe('legacy');
    expect(migratedMeta.title).toBe('Old Cursor Thread');
    expect(migratedMeta.lastSyncedRevision).toBeUndefined();

    const migratedCursor = JSON.parse(
      await fs.readFile(path.join(store.runtimeDir, 'cursors', 'sess_legacy_01.json'), 'utf8'),
    ) as { syncedRevisions: Record<string, number> };
    expect(migratedCursor.syncedRevisions.legacy).toBe(1);

    const snapAfter = await store.getSnapshot('legacy');
    // Only +1 revision for Decision 3, NOT extra bumps for migration
    expect(snapAfter.config.revision).toBe(revBeforeWrite + 1);
    expect(snapAfter.sessions.find((s) => s.id === 'sess_legacy_01')?.lastSyncedRevision).toBe(1);
  });

  it('rebinds a session to another board and preserves per-board cursors', async () => {
    const dir = await makeTempDir();
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'API', slug: 'api' });
    await store.createBoard({ title: 'Web', slug: 'web' });

    const sess = await store.registerSession('api', { title: 'Multi-board agent', harness: 'codex' });
    await store.recordDecision('web', { title: 'Use Tailwind' }, { type: 'agent', sessionId: 'sess_other' });

    const rebound = await store.rebindSession(sess.id, 'web');
    expect(rebound.board).toBe('web');

    expect((await store.listSessions('api')).map((s) => s.id)).not.toContain(sess.id);
    expect((await store.listSessions('web')).map((s) => s.id)).toContain(sess.id);

    // getSessionDrift without boardSlug defaults to the session's bound board (web)
    // Never synced on web yet -> behind by board.init (rev 1) + Use Tailwind (rev 2)
    const drift = await store.getSessionDrift(undefined, sess.id);
    expect(drift.behindBy).toBe(2);
    expect(drift.digestText).toContain('Use Tailwind');

    // Syncing on web preserves api's separate cursor
    const syncedWeb = await store.syncSession(undefined, sess.id);
    expect(syncedWeb.ackRevision).toBe(drift.currentRevision);
    const cursor = await store.readSessionCursor(sess.id);
    expect(cursor?.syncedRevisions.api).toBe(sess.lastSyncedRevision);
    expect(cursor?.syncedRevisions.web).toBe(drift.currentRevision);

    // Rebinding back to api keeps api synced
    const backToApi = await store.rebindSession(sess.id, 'api');
    expect(backToApi.lastSyncedRevision).toBe(sess.lastSyncedRevision);
    expect((await store.getSessionDrift(undefined, sess.id)).behindBy).toBe(0);

    // Rebinding to a non-existent board throws NotFoundError
    await expect(store.rebindSession(sess.id, 'nonexistent')).rejects.toThrow(core.NotFoundError);
  });

  it('H3: legacy session migration fails closed on colliding IDs preserving both originals, and dedupes identical duplicates', async () => {
    const dir = await makeTempDir('cdeck-h3-');
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Board A', slug: 'board-a' });
    await store.createBoard({ title: 'Board B', slug: 'board-b' });

    const legDirA = path.join(store.boardPath('board-a'), 'sessions');
    const legDirB = path.join(store.boardPath('board-b'), 'sessions');
    await fs.mkdir(legDirA, { recursive: true });
    await fs.mkdir(legDirB, { recursive: true });

    const now = new Date().toISOString();
    const legA = path.join(legDirA, 'sess_shared.yaml');
    const legB = path.join(legDirB, 'sess_shared.yaml');
    const legNonConflict = path.join(legDirA, 'sess_unique.yaml');

    await fs.writeFile(
      legA,
      yaml.dump({
        id: 'sess_shared',
        title: 'Session on A',
        harness: 'codex',
        parentSessionId: null,
        relatedSessionIds: [],
        status: 'active',
        summary: 'Metadata A',
        focusFiles: ['a.ts'],
        lastSyncedRevision: 1,
        createdAt: now,
        updatedAt: now,
      }),
      'utf8',
    );
    await fs.writeFile(
      legB,
      yaml.dump({
        id: 'sess_shared',
        title: 'Session on B',
        harness: 'cursor',
        parentSessionId: null,
        relatedSessionIds: [],
        status: 'active',
        summary: 'Metadata B',
        focusFiles: ['b.ts'],
        lastSyncedRevision: 2,
        createdAt: now,
        updatedAt: now,
      }),
      'utf8',
    );
    await fs.writeFile(
      legNonConflict,
      yaml.dump({
        id: 'sess_unique',
        title: 'Non-conflicting session',
        harness: 'claude-code',
        parentSessionId: null,
        relatedSessionIds: [],
        status: 'active',
        summary: 'Should still migrate',
        focusFiles: [],
        lastSyncedRevision: 1,
        createdAt: now,
        updatedAt: now,
      }),
      'utf8',
    );

    // Colliding IDs must fail closed with CorruptDataError naming both paths, keeping BOTH originals intact
    let caughtErr: unknown;
    try {
      await store.recordDecision('board-a', { title: 'Trigger migration' });
    } catch (err) {
      caughtErr = err;
    }
    expect(caughtErr).toBeInstanceOf(core.CorruptDataError);
    expect((caughtErr as Error).message).toContain(legA);
    expect((caughtErr as Error).message).toContain(legB);
    await expect(fs.stat(legA)).resolves.toBeDefined();
    await expect(fs.stat(legB)).resolves.toBeDefined();
    expect(await fs.readFile(legA, 'utf8')).toContain('Metadata A');
    expect(await fs.readFile(legB, 'utf8')).toContain('Metadata B');
    // Non-conflicting session still migrated cleanly
    await expect(fs.stat(path.join(store.sessionsDir, 'sess_unique.yaml'))).resolves.toBeDefined();
    await expect(fs.stat(legNonConflict)).rejects.toThrow();

    // Separate workspace: identical duplicates (same id, board, content) -> deduped cleanly, both legacy files removed
    const dir2 = await makeTempDir('cdeck-h3-dup-');
    const store2 = new core.ContextDeckStore(dir2);
    await store2.createBoard({ title: 'Board A', slug: 'board-a' });
    await store2.createBoard({ title: 'Board B', slug: 'board-b' });
    const dupDirA = path.join(store2.boardPath('board-a'), 'sessions');
    const dupDirB = path.join(store2.boardPath('board-b'), 'sessions');
    await fs.mkdir(dupDirA, { recursive: true });
    await fs.mkdir(dupDirB, { recursive: true });
    const identicalYaml = yaml.dump({
      id: 'sess_identical',
      title: 'Same Session',
      harness: 'codex',
      board: 'board-a',
      parentSessionId: null,
      relatedSessionIds: [],
      status: 'active',
      summary: 'Identical metadata',
      focusFiles: ['x.ts'],
      lastSyncedRevision: 1,
      createdAt: now,
      updatedAt: now,
    });
    const dupA = path.join(dupDirA, 'sess_identical.yaml');
    const dupB = path.join(dupDirB, 'sess_identical.yaml');
    await fs.writeFile(dupA, identicalYaml, 'utf8');
    await fs.writeFile(dupB, identicalYaml, 'utf8');

    await store2.recordDecision('board-a', { title: 'Trigger identical dedupe' });
    await expect(fs.stat(dupA)).rejects.toThrow();
    await expect(fs.stat(dupB)).rejects.toThrow();
    const migrated = await store2.getSession('sess_identical');
    expect(migrated?.title).toBe('Same Session');
    expect(migrated?.board).toBe('board-a');
  });

  it('H12: ignores stray non-slug dirs under boards/ and removes empty legacy sessions/ dirs after migration', async () => {
    const dir = await makeTempDir('cdeck-h12-');
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Main', slug: 'main' });

    // Create stray non-slug dir `boards/Backup/sessions/x.yaml` AND a valid legacy session under main
    const strayDir = path.join(store.boardsDir, 'Backup', 'sessions');
    await fs.mkdir(strayDir, { recursive: true });
    await fs.writeFile(path.join(strayDir, 'x.yaml'), 'not-even: relevant\n', 'utf8');

    const mainLegDir = path.join(store.boardPath('main'), 'sessions');
    await fs.mkdir(mainLegDir, { recursive: true });
    const now = new Date().toISOString();
    await fs.writeFile(
      path.join(mainLegDir, 'sess_leg1.yaml'),
      yaml.dump({
        id: 'sess_leg1',
        title: 'Legacy 1',
        harness: 'claude-code',
        parentSessionId: null,
        relatedSessionIds: [],
        status: 'active',
        summary: '',
        focusFiles: [],
        lastSyncedRevision: 1,
        createdAt: now,
        updatedAt: now,
      }),
      'utf8',
    );

    // Writes and reads on main must NOT be wedged by `boards/Backup/`
    const dec = await store.recordDecision('main', { title: 'Works despite stray Backup dir' });
    expect(dec.title).toBe('Works despite stray Backup dir');
    expect((await store.listBoards()).map((b) => b.slug)).toEqual(['main']);

    // Empty legacy `boards/main/sessions/` directory must be cleaned up after migration
    await expect(fs.stat(mainLegDir)).rejects.toThrow();
    expect((await store.getSession('sess_leg1'))?.title).toBe('Legacy 1');
  });

  it('H6: rejects symlinked .runtime/cursors directory and aliased cursor files with CorruptDataError without touching outside files', async () => {
    const dir = await makeTempDir('cdeck-h6-');
    const outsideDir = await makeTempDir('cdeck-h6-outside-');
    const outsideSentinel = path.join(outsideDir, 'sess_victim.json');
    await fs.writeFile(outsideSentinel, '{"untouched":true}\n', 'utf8');

    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Main', slug: 'main' });

    // Replace .contextdeck/.runtime/cursors with a real symlink to outsideDir
    await fs.mkdir(store.runtimeDir, { recursive: true });
    await fs.rm(store.cursorsDir, { recursive: true, force: true });
    await fs.symlink(outsideDir, store.cursorsDir);

    await expect(store.readSessionCursor('sess_victim')).rejects.toThrow(core.CorruptDataError);
    await expect(
      store.writeSessionCursor({
        sessionId: 'sess_victim',
        syncedRevisions: { main: 1 },
        lastActiveAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(core.CorruptDataError);

    // Outside file must remain completely untouched
    expect(await fs.readFile(outsideSentinel, 'utf8')).toBe('{"untouched":true}\n');

    // Also test an individual symlinked cursor file inside a legitimate cursors dir
    await fs.rm(store.cursorsDir, { force: true });
    await fs.mkdir(store.cursorsDir, { recursive: true });
    await fs.symlink(outsideSentinel, path.join(store.cursorsDir, 'sess_victim.json'));

    await expect(store.readSessionCursor('sess_victim')).rejects.toThrow(core.CorruptDataError);
    await expect(
      store.writeSessionCursor({
        sessionId: 'sess_victim',
        syncedRevisions: { main: 2 },
        lastActiveAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(core.CorruptDataError);
    expect(await fs.readFile(outsideSentinel, 'utf8')).toBe('{"untouched":true}\n');
  });
});

describe('E6 + D15 board path routing and parentBoard hierarchy', () => {
  it('routes cwd deterministically by longest literal prefix, then segment count, then slug', () => {
    const mkBoard = (slug: string, paths?: string[]): core.BoardConfig => ({
      id: `brd_${slug}`,
      slug,
      title: slug,
      description: '',
      revision: 1,
      lenses: core.DEFAULT_LENSES,
      paths,
      createdAt: '2026-11-26T00:00:00.000Z',
      updatedAt: '2026-11-26T00:00:00.000Z',
    });

    const projectRoot = '/repo';
    const boards = [
      mkBoard('root-all', ['**']),
      mkBoard('packages-all', ['packages/**']),
      mkBoard('web', ['packages/web/**']),
      mkBoard('web-src', ['packages/web/src/**']),
      mkBoard('web-direct-child', ['packages/web/*']),
      mkBoard('web-admin', ['packages/web-admin']),
      mkBoard('z-tie', ['apps/mobile/**']),
      mkBoard('a-tie', ['apps/mobile/**']),
      mkBoard('wild-deep', ['services/*/api/**']),
      mkBoard('wild-shallow', ['services/*/**']),
    ];

    // Longest literal prefix wins
    expect(core.routeBoardForCwd(boards, '/repo/packages/web/src/components', projectRoot, 'main')).toBe(
      'web-src',
    );
    // Exact directory match for `packages/web/**`
    expect(core.routeBoardForCwd(boards, '/repo/packages/web', projectRoot, 'main')).toBe('web');
    // Same literal prefix ("packages/web"), higher non-globstar segment count (`packages/web/*` = 3 vs `packages/web/**` = 2)
    expect(core.routeBoardForCwd(boards, '/repo/packages/web/public', projectRoot, 'main')).toBe(
      'web-direct-child',
    );
    // Segment boundary: `packages/web` must NOT match `packages/web-admin/src`
    expect(core.routeBoardForCwd(boards, '/repo/packages/web-admin/src', projectRoot, 'main')).toBe(
      'web-admin',
    );
    // Wildcard segment count tiebreaker: `services/*/api/**` (3) > `services/*/**` (2)
    expect(core.routeBoardForCwd(boards, '/repo/services/auth/api/v1', projectRoot, 'main')).toBe(
      'wild-deep',
    );
    // Equal prefix + equal segment count -> alphabetical slug wins ('a-tie' < 'z-tie')
    expect(core.routeBoardForCwd(boards, '/repo/apps/mobile/ios', projectRoot, 'main')).toBe('a-tie');
    // Fallback to defaultBoard when cwd is outside projectRoot
    expect(core.routeBoardForCwd(boards, '/other/dir', projectRoot, 'main')).toBe('main');
    // Fallback to defaultBoard when no board declares matching paths
    expect(
      core.routeBoardForCwd([mkBoard('only-api', ['packages/api/**'])], '/repo/docs', projectRoot, 'main'),
    ).toBe('main');

    // N1: exact segments beat wildcard segments on ties (`packages/web/**` beats `packages/web*` even when wildcard slug sorts earlier)
    expect(
      core.routeBoardForCwd(
        [mkBoard('a-wild', ['packages/web*']), mkBoard('z-exact', ['packages/web/**'])],
        '/repo/packages/web',
        projectRoot,
        'main',
      ),
    ).toBe('z-exact');

    // N1: directory starting with `..` (e.g. `..foo`) inside projectRoot is NOT treated as parent traversal
    expect(
      core.routeBoardForCwd(
        [mkBoard('dotdot', ['..foo/**'])],
        '/repo/..foo/bar',
        projectRoot,
        'main',
      ),
    ).toBe('dotdot');

    // N1: deterministic ASCII code-unit slug tie-breaking (e.g. `a-1` vs `a_1`: '-' (45) < '_' (95))
    expect(
      core.routeBoardForCwd(
        [mkBoard('a_1', ['shared/**']), mkBoard('a-1', ['shared/**'])],
        '/repo/shared/dir',
        projectRoot,
        'main',
      ),
    ).toBe('a-1');
  });

  it('persists parentBoard and paths and rejects self-parent and multi-hop parentBoard cycles (D15)', async () => {
    const dir = await makeTempDir();
    const store = new core.ContextDeckStore(dir);

    const root = await store.createBoard({ title: 'Platform', slug: 'platform', paths: ['**'] });
    const web = await store.createBoard({
      title: 'Web',
      slug: 'web',
      parentBoard: 'platform',
      paths: ['packages/web/**'],
    });
    const auth = await store.createBoard({
      title: 'Auth UI',
      slug: 'auth-ui',
      parentBoard: 'web',
      paths: ['packages/web/src/auth/**'],
    });

    expect(root.paths).toEqual(['**']);
    expect(web.parentBoard).toBe('platform');
    expect(auth.parentBoard).toBe('web');

    // Self-parent rejected on create and update
    await expect(
      store.createBoard({ title: 'Self', slug: 'self-loop', parentBoard: 'self-loop' }),
    ).rejects.toThrow(core.ValidationError);
    await expect(store.updateBoard('platform', { parentBoard: 'platform' })).rejects.toThrow(
      core.ValidationError,
    );

    // Direct 2-node cycle rejected: platform -> web -> platform
    await expect(store.updateBoard('platform', { parentBoard: 'web' })).rejects.toThrow(
      core.ValidationError,
    );

    // 3-node cycle rejected: platform -> auth-ui -> web -> platform
    await expect(store.updateBoard('platform', { parentBoard: 'auth-ui' })).rejects.toThrow(
      core.ValidationError,
    );

    // Missing parent rejected
    await expect(
      store.createBoard({ title: 'Orphan', slug: 'orphan', parentBoard: 'does-not-exist' }),
    ).rejects.toThrow(core.NotFoundError);

    // Valid update works
    const updated = await store.updateBoard('auth-ui', {
      parentBoard: 'platform',
      paths: ['packages/web/auth/**'],
    });
    expect(updated.parentBoard).toBe('platform');
    expect(updated.paths).toEqual(['packages/web/auth/**']);
  });
});

describe('D12 bounded lock acquisition timeout', () => {
  it('throws LockTimeoutError within maxWaitMs when lock is already held', async () => {
    const dir = await makeTempDir();
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Lock Test', slug: 'main' });

    let releaseHolder!: () => void;
    const holderAcquired = new Promise<void>((resolve) => {
      void core.withWorkspaceLock(
        store.runtimeDir,
        async () => {
          resolve();
          await new Promise<void>((r) => {
            releaseHolder = r;
          });
        },
        store.deckDir,
      );
    });

    await holderAcquired;
    const started = Date.now();
    try {
      await expect(
        core.withWorkspaceLock(
          store.runtimeDir,
          async () => 'never',
          store.deckDir,
          { maxWaitMs: 250 },
        ),
      ).rejects.toThrow(core.LockTimeoutError);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(1200);
    } finally {
      releaseHolder();
    }
  });

  it('R2-2: commitHookDelivery serializes concurrent acks preserving higher revisions, other boards, and lastCursorInjectAt, and skips on lock timeout', async () => {
    const dir = await makeTempDir('cdeck-r2-2-');
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Main', slug: 'main' });
    await store.createBoard({ title: 'Web', slug: 'web' });
    const sess = await store.registerSession('main', {
      title: 'Concurrent Hook Session',
      harness: 'cursor',
    });

    const origWrite = store.writeSessionCursor.bind(store);
    let pauseFirstWrite = true;
    let signalFirstPaused!: () => void;
    const firstPaused = new Promise<void>((resolve) => {
      signalFirstPaused = resolve;
    });
    let releaseFirstWrite!: () => void;
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });

    const writeSpy = vi
      .spyOn(store, 'writeSessionCursor')
      .mockImplementation(async (cursor) => {
        if (pauseFirstWrite && cursor.syncedRevisions.main === 2) {
          pauseFirstWrite = false;
          signalFirstPaused();
          await firstRelease;
        }
        return origWrite(cursor);
      });

    try {
      const p1 = store.commitHookDelivery(
        { sessionId: sess.id, boardSlug: 'main', revision: 2 },
        { maxWaitMs: 5_000 },
      );

      await firstPaused;

      // Launch newer updates on main (with throttle stamp) and web while p1 is paused between read and write
      const p2 = store.commitHookDelivery(
        {
          sessionId: sess.id,
          boardSlug: 'main',
          revision: 5,
          stampCursorThrottle: true,
          now: '2026-11-26T10:00:00.000Z',
        },
        { maxWaitMs: 5_000 },
      );
      const p3 = store.commitHookDelivery(
        {
          sessionId: sess.id,
          boardSlug: 'web',
          revision: 3,
          now: '2026-11-26T10:01:00.000Z',
        },
        { maxWaitMs: 5_000 },
      );

      // Give p2/p3 time to complete if unlocked (RED); when locked (GREEN) they block on workspace lock
      await new Promise((r) => setTimeout(r, 150));
      releaseFirstWrite();
      await Promise.all([p1, p2, p3]);
    } finally {
      writeSpy.mockRestore();
    }

    const finalCursor = await store.readSessionCursor(sess.id);
    expect(finalCursor?.syncedRevisions).toEqual({ main: 5, web: 3 });
    expect(finalCursor?.lastCursorInjectAt).toBe('2026-11-26T10:00:00.000Z');

    // A stale delayed ack arriving afterward must also keep main:5, web:3, and newer lastCursorInjectAt
    await store.commitHookDelivery({
      sessionId: sess.id,
      boardSlug: 'main',
      revision: 2,
      stampCursorThrottle: true,
      now: '2026-11-26T09:00:00.000Z',
    });
    const afterStale = await store.readSessionCursor(sess.id);
    expect(afterStale?.syncedRevisions).toEqual({ main: 5, web: 3 });
    expect(afterStale?.lastCursorInjectAt).toBe('2026-11-26T10:00:00.000Z');

    // When workspace lock is held past maxWaitMs, commitHookDelivery skips ack cleanly (returns null, no throw)
    let releaseLock!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      void core.withWorkspaceLock(
        store.runtimeDir,
        async () => {
          resolve();
          await new Promise<void>((r) => {
            releaseLock = r;
          });
        },
        store.deckDir,
      );
    });
    await lockHeld;
    try {
      const skipped = await store.commitHookDelivery(
        { sessionId: sess.id, boardSlug: 'main', revision: 9 },
        { maxWaitMs: 120 },
      );
      expect(skipped).toBeNull();
      const afterSkipped = await store.readSessionCursor(sess.id);
      expect(afterSkipped?.syncedRevisions.main).toBe(5);
    } finally {
      releaseLock();
    }
  });

  it('R3-2: registerSession resolves both id and externalRef under lock, rejects conflicting reassignments without clobbering, and attaches ref to ref-less session preserving metadata', async () => {
    const dir = await makeTempDir('cdeck-r3-2-');
    const store = new core.ContextDeckStore(dir);
    await store.createBoard({ title: 'Main', slug: 'main', setAsDefault: true });
    await store.createBoard({ title: 'Frontend', slug: 'frontend' });

    // (1) Codex 1 exact repro: existing session with externalRef + metadata
    const existing = await store.registerSession('main', {
      id: 'sess_existing',
      externalRef: 'codex:old',
      title: 'Original Session',
      harness: 'codex',
      parentSessionId: 'sess_parent',
      relatedSessionIds: ['sess_rel_1'],
      summary: 'Important existing notes',
      focusFiles: ['packages/core/src/store.ts'],
    });
    const existingPath = path.join(store.sessionsDir, 'sess_existing.yaml');
    const existingRawBefore = await fs.readFile(existingPath, 'utf8');

    await expect(
      store.registerSession('main', {
        id: 'sess_existing',
        externalRef: 'codex:new',
        title: 'New',
      }),
    ).rejects.toThrow(core.ValidationError);

    expect(await fs.readFile(existingPath, 'utf8')).toBe(existingRawBefore);
    const reloadedExisting = await store.getSession('sess_existing');
    expect(reloadedExisting?.externalRef).toBe('codex:old');
    expect(reloadedExisting?.summary).toBe('Important existing notes');
    expect(reloadedExisting?.parentSessionId).toBe('sess_parent');
    expect(reloadedExisting?.focusFiles).toEqual(['packages/core/src/store.ts']);
    expect(reloadedExisting?.createdAt).toBe(existing.createdAt);

    // (2) id of session A + externalRef owned by session B rejects and leaves both files untouched
    await store.registerSession('main', {
      id: 'sess_other',
      externalRef: 'codex:other',
      title: 'Other Session',
      harness: 'codex',
      summary: 'Other summary',
    });
    const otherPath = path.join(store.sessionsDir, 'sess_other.yaml');
    const otherRawBefore = await fs.readFile(otherPath, 'utf8');

    await expect(
      store.registerSession('main', {
        id: 'sess_existing',
        externalRef: 'codex:other',
        title: 'Cross Identity',
      }),
    ).rejects.toThrow(core.ValidationError);
    expect(await fs.readFile(existingPath, 'utf8')).toBe(existingRawBefore);
    expect(await fs.readFile(otherPath, 'utf8')).toBe(otherRawBefore);

    // Also reject explicit non-existent id paired with externalRef already owned by another session
    await expect(
      store.registerSession('main', {
        id: 'sess_unregistered',
        externalRef: 'codex:other',
        title: 'Mismatch New Id',
      }),
    ).rejects.toThrow(core.ValidationError);
    expect(await fs.readFile(otherPath, 'utf8')).toBe(otherRawBefore);
    await expect(fs.stat(path.join(store.sessionsDir, 'sess_unregistered.yaml'))).rejects.toThrow();

    // (3) id of existing session with NO externalRef + new ref attaches the ref, keeps bound board when omitted, and preserves metadata
    const noRef = await store.registerSession('frontend', {
      id: 'sess_no_ref',
      title: 'Initial No-Ref Session',
      harness: 'cursor',
      parentSessionId: 'sess_parent',
      relatedSessionIds: ['sess_rel_2'],
      summary: 'Preserved summary',
      focusFiles: ['packages/web/src/App.tsx'],
    });
    expect(noRef.externalRef).toBeUndefined();

    const attached = await store.registerSession(undefined, {
      id: 'sess_no_ref',
      externalRef: 'cursor:attached-1',
      title: 'Attached Ref Session',
    });
    expect(attached.id).toBe('sess_no_ref');
    expect(attached.board).toBe('frontend');
    expect(attached.externalRef).toBe('cursor:attached-1');
    expect(attached.title).toBe('Attached Ref Session');
    expect(attached.harness).toBe('cursor');
    expect(attached.parentSessionId).toBe('sess_parent');
    expect(attached.relatedSessionIds).toEqual(['sess_rel_2']);
    expect(attached.summary).toBe('Preserved summary');
    expect(attached.focusFiles).toEqual(['packages/web/src/App.tsx']);
    expect(attached.createdAt).toBe(noRef.createdAt);
  });
});
