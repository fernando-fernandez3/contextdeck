import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { setupHarness } from '../src/setup.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI_BIN = path.resolve(here, '../dist/index.js');
const tmpDirs: string[] = [];

async function makeTempDir(prefix = 'cdeck-setup-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function runCli(
  args: string[],
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    await fs.rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('AC5.5-AC5.7 + C3/C4 + D13 cdeck setup and --uninstall', () => {
  it('regression: claude-code preserves pre-existing user SessionStart hook & mcpServers, writes zero absolute paths, is idempotent, and uninstalls cleanly', async () => {
    const repo = await makeTempDir();

    // Seed pre-existing user .mcp.json and .claude/settings.json
    const userMcp = {
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
        },
      },
    };
    const userSettings = {
      permissions: { allow: ['Bash(git status)'] },
      hooks: {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [{ type: 'command', command: './scripts/my-user-hook.sh' }],
          },
        ],
      },
    };
    await fs.writeFile(path.join(repo, '.mcp.json'), `${JSON.stringify(userMcp, null, 2)}\n`, 'utf8');
    await fs.mkdir(path.join(repo, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.claude', 'settings.json'),
      `${JSON.stringify(userSettings, null, 2)}\n`,
      'utf8',
    );

    // Install
    const res1 = await setupHarness(repo, 'claude-code');
    expect(res1.filesWritten).toHaveLength(2);

    const mcpRaw1 = await fs.readFile(path.join(repo, '.mcp.json'), 'utf8');
    const settingsRaw1 = await fs.readFile(path.join(repo, '.claude', 'settings.json'), 'utf8');

    // C3 regression: ZERO absolute paths or --dir flags in committed configs
    expect(mcpRaw1).not.toContain(repo);
    expect(mcpRaw1).not.toContain('--dir');
    expect(settingsRaw1).not.toContain(repo);
    expect(settingsRaw1).not.toContain('--dir');

    const mcp1 = JSON.parse(mcpRaw1) as { mcpServers: Record<string, unknown> };
    expect(mcp1.mcpServers.filesystem).toEqual(userMcp.mcpServers.filesystem);
    expect(mcp1.mcpServers.contextdeck).toEqual({ command: 'cdeck', args: ['mcp'] });

    const settings1 = JSON.parse(settingsRaw1) as {
      permissions: unknown;
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>>;
    };
    expect(settings1.permissions).toEqual(userSettings.permissions);
    // Regression: pre-existing user SessionStart hook SURVIVES!
    expect(settings1.hooks.SessionStart[0]).toEqual(userSettings.hooks.SessionStart[0]);
    expect(settings1.hooks.SessionStart[1]).toEqual({
      matcher: 'startup|resume|clear|compact',
      hooks: [{ type: 'command', command: 'cdeck hook claude-code SessionStart' }],
    });
    // D12: No matcher on UserPromptSubmit or SessionEnd
    expect(settings1.hooks.UserPromptSubmit).toEqual([
      { hooks: [{ type: 'command', command: 'cdeck hook claude-code UserPromptSubmit' }] },
    ]);
    expect(settings1.hooks.SessionEnd).toEqual([
      { hooks: [{ type: 'command', command: 'cdeck hook claude-code SessionEnd' }] },
    ]);

    // Idempotence: running twice produces byte-identical files
    await setupHarness(repo, 'claude-code');
    expect(await fs.readFile(path.join(repo, '.mcp.json'), 'utf8')).toBe(mcpRaw1);
    expect(await fs.readFile(path.join(repo, '.claude', 'settings.json'), 'utf8')).toBe(settingsRaw1);

    // Uninstall removes ONLY ContextDeck entries; user entries survive intact
    await setupHarness(repo, 'claude-code', { uninstall: true });
    expect(JSON.parse(await fs.readFile(path.join(repo, '.mcp.json'), 'utf8'))).toEqual(userMcp);
    expect(JSON.parse(await fs.readFile(path.join(repo, '.claude', 'settings.json'), 'utf8'))).toEqual(
      userSettings,
    );
  });

  it('codex merges .codex/hooks.json and .codex/config.toml (preserving TOML bytes), respects additionalContextLimit, and uninstalls cleanly', async () => {
    const repo = await makeTempDir();
    await fs.mkdir(path.join(repo, '.codex'), { recursive: true });

    const userToml = `# User custom Codex config\nmodel = "gpt-5"\n\n[features]\nshell_snapshot = true\n\n[mcp_servers.other]\ncommand = "npx"\nargs = ["-y", "other-mcp"]\n`;
    const userHooks = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: './scripts/check-bash.sh' }],
          },
        ],
      },
    };
    await fs.writeFile(path.join(repo, '.codex', 'config.toml'), userToml, 'utf8');
    await fs.writeFile(
      path.join(repo, '.codex', 'hooks.json'),
      `${JSON.stringify(userHooks, null, 2)}\n`,
      'utf8',
    );

    await setupHarness(repo, 'codex');

    const tomlAfter1 = await fs.readFile(path.join(repo, '.codex', 'config.toml'), 'utf8');
    const hooksRaw1 = await fs.readFile(path.join(repo, '.codex', 'hooks.json'), 'utf8');

    // No absolute paths
    expect(tomlAfter1).not.toContain(repo);
    expect(tomlAfter1).toContain('# contextdeck:start');
    expect(tomlAfter1).toContain('[mcp_servers.contextdeck]');
    expect(tomlAfter1).toContain('command = "cdeck"');
    expect(tomlAfter1).toContain('args = ["mcp"]');
    expect(tomlAfter1).toContain('# User custom Codex config');
    expect(hooksRaw1).not.toContain(repo);

    const hooksObj = JSON.parse(hooksRaw1) as {
      hooks: Record<
        string,
        Array<{
          matcher?: string;
          hooks: Array<{ type: string; command: string; additionalContextLimit?: number }>;
        }>
      >;
    };
    expect(hooksObj.hooks.PreToolUse).toEqual(userHooks.hooks.PreToolUse);
    expect(hooksObj.hooks.SessionStart[0].hooks[0].command).toBe('cdeck hook codex SessionStart');
    expect(hooksObj.hooks.SessionStart[0].hooks[0].additionalContextLimit).toBeGreaterThan(0);
    expect(hooksObj.hooks.UserPromptSubmit[0].matcher).toBeUndefined();
    expect(hooksObj.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
      'cdeck hook codex UserPromptSubmit',
    );
    expect(hooksObj.hooks.UserPromptSubmit[0].hooks[0].additionalContextLimit).toBeGreaterThan(0);
    // SessionEnd must NOT set additionalContextLimit (Codex warns on events without additionalContext)
    expect(hooksObj.hooks.SessionEnd[0].hooks[0].command).toBe('cdeck hook codex SessionEnd');
    expect(hooksObj.hooks.SessionEnd[0].hooks[0].additionalContextLimit).toBeUndefined();
    // N2: Codex SessionEnd sets timeout: 3 (Codex defaults SessionEnd to 1s)
    expect((hooksObj.hooks.SessionEnd[0].hooks[0] as { timeout?: number }).timeout).toBe(3);

    // Idempotent
    await setupHarness(repo, 'codex');
    expect(await fs.readFile(path.join(repo, '.codex', 'config.toml'), 'utf8')).toBe(tomlAfter1);
    expect(await fs.readFile(path.join(repo, '.codex', 'hooks.json'), 'utf8')).toBe(hooksRaw1);

    // Uninstall restores user TOML byte-for-byte and preserves user hooks
    await setupHarness(repo, 'codex', { uninstall: true });
    expect(await fs.readFile(path.join(repo, '.codex', 'config.toml'), 'utf8')).toBe(userToml);
    expect(JSON.parse(await fs.readFile(path.join(repo, '.codex', 'hooks.json'), 'utf8'))).toEqual(
      userHooks,
    );
  });

  it('cursor merges .cursor/mcp.json, .cursor/hooks.json (version 1), and .cursor/rules/contextdeck.mdc with D13 instructions', async () => {
    const repo = await makeTempDir();
    await fs.mkdir(path.join(repo, '.cursor'), { recursive: true });

    const userCursorHooks = {
      version: 1,
      hooks: {
        afterFileEdit: [{ command: './scripts/fmt.sh' }],
        postToolUse: [{ command: './scripts/audit.sh' }],
      },
    };
    const userCursorMcp = {
      mcpServers: {
        linear: { url: 'https://mcp.linear.app/mcp' },
      },
    };
    await fs.writeFile(
      path.join(repo, '.cursor', 'hooks.json'),
      `${JSON.stringify(userCursorHooks, null, 2)}\n`,
      'utf8',
    );
    await fs.writeFile(
      path.join(repo, '.cursor', 'mcp.json'),
      `${JSON.stringify(userCursorMcp, null, 2)}\n`,
      'utf8',
    );

    await setupHarness(repo, 'cursor');

    const mcpRaw = await fs.readFile(path.join(repo, '.cursor', 'mcp.json'), 'utf8');
    const hooksRaw = await fs.readFile(path.join(repo, '.cursor', 'hooks.json'), 'utf8');
    const ruleRaw = await fs.readFile(
      path.join(repo, '.cursor', 'rules', 'contextdeck.mdc'),
      'utf8',
    );

    expect(mcpRaw).not.toContain(repo);
    expect(hooksRaw).not.toContain(repo);
    expect(JSON.parse(mcpRaw).mcpServers.contextdeck).toEqual({ command: 'cdeck', args: ['mcp'] });
    expect(JSON.parse(mcpRaw).mcpServers.linear).toEqual(userCursorMcp.mcpServers.linear);

    const hooks = JSON.parse(hooksRaw) as {
      version: number;
      hooks: Record<string, Array<{ command: string }>>;
    };
    expect(hooks.version).toBe(1);
    expect(hooks.hooks.afterFileEdit).toEqual([{ command: './scripts/fmt.sh' }]);
    expect(hooks.hooks.sessionStart).toEqual([{ command: 'cdeck hook cursor sessionStart' }]);
    expect(hooks.hooks.postToolUse).toEqual([
      { command: './scripts/audit.sh' },
      { command: 'cdeck hook cursor postToolUse' },
    ]);
    expect(hooks.hooks.sessionEnd).toEqual([{ command: 'cdeck hook cursor sessionEnd' }]);

    // D13 rule text instructs reusing injected sessionId and not calling session_register
    expect(ruleRaw).toContain('alwaysApply: true');
    expect(ruleRaw).toMatch(/do not call `session_register`/i);

    // Idempotent
    await setupHarness(repo, 'cursor');
    expect(await fs.readFile(path.join(repo, '.cursor', 'hooks.json'), 'utf8')).toBe(hooksRaw);

    // Uninstall preserves user entries and removes contextdeck.mdc
    await setupHarness(repo, 'cursor', { uninstall: true });
    expect(JSON.parse(await fs.readFile(path.join(repo, '.cursor', 'mcp.json'), 'utf8'))).toEqual(
      userCursorMcp,
    );
    expect(JSON.parse(await fs.readFile(path.join(repo, '.cursor', 'hooks.json'), 'utf8'))).toEqual(
      userCursorHooks,
    );
    await expect(
      fs.stat(path.join(repo, '.cursor', 'rules', 'contextdeck.mdc')),
    ).rejects.toThrow();
  });

  it('grok merges .grok/config.toml (byte-preserving) and AGENTS.md, and prints equivalent grok mcp add command', async () => {
    const repo = await makeTempDir();
    await fs.mkdir(path.join(repo, '.grok'), { recursive: true });
    const userGrokToml = `# Repo Grok servers\n[mcp_servers.docs]\ncommand = "npx"\nargs = ["-y", "docs-mcp"]\n`;
    const userAgents = `# Project Rules\n\nAlways write unit tests.\n`;
    await fs.writeFile(path.join(repo, '.grok', 'config.toml'), userGrokToml, 'utf8');
    await fs.writeFile(path.join(repo, 'AGENTS.md'), userAgents, 'utf8');

    const res = await setupHarness(repo, 'grok');
    expect(res.notes.join('\n')).toContain(
      'grok mcp add --scope project contextdeck -- cdeck mcp',
    );

    const grokAfter = await fs.readFile(path.join(repo, '.grok', 'config.toml'), 'utf8');
    const agentsAfter = await fs.readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    expect(grokAfter).not.toContain(repo);
    expect(grokAfter).toContain('[mcp_servers.contextdeck]');
    expect(agentsAfter).toContain('<!-- contextdeck:start -->');
    expect(agentsAfter).toMatch(/do not call `session_register`/i);

    // Idempotent
    await setupHarness(repo, 'grok');
    expect(await fs.readFile(path.join(repo, '.grok', 'config.toml'), 'utf8')).toBe(grokAfter);
    expect(await fs.readFile(path.join(repo, 'AGENTS.md'), 'utf8')).toBe(agentsAfter);

    // Uninstall restores BOTH files byte-for-byte
    await setupHarness(repo, 'grok', { uninstall: true });
    expect(await fs.readFile(path.join(repo, '.grok', 'config.toml'), 'utf8')).toBe(userGrokToml);
    expect(await fs.readFile(path.join(repo, 'AGENTS.md'), 'utf8')).toBe(userAgents);
  });

  it('antigravity prints agy command by default and only executes when --apply is passed (AC5.6)', async () => {
    const repo = await makeTempDir();
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner = async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
    };

    // Without --apply: prints command, executes nothing
    const dryRes = await setupHarness(repo, 'antigravity', { commandRunner: runner });
    expect(calls).toHaveLength(0);
    expect(dryRes.notes.join('\n')).toContain('agy mcp add contextdeck cdeck mcp');
    expect(await fs.readFile(path.join(repo, 'AGENTS.md'), 'utf8')).toContain(
      '<!-- contextdeck:start -->',
    );

    // With --apply: invokes agy mcp add contextdeck cdeck mcp
    await setupHarness(repo, 'antigravity', { apply: true, commandRunner: runner });
    expect(calls).toEqual([{ cmd: 'agy', args: ['mcp', 'add', 'contextdeck', 'cdeck', 'mcp'] }]);

    // Uninstall with --apply: invokes agy mcp remove contextdeck and strips AGENTS.md block
    await setupHarness(repo, 'antigravity', { uninstall: true, apply: true, commandRunner: runner });
    expect(calls[1]).toEqual({ cmd: 'agy', args: ['mcp', 'remove', 'contextdeck'] });
  });

  it('D13 fail-closed: rejects corrupt JSON/TOML and unowned contextdeck collisions without modifying any file', async () => {
    // 1. Corrupt JSON in .mcp.json -> fails without touching .mcp.json OR .claude/settings.json
    const repo1 = await makeTempDir();
    const corruptJson = '{ "mcpServers": { broken json';
    await fs.writeFile(path.join(repo1, '.mcp.json'), corruptJson, 'utf8');
    await expect(setupHarness(repo1, 'claude-code')).rejects.toThrow(/parse|json/i);
    expect(await fs.readFile(path.join(repo1, '.mcp.json'), 'utf8')).toBe(corruptJson);
    await expect(fs.stat(path.join(repo1, '.claude', 'settings.json'))).rejects.toThrow();

    // 2. Corrupt TOML in .grok/config.toml -> fails without touching file or AGENTS.md
    const repo2 = await makeTempDir();
    await fs.mkdir(path.join(repo2, '.grok'), { recursive: true });
    const corruptToml = '[mcp_servers.bad\ncommand = "oops"\n';
    await fs.writeFile(path.join(repo2, '.grok', 'config.toml'), corruptToml, 'utf8');
    await expect(setupHarness(repo2, 'grok')).rejects.toThrow(/parse|toml/i);
    expect(await fs.readFile(path.join(repo2, '.grok', 'config.toml'), 'utf8')).toBe(corruptToml);
    await expect(fs.stat(path.join(repo2, 'AGENTS.md'))).rejects.toThrow();

    // 3. Unowned contextdeck collision in JSON (.mcp.json) -> fails without writing; uninstall preserves it
    const repo3 = await makeTempDir();
    const unownedMcp = `${JSON.stringify(
      { mcpServers: { contextdeck: { command: 'my-custom-tool', args: ['--serve'] } } },
      null,
      2,
    )}\n`;
    await fs.writeFile(path.join(repo3, '.mcp.json'), unownedMcp, 'utf8');
    await expect(setupHarness(repo3, 'claude-code')).rejects.toThrow(/unowned|existing|collision/i);
    expect(await fs.readFile(path.join(repo3, '.mcp.json'), 'utf8')).toBe(unownedMcp);
    await setupHarness(repo3, 'claude-code', { uninstall: true });
    expect(await fs.readFile(path.join(repo3, '.mcp.json'), 'utf8')).toBe(unownedMcp);

    // 4. Unowned [mcp_servers.contextdeck] collision in TOML (.codex/config.toml) -> fails without writing
    const repo4 = await makeTempDir();
    await fs.mkdir(path.join(repo4, '.codex'), { recursive: true });
    const unownedToml = `[mcp_servers.contextdeck]\ncommand = "custom-binary"\nargs = []\n`;
    await fs.writeFile(path.join(repo4, '.codex', 'config.toml'), unownedToml, 'utf8');
    await expect(setupHarness(repo4, 'codex')).rejects.toThrow(/unowned|existing|collision/i);
    expect(await fs.readFile(path.join(repo4, '.codex', 'config.toml'), 'utf8')).toBe(unownedToml);
    await setupHarness(repo4, 'codex', { uninstall: true });
    expect(await fs.readFile(path.join(repo4, '.codex', 'config.toml'), 'utf8')).toBe(unownedToml);

    // 5. Malformed unclosed marker block in AGENTS.md -> fails without modifying file
    const repo5 = await makeTempDir();
    const brokenAgents = `# Guidelines\n\n<!-- contextdeck:start -->\nunclosed block\n`;
    await fs.writeFile(path.join(repo5, 'AGENTS.md'), brokenAgents, 'utf8');
    await expect(setupHarness(repo5, 'agents-md')).rejects.toThrow(/malformed|marker/i);
    expect(await fs.readFile(path.join(repo5, 'AGENTS.md'), 'utf8')).toBe(brokenAgents);
  });

  it('agents-md standalone target merges D13 instructions idempotently and uninstalls cleanly', async () => {
    const repo = await makeTempDir();
    const original = '# Team Guidelines\n\nKeep PRs focused.\n';
    await fs.writeFile(path.join(repo, 'AGENTS.md'), original, 'utf8');

    await setupHarness(repo, 'agents-md');
    const after1 = await fs.readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    expect(after1).toContain('# Team Guidelines');
    expect(after1).toContain('<!-- contextdeck:start -->');
    expect(after1).toMatch(/do not call `session_register`/i);

    await setupHarness(repo, 'agents-md');
    expect(await fs.readFile(path.join(repo, 'AGENTS.md'), 'utf8')).toBe(after1);

    await setupHarness(repo, 'agents-md', { uninstall: true });
    expect(await fs.readFile(path.join(repo, 'AGENTS.md'), 'utf8')).toBe(original);
  });

  it('CLI exposes all 6 targets with --uninstall and --apply flags', async () => {
    const repo = await makeTempDir();
    const res = await runCli(['setup', 'grok', '--dir', repo], repo);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('grok mcp add --scope project contextdeck -- cdeck mcp');

    const unRes = await runCli(['setup', 'grok', '--dir', repo, '--uninstall'], repo);
    expect(unRes.code).toBe(0);
    await expect(fs.stat(path.join(repo, '.grok', 'config.toml'))).rejects.toThrow();

    const agyRes = await runCli(['setup', 'antigravity', '--dir', repo], repo);
    expect(agyRes.code).toBe(0);
    expect(agyRes.stdout).toContain('agy mcp add contextdeck cdeck mcp');
  });

  it('H15: setup preserves extra user fields on a compatible contextdeck MCP entry and uninstall leaves the pre-existing entry intact', async () => {
    const repo = await makeTempDir('cdeck-h15-');
    const preExistingMcp = {
      mcpServers: {
        contextdeck: {
          command: 'cdeck',
          args: ['mcp'],
          env: { CONTEXTDECK_HOME: 'team-store' },
          timeout: 90,
        },
      },
    };
    const mcpPath = path.join(repo, '.mcp.json');
    await fs.writeFile(mcpPath, `${JSON.stringify(preExistingMcp, null, 2)}\n`, 'utf8');

    // Install must preserve env and timeout
    await setupHarness(repo, 'claude-code');
    const afterInstall = JSON.parse(await fs.readFile(mcpPath, 'utf8')) as typeof preExistingMcp;
    expect(afterInstall.mcpServers.contextdeck).toEqual(preExistingMcp.mcpServers.contextdeck);

    // Uninstall must leave the pre-existing user-customized entry intact while removing hooks
    await setupHarness(repo, 'claude-code', { uninstall: true });
    const afterUninstall = JSON.parse(await fs.readFile(mcpPath, 'utf8')) as typeof preExistingMcp;
    expect(afterUninstall.mcpServers.contextdeck).toEqual(preExistingMcp.mcpServers.contextdeck);
    await expect(fs.stat(path.join(repo, '.claude', 'settings.json'))).rejects.toThrow();

    // Same for Cursor `.cursor/mcp.json`
    const cursorRepo = await makeTempDir('cdeck-h15-cursor-');
    const cursorMcpPath = path.join(cursorRepo, '.cursor', 'mcp.json');
    await fs.mkdir(path.dirname(cursorMcpPath), { recursive: true });
    await fs.writeFile(cursorMcpPath, `${JSON.stringify(preExistingMcp, null, 2)}\n`, 'utf8');

    await setupHarness(cursorRepo, 'cursor');
    expect(JSON.parse(await fs.readFile(cursorMcpPath, 'utf8'))).toEqual(preExistingMcp);
    await setupHarness(cursorRepo, 'cursor', { uninstall: true });
    expect(JSON.parse(await fs.readFile(cursorMcpPath, 'utf8'))).toEqual(preExistingMcp);
  });

  it('H16: setup claude-code (install and uninstall) removes legacy v0.1 .claude/settings.local.json brief-hook while preserving user hooks', async () => {
    // 1. v0.1 settings.local.json with BOTH legacy brief-hook and a user hook -> brief-hook removed, user hook kept
    const repo1 = await makeTempDir('cdeck-h16-keep-');
    const localPath1 = path.join(repo1, '.claude', 'settings.local.json');
    await fs.mkdir(path.dirname(localPath1), { recursive: true });
    const v01WithUser = {
      permissions: { allow: ['Bash(pnpm test)'] },
      hooks: {
        SessionStart: [
          {
            matcher: 'startup|resume',
            hooks: [
              { type: 'command', command: './scripts/user-startup.sh' },
              {
                type: 'command',
                command: 'node /old/path/index.js status --brief-hook --dir "/old/repo"',
              },
            ],
          },
        ],
      },
    };
    await fs.writeFile(localPath1, `${JSON.stringify(v01WithUser, null, 2)}\n`, 'utf8');

    await setupHarness(repo1, 'claude-code');
    const afterInstall1 = JSON.parse(await fs.readFile(localPath1, 'utf8')) as {
      permissions: unknown;
      hooks: { SessionStart: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> };
    };
    expect(afterInstall1.permissions).toEqual(v01WithUser.permissions);
    expect(afterInstall1.hooks.SessionStart).toEqual([
      {
        matcher: 'startup|resume',
        hooks: [{ type: 'command', command: './scripts/user-startup.sh' }],
      },
    ]);

    // 2. v0.1 settings.local.json containing ONLY the legacy brief-hook -> file deleted on uninstall (and install)
    const repo2 = await makeTempDir('cdeck-h16-delete-');
    const localPath2 = path.join(repo2, '.claude', 'settings.local.json');
    await fs.mkdir(path.dirname(localPath2), { recursive: true });
    const v01Only = {
      hooks: {
        SessionStart: [
          {
            hooks: [{ type: 'command', command: 'cdeck status --brief-hook --dir "/old/repo"' }],
          },
        ],
      },
    };
    await fs.writeFile(localPath2, `${JSON.stringify(v01Only, null, 2)}\n`, 'utf8');

    await setupHarness(repo2, 'claude-code', { uninstall: true });
    await expect(fs.stat(localPath2)).rejects.toThrow();
  });

  it('R2-4: legacy brief-hook cleanup preserves echo/compound user hooks and removes exact v0.1 commands (including quoted paths with spaces)', async () => {
    // 1. User hook that merely mentions `status --brief-hook` in echo must NOT be removed
    const repo1 = await makeTempDir('cdeck-r2-4-echo-');
    const localPath1 = path.join(repo1, '.claude', 'settings.local.json');
    await fs.mkdir(path.dirname(localPath1), { recursive: true });
    const echoOnly = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: 'echo "run cdeck status --brief-hook for status"',
              },
            ],
          },
        ],
      },
    };
    const echoRaw = `${JSON.stringify(echoOnly, null, 2)}\n`;
    await fs.writeFile(localPath1, echoRaw, 'utf8');

    await setupHarness(repo1, 'claude-code');
    expect(await fs.readFile(localPath1, 'utf8')).toBe(echoRaw);
    await setupHarness(repo1, 'claude-code', { uninstall: true });
    expect(await fs.readFile(localPath1, 'utf8')).toBe(echoRaw);

    // 2. Compound user hook (`foo; cdeck status --brief-hook`) is kept, while exact v0.1 shapes
    //    (with quoted path containing spaces and without --dir) are removed.
    const repo2 = await makeTempDir('cdeck-r2-4-mixed-');
    const localPath2 = path.join(repo2, '.claude', 'settings.local.json');
    await fs.mkdir(path.dirname(localPath2), { recursive: true });
    const mixed = {
      hooks: {
        SessionStart: [
          {
            matcher: '*',
            hooks: [
              { type: 'command', command: 'foo; cdeck status --brief-hook' },
              { type: 'command', command: 'cdeck status --brief-hook && echo done' },
              {
                type: 'command',
                command: 'cdeck status --brief-hook --dir "/tmp/my project with spaces"',
              },
              { type: 'command', command: 'cdeck status --brief-hook' },
              {
                type: 'command',
                command: '"/usr/local/bin/cdeck" status --brief-hook --dir "/opt/repo"',
              },
            ],
          },
        ],
      },
    };
    await fs.writeFile(localPath2, `${JSON.stringify(mixed, null, 2)}\n`, 'utf8');

    await setupHarness(repo2, 'claude-code');
    const afterMixed = JSON.parse(await fs.readFile(localPath2, 'utf8')) as {
      hooks: { SessionStart: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> };
    };
    expect(afterMixed.hooks.SessionStart).toEqual([
      {
        matcher: '*',
        hooks: [
          { type: 'command', command: 'foo; cdeck status --brief-hook' },
          { type: 'command', command: 'cdeck status --brief-hook && echo done' },
        ],
      },
    ]);
  });

  it('R2-6: v0.1 --dir <rootDir> MCP entry is upgraded on install and removed on uninstall, while customized --dir other is preserved without false "(no absolute paths)" note', async () => {
    // 1. Claude Code: v0.1 entry with exact rootDir -> install upgrades to v0.2 (no abs path)
    const repo1 = await makeTempDir('cdeck-r2-6-upgrade-');
    const mcpPath1 = path.join(repo1, '.mcp.json');
    await fs.writeFile(
      mcpPath1,
      `${JSON.stringify(
        { mcpServers: { contextdeck: { command: 'cdeck', args: ['mcp', '--dir', repo1] } } },
        null,
        2,
      )}\n`,
      'utf8',
    );
    const installRes1 = await setupHarness(repo1, 'claude-code');
    const rawAfterInstall1 = await fs.readFile(mcpPath1, 'utf8');
    expect(rawAfterInstall1).not.toContain(repo1);
    expect(JSON.parse(rawAfterInstall1)).toEqual({
      mcpServers: { contextdeck: { command: 'cdeck', args: ['mcp'] } },
    });
    expect(installRes1.notes.join(' ')).toContain('(no absolute paths)');

    // 2. Claude Code: v0.1 entry with exact rootDir -> uninstall removes .mcp.json cleanly
    const repo2 = await makeTempDir('cdeck-r2-6-uninstall-');
    const mcpPath2 = path.join(repo2, '.mcp.json');
    await fs.writeFile(
      mcpPath2,
      `${JSON.stringify(
        { mcpServers: { contextdeck: { command: 'cdeck', args: ['mcp', '--dir', repo2] } } },
        null,
        2,
      )}\n`,
      'utf8',
    );
    await setupHarness(repo2, 'claude-code', { uninstall: true });
    await expect(fs.stat(mcpPath2)).rejects.toThrow();

    // 3. Cursor: v0.1 entry in .cursor/mcp.json -> upgraded on install and removed on uninstall
    const cursorRepo1 = await makeTempDir('cdeck-r2-6-cursor-up-');
    const cursorMcp1 = path.join(cursorRepo1, '.cursor', 'mcp.json');
    await fs.mkdir(path.dirname(cursorMcp1), { recursive: true });
    await fs.writeFile(
      cursorMcp1,
      `${JSON.stringify(
        { mcpServers: { contextdeck: { command: 'cdeck', args: ['mcp', '--dir', cursorRepo1] } } },
        null,
        2,
      )}\n`,
      'utf8',
    );
    await setupHarness(cursorRepo1, 'cursor');
    expect(JSON.parse(await fs.readFile(cursorMcp1, 'utf8'))).toEqual({
      mcpServers: { contextdeck: { command: 'cdeck', args: ['mcp'] } },
    });

    const cursorRepo2 = await makeTempDir('cdeck-r2-6-cursor-rm-');
    const cursorMcp2 = path.join(cursorRepo2, '.cursor', 'mcp.json');
    await fs.mkdir(path.dirname(cursorMcp2), { recursive: true });
    await fs.writeFile(
      cursorMcp2,
      `${JSON.stringify(
        { mcpServers: { contextdeck: { command: 'cdeck', args: ['mcp', '--dir', cursorRepo2] } } },
        null,
        2,
      )}\n`,
      'utf8',
    );
    await setupHarness(cursorRepo2, 'cursor', { uninstall: true });
    await expect(fs.stat(cursorMcp2)).rejects.toThrow();

    // 4. Customized --dir pointing to another directory -> preserved on install and uninstall,
    //    AND install MUST NOT falsely print "(no absolute paths)"!
    const repo3 = await makeTempDir('cdeck-r2-6-custom-');
    const otherDir = await makeTempDir('cdeck-r2-6-other-');
    const mcpPath3 = path.join(repo3, '.mcp.json');
    const customMcp = {
      mcpServers: { contextdeck: { command: 'cdeck', args: ['mcp', '--dir', otherDir] } },
    };
    await fs.writeFile(mcpPath3, `${JSON.stringify(customMcp, null, 2)}\n`, 'utf8');

    const customInstallRes = await setupHarness(repo3, 'claude-code');
    expect(JSON.parse(await fs.readFile(mcpPath3, 'utf8'))).toEqual(customMcp);
    expect(customInstallRes.notes.join(' ')).not.toContain('(no absolute paths)');

    await setupHarness(repo3, 'claude-code', { uninstall: true });
    expect(JSON.parse(await fs.readFile(mcpPath3, 'utf8'))).toEqual(customMcp);

    // 5. v0.1 --dir <rootDir> WITH extra user key (env) -> still treated as customized & preserved (H15)
    const repo4 = await makeTempDir('cdeck-r2-6-extra-');
    const mcpPath4 = path.join(repo4, '.mcp.json');
    const extraKeyMcp = {
      mcpServers: {
        contextdeck: { command: 'cdeck', args: ['mcp', '--dir', repo4], env: { FOO: '1' } },
      },
    };
    await fs.writeFile(mcpPath4, `${JSON.stringify(extraKeyMcp, null, 2)}\n`, 'utf8');
    const extraRes = await setupHarness(repo4, 'claude-code');
    expect(JSON.parse(await fs.readFile(mcpPath4, 'utf8'))).toEqual(extraKeyMcp);
    expect(extraRes.notes.join(' ')).not.toContain('(no absolute paths)');
    await setupHarness(repo4, 'claude-code', { uninstall: true });
    expect(JSON.parse(await fs.readFile(mcpPath4, 'utf8'))).toEqual(extraKeyMcp);
  });
});
