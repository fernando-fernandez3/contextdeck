import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parse as parseToml } from 'smol-toml';
import { atomicWriteFile } from '@contextdeck/core';

export type HarnessTarget =
  | 'claude-code'
  | 'cursor'
  | 'codex'
  | 'grok'
  | 'antigravity'
  | 'agents-md';

export const HARNESS_TARGETS: readonly HarnessTarget[] = [
  'claude-code',
  'cursor',
  'codex',
  'grok',
  'antigravity',
  'agents-md',
] as const;

export type CommandRunner = (cmd: string, args: string[], cwd: string) => Promise<void>;

export interface SetupHarnessOptions {
  uninstall?: boolean;
  apply?: boolean;
  commandRunner?: CommandRunner;
}

export interface SetupHarnessResult {
  filesWritten: string[];
  filesRemoved: string[];
  notes: string[];
}

type FileAction =
  | { kind: 'write'; filePath: string; content: string }
  | { kind: 'remove'; filePath: string }
  | { kind: 'noop'; filePath: string };

const HOOK_CMD_PREFIX = 'cdeck hook ';
const TOML_START = '# contextdeck:start';
const TOML_END = '# contextdeck:end';
const MD_START = '<!-- contextdeck:start -->';
const MD_END = '<!-- contextdeck:end -->';

const MCP_STDIO_ENTRY = {
  command: 'cdeck',
  args: ['mcp'],
};

const TOML_MCP_BLOCK = `${TOML_START}
[mcp_servers.contextdeck]
command = "cdeck"
args = ["mcp"]
${TOML_END}`;

export const AGENTS_MD_SECTION = `${MD_START}
## Shared Context Protocol (ContextDeck)

This project maintains a shared context board via **ContextDeck** (\`.contextdeck/\` or \`.contextdeck.yaml\`).
Whenever you work in this repository (from Claude Code, Codex, Cursor, Grok, Antigravity, or any other harness):

1. **Reuse your injected session ID:** If a ContextDeck hook injected \`Your ContextDeck session id is sess_xxx\`, reuse that \`sessionId\` on every ContextDeck MCP tool call and **do NOT call \`session_register\`**. Only call \`session_register\` if no session ID was injected (pass a stable \`externalRef\` when available and \`parentSessionId\` when branching from a parent thread).
2. **Orient & stay synced:** If you did not receive a startup context pack, call \`board_get_brief\` (passing \`sessionId\` when known) or run \`cdeck brief --pack\`. When a hook injects a ContextDeck update digest, align your work with the newer decisions before editing.
3. **Record decisions & supersessions:** Whenever architecture or product direction changes, call \`decision_record\` (passing \`sessionId\`, and \`supersedes: "dec_xxx"\` when replacing an older decision) so other live sessions receive the change and dependent diagrams, media, and quizzes are flagged stale.
4. **Update living artifacts:** Pass \`sessionId\` on \`task_upsert\`, \`diagram_upsert\`, \`media_attach\`, \`quiz_create\`, and \`board_update_brief\` (with \`baseRevision\` from \`board_get_brief\`) so edits route to your bound board and never trigger self-drift.
${MD_END}`;

const CURSOR_RULE_FRONTMATTER = `---
description: Keep Cursor sessions synchronized with the shared ContextDeck board
alwaysApply: true
---`;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCompatibleMcpEntry(entry: unknown): entry is Record<string, unknown> {
  if (!isPlainObject(entry)) return false;
  return (
    entry.command === 'cdeck' &&
    Array.isArray(entry.args) &&
    entry.args.length >= 1 &&
    entry.args[0] === 'mcp'
  );
}

function isExactInstallerMcpEntry(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  const keys = Object.keys(entry);
  return (
    keys.length === 2 &&
    entry.command === 'cdeck' &&
    Array.isArray(entry.args) &&
    entry.args.length === 1 &&
    entry.args[0] === 'mcp'
  );
}

/**
 * R2-6: Match the exact v0.1 installer entry `{ command: 'cdeck', args: ['mcp', '--dir', <rootDir>] }`
 * (no extra user fields, and `--dir` resolves to `rootDir`) so install upgrades it to the v0.2
 * path-free entry and `--uninstall` removes it, while preserving customized entries (H15).
 */
function isLegacyInstallerMcpEntry(entry: unknown, rootDir: string): boolean {
  if (!isPlainObject(entry)) return false;
  const keys = Object.keys(entry);
  if (keys.length !== 2 || entry.command !== 'cdeck' || !Array.isArray(entry.args)) {
    return false;
  }
  if (
    entry.args.length !== 3 ||
    entry.args[0] !== 'mcp' ||
    entry.args[1] !== '--dir' ||
    typeof entry.args[2] !== 'string' ||
    entry.args[2].trim().length === 0
  ) {
    return false;
  }
  return path.resolve(entry.args[2]) === path.resolve(rootDir);
}

function isOwnedHookCommand(cmd: unknown): boolean {
  return typeof cmd === 'string' && cmd.startsWith(HOOK_CMD_PREFIX);
}

const SHELL_META_OUTSIDE_QUOTES = /[;&|`$<>()\r\n]/;

function tokenizeSimpleShellCommand(cmd: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else if (ch === '\n' || ch === '\r') {
        return null;
      } else {
        current += ch;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === '\\' && i + 1 < cmd.length && (cmd[i + 1] === '"' || cmd[i + 1] === '\\')) {
        current += cmd[i + 1];
        i += 1;
      } else if (ch === '`' || ch === '\n' || ch === '\r') {
        return null;
      } else if (ch === '$' && cmd[i + 1] === '(') {
        return null;
      } else {
        current += ch;
      }
      continue;
    }

    if (SHELL_META_OUTSIDE_QUOTES.test(ch)) {
      return null;
    }
    if (ch === ' ' || ch === '\t') {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (ch === '\\' && i + 1 < cmd.length) {
      current += cmd[i + 1];
      i += 1;
      inToken = true;
      continue;
    }
    current += ch;
    inToken = true;
  }

  if (quote !== null) return null;
  if (inToken) tokens.push(current);
  return tokens;
}

function execBaseName(token: string): string {
  const parts = token.split(/[\\/]/);
  return (parts[parts.length - 1] ?? '').toLowerCase();
}

const LEGACY_CDECK_EXECUTABLES = new Set([
  'cdeck',
  'cdeck.cmd',
  'cdeck.exe',
  'cdeck.js',
  'contextdeck',
  'contextdeck.cmd',
  'contextdeck.exe',
]);

/**
 * R2-4: Match only the exact v0.1 brief-hook command shape:
 *   `<cdeck|node cli.js> status --brief-hook [--dir "<path>"]`
 * Ambiguous, quoted-mention (`echo ...`), or compound (`;`, `&&`, `|`) commands are preserved.
 */
function isLegacyBriefHookCommand(cmd: unknown): boolean {
  if (typeof cmd !== 'string') return false;
  const trimmed = cmd.trim();
  if (!trimmed) return false;

  const tokens = tokenizeSimpleShellCommand(trimmed);
  if (!tokens || tokens.length < 3) return false;

  const base0 = execBaseName(tokens[0]);
  let argStart = -1;
  if (LEGACY_CDECK_EXECUTABLES.has(base0)) {
    argStart = 1;
  } else if ((base0 === 'node' || base0 === 'node.exe') && tokens.length >= 4) {
    const script = tokens[1];
    if (!script.startsWith('-') && /\.(?:m|c)?js$/i.test(script)) {
      argStart = 2;
    }
  }
  if (argStart === -1) return false;

  const rest = tokens.slice(argStart);
  if (rest[0] !== 'status' || rest[1] !== '--brief-hook') {
    return false;
  }
  if (rest.length === 2) return true;
  if (rest.length === 4 && rest[2] === '--dir' && rest[3].length > 0) return true;
  if (rest.length === 3 && rest[2].startsWith('--dir=') && rest[2].length > '--dir='.length) {
    return true;
  }
  return false;
}

function stringContainsAbsolutePath(value: string): boolean {
  const withoutUrls = value.replace(/https?:\/\/\S+/gi, '');
  if (path.isAbsolute(withoutUrls) || /^[A-Za-z]:[\\/]/.test(withoutUrls)) {
    return true;
  }
  return /(?:^|[\s"'])(?:\/[A-Za-z0-9._-]|[A-Za-z]:[\\/])/.test(withoutUrls);
}

function jsonContainsAbsolutePath(value: unknown): boolean {
  if (typeof value === 'string') return stringContainsAbsolutePath(value);
  if (Array.isArray(value)) return value.some((item) => jsonContainsAbsolutePath(item));
  if (isPlainObject(value)) {
    return Object.values(value).some((v) => jsonContainsAbsolutePath(v));
  }
  return false;
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

async function readJsonObjectStrict(filePath: string): Promise<Record<string, unknown> | null> {
  const raw = await readTextIfExists(filePath);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse JSON in "${filePath}": ${err instanceof Error ? err.message : String(err)}. Fix the file before running cdeck setup.`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Invalid JSON root in "${filePath}": expected a JSON object.`);
  }
  return parsed;
}

function planMcpJson(
  filePath: string,
  existing: Record<string, unknown> | null,
  uninstall: boolean,
  rootDir: string,
): FileAction {
  if (uninstall) {
    if (!existing) return { kind: 'noop', filePath };
    if (existing.mcpServers === undefined) return { kind: 'noop', filePath };
    if (!isPlainObject(existing.mcpServers)) {
      throw new Error(`Invalid "mcpServers" field in "${filePath}": expected an object.`);
    }
    const servers = { ...existing.mcpServers };
    const isInstallerOwned =
      servers.contextdeck !== undefined &&
      (isExactInstallerMcpEntry(servers.contextdeck) ||
        isLegacyInstallerMcpEntry(servers.contextdeck, rootDir));
    if (!isInstallerOwned) {
      // D13 / H15 / R2-6: Remove only exact v0.2 or legacy v0.1 (`--dir <rootDir>`) installer entries
      return { kind: 'noop', filePath };
    }
    delete servers.contextdeck;
    const next: Record<string, unknown> = { ...existing };
    if (Object.keys(servers).length === 0) {
      delete next.mcpServers;
    } else {
      next.mcpServers = servers;
    }
    if (Object.keys(next).length === 0) {
      return { kind: 'remove', filePath };
    }
    return { kind: 'write', filePath, content: `${JSON.stringify(next, null, 2)}\n` };
  }

  const base = existing ? { ...existing } : {};
  if (base.mcpServers !== undefined && !isPlainObject(base.mcpServers)) {
    throw new Error(`Invalid "mcpServers" field in "${filePath}": expected an object.`);
  }
  const servers: Record<string, unknown> = isPlainObject(base.mcpServers)
    ? { ...base.mcpServers }
    : {};

  if (servers.contextdeck !== undefined) {
    if (!isCompatibleMcpEntry(servers.contextdeck)) {
      throw new Error(
        `Refusing to overwrite unowned "mcpServers.contextdeck" collision in "${filePath}". Remove or rename the existing entry first.`,
      );
    }
    const isInstallerOwned =
      isExactInstallerMcpEntry(servers.contextdeck) ||
      isLegacyInstallerMcpEntry(servers.contextdeck, rootDir);
    if (!isInstallerOwned) {
      // H15: Compatible user-customized entry (e.g. extra env/timeout/custom --dir) -> preserve untouched
      return { kind: 'noop', filePath };
    }
  }

  servers.contextdeck = MCP_STDIO_ENTRY;
  const next = { ...base, mcpServers: servers };
  return { kind: 'write', filePath, content: `${JSON.stringify(next, null, 2)}\n` };
}

interface MatcherGroupSpec {
  matcher?: string;
  hooks: Array<{
    type: 'command';
    command: string;
    additionalContextLimit?: number;
    timeout?: number;
  }>;
}

/**
 * H16: Remove legacy v0.1 `status --brief-hook` entries from `.claude/settings.local.json`
 * on both install and uninstall while preserving all other user settings/hooks byte-for-byte
 * when untouched and deleting the file only if it becomes completely empty.
 */
function planLegacyClaudeLocalCleanup(
  filePath: string,
  existing: Record<string, unknown> | null,
): FileAction {
  if (!existing || existing.hooks === undefined) {
    return { kind: 'noop', filePath };
  }
  if (!isPlainObject(existing.hooks)) {
    throw new Error(`Invalid "hooks" field in "${filePath}": expected an object.`);
  }

  const hooksObj: Record<string, unknown> = { ...existing.hooks };
  let changed = false;

  for (const [eventName, rawGroups] of Object.entries(hooksObj)) {
    if (!Array.isArray(rawGroups)) continue;
    const keptGroups: unknown[] = [];
    let eventChanged = false;

    for (const group of rawGroups) {
      if (isPlainObject(group) && Array.isArray(group.hooks)) {
        const remainingHandlers = group.hooks.filter((h) => {
          if (isPlainObject(h) && isLegacyBriefHookCommand(h.command)) {
            eventChanged = true;
            return false;
          }
          return true;
        });
        if (remainingHandlers.length > 0) {
          keptGroups.push(
            remainingHandlers.length === group.hooks.length
              ? group
              : { ...group, hooks: remainingHandlers },
          );
        }
      } else if (isPlainObject(group) && isLegacyBriefHookCommand(group.command)) {
        eventChanged = true;
      } else {
        keptGroups.push(group);
      }
    }

    if (eventChanged) {
      changed = true;
      if (keptGroups.length === 0) {
        delete hooksObj[eventName];
      } else {
        hooksObj[eventName] = keptGroups;
      }
    }
  }

  if (!changed) {
    return { kind: 'noop', filePath };
  }

  const next: Record<string, unknown> = { ...existing };
  if (Object.keys(hooksObj).length === 0) {
    delete next.hooks;
  } else {
    next.hooks = hooksObj;
  }
  if (Object.keys(next).length === 0) {
    return { kind: 'remove', filePath };
  }
  return { kind: 'write', filePath, content: `${JSON.stringify(next, null, 2)}\n` };
}

function stripOwnedFromMatcherGroups(
  groups: unknown[],
  filePath: string,
  eventName: string,
): { kept: unknown[]; removedAny: boolean } {
  const kept: unknown[] = [];
  let removedAny = false;

  for (const group of groups) {
    if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
      throw new Error(
        `Invalid hook matcher group in "${filePath}" under hooks.${eventName}: expected { hooks: [...] }.`,
      );
    }
    const remainingHandlers = group.hooks.filter((h) => {
      if (isPlainObject(h) && isOwnedHookCommand(h.command)) {
        removedAny = true;
        return false;
      }
      return true;
    });
    if (remainingHandlers.length > 0) {
      kept.push(
        remainingHandlers.length === group.hooks.length
          ? group
          : { ...group, hooks: remainingHandlers },
      );
    }
  }

  return { kept, removedAny };
}

function planMatcherHooksJson(
  filePath: string,
  existing: Record<string, unknown> | null,
  desiredEvents: Record<string, MatcherGroupSpec>,
  uninstall: boolean,
): FileAction {
  if (uninstall) {
    if (!existing || existing.hooks === undefined) return { kind: 'noop', filePath };
    if (!isPlainObject(existing.hooks)) {
      throw new Error(`Invalid "hooks" field in "${filePath}": expected an object.`);
    }

    const hooksObj: Record<string, unknown> = { ...existing.hooks };
    let changed = false;

    for (const [eventName, rawGroups] of Object.entries(hooksObj)) {
      if (!Array.isArray(rawGroups)) continue;
      const { kept, removedAny } = stripOwnedFromMatcherGroups(rawGroups, filePath, eventName);
      if (removedAny) {
        changed = true;
        if (kept.length === 0) {
          delete hooksObj[eventName];
        } else {
          hooksObj[eventName] = kept;
        }
      }
    }

    if (!changed) return { kind: 'noop', filePath };
    const next: Record<string, unknown> = { ...existing };
    if (Object.keys(hooksObj).length === 0) {
      delete next.hooks;
    } else {
      next.hooks = hooksObj;
    }
    if (Object.keys(next).length === 0) {
      return { kind: 'remove', filePath };
    }
    return { kind: 'write', filePath, content: `${JSON.stringify(next, null, 2)}\n` };
  }

  const base = existing ? { ...existing } : {};
  if (base.hooks !== undefined && !isPlainObject(base.hooks)) {
    throw new Error(`Invalid "hooks" field in "${filePath}": expected an object.`);
  }
  const hooksObj: Record<string, unknown> = isPlainObject(base.hooks) ? { ...base.hooks } : {};

  for (const [eventName, desiredGroup] of Object.entries(desiredEvents)) {
    const existingGroups = hooksObj[eventName];
    if (existingGroups !== undefined && !Array.isArray(existingGroups)) {
      throw new Error(
        `Invalid "hooks.${eventName}" field in "${filePath}": expected an array.`,
      );
    }
    const { kept } = stripOwnedFromMatcherGroups(
      (existingGroups as unknown[] | undefined) ?? [],
      filePath,
      eventName,
    );
    hooksObj[eventName] = [...kept, desiredGroup];
  }

  const next = { ...base, hooks: hooksObj };
  return { kind: 'write', filePath, content: `${JSON.stringify(next, null, 2)}\n` };
}

function planCursorHooksJson(
  filePath: string,
  existing: Record<string, unknown> | null,
  desiredEvents: Record<string, { command: string }>,
  uninstall: boolean,
): FileAction {
  if (existing !== null) {
    if (
      existing.version !== undefined &&
      (typeof existing.version !== 'number' ||
        !Number.isInteger(existing.version) ||
        existing.version < 1)
    ) {
      throw new Error(
        `Invalid "version" in "${filePath}": expected a positive integer (e.g. 1).`,
      );
    }
  }

  if (uninstall) {
    if (!existing || existing.hooks === undefined) return { kind: 'noop', filePath };
    if (!isPlainObject(existing.hooks)) {
      throw new Error(`Invalid "hooks" field in "${filePath}": expected an object.`);
    }

    const hooksObj: Record<string, unknown> = { ...existing.hooks };
    let changed = false;

    for (const [eventName, rawList] of Object.entries(hooksObj)) {
      if (!Array.isArray(rawList)) continue;
      const kept = rawList.filter((entry) => {
        if (isPlainObject(entry) && isOwnedHookCommand(entry.command)) {
          changed = true;
          return false;
        }
        return true;
      });
      if (kept.length !== rawList.length) {
        if (kept.length === 0) {
          delete hooksObj[eventName];
        } else {
          hooksObj[eventName] = kept;
        }
      }
    }

    if (!changed) return { kind: 'noop', filePath };
    const next: Record<string, unknown> = { ...existing };
    if (Object.keys(hooksObj).length === 0) {
      delete next.hooks;
    } else {
      next.hooks = hooksObj;
    }
    const remainingKeys = Object.keys(next);
    if (remainingKeys.length === 0 || (remainingKeys.length === 1 && remainingKeys[0] === 'version')) {
      return { kind: 'remove', filePath };
    }
    return { kind: 'write', filePath, content: `${JSON.stringify(next, null, 2)}\n` };
  }

  const base = existing ? { ...existing } : {};
  if (base.hooks !== undefined && !isPlainObject(base.hooks)) {
    throw new Error(`Invalid "hooks" field in "${filePath}": expected an object.`);
  }
  const hooksObj: Record<string, unknown> = isPlainObject(base.hooks) ? { ...base.hooks } : {};

  for (const [eventName, desiredEntry] of Object.entries(desiredEvents)) {
    const rawList = hooksObj[eventName];
    if (rawList !== undefined && !Array.isArray(rawList)) {
      throw new Error(
        `Invalid "hooks.${eventName}" field in "${filePath}": expected an array.`,
      );
    }
    const kept = ((rawList as unknown[] | undefined) ?? []).filter(
      (entry) => !(isPlainObject(entry) && isOwnedHookCommand(entry.command)),
    );
    hooksObj[eventName] = [...kept, desiredEntry];
  }

  const next = {
    version: typeof base.version === 'number' ? base.version : 1,
    ...base,
    hooks: hooksObj,
  };
  return { kind: 'write', filePath, content: `${JSON.stringify(next, null, 2)}\n` };
}

function findMarkerSpan(
  content: string,
  startMarker: string,
  endMarker: string,
  filePath: string,
): { startIdx: number; endIdx: number } | null {
  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);

  if (startIdx === -1 && endIdx === -1) {
    return null;
  }
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(
      `Malformed ContextDeck marker block in "${filePath}": expected matching "${startMarker}" and "${endMarker}".`,
    );
  }
  const secondStart = content.indexOf(startMarker, startIdx + startMarker.length);
  const secondEnd = content.indexOf(endMarker, endIdx + endMarker.length);
  if (secondStart !== -1 || secondEnd !== -1) {
    throw new Error(
      `Multiple ContextDeck marker blocks detected in "${filePath}". Clean up duplicate markers first.`,
    );
  }
  return { startIdx, endIdx: endIdx + endMarker.length };
}

function stripMarkerBlockBytePreserving(
  content: string,
  span: { startIdx: number; endIdx: number },
): string {
  let before = content.slice(0, span.startIdx);
  let after = content.slice(span.endIdx);

  // Strip the single newline immediately following the end marker
  if (after.startsWith('\r\n')) {
    after = after.slice(2);
  } else if (after.startsWith('\n')) {
    after = after.slice(1);
  }

  // If our block was appended at EOF with a blank separator line (`\n\n`), drop the separator line
  if (after.length === 0) {
    if (before.endsWith('\r\n\r\n')) {
      before = before.slice(0, -2);
    } else if (before.endsWith('\n\n')) {
      before = before.slice(0, -1);
    }
  } else if (before.length === 0) {
    if (after.startsWith('\r\n')) {
      after = after.slice(2);
    } else if (after.startsWith('\n')) {
      after = after.slice(1);
    }
  } else if (before.endsWith('\n\n') && after.startsWith('\n')) {
    after = after.slice(1);
  }

  return before + after;
}

function insertMarkerBlockBytePreserving(
  existing: string | null,
  block: string,
  startMarker: string,
  endMarker: string,
  filePath: string,
): string {
  if (existing === null || existing.length === 0) {
    return `${block}\n`;
  }
  const span = findMarkerSpan(existing, startMarker, endMarker, filePath);
  if (span) {
    return `${existing.slice(0, span.startIdx)}${block}${existing.slice(span.endIdx)}`;
  }
  if (existing.endsWith('\n\n') || existing.endsWith('\r\n\r\n')) {
    return `${existing}${block}\n`;
  }
  if (existing.endsWith('\n')) {
    return `${existing}\n${block}\n`;
  }
  return `${existing}\n\n${block}\n`;
}

function planTomlMcpConfig(
  filePath: string,
  existing: string | null,
  uninstall: boolean,
): FileAction {
  if (existing !== null) {
    // D13: Parse error in existing TOML -> fail closed without writing
    try {
      parseToml(existing);
    } catch (err) {
      throw new Error(
        `Failed to parse TOML in "${filePath}": ${err instanceof Error ? err.message : String(err)}. Fix the file before running cdeck setup.`,
      );
    }
  }

  const span =
    existing !== null ? findMarkerSpan(existing, TOML_START, TOML_END, filePath) : null;

  if (uninstall) {
    if (existing === null || !span) {
      // D13: Never remove unowned TOML entries outside `# contextdeck:start/end`
      return { kind: 'noop', filePath };
    }
    const stripped = stripMarkerBlockBytePreserving(existing, span);
    if (stripped.trim().length === 0) {
      return { kind: 'remove', filePath };
    }
    // Validate remaining TOML before committing
    parseToml(stripped);
    return { kind: 'write', filePath, content: stripped };
  }

  // Check for unowned `[mcp_servers.contextdeck]` outside our marker block (D13)
  if (existing !== null) {
    const userOnly = span ? stripMarkerBlockBytePreserving(existing, span) : existing;
    const parsedUser = parseToml(userOnly) as Record<string, unknown>;
    const mcpServers = parsedUser.mcp_servers;
    if (isPlainObject(mcpServers) && mcpServers.contextdeck !== undefined) {
      throw new Error(
        `Refusing to overwrite unowned [mcp_servers.contextdeck] collision in "${filePath}". Remove or wrap the existing entry in ${TOML_START} / ${TOML_END} markers first.`,
      );
    }
  }

  const nextContent = insertMarkerBlockBytePreserving(
    existing,
    TOML_MCP_BLOCK,
    TOML_START,
    TOML_END,
    filePath,
  );
  // Guarantee resulting TOML is 100% valid before writing
  try {
    parseToml(nextContent);
  } catch (err) {
    throw new Error(
      `Generated invalid TOML for "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { kind: 'write', filePath, content: nextContent };
}

function planAgentsMd(
  filePath: string,
  existing: string | null,
  uninstall: boolean,
): FileAction {
  const span = existing !== null ? findMarkerSpan(existing, MD_START, MD_END, filePath) : null;

  if (uninstall) {
    if (existing === null || !span) {
      return { kind: 'noop', filePath };
    }
    const stripped = stripMarkerBlockBytePreserving(existing, span);
    const trimmed = stripped.trim();
    if (trimmed.length === 0 || trimmed === '# Agent Guidelines') {
      return { kind: 'remove', filePath };
    }
    return { kind: 'write', filePath, content: stripped };
  }

  if (existing === null) {
    return { kind: 'write', filePath, content: `# Agent Guidelines\n\n${AGENTS_MD_SECTION}\n` };
  }

  const next = insertMarkerBlockBytePreserving(
    existing,
    AGENTS_MD_SECTION,
    MD_START,
    MD_END,
    filePath,
  );
  return { kind: 'write', filePath, content: next };
}

function planCursorRuleFile(
  filePath: string,
  existing: string | null,
  uninstall: boolean,
): FileAction {
  const span = existing !== null ? findMarkerSpan(existing, MD_START, MD_END, filePath) : null;

  if (uninstall) {
    if (existing === null || !span) {
      return { kind: 'noop', filePath };
    }
    const stripped = stripMarkerBlockBytePreserving(existing, span);
    if (stripped.trim().length === 0 || stripped.trim() === CURSOR_RULE_FRONTMATTER.trim()) {
      return { kind: 'remove', filePath };
    }
    return { kind: 'write', filePath, content: stripped };
  }

  if (existing === null) {
    return {
      kind: 'write',
      filePath,
      content: `${CURSOR_RULE_FRONTMATTER}\n\n${AGENTS_MD_SECTION}\n`,
    };
  }

  const next = insertMarkerBlockBytePreserving(
    existing,
    AGENTS_MD_SECTION,
    MD_START,
    MD_END,
    filePath,
  );
  return { kind: 'write', filePath, content: next };
}

async function commitFileActions(actions: FileAction[]): Promise<{
  filesWritten: string[];
  filesRemoved: string[];
}> {
  const filesWritten: string[] = [];
  const filesRemoved: string[] = [];

  for (const action of actions) {
    if (action.kind === 'write') {
      await fs.mkdir(path.dirname(action.filePath), { recursive: true });
      await atomicWriteFile(action.filePath, action.content);
      filesWritten.push(action.filePath);
    } else if (action.kind === 'remove') {
      await fs.rm(action.filePath, { force: true });
      filesRemoved.push(action.filePath);
    }
  }

  return { filesWritten, filesRemoved };
}

const defaultCommandRunner: CommandRunner = (cmd, args, cwd) => {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, shell: false, stdio: 'inherit' });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command "${cmd} ${args.join(' ')}" exited with code ${code ?? 'null'}`));
    });
  });
};

export async function setupHarness(
  rootDir: string,
  target: HarnessTarget,
  options: SetupHarnessOptions = {},
): Promise<SetupHarnessResult> {
  const uninstall = Boolean(options.uninstall);
  const apply = Boolean(options.apply);
  const runner = options.commandRunner ?? defaultCommandRunner;
  const notes: string[] = [];

  // Plan and validate ALL file edits BEFORE writing anything (D13 atomic fail-closed).
  const actions: FileAction[] = [];

  if (target === 'claude-code') {
    const mcpPath = path.join(rootDir, '.mcp.json');
    const settingsPath = path.join(rootDir, '.claude', 'settings.json');
    const localSettingsPath = path.join(rootDir, '.claude', 'settings.local.json');
    const [existingMcp, existingSettings, existingLocalSettings] = await Promise.all([
      readJsonObjectStrict(mcpPath),
      readJsonObjectStrict(settingsPath),
      readJsonObjectStrict(localSettingsPath),
    ]);

    const mcpAction = planMcpJson(mcpPath, existingMcp, uninstall, rootDir);
    const settingsAction = planMatcherHooksJson(
      settingsPath,
      existingSettings,
      {
        SessionStart: {
          matcher: 'startup|resume|clear|compact',
          hooks: [{ type: 'command', command: 'cdeck hook claude-code SessionStart' }],
        },
        UserPromptSubmit: {
          hooks: [{ type: 'command', command: 'cdeck hook claude-code UserPromptSubmit' }],
        },
        SessionEnd: {
          hooks: [{ type: 'command', command: 'cdeck hook claude-code SessionEnd' }],
        },
      },
      uninstall,
    );
    // H16 / R2-4: Clean up legacy v0.1 `status --brief-hook` from `.claude/settings.local.json`
    const localAction = planLegacyClaudeLocalCleanup(localSettingsPath, existingLocalSettings);
    actions.push(mcpAction, settingsAction, localAction);

    // R2-6: Never print "(no absolute paths)" if any absolute path remains in a file setup touched or preserved
    const finalMcpObj =
      mcpAction.kind === 'write'
        ? JSON.parse(mcpAction.content)
        : mcpAction.kind === 'noop'
          ? existingMcp
          : null;
    const finalSettingsObj =
      settingsAction.kind === 'write'
        ? JSON.parse(settingsAction.content)
        : settingsAction.kind === 'noop'
          ? existingSettings
          : null;
    const finalLocalObj = localAction.kind === 'write' ? JSON.parse(localAction.content) : null;
    const hasRemainingAbsPath =
      jsonContainsAbsolutePath(finalMcpObj) ||
      jsonContainsAbsolutePath(finalSettingsObj) ||
      jsonContainsAbsolutePath(finalLocalObj);

    notes.push(
      uninstall
        ? 'Removed ContextDeck stdio MCP server from .mcp.json and lifecycle hooks from .claude/settings.json.'
        : `Configured stdio MCP server in .mcp.json and SessionStart/UserPromptSubmit/SessionEnd hooks in .claude/settings.json${hasRemainingAbsPath ? '' : ' (no absolute paths)'}.`,
    );
  } else if (target === 'codex') {
    const configPath = path.join(rootDir, '.codex', 'config.toml');
    const hooksPath = path.join(rootDir, '.codex', 'hooks.json');
    const [existingToml, existingHooks] = await Promise.all([
      readTextIfExists(configPath),
      readJsonObjectStrict(hooksPath),
    ]);

    actions.push(planTomlMcpConfig(configPath, existingToml, uninstall));
    actions.push(
      planMatcherHooksJson(
        hooksPath,
        existingHooks,
        {
          SessionStart: {
            matcher: 'startup|resume|clear|compact|fork',
            hooks: [
              {
                type: 'command',
                command: 'cdeck hook codex SessionStart',
                additionalContextLimit: 2500,
              },
            ],
          },
          UserPromptSubmit: {
            hooks: [
              {
                type: 'command',
                command: 'cdeck hook codex UserPromptSubmit',
                additionalContextLimit: 1500,
              },
            ],
          },
          SessionEnd: {
            hooks: [{ type: 'command', command: 'cdeck hook codex SessionEnd', timeout: 3 }],
          },
        },
        uninstall,
      ),
    );
    notes.push(
      uninstall
        ? 'Removed ContextDeck MCP block from .codex/config.toml and lifecycle hooks from .codex/hooks.json.'
        : 'Configured project-scope Codex MCP in .codex/config.toml and SessionStart/UserPromptSubmit/SessionEnd hooks in .codex/hooks.json (hooks are enabled by default in Codex).',
    );
  } else if (target === 'cursor') {
    const mcpPath = path.join(rootDir, '.cursor', 'mcp.json');
    const hooksPath = path.join(rootDir, '.cursor', 'hooks.json');
    const rulePath = path.join(rootDir, '.cursor', 'rules', 'contextdeck.mdc');
    const [existingMcp, existingHooks, existingRule] = await Promise.all([
      readJsonObjectStrict(mcpPath),
      readJsonObjectStrict(hooksPath),
      readTextIfExists(rulePath),
    ]);

    actions.push(planMcpJson(mcpPath, existingMcp, uninstall, rootDir));
    actions.push(
      planCursorHooksJson(
        hooksPath,
        existingHooks,
        {
          sessionStart: { command: 'cdeck hook cursor sessionStart' },
          postToolUse: { command: 'cdeck hook cursor postToolUse' },
          sessionEnd: { command: 'cdeck hook cursor sessionEnd' },
        },
        uninstall,
      ),
    );
    actions.push(planCursorRuleFile(rulePath, existingRule, uninstall));
    notes.push(
      uninstall
        ? 'Removed ContextDeck entries from .cursor/mcp.json, .cursor/hooks.json, and .cursor/rules/contextdeck.mdc.'
        : 'Configured Cursor MCP (.cursor/mcp.json), hooks (.cursor/hooks.json: sessionStart, throttled postToolUse, sessionEnd), and always-apply rule (.cursor/rules/contextdeck.mdc). Note: Cursor does not support injecting context at beforeSubmitPrompt.',
    );
  } else if (target === 'grok') {
    const configPath = path.join(rootDir, '.grok', 'config.toml');
    const agentsPath = path.join(rootDir, 'AGENTS.md');
    const [existingToml, existingAgents] = await Promise.all([
      readTextIfExists(configPath),
      readTextIfExists(agentsPath),
    ]);

    actions.push(planTomlMcpConfig(configPath, existingToml, uninstall));
    actions.push(planAgentsMd(agentsPath, existingAgents, uninstall));
    notes.push(
      uninstall
        ? 'Removed ContextDeck MCP block from .grok/config.toml and protocol block from AGENTS.md. Equivalent CLI: grok mcp remove contextdeck'
        : 'Configured project-scope Grok MCP in .grok/config.toml and updated AGENTS.md. Equivalent CLI: grok mcp add --scope project contextdeck -- cdeck mcp',
    );
  } else if (target === 'antigravity') {
    const agentsPath = path.join(rootDir, 'AGENTS.md');
    const existingAgents = await readTextIfExists(agentsPath);
    actions.push(planAgentsMd(agentsPath, existingAgents, uninstall));

    const agyArgs = uninstall
      ? ['mcp', 'remove', 'contextdeck']
      : ['mcp', 'add', 'contextdeck', 'cdeck', 'mcp'];
    const printableCmd = `agy ${agyArgs.join(' ')}`;

    const committed = await commitFileActions(actions);
    if (apply) {
      await runner('agy', agyArgs, rootDir);
      notes.push(`Executed: ${printableCmd}`);
    } else {
      notes.push(
        `Run \`${printableCmd}\` (or re-run with \`--apply\`) to ${uninstall ? 'remove' : 'register'} the ContextDeck MCP server in Antigravity.`,
      );
    }
    return { ...committed, notes };
  } else {
    // agents-md
    const agentsPath = path.join(rootDir, 'AGENTS.md');
    const existingAgents = await readTextIfExists(agentsPath);
    actions.push(planAgentsMd(agentsPath, existingAgents, uninstall));
    notes.push(
      uninstall
        ? 'Removed ContextDeck protocol block from AGENTS.md.'
        : 'Updated universal ContextDeck protocol block in AGENTS.md.',
    );
  }

  const committed = await commitFileActions(actions);
  return { ...committed, notes };
}
