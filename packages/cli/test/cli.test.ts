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

  it('H6: CLI rejects non-integer --base-revision and --ack-revision flags without corrupting state', async () => {
    const repo = await makeTempDir('cdeck-cli-h6-');
    expect((await runCli(['init'], { cwd: repo })).code).toBe(0);
    expect(
      (await runCli(['brief', '--set', '# Keep This Brief\n', '--base-revision', '1'], { cwd: repo })).code,
    ).toBe(0);

    const badBrief = await runCli(['brief', '--set', '# Clobbered\n', '--base-revision', 'abc'], {
      cwd: repo,
    });
    expect(badBrief.code).not.toBe(0);
    expect(badBrief.stderr).toMatch(/base-revision|integer/i);

    const briefAfter = await runCli(['brief'], { cwd: repo });
    expect(briefAfter.code).toBe(0);
    expect(briefAfter.stdout).toContain('# Keep This Brief');

    const reg = await runCli(['session', 'register', 'S1', '--harness', 'codex'], { cwd: repo });
    expect(reg.code).toBe(0);
    const sess = JSON.parse(reg.stdout) as { id: string };

    const badSync = await runCli(['session', 'sync', sess.id, '--ack-revision', 'abc'], {
      cwd: repo,
    });
    expect(badSync.code).not.toBe(0);
    expect(badSync.stderr).toMatch(/ack-revision|integer/i);

    // Status (getSnapshot) must still succeed (no .nan written to session YAML)
    const statusAfter = await runCli(['status'], { cwd: repo });
    expect(statusAfter.code).toBe(0);
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

  it('AC5.8: cdeck mcp stdio resolves workspace via cwd (no --dir), advertises resources.subscribe, and sends notifications/resources/updated on board changes', async () => {
    const repo = await makeTempDir('cdeck-mcp-stdio-');
    expect((await runCli(['init', '--title', 'Stdio MCP', '--slug', 'main'], { cwd: repo })).code).toBe(
      0,
    );

    const child = spawn(process.execPath, [CLI_BIN, 'mcp'], {
      cwd: repo,
      env: { ...process.env, CONTEXTDECK_DIR: undefined, CLAUDE_PROJECT_DIR: undefined },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const messages: Array<Record<string, unknown>> = [];
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) {
          try {
            messages.push(JSON.parse(line) as Record<string, unknown>);
          } catch {
            // ignore non-JSON
          }
        }
      }
    });

    const waitForMsg = async (
      pred: (m: Record<string, unknown>) => boolean,
      timeoutMs = 3000,
    ): Promise<Record<string, unknown>> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = messages.find(pred);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 30));
      }
      throw new Error(`Timed out waiting for MCP message. Saw: ${JSON.stringify(messages)}`);
    };

    try {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'cli-test', version: '0.1.0' },
          },
        })}\n`,
      );
      const initResp = await waitForMsg((m) => m.id === 1);
      const result = initResp.result as { capabilities?: { resources?: { subscribe?: boolean } } };
      expect(result.capabilities?.resources?.subscribe).toBe(true);

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'resources/subscribe',
          params: { uri: 'contextdeck://brief' },
        })}\n`,
      );
      await waitForMsg((m) => m.id === 2);

      // Give watcher a moment to be ready, then mutate via a separate CLI process
      await new Promise((r) => setTimeout(r, 250));
      expect((await runCli(['decision', 'add', 'Stdio Watch Decision'], { cwd: repo })).code).toBe(0);

      const notif = await waitForMsg(
        (m) =>
          m.method === 'notifications/resources/updated' &&
          (m.params as { uri?: string } | undefined)?.uri === 'contextdeck://brief',
        3000,
      );
      expect(notif).toBeDefined();

      // H4: Closing stdin (EOF) must cleanly shut down watcher + server and exit without child.kill
      const exitResult = await new Promise<{ exited: boolean; code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          const timer = setTimeout(() => {
            resolve({ exited: false, code: null, signal: null });
          }, 2500);
          child.once('exit', (code, signal) => {
            clearTimeout(timer);
            resolve({ exited: true, code, signal });
          });
          child.stdin.end();
        },
      );
      expect(exitResult.exited).toBe(true);
      expect(exitResult.code).toBe(0);
    } finally {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
  });

  it('H5: cdeck board use <slug> switches default board in --global workspace mode (AC6.4)', async () => {
    const base = await makeTempDir('cdeck-h5-global-');
    const fakeHome = path.join(base, 'home');
    const repo = path.join(base, 'repo');
    await fs.mkdir(repo, { recursive: true });
    const env = { CONTEXTDECK_HOME: fakeHome };

    expect((await runCli(['init', '--global', 'myws', '--slug', 'main'], { cwd: repo, env })).code).toBe(0);
    expect((await runCli(['board', 'create', 'Web', '--slug', 'web'], { cwd: repo, env })).code).toBe(0);
    expect((await runCli(['board', 'use', 'web'], { cwd: repo, env })).code).toBe(0);

    const listRes = await runCli(['board', 'list'], { cwd: repo, env });
    expect(listRes.code).toBe(0);
    expect(listRes.stdout).toMatch(/^\*\s+web\b/m);
    expect(listRes.stdout).not.toMatch(/^\*\s+main\b/m);

    const decRes = await runCli(['decision', 'add', 'Should go to web'], { cwd: repo, env });
    expect(decRes.code).toBe(0);

    const webStatus = await runCli(['status', '--board', 'web'], { cwd: repo, env });
    expect(webStatus.code).toBe(0);
    expect(webStatus.stdout).toContain('Decisions: 1');

    const mainStatus = await runCli(['status', '--board', 'main'], { cwd: repo, env });
    expect(mainStatus.code).toBe(0);
    expect(mainStatus.stdout).toContain('Decisions: 0');
  });
});
