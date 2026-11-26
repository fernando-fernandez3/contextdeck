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
  });

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
  });

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
});
