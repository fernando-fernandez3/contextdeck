import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { CorruptDataError, WorkspaceNotFoundError } from './errors.js';
import { validateBoardSlug, validateWorkspaceName } from './ids.js';
import { assertContainedPathSync, canonicalizePathSync } from './paths.js';

export const CONTEXTDECK_DIR_NAME = '.contextdeck';
export const CONTEXTDECK_POINTER_FILE = '.contextdeck.yaml';

const WorkspacePointerSchema = z
  .object({
    workspace: z.string().min(1),
    board: z.string().min(1).optional(),
  })
  .strict();

const UserConfigSchema = z
  .object({
    mediaRoots: z.array(z.string().min(1)).optional(),
  })
  .passthrough();

export interface UserLocalConfig {
  mediaRoots: string[];
}

export interface ResolveWorkspaceOptions {
  dir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface ResolvedWorkspace {
  deckDir: string;
  projectRoot?: string;
  mainWorktreeRoot?: string;
  defaultBoard?: string;
  mode: 'in-repo' | 'global' | 'explicit';
  workspaceName?: string;
  pointerPath?: string;
}

export function resolveContextDeckHome(options: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
} = {}): string {
  const env = options.env ?? process.env;
  const rawHome = env.CONTEXTDECK_HOME?.trim();
  if (rawHome) {
    return canonicalizePathSync(path.resolve(rawHome));
  }
  const baseHome = options.homeDir ?? os.homedir();
  return canonicalizePathSync(path.join(path.resolve(baseHome), CONTEXTDECK_DIR_NAME));
}

export function readUserLocalConfig(options: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
} = {}): UserLocalConfig {
  const home = resolveContextDeckHome(options);
  const cfgPath = path.join(home, 'config.yaml');
  let raw: string;
  try {
    raw = fsSync.readFileSync(cfgPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { mediaRoots: [] };
    }
    throw err;
  }

  let loaded: unknown;
  try {
    loaded = yaml.load(raw);
  } catch (err) {
    throw new CorruptDataError(
      `Corrupt user config at ${cfgPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!loaded || typeof loaded !== 'object') {
    return { mediaRoots: [] };
  }
  const parsed = UserConfigSchema.safeParse(loaded);
  if (!parsed.success) {
    throw new CorruptDataError(`Invalid user config at ${cfgPath}: ${parsed.error.message}`);
  }
  const mediaRoots = (parsed.data.mediaRoots ?? []).map((r) => canonicalizePathSync(path.resolve(r)));
  return { mediaRoots };
}

function readPointerFileSync(
  pointerPath: string,
  home: string,
): { workspaceName: string; deckDir: string; defaultBoard?: string } {
  const raw = fsSync.readFileSync(pointerPath, 'utf8');
  let loaded: unknown;
  try {
    loaded = yaml.load(raw);
  } catch (err) {
    throw new CorruptDataError(
      `Corrupt ${CONTEXTDECK_POINTER_FILE} at ${pointerPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = WorkspacePointerSchema.safeParse(loaded);
  if (!parsed.success) {
    throw new CorruptDataError(
      `Invalid ${CONTEXTDECK_POINTER_FILE} at ${pointerPath}: ${parsed.error.message}`,
    );
  }

  const workspaceName = validateWorkspaceName(parsed.data.workspace);
  const defaultBoard = parsed.data.board
    ? validateBoardSlug(parsed.data.board, 'pointer board slug')
    : undefined;

  const workspacesRoot = path.join(home, 'workspaces');
  const candidateDeckDir = path.join(workspacesRoot, workspaceName);
  const safeDeckDir = assertContainedPathSync(workspacesRoot, candidateDeckDir, {
    label: 'global workspace directory',
  });

  return {
    workspaceName,
    deckDir: safeDeckDir,
    defaultBoard,
  };
}

function walkAncestors(startDir: string): string[] {
  const dirs: string[] = [];
  let current = path.resolve(startDir);
  for (;;) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

function isBareGitConfig(commonDir: string): boolean {
  const configPath = path.join(commonDir, 'config');
  try {
    const content = fsSync.readFileSync(configPath, 'utf8');
    let inCoreSection = false;
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      if (line.startsWith('[')) {
        inCoreSection = /^\[core\]$/i.test(line);
        continue;
      }
      if (inCoreSection) {
        const match = line.match(/^bare\s*=\s*(.+)$/i);
        if (match) {
          return match[1].trim().toLowerCase() === 'true';
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Pure-fs detection of a linked git worktree (D3: no git subprocess).
 * Walks ancestors looking for a `.git` entry:
 * - If `.git` is a directory, we are in a normal checkout (not a linked worktree).
 * - If `.git` is a file containing `gitdir: <path>`, checks `<gitdir>/commondir`.
 *   If `commondir` exists and points to a non-bare `.git` directory, returns
 *   `{ worktreeRoot, mainWorktreeRoot }`.
 */
export function findLinkedGitWorktree(startDir: string): {
  worktreeRoot: string;
  mainWorktreeRoot: string;
} | null {
  for (const dir of walkAncestors(startDir)) {
    const dotGitPath = path.join(dir, '.git');
    let stat: fsSync.Stats;
    try {
      stat = fsSync.lstatSync(dotGitPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      // Main checkout of a normal git repo; stop walking above this repo.
      return null;
    }

    if (!stat.isFile()) {
      return null;
    }

    let gitFileContent: string;
    try {
      gitFileContent = fsSync.readFileSync(dotGitPath, 'utf8');
    } catch {
      return null;
    }

    const match = gitFileContent.match(/^gitdir:\s*(.+)$/m);
    if (!match) return null;

    const gitDir = path.resolve(dir, match[1].trim());
    const commonDirFile = path.join(gitDir, 'commondir');
    let commonDirRel: string;
    try {
      commonDirRel = fsSync.readFileSync(commonDirFile, 'utf8').trim();
    } catch {
      // Submodules have a .git file without a commondir file; not a linked worktree.
      return null;
    }

    if (!commonDirRel) return null;
    const commonDir = path.resolve(gitDir, commonDirRel);

    if (isBareGitConfig(commonDir)) {
      return null;
    }

    // Standard non-bare repo common dir is `<mainWorktreeRoot>/.git`
    if (path.basename(commonDir) !== '.git') {
      return null;
    }

    const mainWorktreeRoot = path.dirname(commonDir);
    if (canonicalizePathSync(mainWorktreeRoot) === canonicalizePathSync(dir)) {
      return null;
    }

    return {
      worktreeRoot: dir,
      mainWorktreeRoot,
    };
  }

  return null;
}

function isDirSync(p: string): boolean {
  try {
    return fsSync.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFileSync(p: string): boolean {
  try {
    return fsSync.statSync(p).isFile();
  } catch {
    return false;
  }
}

function resolveFromSingleStartDir(
  absStart: string,
  home: string,
  allowDirectDeckDir: boolean,
): ResolvedWorkspace | null {
  // 1. Direct explicit .contextdeck dir (only when caller explicitly passed --dir or CONTEXTDECK_DIR)
  if (
    allowDirectDeckDir &&
    isDirSync(absStart) &&
    (path.basename(absStart) === CONTEXTDECK_DIR_NAME ||
      (isDirSync(path.join(absStart, 'boards')) && isFileSync(path.join(absStart, 'workspace.yaml'))))
  ) {
    const canonicalDeckDir = canonicalizePathSync(absStart);
    const projectRoot =
      path.basename(canonicalDeckDir) === CONTEXTDECK_DIR_NAME
        ? path.dirname(canonicalDeckDir)
        : undefined;
    return {
      deckDir: canonicalDeckDir,
      projectRoot,
      mode: 'explicit',
    };
  }

  // 2. `.contextdeck.yaml` pointer in ancestors (D3: checked before linked-worktree redirect)
  for (const dir of walkAncestors(absStart)) {
    const pointerPath = path.join(dir, CONTEXTDECK_POINTER_FILE);
    if (isFileSync(pointerPath)) {
      const ptr = readPointerFileSync(pointerPath, home);
      return {
        deckDir: ptr.deckDir,
        projectRoot: canonicalizePathSync(dir),
        defaultBoard: ptr.defaultBoard,
        mode: 'global',
        workspaceName: ptr.workspaceName,
        pointerPath: canonicalizePathSync(pointerPath),
      };
    }
  }

  // 3. Linked git worktree redirect BEFORE in-repo `.contextdeck/` lookup (D3 / Bug 6)
  const linked = findLinkedGitWorktree(absStart);
  if (linked) {
    const { worktreeRoot, mainWorktreeRoot } = linked;

    // Check pointer at main worktree (and its ancestors)
    for (const dir of walkAncestors(mainWorktreeRoot)) {
      const pointerPath = path.join(dir, CONTEXTDECK_POINTER_FILE);
      if (isFileSync(pointerPath)) {
        const ptr = readPointerFileSync(pointerPath, home);
        return {
          deckDir: ptr.deckDir,
          projectRoot: canonicalizePathSync(worktreeRoot),
          mainWorktreeRoot: canonicalizePathSync(mainWorktreeRoot),
          defaultBoard: ptr.defaultBoard,
          mode: 'global',
          workspaceName: ptr.workspaceName,
          pointerPath: canonicalizePathSync(pointerPath),
        };
      }
    }

    // Check in-repo `.contextdeck/` at main worktree (and its ancestors)
    for (const dir of walkAncestors(mainWorktreeRoot)) {
      const candidate = path.join(dir, CONTEXTDECK_DIR_NAME);
      if (isDirSync(candidate)) {
        return {
          deckDir: canonicalizePathSync(candidate),
          projectRoot: canonicalizePathSync(worktreeRoot),
          mainWorktreeRoot: canonicalizePathSync(dir),
          mode: 'in-repo',
        };
      }
    }
  }

  // 4. Nearest ancestor `.contextdeck/`
  for (const dir of walkAncestors(absStart)) {
    const candidate = path.join(dir, CONTEXTDECK_DIR_NAME);
    if (isDirSync(candidate)) {
      return {
        deckDir: canonicalizePathSync(candidate),
        projectRoot: canonicalizePathSync(dir),
        mode: 'in-repo',
      };
    }
  }

  return null;
}

function resolveFromStartDir(
  startDir: string,
  home: string,
  allowDirectDeckDir: boolean,
): ResolvedWorkspace | null {
  const absStart = path.resolve(startDir);
  const direct = resolveFromSingleStartDir(absStart, home, allowDirectDeckDir);
  if (direct) return direct;

  const canonicalStart = canonicalizePathSync(absStart);
  if (canonicalStart !== absStart) {
    return resolveFromSingleStartDir(canonicalStart, home, allowDirectDeckDir);
  }
  return null;
}

/**
 * Single workspace resolver used by CLI, MCP stdio, hooks, and server (AC4.1, D3):
 * --dir -> CONTEXTDECK_DIR -> CLAUDE_PROJECT_DIR -> .contextdeck.yaml in ancestors
 * -> linked git worktree redirect to main worktree root -> nearest ancestor .contextdeck/ -> error.
 */
export function resolveWorkspace(options: ResolveWorkspaceOptions = {}): ResolvedWorkspace {
  const env = options.env ?? process.env;
  const home = resolveContextDeckHome({ env, homeDir: options.homeDir });

  const explicitDir = options.dir?.trim();
  if (explicitDir) {
    const resolved = resolveFromStartDir(explicitDir, home, true);
    if (resolved) return resolved;
    throw new WorkspaceNotFoundError(
      `No ContextDeck workspace found in "${path.resolve(explicitDir)}". Run \`cdeck init\` (or \`cdeck init --global <name>\`) to initialize one.`,
    );
  }

  const envDir = env.CONTEXTDECK_DIR?.trim();
  if (envDir) {
    const resolved = resolveFromStartDir(envDir, home, true);
    if (resolved) return resolved;
    throw new WorkspaceNotFoundError(
      `No ContextDeck workspace found from CONTEXTDECK_DIR="${path.resolve(envDir)}". Run \`cdeck init\` to initialize one.`,
    );
  }

  const claudeDir = env.CLAUDE_PROJECT_DIR?.trim();
  if (claudeDir) {
    const resolved = resolveFromStartDir(claudeDir, home, false);
    if (resolved) return resolved;
    throw new WorkspaceNotFoundError(
      `No ContextDeck workspace found from CLAUDE_PROJECT_DIR="${path.resolve(claudeDir)}". Run \`cdeck init\` to initialize one.`,
    );
  }

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const resolved = resolveFromStartDir(cwd, home, false);
  if (resolved) return resolved;

  throw new WorkspaceNotFoundError(
    `No ContextDeck workspace found from "${cwd}". Run \`cdeck init\` (or \`cdeck init --global <name>\`) to create one.`,
  );
}

/**
 * Create a committable `.contextdeck.yaml` pointer (no absolute paths) and ensure
 * the target global workspace directory exists under `<CONTEXTDECK_HOME>/workspaces/<name>`.
 */
export async function initGlobalWorkspacePointer(options: {
  projectRoot: string;
  workspaceName: string;
  boardSlug?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): Promise<ResolvedWorkspace> {
  const workspaceName = validateWorkspaceName(options.workspaceName);
  const boardSlug = options.boardSlug
    ? validateBoardSlug(options.boardSlug, 'board slug')
    : undefined;
  const projectRoot = path.resolve(options.projectRoot);
  const home = resolveContextDeckHome({ env: options.env, homeDir: options.homeDir });
  const workspacesRoot = path.join(home, 'workspaces');
  await fs.mkdir(workspacesRoot, { recursive: true });

  const candidateDeckDir = path.join(workspacesRoot, workspaceName);
  const deckDir = assertContainedPathSync(workspacesRoot, candidateDeckDir, {
    label: 'global workspace directory',
  });
  await fs.mkdir(deckDir, { recursive: true });

  const pointerPath = path.join(projectRoot, CONTEXTDECK_POINTER_FILE);
  const payload: Record<string, string> = { workspace: workspaceName };
  if (boardSlug) payload.board = boardSlug;
  const serialized = yaml.dump(payload, { lineWidth: 100, noRefs: true, sortKeys: false });
  await fs.writeFile(pointerPath, serialized, 'utf8');

  return {
    deckDir,
    projectRoot,
    defaultBoard: boardSlug,
    mode: 'global',
    workspaceName,
    pointerPath,
  };
}

const REQUIRED_GITIGNORE_ENTRIES = ['.contextdeck/.runtime/', '.contextdeck/.lock'];

/**
 * Idempotently add `.contextdeck/.runtime/` and `.contextdeck/.lock` to `<projectRoot>/.gitignore`.
 */
export async function ensureContextDeckGitignore(projectRoot: string): Promise<string> {
  const gitignorePath = path.join(path.resolve(projectRoot), '.gitignore');
  let existing = '';
  try {
    existing = await fs.readFile(gitignorePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  const lines = existing.split(/\r?\n/).map((l) => l.trim());
  const missing = REQUIRED_GITIGNORE_ENTRIES.filter((entry) => !lines.includes(entry));
  if (missing.length === 0) {
    return gitignorePath;
  }

  let next = existing;
  if (next.length > 0 && !next.endsWith('\n')) {
    next += '\n';
  }
  next += `${missing.join('\n')}\n`;
  await fs.writeFile(gitignorePath, next, 'utf8');
  return gitignorePath;
}
