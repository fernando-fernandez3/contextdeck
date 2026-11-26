import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
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
});
