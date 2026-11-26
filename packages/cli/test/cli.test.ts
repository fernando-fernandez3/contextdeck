import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer } from '@contextdeck/server';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI_BIN = path.resolve(here, '../dist/index.js');
const tmpDirs: string[] = [];

async function makeTempDir(prefix = 'cdeck-cli-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function runCli(
  args: string[],
  options: { cwd: string; env?: Record<string, string | undefined> },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
    delete cleanEnv.CONTEXTDECK_DIR;
    delete cleanEnv.CLAUDE_PROJECT_DIR;
    delete cleanEnv.CONTEXTDECK_HOME;
    if (options.env) {
      for (const [k, v] of Object.entries(options.env)) {
        if (v === undefined) delete cleanEnv[k];
        else cleanEnv[k] = v;
      }
    }
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd: options.cwd,
      env: cleanEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
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
    await fs.rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('@contextdeck/cli B1 commands', () => {
  it('cdeck init writes .gitignore entries and supports linked git worktrees (Bug 6 CLI)', async () => {
    const base = await makeTempDir();
    const repo = path.join(base, 'repo');
    const wt = path.join(base, 'repo-wt');
    await fs.mkdir(repo, { recursive: true });
    await git(repo, 'init', '-b', 'main');

    const initRes = await runCli(['init', '--title', 'Repo Context', '--slug', 'main'], { cwd: repo });
    expect(initRes.code).toBe(0);

    const gi = await fs.readFile(path.join(repo, '.gitignore'), 'utf8');
    expect(gi).toContain('.contextdeck/.runtime/');
    expect(gi).toContain('.contextdeck/.lock');

    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'init');
    await git(repo, 'worktree', 'add', '-b', 'feat', wt);

    const addFromWt = await runCli(['decision', 'add', 'CLI worktree decision'], { cwd: wt });
    expect(addFromWt.code).toBe(0);

    const briefFromMain = await runCli(['brief', '--pack'], { cwd: repo });
    expect(briefFromMain.code).toBe(0);
    expect(briefFromMain.stdout).toContain('CLI worktree decision');
  });

  it('cdeck init --global creates pointer without absolute paths and rejects traversal names', async () => {
    const base = await makeTempDir();
    const fakeHome = path.join(base, 'home');
    const repo = path.join(base, 'repo');
    await fs.mkdir(repo, { recursive: true });

    const bad = await runCli(['init', '--global', '../escape'], {
      cwd: repo,
      env: { CONTEXTDECK_HOME: fakeHome },
    });
    expect(bad.code).not.toBe(0);

    const ok = await runCli(['init', '--global', 'my-global-ws', '--slug', 'main'], {
      cwd: repo,
      env: { CONTEXTDECK_HOME: fakeHome },
    });
    expect(ok.code).toBe(0);

    const pointer = await fs.readFile(path.join(repo, '.contextdeck.yaml'), 'utf8');
    expect(pointer).toContain('workspace: my-global-ws');
    expect(pointer).not.toContain(base);

    const addRes = await runCli(['decision', 'add', 'Global CLI decision'], {
      cwd: repo,
      env: { CONTEXTDECK_HOME: fakeHome },
    });
    expect(addRes.code).toBe(0);

    const statusRes = await runCli(['status'], {
      cwd: repo,
      env: { CONTEXTDECK_HOME: fakeHome },
    });
    expect(statusRes.code).toBe(0);
    expect(statusRes.stdout).toContain('Decisions: 1');
  });

  it('cdeck mcp refuses to auto-init an uninitialized directory', async () => {
    const empty = await makeTempDir();
    const res = await runCli(['mcp'], { cwd: empty });
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/cdeck init/i);
    await expect(fs.stat(path.join(empty, '.contextdeck'))).rejects.toThrow();
  });

  it('cdeck brief supports --set with --base-revision conflict detection and cdeck media add accepts arbitrary readable file', async () => {
    const base = await makeTempDir();
    const repo = path.join(base, 'repo');
    const outside = await makeTempDir('cdeck-media-');
    await fs.mkdir(repo, { recursive: true });
    const outsideFile = path.join(outside, 'notes.txt');
    await fs.writeFile(outsideFile, 'Human media file', 'utf8');

    expect((await runCli(['init'], { cwd: repo })).code).toBe(0);

    const upd1 = await runCli(['brief', '--set', '# V2 Brief\n', '--base-revision', '1'], {
      cwd: repo,
    });
    expect(upd1.code).toBe(0);

    const stale = await runCli(['brief', '--set', '# Stale\n', '--base-revision', '1'], {
      cwd: repo,
    });
    expect(stale.code).not.toBe(0);
    expect(stale.stderr).toMatch(/conflict/i);

    const mediaRes = await runCli(
      ['media', 'add', 'Outside Human Note', '--type', 'doc', '--file', outsideFile],
      { cwd: repo },
    );
    expect(mediaRes.code).toBe(0);
    expect(mediaRes.stdout).toContain('Outside Human Note');
  });

  it('cdeck serve guards non-loopback host and cdeck open mints a working single-use launch URL', async () => {
    const repo = await makeTempDir();
    expect((await runCli(['init'], { cwd: repo })).code).toBe(0);

    // Non-loopback without --allow-remote must fail
    const badServe = await runCli(['serve', '--host', '0.0.0.0', '--port', '4414'], { cwd: repo });
    expect(badServe.code).not.toBe(0);
    expect(badServe.stderr).toMatch(/allow-remote/i);

    // Start server and verify `cdeck open` returns a working launch URL
    const srv = await startServer({
      deckDir: path.join(repo, '.contextdeck'),
      projectRoot: repo,
      host: '127.0.0.1',
      port: 4415,
    });

    try {
      const openRes = await runCli(['open', '--port', '4415'], { cwd: repo });
      expect(openRes.code).toBe(0);
      const launchUrl = openRes.stdout.trim();
      expect(launchUrl).toMatch(/^http:\/\/127\.0\.0\.1:4415\/auth\?code=[a-f0-9]+$/);

      const exchange = await fetch(launchUrl, { redirect: 'manual' });
      expect(exchange.status).toBe(302);
      expect(exchange.headers.get('set-cookie')).toContain('cdeck_sess_4415=');
    } finally {
      await srv.close();
    }
  });
});
