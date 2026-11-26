import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import * as core from '../src/index.js';

const execFileAsync = promisify(execFile);
const tmpDirs: string[] = [];

async function makeTempDir(prefix = 'cdeck-ws-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test User',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test User',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
  return stdout.trim();
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('E4 workspace resolution, worktrees, global pointer, and watcher', () => {
  it('reproduces Bug 6: linked git worktree shares context with main checkout in in-repo mode (including when .contextdeck is committed)', async () => {
    const base = await makeTempDir();
    const mainRepo = path.join(base, 'main-repo');
    const linkedWt = path.join(base, 'linked-wt');
    await fs.mkdir(mainRepo, { recursive: true });

    await git(mainRepo, 'init', '-b', 'main');
    await fs.writeFile(path.join(mainRepo, 'README.md'), '# Repo\n', 'utf8');

    // Initialize .contextdeck in main repo and commit it (worst-case for worktree forking!)
    const mainStore = new core.ContextDeckStore({
      deckDir: path.join(mainRepo, '.contextdeck'),
      projectRoot: mainRepo,
    });
    await mainStore.createBoard({ title: 'Main Board', slug: 'main', setAsDefault: true });
    await mainStore.recordDecision('main', { title: 'Main checkout decision' });

    await git(mainRepo, 'add', '.');
    await git(mainRepo, 'commit', '-m', 'init');
    await git(mainRepo, 'worktree', 'add', '-b', 'feat-wt', linkedWt);

    // Resolve from inside a subdirectory of the linked worktree
    const subDir = path.join(linkedWt, 'nested', 'dir');
    await fs.mkdir(subDir, { recursive: true });

    const resolvedFromWt = core.resolveWorkspace({ cwd: subDir, env: {} });
    const resolvedFromMain = core.resolveWorkspace({ cwd: mainRepo, env: {} });

    expect(await fs.realpath(resolvedFromWt.deckDir)).toBe(await fs.realpath(resolvedFromMain.deckDir));

    // Write a decision from the linked worktree; verify main checkout sees it
    const wtStore = new core.ContextDeckStore(resolvedFromWt);
    await wtStore.recordDecision('main', { title: 'Worktree decision' });

    const mainSnap = await new core.ContextDeckStore(resolvedFromMain).getSnapshot('main');
    expect(mainSnap.decisions.map((d) => d.title)).toContain('Worktree decision');

    // Write from main checkout; verify linked worktree sees it
    await new core.ContextDeckStore(resolvedFromMain).recordDecision('main', {
      title: 'Second main decision',
    });
    const wtSnap = await wtStore.getSnapshot('main');
    expect(wtSnap.decisions.map((d) => d.title)).toContain('Second main decision');
  }, 20_000);

  it('supports .contextdeck.yaml global pointer across main checkout and linked git worktree', async () => {
    const base = await makeTempDir();
    const fakeHome = path.join(base, 'cdeck-home');
    const mainRepo = path.join(base, 'repo');
    const linkedWt = path.join(base, 'repo-wt');
    await fs.mkdir(mainRepo, { recursive: true });

    await git(mainRepo, 'init', '-b', 'main');
    await core.initGlobalWorkspacePointer({
      projectRoot: mainRepo,
      workspaceName: 'shared-proj',
      boardSlug: 'core-board',
      env: { CONTEXTDECK_HOME: fakeHome },
    });

    const pointerRaw = await fs.readFile(path.join(mainRepo, '.contextdeck.yaml'), 'utf8');
    // C3: no absolute paths in committable pointer file
    expect(pointerRaw).not.toContain(base);
    expect(pointerRaw).toContain('workspace: shared-proj');

    const resolvedMain = core.resolveWorkspace({
      cwd: mainRepo,
      env: { CONTEXTDECK_HOME: fakeHome },
    });
    expect(resolvedMain.mode).toBe('global');
    expect(resolvedMain.defaultBoard).toBe('core-board');
    expect(resolvedMain.deckDir).toBe(path.join(await fs.realpath(fakeHome), 'workspaces', 'shared-proj'));

    const mainStore = new core.ContextDeckStore(resolvedMain);
    await mainStore.createBoard({ title: 'Core', slug: 'core-board', setAsDefault: true });

    await git(mainRepo, 'add', '.');
    await git(mainRepo, 'commit', '-m', 'add pointer');
    await git(mainRepo, 'worktree', 'add', '-b', 'wt-global', linkedWt);

    const resolvedWt = core.resolveWorkspace({
      cwd: linkedWt,
      env: { CONTEXTDECK_HOME: fakeHome },
    });
    expect(resolvedWt.deckDir).toBe(resolvedMain.deckDir);

    const wtStore = new core.ContextDeckStore(resolvedWt);
    await wtStore.recordDecision('core-board', { title: 'Global worktree decision' });

    const mainSnap = await mainStore.getSnapshot('core-board');
    expect(mainSnap.decisions.map((d) => d.title)).toContain('Global worktree decision');
  }, 20_000);

  it('enforces resolver precedence: --dir > CONTEXTDECK_DIR > CLAUDE_PROJECT_DIR > ancestor lookup > error', async () => {
    const base = await makeTempDir();
    const dirA = path.join(base, 'a');
    const dirB = path.join(base, 'b');
    const dirC = path.join(base, 'c');
    const emptyDir = path.join(base, 'empty');
    for (const d of [dirA, dirB, dirC]) {
      const s = new core.ContextDeckStore({ deckDir: path.join(d, '.contextdeck'), projectRoot: d });
      await s.createBoard({ title: path.basename(d), slug: 'main' });
    }
    await fs.mkdir(emptyDir, { recursive: true });

    const r1 = core.resolveWorkspace({
      dir: dirA,
      cwd: emptyDir,
      env: { CONTEXTDECK_DIR: dirB, CLAUDE_PROJECT_DIR: dirC },
    });
    expect(r1.deckDir).toBe(path.join(dirA, '.contextdeck'));

    const r2 = core.resolveWorkspace({
      cwd: emptyDir,
      env: { CONTEXTDECK_DIR: dirB, CLAUDE_PROJECT_DIR: dirC },
    });
    expect(r2.deckDir).toBe(path.join(dirB, '.contextdeck'));

    const r3 = core.resolveWorkspace({
      cwd: emptyDir,
      env: { CLAUDE_PROJECT_DIR: dirC },
    });
    expect(r3.deckDir).toBe(path.join(dirC, '.contextdeck'));

    expect(() => core.resolveWorkspace({ cwd: emptyDir, env: {} })).toThrow(/cdeck init/i);
  });

  it('rejects invalid global workspace names and traversal in .contextdeck.yaml', async () => {
    const base = await makeTempDir();
    const repo = path.join(base, 'bad-pointer');
    await fs.mkdir(repo, { recursive: true });
    await fs.writeFile(path.join(repo, '.contextdeck.yaml'), 'workspace: ../escape\n', 'utf8');

    expect(() => core.resolveWorkspace({ cwd: repo, env: { CONTEXTDECK_HOME: base } })).toThrow();

    await expect(
      core.initGlobalWorkspacePointer({
        projectRoot: repo,
        workspaceName: '../evil',
        env: { CONTEXTDECK_HOME: base },
      }),
    ).rejects.toThrow();
  });

  it('updates .gitignore idempotently with .contextdeck/.runtime/ and .contextdeck/.lock', async () => {
    const base = await makeTempDir();
    const giPath = path.join(base, '.gitignore');
    await fs.writeFile(giPath, 'node_modules/\n', 'utf8');

    await core.ensureContextDeckGitignore(base);
    await core.ensureContextDeckGitignore(base);

    const content = await fs.readFile(giPath, 'utf8');
    expect(content).toContain('node_modules/');
    expect(content).toContain('.contextdeck/.runtime/');
    expect(content).toContain('.contextdeck/.lock');
    expect(content.match(/\.contextdeck\/\.runtime\//g)?.length).toBe(1);
    expect(content.match(/\.contextdeck\/\.lock/g)?.length).toBe(1);
  });

  it('validates slugs (lowercase) and ids before path resolution and rejects symlink escapes', async () => {
    const base = await makeTempDir();
    const outside = await makeTempDir('cdeck-outside-');
    await fs.writeFile(path.join(outside, 'secret.txt'), 'TOP_SECRET', 'utf8');

    const store = new core.ContextDeckStore({
      deckDir: path.join(base, '.contextdeck'),
      projectRoot: base,
    });
    await store.createBoard({ title: 'Main', slug: 'main' });

    // Reject uppercase or traversal slugs (no silent slugify)
    await expect(store.getSnapshot('Main')).rejects.toThrow();
    await expect(store.getSnapshot('../escape')).rejects.toThrow();
    await expect(store.deleteSession('main', '../board')).rejects.toThrow();

    // Symlink inside media dir pointing outside must be rejected
    const mediaDir = path.join(base, '.contextdeck', 'boards', 'main', 'media');
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(mediaDir, 'art_sym.txt'));
    await fs.writeFile(
      path.join(mediaDir, 'art_sym.meta.yaml'),
      `id: art_sym\ntitle: Symlink\nkind: doc\nfilePath: art_sym.txt\ncreatedAt: "2026-01-01T00:00:00.000Z"\nupdatedAt: "2026-01-01T00:00:00.000Z"\n`,
      'utf8',
    );
    await expect(store.resolveMediaFilePath('main', 'art_sym')).rejects.toThrow();
  });

  it('H4: rejects dangling symlinks escaping allowed directory (async and sync)', async () => {
    const base = await makeTempDir('cdeck-h4-');
    const outside = await makeTempDir('cdeck-h4-outside-');
    const pwnedPath = path.join(outside, 'pwned.jsonl');

    const store = new core.ContextDeckStore({
      deckDir: path.join(base, '.contextdeck'),
      projectRoot: base,
    });
    await store.createBoard({ title: 'Main', slug: 'main' });

    const eventsPath = path.join(store.boardPath('main'), 'events.jsonl');
    await fs.rm(eventsPath, { force: true });
    await fs.symlink(pwnedPath, eventsPath);

    // Direct containment checks (async and sync) must throw SecurityError
    await expect(
      core.assertContainedPath(store.boardPath('main'), eventsPath),
    ).rejects.toBeInstanceOf(core.SecurityError);
    expect(() =>
      core.assertContainedPathSync(store.boardPath('main'), eventsPath),
    ).toThrow(core.SecurityError);

    // Mutation must NOT follow the dangling symlink or create the outside file
    await expect(store.upsertTask('main', { title: 'Should fail' })).rejects.toBeInstanceOf(
      core.SecurityError,
    );
    await expect(fs.stat(pwnedPath)).rejects.toThrow();
  });

  it('R3-1: supports full workflow and resolveWorkspace through a symlinked workspace root and cleans up failed createBoard', async () => {
    const base = await makeTempDir('cdeck-r3-1-');
    const realWs = path.join(base, 'real-ws');
    const symWs = path.join(base, 'sym-ws');
    await fs.mkdir(realWs, { recursive: true });
    await fs.symlink(realWs, symWs);

    const store = new core.ContextDeckStore(symWs);
    await store.createBoard({ title: 'Main', slug: 'main', setAsDefault: true });
    const task = await store.upsertTask('main', { title: 'Task via symlink' });
    const dec = await store.recordDecision('main', { title: 'Decision via symlink', summary: 'Works' });
    const media = await store.addMedia('main', {
      title: 'Doc via symlink',
      kind: 'doc',
      content: 'hello via symlink',
    });
    const snap = await store.getSnapshot('main');

    expect(snap.config.slug).toBe('main');
    expect(snap.tasks.some((t) => t.id === task.id)).toBe(true);
    expect(snap.decisions.some((d) => d.id === dec.id)).toBe(true);
    expect(snap.media.some((m) => m.id === media.id)).toBe(true);

    // resolveWorkspace from symlinked root must resolve cleanly and work with ContextDeckStore
    const resolved = core.resolveWorkspace({ cwd: symWs, env: {} });
    const resolvedStore = new core.ContextDeckStore(resolved);
    const snap2 = await resolvedStore.getSnapshot('main');
    expect(snap2.config.revision).toBe(snap.config.revision);

    // Pre-existing staged upload cleanup on error must not leak .tmp-upload-* on symlinked workspace
    const { tmpPath } = await store.createUploadTempFilePath('main');
    await fs.writeFile(tmpPath, 'temp-bytes', 'utf8');
    await expect(
      store.addMedia('main', {
        title: 'Bad URL',
        kind: 'video',
        stagedTempPath: tmpPath,
        externalUrl: 'javascript:alert(1)',
      }),
    ).rejects.toThrow();
    await expect(fs.stat(tmpPath)).rejects.toThrow();

    // Failed createBoard before txn.json commit must not leave empty boards/<slug>/ behind
    const origOpen = fs.open.bind(fs);
    let failNextTmp = true;
    const openSpy = (await import('vitest')).vi
      .spyOn(fs, 'open')
      .mockImplementation(async (p, ...rest) => {
        if (failNextTmp && String(p).includes(`${path.sep}boards${path.sep}failed-board${path.sep}.tmp-`)) {
          failNextTmp = false;
          throw new Error('simulated disk error during createBoard staging');
        }
        return origOpen(p, ...rest);
      });
    try {
      await expect(
        store.createBoard({ title: 'Failed Board', slug: 'failed-board' }),
      ).rejects.toThrow(/simulated disk error/);
    } finally {
      openSpy.mockRestore();
    }
    await expect(fs.stat(path.join(store.boardsDir, 'failed-board'))).rejects.toThrow();
    // Retry must succeed without ConflictError
    const retried = await store.createBoard({ title: 'Failed Board', slug: 'failed-board' });
    expect(retried.slug).toBe('failed-board');
  }, 20_000);

  it('R3-2: rejects relative dangling symlink under a symlinked ancestor and rejects symlinked board dirs outside boards/', async () => {
    const root = await makeTempDir('cdeck-r3-2-');
    const deck = path.join(root, 'repo', '.contextdeck');
    const outDir = path.join(root, 'outside', 'dir');
    await fs.mkdir(path.join(deck, 'boards'), { recursive: true });
    await fs.mkdir(path.join(deck, '.runtime'), { recursive: true });
    await fs.mkdir(outDir, { recursive: true });
    await fs.symlink(outDir, path.join(deck, 'boards', 'evil'));
    await fs.symlink('../pwned.jsonl', path.join(outDir, 'events.jsonl'));

    const target = path.join(deck, 'boards', 'evil', 'events.jsonl');
    await expect(core.assertContainedPath(deck, target)).rejects.toBeInstanceOf(core.SecurityError);
    expect(() => core.assertContainedPathSync(deck, target)).toThrow(core.SecurityError);

    const store = new core.ContextDeckStore({ deckDir: deck, projectRoot: path.join(root, 'repo') });
    expect(() => store.boardPath('evil')).toThrow(core.SecurityError);

    const txnPath = path.join(deck, '.runtime', 'txn.json');
    await fs.writeFile(
      txnPath,
      JSON.stringify({
        id: 't_r3_2',
        boardSlug: 'evil',
        ops: [],
        events: [
          {
            eventsPath: 'boards/evil/events.jsonl',
            eventId: 'evt_1',
            line: '{"id":"evt_1"}\n',
          },
        ],
      }),
      'utf8',
    );

    await expect(
      core.recoverPendingTxn(path.join(deck, '.runtime'), undefined, deck),
    ).rejects.toBeInstanceOf(core.CorruptDataError);
    await expect(fs.stat(path.join(deck, 'boards', 'pwned.jsonl'))).rejects.toThrow();
    await expect(fs.stat(path.join(root, 'outside', 'pwned.jsonl'))).rejects.toThrow();
    await expect(fs.stat(txnPath)).resolves.toBeTruthy();
  });

  it('R5-4: rejects symlinked boards directory and cross-board board.yaml aliases', async () => {
    // 1. Symlinked .contextdeck/boards -> outsideBoardsDir
    const base = await makeTempDir('cdeck-r5-4-');
    const outsideRoot = path.join(base, 'outside-repo');
    const outsideStore = new core.ContextDeckStore(outsideRoot);
    await outsideStore.createBoard({ title: 'Outside Main', slug: 'main' });
    const outsideMedia = await outsideStore.addMedia('main', {
      title: 'Outside Secret',
      kind: 'doc',
      content: 'OUTSIDE_BOARD_SECRET',
    });
    const outsideTmp = path.join(outsideStore.boardPath('main'), 'media', '.tmp-upload-victim');
    await fs.writeFile(outsideTmp, 'DO_NOT_DELETE', 'utf8');

    const wsRoot = path.join(base, 'workspace');
    const deckDir = path.join(wsRoot, '.contextdeck');
    await fs.mkdir(deckDir, { recursive: true });
    await fs.symlink(outsideStore.boardsDir, path.join(deckDir, 'boards'));

    const store = new core.ContextDeckStore({ deckDir, projectRoot: wsRoot });
    expect(() => store.boardPath('main')).toThrow(core.SecurityError);
    await expect(store.listBoards()).rejects.toBeInstanceOf(core.SecurityError);
    await expect(store.getSnapshot('main')).rejects.toBeInstanceOf(core.SecurityError);
    await expect(store.resolveMediaFilePath('main', outsideMedia.id)).rejects.toBeInstanceOf(
      core.SecurityError,
    );

    // addMedia staged-temp cleanup must NOT delete files inside symlinked outside boards dir
    await expect(
      store.addMedia('main', {
        title: 'Bad URL',
        kind: 'doc',
        stagedTempPath: outsideTmp,
        externalUrl: 'javascript:alert(1)',
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(outsideTmp, 'utf8')).toBe('DO_NOT_DELETE');

    // 2. Cross-board board.yaml symlink alias (boards/alias/board.yaml -> ../other/board.yaml)
    const aliasRoot = await makeTempDir('cdeck-r5-4-alias-');
    const aliasStore = new core.ContextDeckStore(aliasRoot);
    await aliasStore.createBoard({ title: 'Other', slug: 'other' });
    const aliasDir = path.join(aliasStore.boardsDir, 'alias');
    await fs.mkdir(aliasDir, { recursive: true });
    await fs.symlink('../other/board.yaml', path.join(aliasDir, 'board.yaml'));

    await expect(aliasStore.listBoards()).rejects.toBeInstanceOf(core.SecurityError);
  });

  it('watcher ignores .runtime, .lock, and temp files and debounces per board', async () => {
    const base = await makeTempDir();
    const store = new core.ContextDeckStore({
      deckDir: path.join(base, '.contextdeck'),
      projectRoot: base,
    });
    await store.createBoard({ title: 'Board A', slug: 'board-a' });
    await store.createBoard({ title: 'Board B', slug: 'board-b' });

    const seen: Array<{ slug: string | null; filePath: string }> = [];
    const watcher = store.watch((slug, filePath) => {
      seen.push({ slug, filePath });
    });

    try {
      await new Promise((r) => setTimeout(r, 150));
      // Write ignored runtime/lock/tmp files
      await fs.mkdir(path.join(store.deckDir, '.runtime'), { recursive: true });
      await fs.writeFile(path.join(store.deckDir, '.runtime', 'token'), 'secret', 'utf8');
      await fs.writeFile(path.join(store.deckDir, '.lock'), '', 'utf8');
      await fs.writeFile(
        path.join(store.boardsDir, 'board-a', 'brief.md.tmp-123'),
        'tmp',
        'utf8',
      );

      // Write real changes to BOTH boards within the same debounce window
      await fs.writeFile(path.join(store.boardsDir, 'board-a', 'brief.md'), '# A updated\n', 'utf8');
      await fs.writeFile(path.join(store.boardsDir, 'board-b', 'brief.md'), '# B updated\n', 'utf8');

      await new Promise((r) => setTimeout(r, 450));

      const slugs = seen.map((e) => e.slug);
      expect(slugs).toContain('board-a');
      expect(slugs).toContain('board-b');
      expect(seen.some((e) => e.filePath.includes('.runtime'))).toBe(false);
      expect(seen.some((e) => e.filePath.includes('.lock'))).toBe(false);
      expect(seen.some((e) => e.filePath.includes('.tmp-'))).toBe(false);
    } finally {
      await watcher.close();
    }
  });

  it('R2-7: long-running global-mode store re-reads .contextdeck.yaml pointer dynamically after board use while explicit defaultBoard without pointerPath stays pinned', async () => {
    const base = await makeTempDir('cdeck-r2-7-');
    const fakeHome = path.join(base, 'home');
    const repo = path.join(base, 'repo');
    await fs.mkdir(repo, { recursive: true });
    const env = { CONTEXTDECK_HOME: fakeHome };

    await core.initGlobalWorkspacePointer({
      projectRoot: repo,
      workspaceName: 'r2-7-ws',
      boardSlug: 'main',
      env,
    });

    const resolved = core.resolveWorkspace({ cwd: repo, env });
    expect(resolved.mode).toBe('global');
    expect(resolved.pointerPath).toBeDefined();

    // Long-lived store simulating a running `cdeck mcp` or `cdeck serve`
    const longLivedStore = new core.ContextDeckStore(resolved);
    await longLivedStore.createBoard({ title: 'Main', slug: 'main', setAsDefault: true });
    await longLivedStore.createBoard({ title: 'Web', slug: 'web' });
    expect(await longLivedStore.getDefaultBoardSlug()).toBe('main');

    // Explicit pinned store (simulating explicit --board override with no pointerPath)
    const pinnedStore = new core.ContextDeckStore({
      deckDir: resolved.deckDir,
      projectRoot: resolved.projectRoot,
      defaultBoard: 'main',
    });

    // Separate process / store performs `cdeck board use web`
    const cliStore = new core.ContextDeckStore(core.resolveWorkspace({ cwd: repo, env }));
    await cliStore.setDefaultBoard('web');
    await core.updateGlobalWorkspacePointerBoard(resolved.pointerPath!, 'web');

    // Long-lived global-mode store MUST immediately observe 'web'
    expect(await longLivedStore.getDefaultBoardSlug()).toBe('web');
    // Explicit override without pointerPath stays pinned to 'main'
    expect(await pinnedStore.getDefaultBoardSlug()).toBe('main');
  });
});
