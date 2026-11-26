import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync, type Dirent } from 'node:fs';
import yaml from 'js-yaml';
import chokidar, { type FSWatcher } from 'chokidar';
import type { ZodType, ZodTypeDef } from 'zod';
import {
  ActorSchema,
  BoardConfigSchema,
  BoardEventSchema,
  ContextUpdatePayloadSchema,
  CreateBoardInputSchema,
  CreateQuizInputSchema,
  DEFAULT_LENSES,
  DecisionSchema,
  DiagramSchema,
  LegacySessionFileSchema,
  MediaArtifactSchema,
  PatchTaskInputSchema,
  QuizAttemptSchema,
  QuizSchema,
  RecordDecisionInputSchema,
  RegisterSessionInputSchema,
  SessionCursorSchema,
  SessionMetadataSchema,
  SessionSchema,
  SubmitQuizAttemptInputSchema,
  SyncSessionInputSchema,
  TaskSchema,
  UpdateBoardInputSchema,
  UpdateBriefInputSchema,
  UpdateDecisionPatchSchema,
  UpdateMediaPatchSchema,
  UpdateSessionPatchSchema,
  UpsertDiagramInputSchema,
  UpsertTaskInputSchema,
  type Actor,
  type BoardConfig,
  type BoardEvent,
  type BoardSnapshot,
  type ContextUpdatePayload,
  type Decision,
  type DecisionStatus,
  type Diagram,
  type DiagramKind,
  type LegacySessionFile,
  type LensConfig,
  type MediaArtifact,
  type MediaKind,
  type Quiz,
  type QuizAttempt,
  type QuizQuestion,
  type Session,
  type SessionCursor,
  type SessionMetadata,
  type SessionStatus,
  type Task,
  type TaskColumn,
  type TaskPriority,
} from './schemas.js';
import {
  ConflictError,
  CorruptDataError,
  LockCompromisedError,
  NotFoundError,
  SecurityError,
  ValidationError,
} from './errors.js';
import {
  nextSequentialId,
  nowIso,
  shortId,
  slugify,
  validateBoardSlug,
  validateEntityId,
  validateHttpUrl,
} from './ids.js';
import {
  assertContainedPath,
  assertContainedPathSync,
  canonicalizePath,
  canonicalizePathSync,
} from './paths.js';
import { CONTEXTDECK_DIR_NAME } from './workspace.js';
import { routeBoardForCwd, validateBoardParentHierarchy } from './routing.js';
import { parseFrontmatter, stringifyFrontmatter } from './markdown.js';
import {
  buildSessionDriftDigest,
  computeDriftReport,
  type SessionDigestResult,
} from './drift.js';
import {
  TXN_FILENAME,
  atomicWriteFile,
  executeTxnJournal,
  maybeInjectFault,
  streamFileToTempFsync,
  toDeckRelativePath,
  withWorkspaceLock,
  writeTempFileFsync,
  type TxnEventEntry,
  type TxnJournal,
  type TxnOp,
  type WorkspaceLockOptions,
} from './txn.js';

export const DEFAULT_MAX_MEDIA_BYTES = 500 * 1024 * 1024; // 500 MB

export interface ContextDeckStoreOptions {
  deckDir: string;
  projectRoot?: string;
  defaultBoard?: string;
  maxMediaBytes?: number;
}

export interface WatchOptions {
  scope?: 'all' | 'board-configs';
  debounceMs?: number;
}

interface WorkspaceMeta {
  defaultBoard: string;
  updatedAt: string;
}

const DEFAULT_ACTOR: Actor = { type: 'human', label: 'user' };

/** True only if the workspace lock is still held; used to gate cleanup in error paths (R6-1). */
function lockStillOwned(assertActive: () => void): boolean {
  try {
    assertActive();
    return true;
  } catch {
    return false;
  }
}

function formatZodError(err: { issues: Array<{ path: (string | number)[]; message: string }> }): string {
  return err.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ');
}

function parseStrict<T>(schema: ZodType<T, ZodTypeDef, unknown>, input: unknown, label: string): T {
  const res = schema.safeParse(input);
  if (!res.success) {
    throw new ValidationError(`Invalid ${label}: ${formatZodError(res.error)}`);
  }
  return res.data;
}

function dumpYaml(data: unknown): string {
  return yaml.dump(data, { lineWidth: 100, noRefs: true, sortKeys: false });
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readFileStrict(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

async function readYamlStrict<T>(
  filePath: string,
  schema?: ZodType<T, ZodTypeDef, unknown>,
): Promise<T | null> {
  const raw = await readFileStrict(filePath);
  if (raw === null) return null;
  let loaded: unknown;
  try {
    loaded = yaml.load(raw);
  } catch (err) {
    throw new CorruptDataError(
      `Corrupt YAML in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (loaded === null || loaded === undefined) {
    throw new CorruptDataError(`Empty or invalid YAML in ${filePath}`);
  }
  if (!schema) return loaded as T;
  const parsed = schema.safeParse(loaded);
  if (!parsed.success) {
    throw new CorruptDataError(`Schema validation failed for ${filePath}: ${formatZodError(parsed.error)}`);
  }
  return parsed.data;
}

async function listFilesStrict(dirPath: string, suffix?: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => {
        if (!e.isFile() && !e.isSymbolicLink()) return false;
        if (e.name.startsWith('.tmp-')) return false;
        return !suffix || e.name.endsWith(suffix);
      })
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

export interface StagedWrite {
  kind: 'write' | 'pre_staged' | 'unlink';
  finalPath: string;
  content?: string | Buffer;
  tmpPath?: string;
  noClobber?: boolean;
}

export interface MutationContext {
  readonly slug: string;
  readonly boardDir: string;
  readonly actor: Actor;
  readonly initialConfig: BoardConfig;
  getCurrentRevision(): number;
  stageFile(finalPath: string, content: string | Buffer, options?: { noClobber?: boolean }): void;
  stagePreStagedFile(tmpPath: string, finalPath: string, options?: { noClobber?: boolean }): void;
  stageDelete(finalPath: string): void;
  addEvent(input: {
    kind: string;
    entityId?: string;
    summary: string;
    details?: Record<string, unknown>;
    actor?: Actor;
  }): BoardEvent;
  markConfigDirty(): void;
  setConfigPatch(
    patch: Partial<Pick<BoardConfig, 'title' | 'description' | 'lenses' | 'parentBoard' | 'paths'>>,
  ): void;
  onAfterCommit(fn: () => Promise<void>): void;
}

/**
 * Pure quiz scoring helper with explicit AC1.5 divide-by-zero guard (H11).
 */
export function scoreQuizAttempt(
  questions: QuizQuestion[],
  answers: Record<string, number | string | boolean>,
): { score: number; total: number; percentage: number } {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new ValidationError('Quiz has zero questions and cannot be scored.');
  }

  let score = 0;
  for (const q of questions) {
    const userAnswer = answers[q.id];
    if (q.type === 'multiple_choice' && typeof q.correctIndex === 'number') {
      if (Number(userAnswer) === q.correctIndex) score += 1;
    } else if (q.type === 'true_false' && q.correctAnswer !== undefined) {
      if (String(userAnswer).toLowerCase() === q.correctAnswer.toLowerCase()) score += 1;
    } else if (q.type === 'short_answer' && q.correctAnswer) {
      if (
        typeof userAnswer === 'string' &&
        userAnswer.trim().toLowerCase().includes(q.correctAnswer.trim().toLowerCase())
      ) {
        score += 1;
      }
    }
  }

  const total = questions.length;
  const percentage = Math.round((score / total) * 100);
  return { score, total, percentage };
}

export class ContextDeckStore {
  public readonly rootDir: string;
  public readonly projectRoot?: string;
  public readonly deckDir: string;
  public readonly runtimeDir: string;
  public readonly boardsDir: string;
  public readonly sessionsDir: string;
  public readonly cursorsDir: string;
  public readonly defaultBoardHint?: string;
  public readonly maxMediaBytes: number;

  constructor(rootDirOrOptions: string | ContextDeckStoreOptions) {
    if (typeof rootDirOrOptions === 'string') {
      const canonicalRoot = canonicalizePathSync(path.resolve(rootDirOrOptions));
      this.projectRoot = canonicalRoot;
      this.rootDir = canonicalRoot;
      this.deckDir = canonicalizePathSync(path.join(canonicalRoot, CONTEXTDECK_DIR_NAME));
      this.maxMediaBytes = DEFAULT_MAX_MEDIA_BYTES;
    } else {
      this.deckDir = canonicalizePathSync(path.resolve(rootDirOrOptions.deckDir));
      this.projectRoot = rootDirOrOptions.projectRoot
        ? canonicalizePathSync(path.resolve(rootDirOrOptions.projectRoot))
        : undefined;
      this.rootDir = this.projectRoot ?? path.dirname(this.deckDir);
      this.defaultBoardHint = rootDirOrOptions.defaultBoard
        ? validateBoardSlug(rootDirOrOptions.defaultBoard, 'defaultBoard')
        : undefined;
      this.maxMediaBytes = rootDirOrOptions.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES;
    }
    this.runtimeDir = path.join(this.deckDir, '.runtime');
    this.boardsDir = path.join(this.deckDir, 'boards');
    this.sessionsDir = path.join(this.deckDir, 'sessions');
    this.cursorsDir = path.join(this.runtimeDir, 'cursors');
  }

  public isInitialized(): boolean {
    return existsSync(this.boardsDir);
  }

  private assertBoardsDirSafeSync(): string {
    const expectedBoardsDir = path.join(canonicalizePathSync(this.deckDir), 'boards');
    const canonicalBoardsDir = canonicalizePathSync(this.boardsDir);
    if (canonicalBoardsDir !== expectedBoardsDir) {
      throw new SecurityError(
        `Access denied: boards directory "${this.boardsDir}" resolves outside workspace deck.`,
      );
    }
    return canonicalBoardsDir;
  }

  private async assertBoardsDirSafe(): Promise<string> {
    const [canonicalDeckDir, canonicalBoardsDir] = await Promise.all([
      canonicalizePath(this.deckDir),
      canonicalizePath(this.boardsDir),
    ]);
    const expectedBoardsDir = path.join(canonicalDeckDir, 'boards');
    if (canonicalBoardsDir !== expectedBoardsDir) {
      throw new SecurityError(
        `Access denied: boards directory "${this.boardsDir}" resolves outside workspace deck.`,
      );
    }
    return canonicalBoardsDir;
  }

  public boardPath(slug: string): string {
    const validSlug = validateBoardSlug(slug);
    const canonicalBoardsDir = this.assertBoardsDirSafeSync();
    const candidate = path.join(canonicalBoardsDir, validSlug);
    const realBoardDir = assertContainedPathSync(canonicalBoardsDir, candidate, {
      label: `board "${validSlug}"`,
    });
    if (realBoardDir !== path.join(canonicalBoardsDir, validSlug)) {
      throw new SecurityError(`Access denied: board "${validSlug}" resolves to an aliased directory.`);
    }
    return realBoardDir;
  }

  private async safeBoardFilePath(slug: string, ...segments: string[]): Promise<string> {
    const boardDir = this.boardPath(slug);
    const target = path.join(boardDir, ...segments);
    return assertContainedPath(boardDir, target, {
      label: segments.join('/'),
    });
  }

  private async assertSessionsDirSafe(): Promise<string> {
    const [canonicalDeckDir, canonicalSessionsDir] = await Promise.all([
      canonicalizePath(this.deckDir),
      canonicalizePath(this.sessionsDir),
    ]);
    const expectedSessionsDir = path.join(canonicalDeckDir, 'sessions');
    if (canonicalSessionsDir !== expectedSessionsDir) {
      throw new SecurityError(
        `Access denied: sessions directory "${this.sessionsDir}" resolves outside workspace deck.`,
      );
    }
    return canonicalSessionsDir;
  }

  private async safeSessionFilePath(sessionId: string): Promise<string> {
    const validId = validateEntityId(sessionId, 'sessionId');
    const canonicalSessionsDir = await this.assertSessionsDirSafe();
    const candidate = path.join(canonicalSessionsDir, `${validId}.yaml`);
    const resolved = await assertContainedPath(canonicalSessionsDir, candidate, {
      label: `session "${validId}"`,
    });
    if (resolved !== candidate) {
      throw new SecurityError(`Access denied: session "${validId}" resolves to an aliased file.`);
    }
    return resolved;
  }

  private async safeCursorFilePath(sessionId: string): Promise<string> {
    const validId = validateEntityId(sessionId, 'sessionId');
    const canonicalRuntime = await canonicalizePath(this.runtimeDir);
    const cursorsRoot = path.join(canonicalRuntime, 'cursors');
    const candidate = path.join(cursorsRoot, `${validId}.json`);
    return assertContainedPath(cursorsRoot, candidate, {
      label: `cursor "${validId}"`,
    });
  }

  public async readSessionCursor(sessionId: string): Promise<SessionCursor | null> {
    const cursorPath = await this.safeCursorFilePath(sessionId);
    const raw = await readFileStrict(cursorPath);
    if (raw === null) return null;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (err) {
      throw new CorruptDataError(
        `Corrupt cursor JSON at ${cursorPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const parsed = SessionCursorSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new CorruptDataError(
        `Invalid cursor schema at ${cursorPath}: ${formatZodError(parsed.error)}`,
      );
    }
    return parsed.data;
  }

  public async writeSessionCursor(cursor: SessionCursor): Promise<void> {
    const validated = SessionCursorSchema.parse(cursor);
    const cursorPath = await this.safeCursorFilePath(validated.sessionId);
    await ensureDir(path.dirname(cursorPath));
    await atomicWriteFile(cursorPath, `${JSON.stringify(validated, null, 2)}\n`);
  }

  private async deleteSessionCursor(sessionId: string): Promise<void> {
    const cursorPath = await this.safeCursorFilePath(sessionId);
    await fs.rm(cursorPath, { force: true });
  }

  /**
   * Migrate pre-B2 board-scoped session files (`boards/<slug>/sessions/<id>.yaml`)
   * to workspace-scoped `<deck>/sessions/<id>.yaml` (metadata only) +
   * `<deck>/.runtime/cursors/<id>.json` (volatile sync state) on first write (D11).
   * Must be called while holding the workspace lock. Does not bump board revisions.
   */
  private async migrateLegacySessionsUnlocked(assertActive: () => void): Promise<void> {
    let boardEntries;
    try {
      boardEntries = await fs.readdir(this.boardsDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }

    const legacyDirs: Array<{ slug: string; dir: string }> = [];
    for (const entry of boardEntries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const legacySessionDir = path.join(this.boardsDir, entry.name, 'sessions');
      if (existsSync(legacySessionDir)) {
        legacyDirs.push({ slug: entry.name, dir: legacySessionDir });
      }
    }
    if (legacyDirs.length === 0) return;

    for (const { slug, dir } of legacyDirs) {
      assertActive();
      const files = await listFilesStrict(dir, '.yaml');
      if (files.length === 0) continue;

      validateBoardSlug(slug);
      const safeDir = await this.safeBoardFilePath(slug, 'sessions');
      await ensureDir(this.sessionsDir);
      await this.assertSessionsDirSafe();

      for (const file of files) {
        assertActive();
        const legacyPath = await assertContainedPath(safeDir, path.join(safeDir, file), {
          label: `legacy session ${file}`,
        });
        const parsed = await readYamlStrict(legacyPath, LegacySessionFileSchema);
        if (!parsed) continue;

        const targetSessionPath = await this.safeSessionFilePath(parsed.id);
        const boundBoard = parsed.board ?? slug;

        if (!existsSync(targetSessionPath)) {
          const meta: SessionMetadata = SessionMetadataSchema.parse({
            id: parsed.id,
            title: parsed.title,
            harness: parsed.harness,
            ...(parsed.externalRef !== undefined ? { externalRef: parsed.externalRef } : {}),
            board: boundBoard,
            parentSessionId: parsed.parentSessionId,
            relatedSessionIds: parsed.relatedSessionIds,
            status: parsed.status,
            summary: parsed.summary,
            focusFiles: parsed.focusFiles,
            createdAt: parsed.createdAt,
            updatedAt: parsed.updatedAt,
          });
          await atomicWriteFile(targetSessionPath, dumpYaml(meta));
        }

        const existingCursor = await this.readSessionCursor(parsed.id);
        const nextSynced: Record<string, number> = {
          ...(existingCursor?.syncedRevisions ?? {}),
        };
        if (nextSynced[slug] === undefined) {
          nextSynced[slug] = parsed.lastSyncedRevision ?? 0;
        }
        await this.writeSessionCursor({
          sessionId: parsed.id,
          syncedRevisions: nextSynced,
          lastActiveAt: existingCursor?.lastActiveAt ?? parsed.updatedAt,
          ...(existingCursor?.lastCursorInjectAt
            ? { lastCursorInjectAt: existingCursor.lastCursorInjectAt }
            : {}),
        });

        assertActive();
        await fs.rm(legacyPath, { force: true });
      }
    }
  }

  private async ensureBoardDirs(slug: string): Promise<string> {
    const dir = this.boardPath(slug);
    await Promise.all([
      ensureDir(dir),
      ensureDir(this.sessionsDir),
      ensureDir(path.join(dir, 'decisions')),
      ensureDir(path.join(dir, 'tasks')),
      ensureDir(path.join(dir, 'diagrams')),
      ensureDir(path.join(dir, 'media')),
      ensureDir(path.join(dir, 'quizzes')),
    ]);
    return dir;
  }

  private workspaceMetaPath(): string {
    return path.join(this.deckDir, 'workspace.yaml');
  }

  public async getDefaultBoardSlug(): Promise<string> {
    if (this.defaultBoardHint && existsSync(this.boardPath(this.defaultBoardHint))) {
      return this.defaultBoardHint;
    }
    const meta = await readYamlStrict<WorkspaceMeta>(this.workspaceMetaPath());
    if (meta?.defaultBoard) {
      const valid = validateBoardSlug(meta.defaultBoard, 'defaultBoard');
      if (existsSync(this.boardPath(valid))) {
        return valid;
      }
    }
    const boards = await this.listBoards();
    if (boards.length > 0) {
      return boards[0].slug;
    }
    return this.defaultBoardHint ?? 'main';
  }

  public async setDefaultBoard(slug: string): Promise<void> {
    const validSlug = validateBoardSlug(slug);
    await withWorkspaceLock(
      this.runtimeDir,
      async (assertActive) => {
        await ensureDir(this.deckDir);
        assertActive();
        await atomicWriteFile(
          this.workspaceMetaPath(),
          dumpYaml({
            defaultBoard: validSlug,
            updatedAt: nowIso(),
          }),
        );
      },
      this.deckDir,
    );
  }

  public async resolveBoardSlug(boardSlug?: string): Promise<string> {
    if (boardSlug !== undefined && boardSlug !== '') {
      return validateBoardSlug(boardSlug);
    }
    return this.getDefaultBoardSlug();
  }

  public async listBoards(): Promise<BoardConfig[]> {
    let entries;
    try {
      entries = await fs.readdir(this.boardsDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        await this.assertBoardsDirSafe();
        return [];
      }
      throw err;
    }
    await this.assertBoardsDirSafe();

    const configs: BoardConfig[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      const boardDir = this.boardPath(entry.name);
      const expectedBoardYaml = path.join(boardDir, 'board.yaml');
      const boardYaml = await assertContainedPath(boardDir, expectedBoardYaml, {
        label: `board.yaml for "${entry.name}"`,
      });
      if (boardYaml !== expectedBoardYaml) {
        throw new SecurityError(
          `Access denied: board.yaml for "${entry.name}" resolves to an aliased file.`,
        );
      }
      const cfg = await readYamlStrict(boardYaml, BoardConfigSchema);
      if (cfg) configs.push(cfg);
    }
    return configs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  public async createBoard(
    rawInput: {
      title: string;
      slug?: string;
      description?: string;
      brief?: string;
      lenses?: LensConfig[];
      parentBoard?: string | null;
      paths?: string[];
      setAsDefault?: boolean;
    },
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<BoardConfig> {
    const input = parseStrict(CreateBoardInputSchema, rawInput, 'createBoard input');
    const validActor = parseStrict(ActorSchema, actor, 'actor');
    const slug = input.slug ? validateBoardSlug(input.slug) : validateBoardSlug(slugify(input.title));

    return withWorkspaceLock(this.runtimeDir, async (assertActive) => {
      this.assertBoardsDirSafeSync();
      await ensureDir(this.boardsDir);
      const dir = this.boardPath(slug);
      const boardYamlPath = path.join(dir, 'board.yaml');

      // D9: Refuse to overwrite an existing board (even if damaged/corrupt)
      if (existsSync(dir) || existsSync(boardYamlPath)) {
        throw new ConflictError(`Board "${slug}" already exists.`);
      }

      const existingBoards = await this.listBoards();
      // D15: Reject self-parent, missing parent, and hierarchy cycles
      validateBoardParentHierarchy(existingBoards, slug, input.parentBoard);

      const now = nowIso();
      const config: BoardConfig = BoardConfigSchema.parse({
        id: shortId('brd'),
        slug,
        title: input.title,
        description: input.description ?? '',
        revision: 1,
        lenses: input.lenses ?? DEFAULT_LENSES,
        ...(input.parentBoard !== undefined ? { parentBoard: input.parentBoard } : {}),
        ...(input.paths !== undefined ? { paths: input.paths } : {}),
        createdAt: now,
        updatedAt: now,
      });

      const initialBrief =
        input.brief ??
        `# ${config.title}\n\n${config.description || 'Shared living mental model for this topic. Any connected agent session can read and update this brief as understanding evolves.'}\n`;

      const initEvent = BoardEventSchema.parse({
        id: shortId('evt'),
        revision: 1,
        timestamp: now,
        actor: validActor,
        kind: 'board.init',
        entityId: config.id,
        summary: `Created board "${config.title}"`,
      });

      const eventsPath = path.join(dir, 'events.jsonl');
      const stagedTmpPaths: string[] = [];
      let createdBoardDir = false;
      try {
        assertActive();
        createdBoardDir = true;
        await this.ensureBoardDirs(slug);
        assertActive();
        const stagedResults = await Promise.allSettled([
          writeTempFileFsync(dir, initialBrief),
          writeTempFileFsync(dir, dumpYaml(config)),
        ]);
        for (const r of stagedResults) {
          if (r.status === 'fulfilled') stagedTmpPaths.push(r.value);
        }
        const firstRejected = stagedResults.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (firstRejected) throw firstRejected.reason;
        const briefTmp = (stagedResults[0] as PromiseFulfilledResult<string>).value;
        const boardTmp = (stagedResults[1] as PromiseFulfilledResult<string>).value;

        const txn: TxnJournal = {
          id: shortId('txn'),
          boardSlug: slug,
          ops: [
            {
              kind: 'rename',
              tmpPath: toDeckRelativePath(this.deckDir, briefTmp),
              finalPath: toDeckRelativePath(this.deckDir, path.join(dir, 'brief.md')),
            },
          ],
          events: [
            {
              eventsPath: toDeckRelativePath(this.deckDir, eventsPath),
              eventId: initEvent.id,
              line: `${JSON.stringify(initEvent)}\n`,
            },
          ],
          boardCommit: {
            tmpPath: toDeckRelativePath(this.deckDir, boardTmp),
            finalPath: toDeckRelativePath(this.deckDir, boardYamlPath),
          },
        };

        const txnPath = path.join(this.runtimeDir, TXN_FILENAME);
        assertActive();
        await atomicWriteFile(txnPath, `${JSON.stringify(txn, null, 2)}\n`);
        await executeTxnJournal(txnPath, txn, {
          deckDir: this.deckDir,
          assertActive,
          allowFaultInjection: true,
          checkEventDedupe: false,
        });
      } catch (err) {
        // R6-1: revalidate ownership itself, not the error type: a lost lock can surface as an unrelated I/O error.
        if (
          !(err instanceof LockCompromisedError) &&
          lockStillOwned(assertActive) &&
          !existsSync(path.join(this.runtimeDir, TXN_FILENAME))
        ) {
          await Promise.all(stagedTmpPaths.map((p) => fs.rm(p, { force: true }).catch(() => {})));
          if (createdBoardDir) {
            await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
          }
        }
        throw err;
      }

      const existing = await this.listBoards();
      if (input.setAsDefault || existing.length <= 1) {
        assertActive();
        await atomicWriteFile(
          this.workspaceMetaPath(),
          dumpYaml({ defaultBoard: slug, updatedAt: nowIso() }),
        );
      }

      return config;
    }, this.deckDir);
  }

  public async updateBoard(
    boardSlug: string,
    rawPatch: {
      title?: string;
      description?: string;
      lenses?: LensConfig[];
      parentBoard?: string | null;
      paths?: string[];
    },
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<BoardConfig> {
    const slug = validateBoardSlug(boardSlug);
    const patch = parseStrict(UpdateBoardInputSchema.omit({ actor: true }), rawPatch, 'board update');

    return this.mutate(slug, actor, async (tx) => {
      if (patch.parentBoard !== undefined) {
        const allBoards = await this.listBoards();
        validateBoardParentHierarchy(allBoards, slug, patch.parentBoard);
      }

      const nextPatch: Partial<Pick<BoardConfig, 'title' | 'description' | 'lenses' | 'parentBoard' | 'paths'>> = {};
      if (patch.title !== undefined) nextPatch.title = patch.title;
      if (patch.description !== undefined) nextPatch.description = patch.description;
      if (patch.lenses !== undefined) nextPatch.lenses = patch.lenses;
      if (patch.parentBoard !== undefined) nextPatch.parentBoard = patch.parentBoard;
      if (patch.paths !== undefined) nextPatch.paths = patch.paths;

      tx.setConfigPatch(nextPatch);
      const ev = tx.addEvent({
        kind: 'board.updated',
        entityId: tx.initialConfig.id,
        summary: `Updated board "${patch.title ?? tx.initialConfig.title}" (${slug})`,
      });

      return BoardConfigSchema.parse({
        ...tx.initialConfig,
        ...nextPatch,
        revision: ev.revision,
        updatedAt: ev.timestamp,
      });
    });
  }

  public async ensureDefaultBoard(title = 'Project Context'): Promise<BoardConfig> {
    const boards = await this.listBoards();
    if (boards.length > 0) {
      return boards[0];
    }
    return this.createBoard({ title, slug: 'main', setAsDefault: true });
  }

  /**
   * Single locked, roll-forward transactional mutation entry point (E1, D1).
   * Commit order (D1):
   *   stage temp files (fsync) -> write .runtime/txn.json -> rename/link entities
   *   -> append events + fdatasync -> atomically write board.yaml LAST -> delete txn.json.
   */
  public async mutate<T>(
    boardSlug: string | undefined,
    actor: Actor,
    fn: (tx: MutationContext) => Promise<T>,
    lockOptions?: WorkspaceLockOptions,
  ): Promise<T> {
    const validActor = parseStrict(ActorSchema, actor, 'actor');

    return withWorkspaceLock(
      this.runtimeDir,
      async (assertActive) => {
        await this.migrateLegacySessionsUnlocked(assertActive);
        const slug = await this.resolveBoardSlug(boardSlug);
        const boardDir = this.boardPath(slug);
        const initialConfig = await this.readBoardConfig(slug);
        const eventsPath = await this.safeBoardFilePath(slug, 'events.jsonl');
        const boardYamlPath = await this.safeBoardFilePath(slug, 'board.yaml');

        let currentRevision = initialConfig.revision;
        let configDirty = false;
        let configPatch: Partial<
          Pick<BoardConfig, 'title' | 'description' | 'lenses' | 'parentBoard' | 'paths'>
        > = {};
        const stagedWrites: StagedWrite[] = [];
        const eventsToAppend: TxnEventEntry[] = [];
        const afterCommitHooks: Array<() => Promise<void>> = [];

        const tx: MutationContext = {
          slug,
          boardDir,
          actor: validActor,
          initialConfig,
          getCurrentRevision: () => currentRevision,
          stageFile: (finalPath, content, options) => {
            stagedWrites.push({
              kind: 'write',
              finalPath,
              content,
              noClobber: options?.noClobber,
            });
          },
          stagePreStagedFile: (tmpPath, finalPath, options) => {
            stagedWrites.push({
              kind: 'pre_staged',
              tmpPath,
              finalPath,
              noClobber: options?.noClobber,
            });
          },
          stageDelete: (finalPath) => {
            stagedWrites.push({ kind: 'unlink', finalPath });
          },
          addEvent: (evInput) => {
            currentRevision += 1;
            configDirty = true;
            const ev = BoardEventSchema.parse({
              id: shortId('evt'),
              revision: currentRevision,
              timestamp: nowIso(),
              actor: evInput.actor ?? validActor,
              kind: evInput.kind,
              entityId: evInput.entityId,
              summary: evInput.summary,
              details: evInput.details,
            });
            eventsToAppend.push({
              eventsPath: toDeckRelativePath(this.deckDir, eventsPath),
              eventId: ev.id,
              line: `${JSON.stringify(ev)}\n`,
            });
            return ev;
          },
          markConfigDirty: () => {
            configDirty = true;
          },
          setConfigPatch: (patch) => {
            configPatch = { ...configPatch, ...patch };
            configDirty = true;
          },
          onAfterCommit: (hook) => {
            afterCommitHooks.push(hook);
          },
        };

        const result = await fn(tx);
        assertActive();

        if (
          stagedWrites.length === 0 &&
          eventsToAppend.length === 0 &&
          !configDirty &&
          afterCommitHooks.length === 0
        ) {
          return result;
        }

        if (stagedWrites.length > 0 || eventsToAppend.length > 0 || configDirty) {
          // Stage all temp files (fsynced) concurrently BEFORE writing txn.json so the OS/filesystem
          // can coalesce journal flushes while preserving the strict D1 commit barrier.
          const createdTmpFiles: string[] = [];
          const ops: TxnOp[] = [];
          let boardCommit: TxnJournal['boardCommit'];

          try {
            assertActive();
            const pendingTempWrites: Array<{
              slot: number | 'board';
              promise: Promise<string>;
            }> = [];

            for (let i = 0; i < stagedWrites.length; i += 1) {
              const item = stagedWrites[i];
              if (item.kind === 'write') {
                pendingTempWrites.push({
                  slot: i,
                  promise: writeTempFileFsync(path.dirname(item.finalPath), item.content!),
                });
              }
            }

            if (configDirty) {
              const nextConfig: BoardConfig = BoardConfigSchema.parse({
                ...initialConfig,
                ...configPatch,
                revision: currentRevision,
                updatedAt: nowIso(),
              });
              pendingTempWrites.push({
                slot: 'board',
                promise: writeTempFileFsync(boardDir, dumpYaml(nextConfig)),
              });
            }

            const settled = await Promise.allSettled(pendingTempWrites.map((w) => w.promise));
            const stagedTmpBySlot = new Map<number | 'board', string>();
            let firstError: unknown;
            for (let i = 0; i < settled.length; i += 1) {
              const res = settled[i];
              if (res.status === 'fulfilled') {
                createdTmpFiles.push(res.value);
                stagedTmpBySlot.set(pendingTempWrites[i].slot, res.value);
              } else if (firstError === undefined) {
                firstError = res.reason;
              }
            }
            if (firstError !== undefined) {
              throw firstError;
            }

            for (let i = 0; i < stagedWrites.length; i += 1) {
              const item = stagedWrites[i];
              if (item.kind === 'unlink') {
                ops.push({ kind: 'unlink', finalPath: toDeckRelativePath(this.deckDir, item.finalPath) });
              } else if (item.kind === 'write') {
                ops.push({
                  kind: item.noClobber ? 'link_create' : 'rename',
                  tmpPath: toDeckRelativePath(this.deckDir, stagedTmpBySlot.get(i)!),
                  finalPath: toDeckRelativePath(this.deckDir, item.finalPath),
                });
              } else if (item.kind === 'pre_staged') {
                ops.push({
                  kind: item.noClobber ? 'link_create' : 'rename',
                  tmpPath: toDeckRelativePath(this.deckDir, item.tmpPath!),
                  finalPath: toDeckRelativePath(this.deckDir, item.finalPath),
                });
              }
            }

            if (configDirty) {
              boardCommit = {
                tmpPath: toDeckRelativePath(this.deckDir, stagedTmpBySlot.get('board')!),
                finalPath: toDeckRelativePath(this.deckDir, boardYamlPath),
              };
            }

            const txn: TxnJournal = {
              id: shortId('txn'),
              boardSlug: slug,
              ops,
              events: eventsToAppend,
              boardCommit,
            };

            const txnPath = path.join(this.runtimeDir, TXN_FILENAME);
            assertActive();
            await atomicWriteFile(txnPath, `${JSON.stringify(txn, null, 2)}\n`);
            maybeInjectFault('after-txn-write');

            await executeTxnJournal(txnPath, txn, {
              deckDir: this.deckDir,
              assertActive,
              allowFaultInjection: true,
              checkEventDedupe: false,
            });
          } catch (err) {
            // Skip all filesystem cleanup if the lock was compromised (R5-5), and never
            // remove temp files once txn.json exists (roll-forward recovery needs them!).
            // R6-1: revalidate current lock ownership too, since a lost lock can surface as an unrelated I/O error.
            if (
              !(err instanceof LockCompromisedError) &&
              lockStillOwned(assertActive) &&
              !existsSync(path.join(this.runtimeDir, TXN_FILENAME))
            ) {
              await Promise.all(createdTmpFiles.map((p) => fs.rm(p, { force: true }).catch(() => {})));
            }
            throw err;
          }
        }

        for (const hook of afterCommitHooks) {
          assertActive();
          await hook();
        }
        return result;
      },
      this.deckDir,
      lockOptions,
    );
  }

  public async readBoardConfig(slug: string): Promise<BoardConfig> {
    const validSlug = validateBoardSlug(slug);
    const cfgPath = await this.safeBoardFilePath(validSlug, 'board.yaml');
    const cfg = await readYamlStrict(cfgPath, BoardConfigSchema);
    if (!cfg) {
      throw new NotFoundError(`Board "${validSlug}" does not exist.`);
    }
    return cfg;
  }

  public async readEvents(slug: string, maxRevision?: number): Promise<BoardEvent[]> {
    const validSlug = validateBoardSlug(slug);
    const eventsPath = await this.safeBoardFilePath(validSlug, 'events.jsonl');
    const raw = await readFileStrict(eventsPath);
    if (raw === null) return [];

    const events: BoardEvent[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(trimmed);
      } catch (err) {
        throw new CorruptDataError(
          `Corrupt JSONL line in ${eventsPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const parsed = BoardEventSchema.safeParse(parsedJson);
      if (!parsed.success) {
        throw new CorruptDataError(
          `Invalid event schema in ${eventsPath}: ${formatZodError(parsed.error)}`,
        );
      }
      if (maxRevision === undefined || parsed.data.revision <= maxRevision) {
        events.push(parsed.data);
      }
    }
    return events;
  }

  /**
   * Lightweight reverse-chunk tail reader for events.jsonl (E3 amended).
   * Reads backwards from EOF in 32 KB chunks and stops as soon as it sees
   * an event with revision <= afterRevision, keeping hook/digest latency
   * well under 300ms even with 5,000+ events.
   */
  public async readEventsSince(
    slug: string,
    afterRevision: number,
    maxRevision?: number,
  ): Promise<BoardEvent[]> {
    const validSlug = validateBoardSlug(slug);
    const eventsPath = await this.safeBoardFilePath(validSlug, 'events.jsonl');
    let fh: fs.FileHandle;
    try {
      fh = await fs.open(eventsPath, 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }

    const CHUNK_SIZE = 32 * 1024;
    const collected: BoardEvent[] = [];

    const parseEventLine = (lineBuf: Buffer): BoardEvent | null => {
      const trimmed = lineBuf.toString('utf8').trim();
      if (!trimmed) return null;
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(trimmed);
      } catch (err) {
        throw new CorruptDataError(
          `Corrupt JSONL line in ${eventsPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const parsed = BoardEventSchema.safeParse(parsedJson);
      if (!parsed.success) {
        throw new CorruptDataError(
          `Invalid event schema in ${eventsPath}: ${formatZodError(parsed.error)}`,
        );
      }
      return parsed.data;
    };

    try {
      const stat = await fh.stat();
      let position = stat.size;
      let carry: Buffer = Buffer.alloc(0);
      let done = false;

      while (position > 0 && !done) {
        const readSize = Math.min(CHUNK_SIZE, position);
        position -= readSize;
        const buf = Buffer.allocUnsafe(readSize);
        await fh.read(buf, 0, readSize, position);

        // Keep carry as raw bytes and split on 0x0A so multi-byte UTF-8 sequences
        // straddling 32 KB chunk boundaries are never decoded half-way (H5).
        const combined = carry.length > 0 ? Buffer.concat([buf, carry]) : buf;
        let regionStart = 0;

        if (position > 0) {
          const firstNl = combined.indexOf(0x0a);
          if (firstNl === -1) {
            carry = combined;
            continue;
          }
          carry = Buffer.from(combined.subarray(0, firstNl));
          regionStart = firstNl + 1;
        } else {
          carry = Buffer.alloc(0);
        }

        let lineEnd = combined.length;
        while (lineEnd > regionStart) {
          const nlIdx = combined.lastIndexOf(0x0a, lineEnd - 1);
          const lineStart = nlIdx >= regionStart ? nlIdx + 1 : regionStart;
          const lineBuf = combined.subarray(lineStart, lineEnd);
          lineEnd = nlIdx >= regionStart ? nlIdx : regionStart;

          const ev = parseEventLine(lineBuf);
          if (!ev) continue;
          if (ev.revision <= afterRevision) {
            done = true;
            break;
          }
          if (maxRevision === undefined || ev.revision <= maxRevision) {
            collected.push(ev);
          }
        }
      }

      if (!done && carry.length > 0) {
        const ev = parseEventLine(carry);
        if (ev && ev.revision > afterRevision && (maxRevision === undefined || ev.revision <= maxRevision)) {
          collected.push(ev);
        }
      }
    } finally {
      await fh.close();
    }

    collected.reverse();
    return collected;
  }

  private hydrateSession(
    raw: LegacySessionFile & { board: string },
    targetBoard: string,
    cursor: SessionCursor | null,
  ): Session {
    const syncedForBoard = cursor?.syncedRevisions[targetBoard];
    const fallbackSynced =
      targetBoard === raw.board ? (raw.lastSyncedRevision ?? 0) : 0;
    return SessionSchema.parse({
      id: raw.id,
      title: raw.title,
      harness: raw.harness,
      ...(raw.externalRef !== undefined ? { externalRef: raw.externalRef } : {}),
      board: raw.board,
      parentSessionId: raw.parentSessionId,
      relatedSessionIds: raw.relatedSessionIds,
      status: raw.status,
      summary: raw.summary,
      focusFiles: raw.focusFiles,
      lastSyncedRevision: syncedForBoard !== undefined ? syncedForBoard : fallbackSynced,
      ...(cursor?.lastActiveAt !== undefined ? { lastActiveAt: cursor.lastActiveAt } : {}),
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    });
  }

  private async readWorkspaceSessionRaw(
    sessionId: string,
  ): Promise<(LegacySessionFile & { board: string }) | null> {
    const validId = validateEntityId(sessionId, 'sessionId');
    const filePath = await this.safeSessionFilePath(validId);
    const parsed = await readYamlStrict(filePath, LegacySessionFileSchema);
    if (!parsed) return null;
    const board = parsed.board ?? (await this.getDefaultBoardSlug());
    return { ...parsed, board };
  }

  private async listAllRawSessions(): Promise<Array<LegacySessionFile & { board: string }>> {
    const byId = new Map<string, LegacySessionFile & { board: string }>();

    // 1. Workspace-scoped sessions in `<deck>/sessions/*.yaml` (canonical D11 location)
    const canonicalSessionsDir = await this.assertSessionsDirSafe();
    const wsFiles = await listFilesStrict(canonicalSessionsDir, '.yaml');
    for (const file of wsFiles) {
      const filePath = await assertContainedPath(
        canonicalSessionsDir,
        path.join(canonicalSessionsDir, file),
        { label: `session ${file}` },
      );
      const parsed = await readYamlStrict(filePath, LegacySessionFileSchema);
      if (parsed) {
        const board = parsed.board ?? (await this.getDefaultBoardSlug());
        byId.set(parsed.id, { ...parsed, board });
      }
    }

    // 2. Read-only fallback for unmigrated fabf58c board-scoped `boards/<slug>/sessions/*.yaml`
    let boardEntries: Dirent[] = [];
    try {
      boardEntries = await fs.readdir(this.boardsDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
    for (const entry of boardEntries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const legacyDir = path.join(this.boardsDir, entry.name, 'sessions');
      if (!existsSync(legacyDir)) continue;
      const safeDir = await this.safeBoardFilePath(entry.name, 'sessions');
      const legacyFiles = await listFilesStrict(safeDir, '.yaml');
      for (const file of legacyFiles) {
        const filePath = await assertContainedPath(safeDir, path.join(safeDir, file), {
          label: `legacy session ${file}`,
        });
        const parsed = await readYamlStrict(filePath, LegacySessionFileSchema);
        if (parsed && !byId.has(parsed.id)) {
          byId.set(parsed.id, { ...parsed, board: parsed.board ?? entry.name });
        }
      }
    }

    return Array.from(byId.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private async readSessionRawAcrossWorkspace(
    sessionId: string,
  ): Promise<(LegacySessionFile & { board: string }) | null> {
    const direct = await this.readWorkspaceSessionRaw(sessionId);
    if (direct) return direct;

    const validId = validateEntityId(sessionId, 'sessionId');
    let boardEntries;
    try {
      boardEntries = await fs.readdir(this.boardsDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    for (const entry of boardEntries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const legacyDir = path.join(this.boardsDir, entry.name, 'sessions');
      if (!existsSync(legacyDir)) continue;
      const legacyPath = await this.safeBoardFilePath(entry.name, 'sessions', `${validId}.yaml`);
      const parsed = await readYamlStrict(legacyPath, LegacySessionFileSchema);
      if (parsed) {
        return { ...parsed, board: parsed.board ?? entry.name };
      }
    }
    return null;
  }

  public async getSession(sessionId: string, boardForCursor?: string): Promise<Session | null> {
    const raw = await this.readSessionRawAcrossWorkspace(sessionId);
    if (!raw) return null;
    const cursor = await this.readSessionCursor(raw.id);
    return this.hydrateSession(raw, boardForCursor ?? raw.board, cursor);
  }

  public async findSessionByExternalRef(externalRef: string): Promise<Session | null> {
    if (!externalRef) return null;
    const all = await this.listAllRawSessions();
    const match = all.find((s) => s.externalRef === externalRef);
    if (!match) return null;
    const cursor = await this.readSessionCursor(match.id);
    return this.hydrateSession(match, match.board, cursor);
  }

  public async listAllSessions(): Promise<Session[]> {
    const rawAll = await this.listAllRawSessions();
    return Promise.all(
      rawAll.map(async (raw) => {
        const cursor = await this.readSessionCursor(raw.id);
        return this.hydrateSession(raw, raw.board, cursor);
      }),
    );
  }

  /**
   * Lightweight session drift check (E3 amended, D11, AC6.1):
   * Reads ONLY board.yaml, the single session yaml, its runtime cursor, and the tail of events.jsonl.
   * When `boardSlug` is omitted, defaults to the session's bound board (`session.board`).
   */
  public async getSessionDrift(
    boardSlug: string | undefined,
    sessionId: string,
    options: { maxDigestLines?: number } = {},
  ): Promise<
    SessionDigestResult & {
      session: Session;
      currentRevision: number;
    }
  > {
    validateEntityId(sessionId, 'sessionId');
    const raw = await this.readSessionRawAcrossWorkspace(sessionId);
    if (!raw) {
      throw new NotFoundError(`Session "${sessionId}" not found.`);
    }
    const slug = boardSlug ? validateBoardSlug(boardSlug) : validateBoardSlug(raw.board);
    const [config, cursor] = await Promise.all([
      this.readBoardConfig(slug),
      this.readSessionCursor(raw.id),
    ]);
    const session = this.hydrateSession(raw, slug, cursor);

    if (session.lastSyncedRevision >= config.revision) {
      return {
        session,
        currentRevision: config.revision,
        behindBy: 0,
        digest: [],
        digestText: '',
        truncatedCount: 0,
      };
    }

    const tailEvents = await this.readEventsSince(
      slug,
      session.lastSyncedRevision,
      config.revision,
    );

    const digestResult = buildSessionDriftDigest({
      sessionId: session.id,
      lastSyncedRevision: session.lastSyncedRevision,
      currentRevision: config.revision,
      events: tailEvents,
      maxLines: options.maxDigestLines,
    });

    return {
      session,
      currentRevision: config.revision,
      ...digestResult,
    };
  }

  public async listSessions(slug: string): Promise<Session[]> {
    const validSlug = validateBoardSlug(slug);
    const rawAll = await this.listAllRawSessions();
    const matching = rawAll.filter((s) => s.board === validSlug);
    return Promise.all(
      matching.map(async (raw) => {
        const cursor = await this.readSessionCursor(raw.id);
        return this.hydrateSession(raw, validSlug, cursor);
      }),
    );
  }

  public async listDecisions(slug: string): Promise<Decision[]> {
    const dir = await this.safeBoardFilePath(slug, 'decisions');
    const files = await listFilesStrict(dir, '.md');
    const out: Decision[] = [];
    for (const file of files) {
      const filePath = await assertContainedPath(dir, path.join(dir, file), { label: `decision ${file}` });
      const raw = await readFileStrict(filePath);
      if (raw === null) continue;
      let data: Record<string, unknown>;
      let body: string;
      try {
        ({ data, body } = parseFrontmatter<Record<string, unknown>>(raw));
      } catch (err) {
        throw new CorruptDataError(
          `Corrupt frontmatter in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const parsed = DecisionSchema.safeParse({ ...data, rationale: body });
      if (!parsed.success) {
        throw new CorruptDataError(
          `Invalid decision schema in ${filePath}: ${formatZodError(parsed.error)}`,
        );
      }
      out.push(parsed.data);
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  public async listTasks(slug: string): Promise<Task[]> {
    const dir = await this.safeBoardFilePath(slug, 'tasks');
    const files = await listFilesStrict(dir, '.md');
    const out: Task[] = [];
    for (const file of files) {
      const filePath = await assertContainedPath(dir, path.join(dir, file), { label: `task ${file}` });
      const raw = await readFileStrict(filePath);
      if (raw === null) continue;
      let data: Record<string, unknown>;
      let body: string;
      try {
        ({ data, body } = parseFrontmatter<Record<string, unknown>>(raw));
      } catch (err) {
        throw new CorruptDataError(
          `Corrupt frontmatter in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const parsed = TaskSchema.safeParse({ ...data, description: body });
      if (!parsed.success) {
        throw new CorruptDataError(
          `Invalid task schema in ${filePath}: ${formatZodError(parsed.error)}`,
        );
      }
      out.push(parsed.data);
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  public async listDiagrams(slug: string): Promise<Diagram[]> {
    const dir = await this.safeBoardFilePath(slug, 'diagrams');
    const metaFiles = await listFilesStrict(dir, '.meta.yaml');
    const out: Diagram[] = [];
    for (const metaFile of metaFiles) {
      const metaPath = await assertContainedPath(dir, path.join(dir, metaFile), {
        label: `diagram meta ${metaFile}`,
      });
      const meta = await readYamlStrict<Record<string, unknown>>(metaPath);
      if (!meta) continue;
      const baseName = metaFile.replace(/\.meta\.yaml$/, '');
      const ext = meta.kind === 'excalidraw' ? '.excalidraw' : '.mmd';
      const contentPath = await assertContainedPath(dir, path.join(dir, `${baseName}${ext}`), {
        label: `diagram content ${baseName}${ext}`,
      });
      const content = (await readFileStrict(contentPath)) ?? '';
      const parsed = DiagramSchema.safeParse({ ...meta, content });
      if (!parsed.success) {
        throw new CorruptDataError(
          `Invalid diagram schema in ${metaPath}: ${formatZodError(parsed.error)}`,
        );
      }
      out.push(parsed.data);
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  public async listMedia(slug: string, options: { loadContent?: boolean } = {}): Promise<MediaArtifact[]> {
    const { loadContent = true } = options;
    const dir = await this.safeBoardFilePath(slug, 'media');
    const metaFiles = await listFilesStrict(dir, '.meta.yaml');
    const out: MediaArtifact[] = [];
    for (const metaFile of metaFiles) {
      const metaPath = await assertContainedPath(dir, path.join(dir, metaFile), {
        label: `media meta ${metaFile}`,
      });
      const meta = await readYamlStrict<Record<string, unknown>>(metaPath);
      if (!meta) continue;
      let content = typeof meta.content === 'string' ? meta.content : undefined;
      if (
        loadContent &&
        !content &&
        typeof meta.filePath === 'string' &&
        (meta.kind === 'doc' || meta.kind === 'html' || meta.kind === 'json')
      ) {
        const contentPath = await assertContainedPath(dir, path.join(dir, meta.filePath), {
          label: `media content ${meta.filePath}`,
        });
        content = (await readFileStrict(contentPath)) ?? undefined;
      }
      const parsed = MediaArtifactSchema.safeParse({ ...meta, content });
      if (!parsed.success) {
        throw new CorruptDataError(
          `Invalid media schema in ${metaPath}: ${formatZodError(parsed.error)}`,
        );
      }
      out.push(parsed.data);
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  public async listQuizzes(slug: string): Promise<Quiz[]> {
    const dir = await this.safeBoardFilePath(slug, 'quizzes');
    const files = await listFilesStrict(dir, '.quiz.json');
    const out: Quiz[] = [];
    for (const file of files) {
      const filePath = await assertContainedPath(dir, path.join(dir, file), { label: `quiz ${file}` });
      const raw = await readFileStrict(filePath);
      if (raw === null) continue;
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch (err) {
        throw new CorruptDataError(
          `Corrupt JSON in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const parsed = QuizSchema.safeParse(json);
      if (!parsed.success) {
        throw new CorruptDataError(
          `Invalid quiz schema in ${filePath}: ${formatZodError(parsed.error)}`,
        );
      }
      out.push(parsed.data);
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private async readDecisionById(slug: string, decisionId: string): Promise<Decision | null> {
    const validId = validateEntityId(decisionId, 'decisionId');
    const filePath = await this.safeBoardFilePath(slug, 'decisions', `${validId}.md`);
    const raw = await readFileStrict(filePath);
    if (raw === null) return null;
    let data: Record<string, unknown>;
    let body: string;
    try {
      ({ data, body } = parseFrontmatter<Record<string, unknown>>(raw));
    } catch (err) {
      throw new CorruptDataError(
        `Corrupt frontmatter in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const parsed = DecisionSchema.safeParse({ ...data, rationale: body });
    if (!parsed.success) {
      throw new CorruptDataError(
        `Invalid decision schema in ${filePath}: ${formatZodError(parsed.error)}`,
      );
    }
    return parsed.data;
  }

  private async readTaskById(slug: string, taskId: string): Promise<Task | null> {
    const validId = validateEntityId(taskId, 'taskId');
    const filePath = await this.safeBoardFilePath(slug, 'tasks', `${validId}.md`);
    const raw = await readFileStrict(filePath);
    if (raw === null) return null;
    let data: Record<string, unknown>;
    let body: string;
    try {
      ({ data, body } = parseFrontmatter<Record<string, unknown>>(raw));
    } catch (err) {
      throw new CorruptDataError(
        `Corrupt frontmatter in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const parsed = TaskSchema.safeParse({ ...data, description: body });
    if (!parsed.success) {
      throw new CorruptDataError(
        `Invalid task schema in ${filePath}: ${formatZodError(parsed.error)}`,
      );
    }
    return parsed.data;
  }

  private async readDiagramById(slug: string, diagramId: string): Promise<Diagram | null> {
    const validId = validateEntityId(diagramId, 'diagramId');
    const dir = await this.safeBoardFilePath(slug, 'diagrams');
    const metaPath = await assertContainedPath(dir, path.join(dir, `${validId}.meta.yaml`), {
      label: `diagram meta ${validId}`,
    });
    const meta = await readYamlStrict<Record<string, unknown>>(metaPath);
    if (!meta) return null;
    const ext = meta.kind === 'excalidraw' ? '.excalidraw' : '.mmd';
    const contentPath = await assertContainedPath(dir, path.join(dir, `${validId}${ext}`), {
      label: `diagram content ${validId}${ext}`,
    });
    const content = (await readFileStrict(contentPath)) ?? '';
    const parsed = DiagramSchema.safeParse({ ...meta, content });
    if (!parsed.success) {
      throw new CorruptDataError(
        `Invalid diagram schema in ${metaPath}: ${formatZodError(parsed.error)}`,
      );
    }
    return parsed.data;
  }

  private async readMediaById(
    slug: string,
    mediaId: string,
    options: { loadContent?: boolean } = {},
  ): Promise<MediaArtifact | null> {
    const { loadContent = true } = options;
    const validId = validateEntityId(mediaId, 'mediaId');
    const dir = await this.safeBoardFilePath(slug, 'media');
    const metaPath = await assertContainedPath(dir, path.join(dir, `${validId}.meta.yaml`), {
      label: `media meta ${validId}`,
    });
    const meta = await readYamlStrict<Record<string, unknown>>(metaPath);
    if (!meta) return null;
    let content = typeof meta.content === 'string' ? meta.content : undefined;
    if (
      loadContent &&
      !content &&
      typeof meta.filePath === 'string' &&
      (meta.kind === 'doc' || meta.kind === 'html' || meta.kind === 'json')
    ) {
      const contentPath = await assertContainedPath(dir, path.join(dir, meta.filePath), {
        label: `media content ${meta.filePath}`,
      });
      content = (await readFileStrict(contentPath)) ?? undefined;
    }
    const parsed = MediaArtifactSchema.safeParse({ ...meta, content });
    if (!parsed.success) {
      throw new CorruptDataError(
        `Invalid media schema in ${metaPath}: ${formatZodError(parsed.error)}`,
      );
    }
    return parsed.data;
  }

  private async readQuizById(slug: string, quizId: string): Promise<Quiz | null> {
    const validId = validateEntityId(quizId, 'quizId');
    const quizPath = await this.safeBoardFilePath(slug, 'quizzes', `${validId}.quiz.json`);
    const raw = await readFileStrict(quizPath);
    if (raw === null) return null;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (err) {
      throw new CorruptDataError(
        `Corrupt quiz JSON at ${quizPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const quizParsed = QuizSchema.safeParse(parsedJson);
    if (!quizParsed.success) {
      throw new CorruptDataError(
        `Invalid quiz schema in ${quizPath}: ${formatZodError(quizParsed.error)}`,
      );
    }
    return quizParsed.data;
  }

  private async txnJournalExists(txnPath: string): Promise<boolean> {
    try {
      await fs.access(txnPath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw err;
    }
  }

  private async readSnapshotOnce(slug: string): Promise<BoardSnapshot> {
    const config = await this.readBoardConfig(slug);
    const briefPath = await this.safeBoardFilePath(slug, 'brief.md');
    const brief = (await readFileStrict(briefPath)) ?? '';

    const [sessions, decisions, tasks, diagrams, media, quizzes, events] = await Promise.all([
      this.listSessions(slug),
      this.listDecisions(slug),
      this.listTasks(slug),
      this.listDiagrams(slug),
      this.listMedia(slug),
      this.listQuizzes(slug),
      this.readEvents(slug, config.revision),
    ]);

    const drift = computeDriftReport({
      config,
      sessions,
      decisions,
      tasks,
      diagrams,
      media,
      quizzes,
      events,
    });

    return {
      config,
      brief,
      sessions,
      decisions,
      tasks,
      diagrams,
      media,
      quizzes,
      events,
      drift,
    };
  }

  /**
   * Consistent snapshot reader (E1 + D1 + R3-7):
   * treats any in-flight `.runtime/txn.json` (checked at start and end of each attempt)
   * or revision mismatch as unstable and retries with short backoff; when retries are
   * exhausted, acquires the workspace lock (running recovery if needed) and reads once
   * under the lock. Never returns an unverified snapshot.
   */
  public async getSnapshot(boardSlug?: string): Promise<BoardSnapshot> {
    const slug = await this.resolveBoardSlug(boardSlug);
    const txnPath = path.join(this.runtimeDir, TXN_FILENAME);
    const maxRetries = 4;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const txnBefore = await this.txnJournalExists(txnPath);
      if (txnBefore) {
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
          continue;
        }
        break;
      }

      const snapshot = await this.readSnapshotOnce(slug);
      // Order matters (R5-1): writer commits in strict order
      //   txn.json create -> entity renames -> events -> board.yaml commit -> txn.json remove.
      // Checking txnJournalExists BEFORE readBoardConfig prevents straddling a commit:
      // once the journal is observed absent, any overlapping commit has already updated
      // board.yaml, so the subsequent readBoardConfig is guaranteed to see the new revision
      // and force a retry.
      const txnAfter = await this.txnJournalExists(txnPath);
      if (!txnAfter) {
        const configAfter = await this.readBoardConfig(slug);
        if (configAfter.revision === snapshot.config.revision) {
          return snapshot;
        }
      }

      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
      }
    }

    return withWorkspaceLock(
      this.runtimeDir,
      async (assertActive) => {
        assertActive();
        return this.readSnapshotOnce(slug);
      },
      this.deckDir,
    );
  }

  // ---------------------------------------------------------------------------
  // Unlocked internal mutation helpers (called inside mutate() — D1 no deadlock)
  // ---------------------------------------------------------------------------

  private async updateBriefUnlocked(
    tx: MutationContext,
    brief: string,
    options?: { baseRevision?: number },
    actorOverride?: Actor,
  ): Promise<{ revision: number; brief: string }> {
    const validated = parseStrict(
      UpdateBriefInputSchema.omit({ actor: true }),
      {
        brief,
        ...(options?.baseRevision !== undefined ? { baseRevision: options.baseRevision } : {}),
      },
      'brief update',
    );
    const briefPath = await this.safeBoardFilePath(tx.slug, 'brief.md');
    const currentBrief = (await readFileStrict(briefPath)) ?? '';
    const committedRev = tx.initialConfig.revision;

    if (validated.baseRevision !== undefined) {
      const baseRev = validated.baseRevision;
      if (baseRev > committedRev) {
        throw new ConflictError(
          `Invalid baseRevision ${baseRev} exceeds current revision ${committedRev}.`,
          { currentRevision: committedRev, currentBrief, baseRevision: baseRev },
        );
      }
      if (baseRev < committedRev) {
        const events = await this.readEventsSince(tx.slug, baseRev, committedRev);
        const briefChangedSince = events.some(
          (ev) => ev.revision > baseRev && ev.kind === 'brief.updated',
        );
        if (briefChangedSince) {
          throw new ConflictError(
            `Brief conflict: brief was updated after revision ${baseRev} (current revision is ${committedRev}).`,
            { currentRevision: committedRev, currentBrief, baseRevision: baseRev },
          );
        }
      }
    }

    tx.stageFile(briefPath, validated.brief);
    const ev = tx.addEvent({
      kind: 'brief.updated',
      entityId: 'brief',
      summary: 'Updated living mental-model brief',
      actor: actorOverride,
    });
    return { revision: ev.revision, brief: validated.brief };
  }

  private async registerSessionUnlocked(
    tx: MutationContext,
    rawInput: {
      id?: string;
      title: string;
      harness?: string;
      externalRef?: string;
      parentSessionId?: string | null;
      relatedSessionIds?: string[];
      status?: SessionStatus;
      summary?: string;
      focusFiles?: string[];
      lastSyncedRevision?: number;
    },
    actorOverride?: Actor,
  ): Promise<Session> {
    const input = parseStrict(RegisterSessionInputSchema.omit({ actor: true }), rawInput, 'session');
    const effActor = actorOverride ?? tx.actor;
    const now = nowIso();
    await ensureDir(this.sessionsDir);

    // D11: Dedupe by externalRef when provided so repeated calls / resumes reuse the same session record
    let existing: (LegacySessionFile & { board: string }) | null = null;
    if (input.externalRef) {
      const all = await this.listAllRawSessions();
      existing = all.find((s) => s.externalRef === input.externalRef) ?? null;
    } else if (input.id) {
      existing = await this.readWorkspaceSessionRaw(input.id);
    }

    const id = existing
      ? existing.id
      : input.id
        ? validateEntityId(input.id, 'sessionId')
        : shortId('sess');
    const filePath = await this.safeSessionFilePath(id);
    const harness = input.harness ?? existing?.harness ?? effActor.harness ?? 'custom';

    const ev = tx.addEvent({
      kind: existing ? 'session.updated' : 'session.registered',
      entityId: id,
      summary: existing
        ? `Resumed ${harness} session "${input.title}"`
        : `Registered ${harness} session "${input.title}"`,
      actor: { ...effActor, harness, sessionId: id },
    });

    const meta = SessionMetadataSchema.parse({
      id,
      title: input.title,
      harness,
      ...(input.externalRef !== undefined
        ? { externalRef: input.externalRef }
        : existing?.externalRef !== undefined
          ? { externalRef: existing.externalRef }
          : {}),
      board: tx.slug,
      parentSessionId:
        input.parentSessionId !== undefined
          ? input.parentSessionId
          : (existing?.parentSessionId ?? null),
      relatedSessionIds: input.relatedSessionIds ?? existing?.relatedSessionIds ?? [],
      status: input.status ?? 'active',
      summary: input.summary !== undefined ? input.summary : (existing?.summary ?? ''),
      focusFiles: input.focusFiles ?? existing?.focusFiles ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });

    tx.stageFile(filePath, dumpYaml(meta));

    const existingCursor = await this.readSessionCursor(id);
    const existingRevForBoard = existingCursor?.syncedRevisions[tx.slug];
    const targetSyncedRevision =
      input.lastSyncedRevision !== undefined
        ? input.lastSyncedRevision
        : existingRevForBoard !== undefined
          ? existingRevForBoard
          : ev.revision;

    const nextCursor: SessionCursor = {
      sessionId: id,
      syncedRevisions: {
        ...(existingCursor?.syncedRevisions ?? {}),
        [tx.slug]: targetSyncedRevision,
      },
      lastActiveAt: now,
      ...(existingCursor?.lastCursorInjectAt
        ? { lastCursorInjectAt: existingCursor.lastCursorInjectAt }
        : {}),
    };

    tx.onAfterCommit(async () => {
      await this.writeSessionCursor(nextCursor);
    });

    return this.hydrateSession(meta, tx.slug, nextCursor);
  }

  private async updateSessionUnlocked(
    tx: MutationContext,
    sessionId: string,
    rawPatch: Record<string, unknown>,
    actorOverride?: Actor,
  ): Promise<Session> {
    validateEntityId(sessionId, 'sessionId');
    const patch = parseStrict(UpdateSessionPatchSchema.omit({ actor: true }), rawPatch, 'session patch');
    const effActor = actorOverride ?? tx.actor;
    const filePath = await this.safeSessionFilePath(sessionId);
    const existing = await this.readWorkspaceSessionRaw(sessionId);
    if (!existing) {
      throw new NotFoundError(`Session "${sessionId}" not found.`);
    }

    if (patch.board !== undefined) {
      // Verify target board exists
      await this.readBoardConfig(patch.board);
    }

    const nextBoard = patch.board ?? existing.board;

    // D7 / D11: Metadata updates NEVER move syncedRevisions cursor
    const updatedMeta = SessionMetadataSchema.parse({
      id: existing.id,
      title: patch.title !== undefined ? patch.title : existing.title,
      harness: patch.harness !== undefined ? patch.harness : existing.harness,
      ...(patch.externalRef !== undefined
        ? { externalRef: patch.externalRef }
        : existing.externalRef !== undefined
          ? { externalRef: existing.externalRef }
          : {}),
      board: nextBoard,
      parentSessionId:
        patch.parentSessionId !== undefined ? patch.parentSessionId : existing.parentSessionId,
      relatedSessionIds:
        patch.relatedSessionIds !== undefined
          ? patch.relatedSessionIds
          : existing.relatedSessionIds,
      status: patch.status !== undefined ? patch.status : existing.status,
      summary: patch.summary !== undefined ? patch.summary : existing.summary,
      focusFiles: patch.focusFiles !== undefined ? patch.focusFiles : existing.focusFiles,
      createdAt: existing.createdAt,
      updatedAt: nowIso(),
    });

    tx.stageFile(filePath, dumpYaml(updatedMeta));
    tx.addEvent({
      kind: 'session.updated',
      entityId: updatedMeta.id,
      summary: `Updated session "${updatedMeta.title}" (${updatedMeta.status})`,
      actor: { ...effActor, harness: updatedMeta.harness, sessionId: updatedMeta.id },
    });

    const cursor = await this.readSessionCursor(updatedMeta.id);
    return this.hydrateSession(updatedMeta, nextBoard, cursor);
  }

  private async applySupersessionUnlocked(
    tx: MutationContext,
    supersedingId: string,
    targetId: string,
    now: string,
    inMemoryExisting?: Decision[],
  ): Promise<Decision | undefined> {
    validateEntityId(targetId, 'supersedes');
    if (targetId === supersedingId) {
      throw new ValidationError(`Decision "${supersedingId}" cannot supersede itself.`);
    }

    const loadDecision = async (id: string): Promise<Decision | undefined> =>
      inMemoryExisting
        ? inMemoryExisting.find((d) => d.id === id)
        : ((await this.readDecisionById(tx.slug, id)) ?? undefined);

    // Reject supersession cycles (e.g. A -> B -> A)
    const visited = new Set<string>([supersedingId]);
    let cursorId: string | null | undefined = targetId;
    while (cursorId) {
      if (visited.has(cursorId)) {
        throw new ValidationError(
          `Supersession cycle detected: decision "${supersedingId}" cannot supersede "${targetId}".`,
        );
      }
      visited.add(cursorId);
      const node = await loadDecision(cursorId);
      cursorId = node?.supersedes ?? null;
    }

    const oldDecision = await loadDecision(targetId);
    if (!oldDecision) {
      return undefined;
    }

    if (oldDecision.supersededBy && oldDecision.supersededBy !== supersedingId) {
      throw new ValidationError(
        `Decision ${targetId} is already superseded by ${oldDecision.supersededBy}; supersede ${oldDecision.supersededBy} instead.`,
      );
    }

    const statusBeforeSupersede =
      oldDecision.status === 'superseded'
        ? oldDecision.statusBeforeSupersede
        : oldDecision.status;

    const updatedOld: Decision = DecisionSchema.parse({
      ...oldDecision,
      status: 'superseded',
      supersededBy: supersedingId,
      ...(statusBeforeSupersede !== undefined ? { statusBeforeSupersede } : {}),
      updatedAt: now,
    });
    const oldPath = await this.safeBoardFilePath(tx.slug, 'decisions', `${updatedOld.id}.md`);
    const { rationale: oldRat, ...oldFm } = updatedOld;
    tx.stageFile(oldPath, stringifyFrontmatter(oldFm, oldRat));
    if (inMemoryExisting) {
      const idx = inMemoryExisting.findIndex((d) => d.id === updatedOld.id);
      if (idx >= 0) inMemoryExisting[idx] = updatedOld;
    }
    return oldDecision;
  }

  private async recordDecisionUnlocked(
    tx: MutationContext,
    rawInput: {
      id?: string;
      title: string;
      status?: DecisionStatus;
      supersedes?: string | null;
      sessionId?: string | null;
      tags?: string[];
      summary?: string;
      rationale?: string;
    },
    actorOverride?: Actor,
    inMemoryExisting?: Decision[],
  ): Promise<Decision> {
    const input = parseStrict(RecordDecisionInputSchema.omit({ actor: true }), rawInput, 'decision');
    const effActor = actorOverride ?? tx.actor;
    const decisionsDir = await this.safeBoardFilePath(tx.slug, 'decisions');

    let id: string;
    let isNewSequential = false;
    if (input.id) {
      id = validateEntityId(input.id, 'decisionId');
    } else {
      isNewSequential = true;
      const diskFiles = await listFilesStrict(decisionsDir, '.md');
      const allIds = [
        ...(inMemoryExisting ? inMemoryExisting.map((d) => d.id) : []),
        ...diskFiles.map((f) => f.replace(/\.md$/, '')),
      ];
      id = nextSequentialId('dec', allIds);
      while (existsSync(path.join(decisionsDir, `${id}.md`))) {
        allIds.push(id);
        id = nextSequentialId('dec', allIds);
      }
    }

    const now = nowIso();
    const sessionId = input.sessionId ?? effActor.sessionId ?? null;
    const decision = DecisionSchema.parse({
      id,
      title: input.title,
      status: input.status ?? 'accepted',
      supersedes: input.supersedes ?? null,
      supersededBy: null,
      sessionId,
      tags: input.tags ?? [],
      summary: input.summary ?? '',
      rationale: input.rationale ?? '',
      createdAt: now,
      updatedAt: now,
    });

    let oldDecision: Decision | undefined;
    if (decision.supersedes) {
      oldDecision = await this.applySupersessionUnlocked(
        tx,
        decision.id,
        decision.supersedes,
        now,
        inMemoryExisting,
      );
    }

    const decPath = await this.safeBoardFilePath(tx.slug, 'decisions', `${decision.id}.md`);
    const { rationale, ...frontmatter } = decision;
    tx.stageFile(decPath, stringifyFrontmatter(frontmatter, rationale), {
      noClobber: isNewSequential,
    });

    if (inMemoryExisting) {
      inMemoryExisting.push(decision);
    }

    const eventActor: Actor = sessionId ? { ...effActor, sessionId } : effActor;
    tx.addEvent({
      kind: decision.supersedes ? 'decision.superseded' : 'decision.recorded',
      entityId: decision.id,
      summary: decision.supersedes
        ? `Recorded ${decision.id} ("${decision.title}"), superseding ${decision.supersedes}`
        : `Recorded ${decision.id} ("${decision.title}")`,
      actor: eventActor,
      details: {
        ...(decision.supersedes ? { supersedes: decision.supersedes } : {}),
        before: oldDecision
          ? {
              id: oldDecision.id,
              status: oldDecision.status,
              title: oldDecision.title,
              summary: oldDecision.summary,
            }
          : null,
        after: {
          id: decision.id,
          status: decision.status,
          title: decision.title,
          summary: decision.summary,
        },
      },
    });

    return decision;
  }

  private async upsertTaskUnlocked(
    tx: MutationContext,
    rawInput: {
      id?: string;
      title: string;
      column?: TaskColumn;
      priority?: TaskPriority;
      assignee?: string;
      linkedSessionIds?: string[];
      linkedDecisionIds?: string[];
      tags?: string[];
      description?: string;
    },
    actorOverride?: Actor,
    inMemoryExisting?: Task[],
  ): Promise<Task> {
    const input = parseStrict(UpsertTaskInputSchema.omit({ actor: true }), rawInput, 'task');
    const effActor = actorOverride ?? tx.actor;
    const existing = input.id
      ? inMemoryExisting
        ? inMemoryExisting.find((t) => t.id === input.id)
        : ((await this.readTaskById(tx.slug, input.id)) ?? undefined)
      : undefined;
    const tasksDir = await this.safeBoardFilePath(tx.slug, 'tasks');
    const now = nowIso();

    let id: string;
    let isNewSequential = false;
    if (existing) {
      id = existing.id;
    } else if (input.id) {
      id = validateEntityId(input.id, 'taskId');
    } else {
      isNewSequential = true;
      const diskFiles = await listFilesStrict(tasksDir, '.md');
      const allIds = [
        ...(inMemoryExisting ? inMemoryExisting.map((t) => t.id) : []),
        ...diskFiles.map((f) => f.replace(/\.md$/, '')),
      ];
      id = nextSequentialId('task', allIds);
      while (existsSync(path.join(tasksDir, `${id}.md`))) {
        allIds.push(id);
        id = nextSequentialId('task', allIds);
      }
    }

    const task = TaskSchema.parse({
      id,
      title: input.title,
      column: input.column ?? existing?.column ?? 'backlog',
      priority: input.priority ?? existing?.priority ?? 'medium',
      assignee: input.assignee ?? existing?.assignee ?? 'unassigned',
      linkedSessionIds:
        input.linkedSessionIds ??
        existing?.linkedSessionIds ??
        (effActor.sessionId ? [effActor.sessionId] : []),
      linkedDecisionIds: input.linkedDecisionIds ?? existing?.linkedDecisionIds ?? [],
      tags: input.tags ?? existing?.tags ?? [],
      description: input.description ?? existing?.description ?? '',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });

    const taskPath = await this.safeBoardFilePath(tx.slug, 'tasks', `${task.id}.md`);
    const { description, ...frontmatter } = task;
    tx.stageFile(taskPath, stringifyFrontmatter(frontmatter, description), {
      noClobber: isNewSequential,
    });

    if (inMemoryExisting) {
      const idx = inMemoryExisting.findIndex((t) => t.id === task.id);
      if (idx >= 0) inMemoryExisting[idx] = task;
      else inMemoryExisting.push(task);
    }

    tx.addEvent({
      kind: existing ? 'task.updated' : 'task.created',
      entityId: task.id,
      summary: existing
        ? `Updated ${task.id} ("${task.title}") → ${task.column}`
        : `Created ${task.id} ("${task.title}") in ${task.column}`,
      actor: effActor,
      details: {
        before: existing ? { column: existing.column, title: existing.title } : null,
        after: { column: task.column, title: task.title },
      },
    });

    return task;
  }

  private async upsertDiagramUnlocked(
    tx: MutationContext,
    rawInput: {
      id?: string;
      title: string;
      kind?: DiagramKind;
      content: string;
      description?: string;
      basedOnDecisions?: string[];
      sessionId?: string | null;
    },
    actorOverride?: Actor,
  ): Promise<Diagram> {
    const input = parseStrict(UpsertDiagramInputSchema.omit({ actor: true }), rawInput, 'diagram');
    const effActor = actorOverride ?? tx.actor;
    const existing = input.id ? ((await this.readDiagramById(tx.slug, input.id)) ?? undefined) : undefined;
    const now = nowIso();

    const kind = input.kind ?? existing?.kind ?? 'mermaid';
    const id = existing?.id ?? input.id ?? `diag_${slugify(input.title)}_${shortId('x').slice(2, 6)}`;
    validateEntityId(id, 'diagramId');

    // H10: Attribute the event ONLY to the actual caller's sessionId (never existing.sessionId),
    // while keeping existing.sessionId preserved as diagram metadata.
    const actorSessionId = input.sessionId ?? effActor.sessionId ?? undefined;
    const diagramSessionId =
      input.sessionId !== undefined ? input.sessionId : (effActor.sessionId ?? existing?.sessionId ?? null);
    const eventActor: Actor = actorSessionId ? { ...effActor, sessionId: actorSessionId } : effActor;
    const ev = tx.addEvent({
      kind: existing ? 'diagram.updated' : 'diagram.created',
      entityId: id,
      summary: `${existing ? 'Updated' : 'Created'} ${kind} diagram "${input.title}"`,
      actor: eventActor,
    });

    const diagram = DiagramSchema.parse({
      id,
      title: input.title,
      kind,
      content: input.content,
      description: input.description ?? existing?.description ?? '',
      basedOnDecisions: input.basedOnDecisions ?? existing?.basedOnDecisions ?? [],
      sessionId: diagramSessionId,
      boardRevisionAtUpdate: ev.revision,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });

    const ext = diagram.kind === 'excalidraw' ? '.excalidraw' : '.mmd';
    const { content, ...meta } = diagram;
    const contentPath = await this.safeBoardFilePath(tx.slug, 'diagrams', `${diagram.id}${ext}`);
    const metaPath = await this.safeBoardFilePath(tx.slug, 'diagrams', `${diagram.id}.meta.yaml`);
    tx.stageFile(contentPath, content);
    tx.stageFile(metaPath, dumpYaml(meta));

    return diagram;
  }

  private async updateMediaUnlocked(
    tx: MutationContext,
    mediaId: string,
    rawPatch: Record<string, unknown>,
    actorOverride?: Actor,
  ): Promise<MediaArtifact> {
    validateEntityId(mediaId, 'mediaId');
    const patch = parseStrict(UpdateMediaPatchSchema.omit({ actor: true }), rawPatch, 'media patch');
    const effActor = actorOverride ?? tx.actor;

    const existing = await this.readMediaById(tx.slug, mediaId, { loadContent: true });
    if (!existing) {
      throw new NotFoundError(`Media artifact "${mediaId}" not found on board "${tx.slug}".`);
    }

    const ev = tx.addEvent({
      kind: 'media.updated',
      entityId: existing.id,
      summary: `Updated ${existing.kind} artifact "${patch.title ?? existing.title}"`,
      actor: effActor,
    });

    const updated = MediaArtifactSchema.parse({
      ...existing,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.transcript !== undefined ? { transcript: patch.transcript } : {}),
      ...(patch.chapters !== undefined ? { chapters: patch.chapters } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.basedOnDecisions !== undefined ? { basedOnDecisions: patch.basedOnDecisions } : {}),
      ...(patch.externalUrl !== undefined ? { externalUrl: patch.externalUrl } : {}),
      ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
      // Never allow storage-managed fields to be overwritten by patch
      id: existing.id,
      filePath: existing.filePath,
      createdAt: existing.createdAt,
      boardRevisionAtUpdate: ev.revision,
      updatedAt: nowIso(),
    });

    const mediaDir = await this.safeBoardFilePath(tx.slug, 'media');
    if (patch.content !== undefined && updated.filePath) {
      const targetContentPath = await assertContainedPath(
        mediaDir,
        path.join(mediaDir, updated.filePath),
        { label: `media file for "${updated.id}"` },
      );
      tx.stageFile(targetContentPath, patch.content);
    }

    const metaPath = await assertContainedPath(
      mediaDir,
      path.join(mediaDir, `${updated.id}.meta.yaml`),
      { label: `media meta for "${updated.id}"` },
    );
    const { content: _inlineContent, ...metaOnly } = updated;
    tx.stageFile(metaPath, dumpYaml(updated.filePath ? metaOnly : updated));

    return updated;
  }

  private async createQuizUnlocked(
    tx: MutationContext,
    rawInput: {
      id?: string;
      title: string;
      topic?: string;
      description?: string;
      questions: QuizQuestion[];
      basedOnDecisions?: string[];
      sessionId?: string | null;
    },
    actorOverride?: Actor,
  ): Promise<Quiz> {
    const input = parseStrict(CreateQuizInputSchema.omit({ actor: true }), rawInput, 'quiz');
    const effActor = actorOverride ?? tx.actor;
    const id = input.id ? validateEntityId(input.id, 'quizId') : shortId('quiz');
    const sessionId = input.sessionId ?? effActor.sessionId ?? null;
    const eventActor: Actor = sessionId ? { ...effActor, sessionId } : effActor;

    const ev = tx.addEvent({
      kind: 'quiz.created',
      entityId: id,
      summary: `Created knowledge check quiz "${input.title}" (${input.questions.length} questions)`,
      actor: eventActor,
    });

    const now = nowIso();
    const quiz = QuizSchema.parse({
      id,
      title: input.title,
      topic: input.topic ?? '',
      description: input.description ?? '',
      questions: input.questions,
      attempts: [],
      basedOnDecisions: input.basedOnDecisions ?? [],
      sessionId,
      boardRevisionAtUpdate: ev.revision,
      createdAt: now,
      updatedAt: now,
    });

    const quizPath = await this.safeBoardFilePath(tx.slug, 'quizzes', `${quiz.id}.quiz.json`);
    tx.stageFile(quizPath, `${JSON.stringify(quiz, null, 2)}\n`);
    return quiz;
  }

  // ---------------------------------------------------------------------------
  // Public mutation API (thin wrappers over mutate())
  // ---------------------------------------------------------------------------

  public async updateBrief(
    boardSlug: string | undefined,
    brief: string,
    actor: Actor = DEFAULT_ACTOR,
    options?: { baseRevision?: number },
  ): Promise<{ revision: number; brief: string }> {
    return this.mutate(boardSlug, actor, (tx) => this.updateBriefUnlocked(tx, brief, options));
  }

  public async registerSession(
    boardSlug: string | undefined,
    input: {
      id?: string;
      title: string;
      harness?: string;
      externalRef?: string;
      parentSessionId?: string | null;
      relatedSessionIds?: string[];
      status?: SessionStatus;
      summary?: string;
      focusFiles?: string[];
      lastSyncedRevision?: number;
    },
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<Session> {
    return this.mutate(boardSlug, actor, (tx) => this.registerSessionUnlocked(tx, input));
  }

  public async updateSession(
    boardSlug: string | undefined,
    sessionId: string,
    patch: Partial<
      Pick<
        Session,
        | 'title'
        | 'harness'
        | 'externalRef'
        | 'board'
        | 'parentSessionId'
        | 'relatedSessionIds'
        | 'status'
        | 'summary'
        | 'focusFiles'
      >
    >,
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<Session> {
    let targetBoard = boardSlug;
    if (!targetBoard) {
      const existing = await this.readSessionRawAcrossWorkspace(sessionId);
      if (existing) targetBoard = existing.board;
    }
    return this.mutate(targetBoard, actor, (tx) =>
      this.updateSessionUnlocked(tx, sessionId, patch as Record<string, unknown>),
    );
  }

  /**
   * Rebind a workspace session to a different board (AC6.4).
   * Preserves per-board sync cursors in `.runtime/cursors/<id>.json`.
   */
  public async rebindSession(
    sessionId: string,
    targetBoardSlug: string,
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<Session> {
    validateEntityId(sessionId, 'sessionId');
    const validBoard = validateBoardSlug(targetBoardSlug);
    return this.mutate(validBoard, actor, (tx) =>
      this.updateSessionUnlocked(tx, sessionId, { board: validBoard }),
    );
  }

  /**
   * Advance a session's sync cursor for a board (D7, D11).
   * Writes ONLY `<deck>/.runtime/cursors/<id>.json` (never dirties git-tracked files).
   */
  public async syncSession(
    boardSlug: string | undefined,
    sessionId: string,
    options?: {
      ackRevision?: number;
      maxDigestLines?: number;
      stampCursorThrottle?: boolean;
      maxWaitMs?: number;
    },
  ): Promise<
    SessionDigestResult & {
      session: Session;
      currentRevision: number;
      ackRevision: number;
    }
  > {
    validateEntityId(sessionId, 'sessionId');
    const validatedOpts = parseStrict(
      SyncSessionInputSchema,
      options?.ackRevision !== undefined ? { ackRevision: options.ackRevision } : {},
      'syncSession options',
    );
    return withWorkspaceLock(
      this.runtimeDir,
      async (assertActive) => {
        await this.migrateLegacySessionsUnlocked(assertActive);
        const existing = await this.readWorkspaceSessionRaw(sessionId);
        if (!existing) {
          throw new NotFoundError(`Session "${sessionId}" not found.`);
        }

        const slug = boardSlug ? validateBoardSlug(boardSlug) : validateBoardSlug(existing.board);
        const config = await this.readBoardConfig(slug);
        const existingCursor = await this.readSessionCursor(existing.id);

        const currentRevision = config.revision;
        const prevSynced =
          existingCursor?.syncedRevisions[slug] ??
          (slug === existing.board ? (existing.lastSyncedRevision ?? 0) : 0);
        const requestedAck =
          validatedOpts.ackRevision !== undefined
            ? Math.min(validatedOpts.ackRevision, currentRevision)
            : currentRevision;
        const ackRevision = Math.max(prevSynced, requestedAck);

        const tailEvents =
          ackRevision > prevSynced
            ? await this.readEventsSince(slug, prevSynced, ackRevision)
            : [];
        const digestResult = buildSessionDriftDigest({
          sessionId: existing.id,
          lastSyncedRevision: prevSynced,
          currentRevision: ackRevision,
          events: tailEvents,
          maxLines: options?.maxDigestLines,
        });

        const now = nowIso();
        const nextCursor: SessionCursor = {
          sessionId: existing.id,
          syncedRevisions: {
            ...(existingCursor?.syncedRevisions ?? {}),
            [slug]: ackRevision,
          },
          lastActiveAt: now,
          ...(options?.stampCursorThrottle
            ? { lastCursorInjectAt: now }
            : existingCursor?.lastCursorInjectAt
              ? { lastCursorInjectAt: existingCursor.lastCursorInjectAt }
              : {}),
        };

        assertActive();
        await this.writeSessionCursor(nextCursor);

        return {
          session: this.hydrateSession(existing, slug, nextCursor),
          currentRevision,
          ackRevision,
          ...digestResult,
        };
      },
      this.deckDir,
      options?.maxWaitMs !== undefined ? { maxWaitMs: options.maxWaitMs } : undefined,
    );
  }

  public async deleteSession(
    boardSlug: string | undefined,
    sessionId: string,
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<void> {
    validateEntityId(sessionId, 'sessionId');
    let targetBoard = boardSlug;
    if (!targetBoard) {
      const existing = await this.readSessionRawAcrossWorkspace(sessionId);
      if (existing) targetBoard = existing.board;
    }
    await this.mutate(targetBoard, actor, async (tx) => {
      const filePath = await this.safeSessionFilePath(sessionId);
      tx.stageDelete(filePath);
      tx.addEvent({
        kind: 'session.deleted',
        entityId: sessionId,
        summary: `Removed session ${sessionId}`,
      });
      tx.onAfterCommit(async () => {
        await this.deleteSessionCursor(sessionId);
      });
    });
  }

  /**
   * Hook helper for SessionStart / sessionStart (AC5.1-AC5.4, D11, D12, D15):
   * - Runs under workspace lock bounded by `maxWaitMs` (default 800ms).
   * - Deduplicates by `externalRef`; never stores raw prompt text; routes new sessions via board `paths` globs.
   * - Does NOT bump `board.yaml` revision or churn `events.jsonl`.
   * - Advances `.runtime/cursors/<id>.json` to the snapshot revision returned.
   */
  public async upsertHookSession(params: {
    externalRef: string;
    harness: string;
    defaultTitle: string;
    cwd?: string;
    maxWaitMs?: number;
  }): Promise<{
    session: Session;
    boardSlug: string;
    snapshot: BoardSnapshot;
    created: boolean;
  }> {
    const maxWaitMs = params.maxWaitMs ?? 800;
    return withWorkspaceLock(
      this.runtimeDir,
      async (assertActive) => {
        await this.migrateLegacySessionsUnlocked(assertActive);
        const boards = await this.listBoards();
        if (boards.length === 0) {
          throw new NotFoundError('No ContextDeck boards exist in this workspace.');
        }
        const defaultBoard = await this.getDefaultBoardSlug();
        const existingBoardsSet = new Set(boards.map((b) => b.slug));

        const allRaw = await this.listAllRawSessions();
        const existing = allRaw.find((s) => s.externalRef === params.externalRef);

        const now = nowIso();
        let meta: SessionMetadata;
        let created = false;
        let boardSlug: string;

        if (existing) {
          boardSlug = existingBoardsSet.has(existing.board)
            ? existing.board
            : routeBoardForCwd(boards, params.cwd, this.projectRoot, defaultBoard);
          meta = SessionMetadataSchema.parse({
            id: existing.id,
            title: existing.title,
            harness: existing.harness,
            externalRef: existing.externalRef,
            board: boardSlug,
            parentSessionId: existing.parentSessionId,
            relatedSessionIds: existing.relatedSessionIds,
            status: existing.status === 'idle' || existing.status === 'paused' ? 'active' : existing.status,
            summary: existing.summary,
            focusFiles: existing.focusFiles,
            createdAt: existing.createdAt,
            updatedAt:
              existing.status === 'idle' || existing.status === 'paused' || boardSlug !== existing.board
                ? now
                : existing.updatedAt,
          });
          // Only write metadata YAML if status or bound board actually changed (keeps git clean on resume)
          if (meta.status !== existing.status || meta.board !== existing.board) {
            await ensureDir(this.sessionsDir);
            const filePath = await this.safeSessionFilePath(meta.id);
            assertActive();
            await atomicWriteFile(filePath, dumpYaml(meta));
          }
        } else {
          created = true;
          boardSlug = routeBoardForCwd(boards, params.cwd, this.projectRoot, defaultBoard);
          meta = SessionMetadataSchema.parse({
            id: shortId('sess'),
            title: params.defaultTitle,
            harness: params.harness,
            externalRef: params.externalRef,
            board: boardSlug,
            parentSessionId: null,
            relatedSessionIds: [],
            status: 'active',
            summary: '',
            focusFiles: [],
            createdAt: now,
            updatedAt: now,
          });
          await ensureDir(this.sessionsDir);
          const filePath = await this.safeSessionFilePath(meta.id);
          assertActive();
          await atomicWriteFile(filePath, dumpYaml(meta));
        }

        const snapshot = await this.readSnapshotOnce(boardSlug);
        const existingCursor = await this.readSessionCursor(meta.id);
        const nextCursor: SessionCursor = {
          sessionId: meta.id,
          syncedRevisions: {
            ...(existingCursor?.syncedRevisions ?? {}),
            [boardSlug]: snapshot.config.revision,
          },
          lastActiveAt: now,
          ...(existingCursor?.lastCursorInjectAt
            ? { lastCursorInjectAt: existingCursor.lastCursorInjectAt }
            : {}),
        };
        assertActive();
        await this.writeSessionCursor(nextCursor);

        return {
          session: this.hydrateSession(meta, boardSlug, nextCursor),
          boardSlug,
          snapshot,
          created,
        };
      },
      this.deckDir,
      { maxWaitMs },
    );
  }

  /**
   * Hook fast-path helper for UserPromptSubmit / postToolUse (AC5.2-AC5.4, D11, D12):
   * 1. Lock-free read of session, board.yaml, cursor, and events tail; exits immediately with 'noop' if not behind.
   * 2. Enforces optional throttleMs (Cursor 60s) without advancing cursor when throttled.
   * 3. Acquires bounded workspace lock (`maxWaitMs`, default 800ms) only when registering or emitting a digest.
   *    If the lock times out, throws LockTimeoutError and leaves the cursor unchanged.
   */
  public async checkAndSyncHookDrift(params: {
    externalRef: string;
    harness: string;
    defaultTitle: string;
    cwd?: string;
    throttleMs?: number;
    maxWaitMs?: number;
    maxDigestLines?: number;
    now?: Date;
  }): Promise<{
    action: 'noop' | 'throttled' | 'registered_silent' | 'digest';
    session?: Session;
    boardConfig?: BoardConfig;
    digestResult?: SessionDigestResult;
  }> {
    const maxWaitMs = params.maxWaitMs ?? 800;
    const nowDate = params.now ?? new Date();
    const nowMs = nowDate.getTime();

    // --- Lock-free fast path (D12) ---
    const fastMatch = (await this.listAllRawSessions()).find(
      (s) => s.externalRef === params.externalRef,
    );
    if (fastMatch) {
      const boardSlug = fastMatch.board;
      const [config, cursor] = await Promise.all([
        this.readBoardConfig(boardSlug),
        this.readSessionCursor(fastMatch.id),
      ]);
      const lastSynced =
        cursor?.syncedRevisions[boardSlug] ?? fastMatch.lastSyncedRevision ?? 0;

      if (lastSynced >= config.revision) {
        return { action: 'noop' };
      }

      const tailEvents = await this.readEventsSince(boardSlug, lastSynced, config.revision);
      const fastDigest = buildSessionDriftDigest({
        sessionId: fastMatch.id,
        lastSyncedRevision: lastSynced,
        currentRevision: config.revision,
        events: tailEvents,
        maxLines: params.maxDigestLines,
      });

      if (fastDigest.behindBy === 0 || fastDigest.digest.length === 0) {
        return { action: 'noop' };
      }

      if (params.throttleMs !== undefined && cursor?.lastCursorInjectAt) {
        const lastInjectMs = Date.parse(cursor.lastCursorInjectAt);
        if (Number.isFinite(lastInjectMs) && nowMs - lastInjectMs < params.throttleMs) {
          // D12: Never advance cursor when throttled
          return { action: 'throttled' };
        }
      }
    }

    // --- Locked commit path (only when registering a new session OR emitting a real digest) ---
    return withWorkspaceLock(
      this.runtimeDir,
      async (assertActive) => {
        await this.migrateLegacySessionsUnlocked(assertActive);
        const boards = await this.listBoards();
        if (boards.length === 0) {
          throw new NotFoundError('No ContextDeck boards exist in this workspace.');
        }
        const defaultBoard = await this.getDefaultBoardSlug();
        const existingBoardsSet = new Set(boards.map((b) => b.slug));

        const allRaw = await this.listAllRawSessions();
        const existing = allRaw.find((s) => s.externalRef === params.externalRef);
        const nowStr = nowDate.toISOString();

        if (!existing) {
          const boardSlug = routeBoardForCwd(boards, params.cwd, this.projectRoot, defaultBoard);
          const boardConfig = await this.readBoardConfig(boardSlug);
          const meta = SessionMetadataSchema.parse({
            id: shortId('sess'),
            title: params.defaultTitle,
            harness: params.harness,
            externalRef: params.externalRef,
            board: boardSlug,
            parentSessionId: null,
            relatedSessionIds: [],
            status: 'active',
            summary: '',
            focusFiles: [],
            createdAt: nowStr,
            updatedAt: nowStr,
          });
          await ensureDir(this.sessionsDir);
          const filePath = await this.safeSessionFilePath(meta.id);
          assertActive();
          await atomicWriteFile(filePath, dumpYaml(meta));

          const cursor: SessionCursor = {
            sessionId: meta.id,
            syncedRevisions: { [boardSlug]: boardConfig.revision },
            lastActiveAt: nowStr,
          };
          assertActive();
          await this.writeSessionCursor(cursor);

          return {
            action: 'registered_silent' as const,
            session: this.hydrateSession(meta, boardSlug, cursor),
            boardConfig,
          };
        }

        const boardSlug = existingBoardsSet.has(existing.board)
          ? existing.board
          : routeBoardForCwd(boards, params.cwd, this.projectRoot, defaultBoard);
        const [boardConfig, existingCursor] = await Promise.all([
          this.readBoardConfig(boardSlug),
          this.readSessionCursor(existing.id),
        ]);
        const lastSynced =
          existingCursor?.syncedRevisions[boardSlug] ??
          (boardSlug === existing.board ? (existing.lastSyncedRevision ?? 0) : 0);

        if (lastSynced >= boardConfig.revision) {
          return { action: 'noop' as const };
        }

        const tailEvents = await this.readEventsSince(boardSlug, lastSynced, boardConfig.revision);
        const digestResult = buildSessionDriftDigest({
          sessionId: existing.id,
          lastSyncedRevision: lastSynced,
          currentRevision: boardConfig.revision,
          events: tailEvents,
          maxLines: params.maxDigestLines,
        });

        if (digestResult.behindBy === 0 || digestResult.digest.length === 0) {
          return { action: 'noop' as const };
        }

        if (params.throttleMs !== undefined && existingCursor?.lastCursorInjectAt) {
          const lastInjectMs = Date.parse(existingCursor.lastCursorInjectAt);
          if (Number.isFinite(lastInjectMs) && nowMs - lastInjectMs < params.throttleMs) {
            return { action: 'throttled' as const };
          }
        }

        const nextCursor: SessionCursor = {
          sessionId: existing.id,
          syncedRevisions: {
            ...(existingCursor?.syncedRevisions ?? {}),
            [boardSlug]: boardConfig.revision,
          },
          lastActiveAt: nowStr,
          // D12: Cursor throttle stamps ONLY when a digest is actually emitted
          ...(params.throttleMs !== undefined
            ? { lastCursorInjectAt: nowStr }
            : existingCursor?.lastCursorInjectAt
              ? { lastCursorInjectAt: existingCursor.lastCursorInjectAt }
              : {}),
        };
        assertActive();
        await this.writeSessionCursor(nextCursor);

        return {
          action: 'digest' as const,
          session: this.hydrateSession(existing, boardSlug, nextCursor),
          boardConfig,
          digestResult,
        };
      },
      this.deckDir,
      { maxWaitMs },
    );
  }

  /**
   * Hook helper for SessionEnd / sessionEnd (AC5.2, D11, D12):
   * Marks the matching session `idle` without bumping board.yaml.
   */
  public async markHookSessionIdle(params: {
    externalRef: string;
    maxWaitMs?: number;
  }): Promise<boolean> {
    const fastMatch = (await this.listAllRawSessions()).find(
      (s) => s.externalRef === params.externalRef,
    );
    if (
      !fastMatch ||
      fastMatch.status === 'idle' ||
      fastMatch.status === 'completed' ||
      fastMatch.status === 'archived'
    ) {
      return false;
    }

    const maxWaitMs = params.maxWaitMs ?? 800;
    return withWorkspaceLock(
      this.runtimeDir,
      async (assertActive) => {
        await this.migrateLegacySessionsUnlocked(assertActive);
        const current = (await this.listAllRawSessions()).find(
          (s) => s.externalRef === params.externalRef,
        );
        if (
          !current ||
          current.status === 'idle' ||
          current.status === 'completed' ||
          current.status === 'archived'
        ) {
          return false;
        }
        const meta = SessionMetadataSchema.parse({
          id: current.id,
          title: current.title,
          harness: current.harness,
          ...(current.externalRef !== undefined ? { externalRef: current.externalRef } : {}),
          board: current.board,
          parentSessionId: current.parentSessionId,
          relatedSessionIds: current.relatedSessionIds,
          status: 'idle',
          summary: current.summary,
          focusFiles: current.focusFiles,
          createdAt: current.createdAt,
          updatedAt: nowIso(),
        });
        await ensureDir(this.sessionsDir);
        const filePath = await this.safeSessionFilePath(meta.id);
        assertActive();
        await atomicWriteFile(filePath, dumpYaml(meta));
        return true;
      },
      this.deckDir,
      { maxWaitMs },
    );
  }

  public async recordDecision(
    boardSlug: string | undefined,
    input: {
      id?: string;
      title: string;
      status?: DecisionStatus;
      supersedes?: string | null;
      sessionId?: string | null;
      tags?: string[];
      summary?: string;
      rationale?: string;
    },
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<Decision> {
    return this.mutate(boardSlug, actor, (tx) => this.recordDecisionUnlocked(tx, input));
  }

  public async updateDecision(
    boardSlug: string | undefined,
    decisionId: string,
    rawPatch: Partial<
      Pick<Decision, 'title' | 'status' | 'summary' | 'rationale' | 'tags' | 'supersedes'>
    >,
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<Decision> {
    validateEntityId(decisionId, 'decisionId');
    const patch = parseStrict(UpdateDecisionPatchSchema.omit({ actor: true }), rawPatch, 'decision patch');

    return this.mutate(boardSlug, actor, async (tx) => {
      const existing = await this.readDecisionById(tx.slug, decisionId);
      if (!existing) {
        throw new NotFoundError(`Decision "${decisionId}" not found on board "${tx.slug}".`);
      }
      const now = nowIso();
      const { statusBeforeSupersede: existingPriorStatus, ...restExisting } = existing;
      const nextStatus = patch.status ?? existing.status;
      const updated = DecisionSchema.parse({
        ...restExisting,
        ...(nextStatus === 'superseded' && existingPriorStatus !== undefined
          ? { statusBeforeSupersede: existingPriorStatus }
          : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
        ...(patch.rationale !== undefined ? { rationale: patch.rationale } : {}),
        ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
        ...(patch.supersedes !== undefined ? { supersedes: patch.supersedes } : {}),
        updatedAt: now,
      });

      // H9 / R3-5: Keep supersession graph consistent using the shared helper
      // (rejects self-supersede and cycles) and restore previous target when supersedes changes away.
      const prevSupersedes = existing.supersedes ?? null;
      const nextSupersedes = patch.supersedes !== undefined ? patch.supersedes : prevSupersedes;
      const supersedesChanged = patch.supersedes !== undefined && nextSupersedes !== prevSupersedes;
      const supersedingTarget =
        patch.supersedes !== undefined && patch.supersedes !== null ? patch.supersedes : null;

      let oldDecision: Decision | undefined;
      if (supersedingTarget) {
        oldDecision = await this.applySupersessionUnlocked(tx, updated.id, supersedingTarget, now);
      }

      let restoredPrevious: { before: Decision; after: Decision } | undefined;
      if (supersedesChanged && prevSupersedes) {
        const prevTarget = await this.readDecisionById(tx.slug, prevSupersedes);
        if (prevTarget && prevTarget.supersededBy === updated.id) {
          const { statusBeforeSupersede: priorStatus, ...restPrevTarget } = prevTarget;
          const restoredTarget = DecisionSchema.parse({
            ...restPrevTarget,
            supersededBy: null,
            status:
              prevTarget.status === 'superseded'
                ? (priorStatus ?? 'accepted')
                : prevTarget.status,
            updatedAt: now,
          });
          const prevPath = await this.safeBoardFilePath(
            tx.slug,
            'decisions',
            `${restoredTarget.id}.md`,
          );
          const { rationale: prevRat, ...prevFm } = restoredTarget;
          tx.stageFile(prevPath, stringifyFrontmatter(prevFm, prevRat));
          restoredPrevious = { before: prevTarget, after: restoredTarget };
        }
      }

      const decPath = await this.safeBoardFilePath(tx.slug, 'decisions', `${updated.id}.md`);
      const { rationale, ...frontmatter } = updated;
      tx.stageFile(decPath, stringifyFrontmatter(frontmatter, rationale));

      if (restoredPrevious) {
        tx.addEvent({
          kind: 'decision.updated',
          entityId: restoredPrevious.after.id,
          summary: `Restored decision ${restoredPrevious.after.id} ("${restoredPrevious.after.title}") [${restoredPrevious.after.status}] (no longer superseded by ${updated.id})`,
          details: {
            before: {
              status: restoredPrevious.before.status,
              title: restoredPrevious.before.title,
              summary: restoredPrevious.before.summary,
            },
            after: {
              status: restoredPrevious.after.status,
              title: restoredPrevious.after.title,
              summary: restoredPrevious.after.summary,
            },
            unSupersededBy: updated.id,
          },
        });
      }

      if (supersedingTarget) {
        tx.addEvent({
          kind: 'decision.superseded',
          entityId: updated.id,
          summary: `Updated decision ${updated.id} ("${updated.title}"), superseding ${supersedingTarget}`,
          details: {
            supersedes: supersedingTarget,
            ...(supersedesChanged && prevSupersedes ? { previousSupersedes: prevSupersedes } : {}),
            before: oldDecision
              ? {
                  id: oldDecision.id,
                  status: oldDecision.status,
                  title: oldDecision.title,
                  summary: oldDecision.summary,
                }
              : null,
            after: {
              id: updated.id,
              status: updated.status,
              title: updated.title,
              summary: updated.summary,
            },
          },
        });
      } else {
        tx.addEvent({
          kind: 'decision.updated',
          entityId: updated.id,
          summary: `Updated decision ${updated.id} ("${updated.title}") [${updated.status}]`,
          details: {
            ...(supersedesChanged && prevSupersedes ? { clearedSupersedes: prevSupersedes } : {}),
            before: { status: existing.status, title: existing.title, summary: existing.summary },
            after: { status: updated.status, title: updated.title, summary: updated.summary },
          },
        });
      }
      return updated;
    });
  }

  public async upsertTask(
    boardSlug: string | undefined,
    input: {
      id?: string;
      title: string;
      column?: TaskColumn;
      priority?: TaskPriority;
      assignee?: string;
      linkedSessionIds?: string[];
      linkedDecisionIds?: string[];
      tags?: string[];
      description?: string;
    },
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<Task> {
    return this.mutate(boardSlug, actor, (tx) => this.upsertTaskUnlocked(tx, input));
  }

  /**
   * Locked atomic task PATCH: reads latest task INSIDE the lock and merges only
   * fields explicitly present in `patch`, preventing silent field loss under concurrent PATCHes.
   */
  public async patchTask(
    boardSlug: string | undefined,
    taskId: string,
    rawPatch: Partial<
      Pick<
        Task,
        | 'title'
        | 'column'
        | 'priority'
        | 'assignee'
        | 'linkedSessionIds'
        | 'linkedDecisionIds'
        | 'tags'
        | 'description'
      >
    >,
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<Task> {
    validateEntityId(taskId, 'taskId');
    const patch = parseStrict(PatchTaskInputSchema.omit({ actor: true }), rawPatch, 'task patch');

    return this.mutate(boardSlug, actor, async (tx) => {
      const existing = await this.readTaskById(tx.slug, taskId);
      if (!existing) {
        throw new NotFoundError(`Task "${taskId}" not found on board "${tx.slug}".`);
      }
      const taskPath = await this.safeBoardFilePath(tx.slug, 'tasks', `${existing.id}.md`);

      const updated = TaskSchema.parse({
        ...existing,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.column !== undefined ? { column: patch.column } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.assignee !== undefined ? { assignee: patch.assignee } : {}),
        ...(patch.linkedSessionIds !== undefined ? { linkedSessionIds: patch.linkedSessionIds } : {}),
        ...(patch.linkedDecisionIds !== undefined ? { linkedDecisionIds: patch.linkedDecisionIds } : {}),
        ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: nowIso(),
      });

      const { description, ...frontmatter } = updated;
      tx.stageFile(taskPath, stringifyFrontmatter(frontmatter, description));
      tx.addEvent({
        kind: 'task.updated',
        entityId: updated.id,
        summary: `Updated ${updated.id} ("${updated.title}") → ${updated.column}`,
        details: {
          before: { column: existing.column, title: existing.title },
          after: { column: updated.column, title: updated.title },
        },
      });
      return updated;
    });
  }

  public async deleteTask(
    boardSlug: string | undefined,
    taskId: string,
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<void> {
    validateEntityId(taskId, 'taskId');
    await this.mutate(boardSlug, actor, async (tx) => {
      const taskPath = await this.safeBoardFilePath(tx.slug, 'tasks', `${taskId}.md`);
      let existing: Task | null = null;
      const raw = await readFileStrict(taskPath);
      if (raw !== null) {
        try {
          const { data, body } = parseFrontmatter<Record<string, unknown>>(raw);
          const parsed = TaskSchema.safeParse({ ...data, description: body });
          if (parsed.success) existing = parsed.data;
        } catch {
          // Deleting a corrupt task file must succeed as the user's remedy (R3-4)
          existing = null;
        }
      }
      tx.stageDelete(taskPath);
      tx.addEvent({
        kind: 'task.deleted',
        entityId: taskId,
        summary: `Deleted task ${taskId}`,
        details: {
          before: existing ? { column: existing.column, title: existing.title } : null,
          after: null,
        },
      });
    });
  }

  public async upsertDiagram(
    boardSlug: string | undefined,
    input: {
      id?: string;
      title: string;
      kind?: DiagramKind;
      content: string;
      description?: string;
      basedOnDecisions?: string[];
      sessionId?: string | null;
    },
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<Diagram> {
    return this.mutate(boardSlug, actor, (tx) => this.upsertDiagramUnlocked(tx, input));
  }

  public async deleteDiagram(
    boardSlug: string | undefined,
    diagramId: string,
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<void> {
    validateEntityId(diagramId, 'diagramId');
    await this.mutate(boardSlug, actor, async (tx) => {
      const [metaPath, mmdPath, excalPath] = await Promise.all([
        this.safeBoardFilePath(tx.slug, 'diagrams', `${diagramId}.meta.yaml`),
        this.safeBoardFilePath(tx.slug, 'diagrams', `${diagramId}.mmd`),
        this.safeBoardFilePath(tx.slug, 'diagrams', `${diagramId}.excalidraw`),
      ]);
      tx.stageDelete(metaPath);
      tx.stageDelete(mmdPath);
      tx.stageDelete(excalPath);
      tx.addEvent({
        kind: 'diagram.deleted',
        entityId: diagramId,
        summary: `Deleted diagram ${diagramId}`,
      });
    });
  }

  /**
   * Add a media artifact. Big media copies (sourceFilePath / fileBuffer / pre-staged upload)
   * are staged to a temp file in media/ OUTSIDE the workspace lock (D1), then moved into place
   * atomically inside mutate().
   */
  public async addMedia(
    boardSlug: string | undefined,
    input: {
      id?: string;
      title: string;
      kind: MediaKind;
      mimeType?: string;
      sourceFilePath?: string;
      stagedTempPath?: string;
      fileBuffer?: Buffer;
      fileName?: string;
      externalUrl?: string;
      content?: string;
      transcript?: string;
      chapters?: Array<{ timeSec: number; title: string }>;
      durationSec?: number;
      tags?: string[];
      basedOnDecisions?: string[];
      sessionId?: string | null;
      customLensId?: string;
      metadata?: Record<string, unknown>;
      maxBytes?: number;
    },
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<MediaArtifact> {
    const limit = input.maxBytes ?? this.maxMediaBytes;
    let preStagedTmp: string | undefined;
    let storedFileName: string | undefined;
    let ownPreStagedTmp = false;

    const safeExt = (rawName: string): string => {
      const ext = path.extname(rawName).toLowerCase();
      return /^\.[a-z0-9]{1,12}$/.test(ext) ? ext : '';
    };

    try {
      if (input.externalUrl !== undefined) {
        validateHttpUrl(input.externalUrl, 'externalUrl');
      }
      const id = input.id ? validateEntityId(input.id, 'mediaId') : shortId('art');
      const slug = await this.resolveBoardSlug(boardSlug);
      // Verify board exists before staging big files
      await this.readBoardConfig(slug);
      const mediaDir = await this.safeBoardFilePath(slug, 'media');
      await ensureDir(mediaDir);

      // Stage file bytes OUTSIDE the lock (D1)
      if (input.stagedTempPath) {
        const ext = input.fileName ? safeExt(input.fileName) : safeExt(input.stagedTempPath);
        storedFileName = `${id}${ext}`;
        // Ensure stagedTempPath lives inside mediaDir (same filesystem for atomic rename);
        // once validated, addMedia owns temp cleanup on every path (H2).
        const canonicalStagedTmp = await canonicalizePath(input.stagedTempPath);
        const verifiedTmp = await assertContainedPath(mediaDir, canonicalStagedTmp, {
          label: 'staged upload file',
        });
        preStagedTmp = verifiedTmp;
        ownPreStagedTmp = true;
      } else if (input.sourceFilePath) {
        const ext = safeExt(input.sourceFilePath);
        storedFileName = `${id}${ext}`;
        const staged = await streamFileToTempFsync(input.sourceFilePath, mediaDir, limit);
        preStagedTmp = staged.tmpPath;
        ownPreStagedTmp = true;
      } else if (input.fileBuffer) {
        if (input.fileBuffer.length > limit) {
          throw new ValidationError(`Uploaded file exceeds limit of ${limit} bytes.`);
        }
        const ext = input.fileName ? safeExt(input.fileName) : '';
        storedFileName = `${id}${ext}`;
        preStagedTmp = await writeTempFileFsync(mediaDir, input.fileBuffer, '.tmp-media-');
        ownPreStagedTmp = true;
      } else if (
        input.content !== undefined &&
        (input.kind === 'doc' || input.kind === 'html' || input.kind === 'json')
      ) {
        const ext = input.kind === 'html' ? '.html' : input.kind === 'json' ? '.json' : '.md';
        storedFileName = `${id}${ext}`;
        preStagedTmp = await writeTempFileFsync(mediaDir, input.content, '.tmp-media-');
        ownPreStagedTmp = true;
      }

      const sessionId = input.sessionId ?? actor.sessionId ?? null;
      const eventActor: Actor = sessionId ? { ...actor, sessionId } : actor;

      return await this.mutate(slug, eventActor, async (tx) => {
        const now = nowIso();
        const ev = tx.addEvent({
          kind: 'media.added',
          entityId: id,
          summary: `Attached ${input.kind} artifact "${input.title}"`,
        });

        const artifact = MediaArtifactSchema.parse({
          id,
          title: input.title,
          kind: input.kind,
          mimeType: input.mimeType,
          filePath: storedFileName,
          externalUrl: input.externalUrl,
          content: input.content,
          transcript: input.transcript,
          chapters: input.chapters ?? [],
          durationSec: input.durationSec,
          tags: input.tags ?? [],
          basedOnDecisions: input.basedOnDecisions ?? [],
          sessionId,
          boardRevisionAtUpdate: ev.revision,
          customLensId: input.customLensId,
          metadata: input.metadata ?? {},
          createdAt: now,
          updatedAt: now,
        });

        if (preStagedTmp && storedFileName) {
          const finalFilePath = await assertContainedPath(
            mediaDir,
            path.join(mediaDir, storedFileName),
            { label: `media file "${storedFileName}"` },
          );
          tx.stagePreStagedFile(preStagedTmp, finalFilePath);
        }

        const metaPath = await assertContainedPath(
          mediaDir,
          path.join(mediaDir, `${artifact.id}.meta.yaml`),
          { label: `media meta "${artifact.id}"` },
        );
        const { content: _inlineContent, ...metaOnly } = artifact;
        tx.stageFile(metaPath, dumpYaml(storedFileName ? metaOnly : artifact));

        return artifact;
      });
    } catch (err) {
      // Only remove staged temp if txn.json was NOT written (roll-forward needs it if txn.json exists)
      const txnExists = existsSync(path.join(this.runtimeDir, TXN_FILENAME));
      if (!txnExists) {
        if (ownPreStagedTmp && preStagedTmp) {
          await fs.rm(preStagedTmp, { force: true }).catch(() => {});
        } else if (input.stagedTempPath) {
          // If an error occurred before mediaDir verification, safely clean up if contained under boardsDir
          const base = path.basename(input.stagedTempPath);
          if (base.startsWith('.tmp-')) {
            await Promise.all([
              this.assertBoardsDirSafe(),
              canonicalizePath(input.stagedTempPath),
            ])
              .then(([canonicalBoardsDir, canonicalStaged]) =>
                assertContainedPath(canonicalBoardsDir, canonicalStaged, {
                  label: 'staged upload cleanup',
                }),
              )
              .then((verified) =>
                path.basename(verified).startsWith('.tmp-')
                  ? fs.rm(verified, { force: true })
                  : undefined,
              )
              .catch(() => {});
          }
        }
      }
      throw err;
    }
  }

  public async updateMedia(
    boardSlug: string | undefined,
    mediaId: string,
    patch: Partial<
      Pick<
        MediaArtifact,
        | 'title'
        | 'content'
        | 'transcript'
        | 'chapters'
        | 'tags'
        | 'basedOnDecisions'
        | 'externalUrl'
        | 'metadata'
      >
    >,
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<MediaArtifact> {
    return this.mutate(boardSlug, actor, (tx) =>
      this.updateMediaUnlocked(tx, mediaId, patch as Record<string, unknown>),
    );
  }

  public async deleteMedia(
    boardSlug: string | undefined,
    mediaId: string,
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<void> {
    validateEntityId(mediaId, 'mediaId');
    await this.mutate(boardSlug, actor, async (tx) => {
      const existing = await this.readMediaById(tx.slug, mediaId, { loadContent: false });
      const mediaDir = await this.safeBoardFilePath(tx.slug, 'media');
      const metaPath = await assertContainedPath(
        mediaDir,
        path.join(mediaDir, `${mediaId}.meta.yaml`),
        { label: `media meta "${mediaId}"` },
      );
      tx.stageDelete(metaPath);
      if (existing?.filePath) {
        const assetPath = await assertContainedPath(
          mediaDir,
          path.join(mediaDir, existing.filePath),
          { label: `media file "${mediaId}"` },
        );
        tx.stageDelete(assetPath);
      }
      tx.addEvent({
        kind: 'media.deleted',
        entityId: mediaId,
        summary: `Removed media artifact ${mediaId}`,
      });
    });
  }

  public async resolveMediaFilePath(
    boardSlug: string | undefined,
    mediaId: string,
  ): Promise<{ absolutePath: string; artifact: MediaArtifact } | null> {
    const slug = await this.resolveBoardSlug(boardSlug);
    validateEntityId(mediaId, 'mediaId');
    const artifact = await this.readMediaById(slug, mediaId, { loadContent: false });
    if (!artifact?.filePath) return null;
    const mediaDir = await this.safeBoardFilePath(slug, 'media');
    const candidate = path.join(mediaDir, artifact.filePath);
    const absolutePath = await assertContainedPath(mediaDir, candidate, {
      label: `media file for "${mediaId}"`,
    });
    if (!existsSync(absolutePath)) return null;
    return { absolutePath, artifact };
  }

  public async createQuiz(
    boardSlug: string | undefined,
    input: {
      id?: string;
      title: string;
      topic?: string;
      description?: string;
      questions: QuizQuestion[];
      basedOnDecisions?: string[];
      sessionId?: string | null;
    },
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<Quiz> {
    return this.mutate(boardSlug, actor, (tx) => this.createQuizUnlocked(tx, input));
  }

  public async submitQuizAttempt(
    boardSlug: string | undefined,
    quizId: string,
    rawInput: {
      answers: Record<string, number | string | boolean>;
      confidence?: number;
    },
    actor: Actor = { type: 'human', label: 'user' },
  ): Promise<{ quiz: Quiz; attempt: QuizAttempt }> {
    validateEntityId(quizId, 'quizId');
    const input = parseStrict(SubmitQuizAttemptInputSchema.omit({ actor: true }), rawInput, 'quiz attempt');

    return this.mutate(boardSlug, actor, async (tx) => {
      const quiz = await this.readQuizById(tx.slug, quizId);
      if (!quiz) {
        throw new NotFoundError(`Quiz "${quizId}" not found on board "${tx.slug}".`);
      }
      const quizPath = await this.safeBoardFilePath(tx.slug, 'quizzes', `${quiz.id}.quiz.json`);
      const { score, total, percentage } = scoreQuizAttempt(quiz.questions, input.answers);
      const attempt = QuizAttemptSchema.parse({
        id: shortId('att'),
        takenAt: nowIso(),
        score,
        total,
        percentage,
        confidence: input.confidence,
        answers: input.answers,
      });

      const updatedQuiz: Quiz = {
        ...quiz,
        attempts: [...quiz.attempts, attempt],
        updatedAt: nowIso(),
      };

      tx.stageFile(quizPath, `${JSON.stringify(updatedQuiz, null, 2)}\n`);
      tx.addEvent({
        kind: 'quiz.attempted',
        entityId: quiz.id,
        summary: `Completed quiz "${quiz.title}" — ${score}/${total} (${percentage}%)`,
      });

      return { quiz: updatedQuiz, attempt };
    });
  }

  public async refreshArtifactDecisions(
    boardSlug: string | undefined,
    artifactType: 'diagram' | 'media' | 'quiz' | 'task',
    artifactId: string,
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<void> {
    validateEntityId(artifactId, 'artifactId');

    await this.mutate(boardSlug, actor, async (tx) => {
      const decisions = await this.listDecisions(tx.slug);
      const map = new Map(decisions.map((d) => [d.id, d]));

      const upgradeDecisionIds = (ids: string[]): string[] => {
        const next = new Set<string>();
        for (const id of ids) {
          let cur = map.get(id);
          const seen = new Set<string>();
          while (cur?.supersededBy && !seen.has(cur.id)) {
            seen.add(cur.id);
            const replacement = map.get(cur.supersededBy);
            if (!replacement) break;
            cur = replacement;
          }
          if (cur && cur.status !== 'deprecated') {
            next.add(cur.id);
          }
        }
        return Array.from(next);
      };

      if (artifactType === 'diagram') {
        const item = await this.readDiagramById(tx.slug, artifactId);
        if (!item) throw new NotFoundError(`Diagram "${artifactId}" not found.`);
        await this.upsertDiagramUnlocked(tx, {
          id: item.id,
          title: item.title,
          kind: item.kind,
          content: item.content,
          description: item.description,
          basedOnDecisions: upgradeDecisionIds(item.basedOnDecisions),
        });
        return;
      }

      if (artifactType === 'media') {
        const item = await this.readMediaById(tx.slug, artifactId, { loadContent: false });
        if (!item) throw new NotFoundError(`Media "${artifactId}" not found.`);
        await this.updateMediaUnlocked(tx, artifactId, {
          basedOnDecisions: upgradeDecisionIds(item.basedOnDecisions),
        });
        return;
      }

      if (artifactType === 'task') {
        const item = await this.readTaskById(tx.slug, artifactId);
        if (!item) throw new NotFoundError(`Task "${artifactId}" not found.`);
        await this.upsertTaskUnlocked(tx, {
          id: item.id,
          title: item.title,
          linkedDecisionIds: upgradeDecisionIds(item.linkedDecisionIds),
        });
        return;
      }

      if (artifactType === 'quiz') {
        const quiz = await this.readQuizById(tx.slug, artifactId);
        if (!quiz) throw new NotFoundError(`Quiz "${artifactId}" not found.`);
        const quizPath = await this.safeBoardFilePath(tx.slug, 'quizzes', `${quiz.id}.quiz.json`);
        const ev = tx.addEvent({
          kind: 'artifact.refreshed',
          entityId: quiz.id,
          summary: `Marked quiz "${quiz.title}" aligned with latest decisions`,
        });
        const updated: Quiz = {
          ...quiz,
          basedOnDecisions: upgradeDecisionIds(quiz.basedOnDecisions),
          boardRevisionAtUpdate: ev.revision,
          updatedAt: nowIso(),
        };
        tx.stageFile(quizPath, `${JSON.stringify(updated, null, 2)}\n`);
      }
    });
  }

  public async applyContextUpdate(
    boardSlug: string | undefined,
    rawPayload: ContextUpdatePayload,
    actor: Actor = { type: 'agent', label: 'web-chat' },
  ): Promise<{ appliedCount: number; sessionId?: string; snapshot: BoardSnapshot }> {
    const payload = parseStrict(ContextUpdatePayloadSchema, rawPayload, 'context update payload');
    const slug = await this.resolveBoardSlug(boardSlug);

    const { appliedCount, activeSessionId } = await this.mutate(slug, actor, async (tx) => {
      let count = 0;
      let currentSessionId = payload.sessionId;
      const effectiveActor: Actor = {
        ...actor,
        harness: payload.harness ?? actor.harness ?? 'web-chat',
      };

      if (payload.sessionId) {
        const sessions = await this.listSessions(tx.slug);
        const found = sessions.find((s) => s.id === payload.sessionId);
        if (found) {
          await this.updateSessionUnlocked(
            tx,
            found.id,
            { summary: payload.sessionSummary ?? found.summary },
            effectiveActor,
          );
          count += 1;
        }
      } else if (payload.sessionTitle) {
        const created = await this.registerSessionUnlocked(
          tx,
          {
            title: payload.sessionTitle,
            harness: payload.harness ?? 'grok',
            summary: payload.sessionSummary ?? '',
          },
          effectiveActor,
        );
        currentSessionId = created.id;
        count += 1;
      }

      const withSessionActor: Actor = currentSessionId
        ? { ...effectiveActor, sessionId: currentSessionId }
        : effectiveActor;

      if (payload.brief !== undefined) {
        if (payload.baseRevision === undefined) {
          throw new ValidationError(
            'Context update payload includes "brief" and requires "baseRevision" to prevent overwriting newer brief edits.',
            { field: 'baseRevision' },
          );
        }
        await this.updateBriefUnlocked(
          tx,
          payload.brief,
          { baseRevision: payload.baseRevision },
          withSessionActor,
        );
        count += 1;
      }

      if (payload.decisions && payload.decisions.length > 0) {
        const existingDecisions = await this.listDecisions(tx.slug);
        for (const dec of payload.decisions) {
          await this.recordDecisionUnlocked(
            tx,
            { ...dec, sessionId: currentSessionId },
            withSessionActor,
            existingDecisions,
          );
          count += 1;
        }
      }

      if (payload.tasks && payload.tasks.length > 0) {
        const existingTasks = await this.listTasks(tx.slug);
        for (const task of payload.tasks) {
          await this.upsertTaskUnlocked(
            tx,
            {
              ...task,
              linkedSessionIds: currentSessionId ? [currentSessionId] : undefined,
            },
            withSessionActor,
            existingTasks,
          );
          count += 1;
        }
      }

      for (const diag of payload.diagrams ?? []) {
        await this.upsertDiagramUnlocked(tx, { ...diag, sessionId: currentSessionId }, withSessionActor);
        count += 1;
      }

      for (const quiz of payload.quizzes ?? []) {
        await this.createQuizUnlocked(tx, { ...quiz, sessionId: currentSessionId }, withSessionActor);
        count += 1;
      }

      return { appliedCount: count, activeSessionId: currentSessionId };
    });

    const snapshot = await this.getSnapshot(slug);
    return { appliedCount, sessionId: activeSessionId, snapshot };
  }

  public async createUploadTempFilePath(boardSlug: string | undefined): Promise<{
    slug: string;
    mediaDir: string;
    tmpPath: string;
  }> {
    const slug = await this.resolveBoardSlug(boardSlug);
    await this.readBoardConfig(slug);
    const mediaDir = await this.safeBoardFilePath(slug, 'media');
    await ensureDir(mediaDir);
    const tmpPath = path.join(mediaDir, `.tmp-upload-${crypto.randomBytes(8).toString('hex')}`);
    return { slug, mediaDir, tmpPath };
  }

  public watch(
    onChange: (boardSlug: string | null, changedPath: string) => void,
    options: WatchOptions = {},
  ): FSWatcher {
    const { scope = 'all', debounceMs = 150 } = options;
    const timers = new Map<string, NodeJS.Timeout>();

    const isIgnoredPath = (filePath: string): boolean => {
      const rel = path.relative(this.deckDir, filePath);
      const segments = rel.split(path.sep);
      for (const seg of segments) {
        if (
          seg === '.runtime' ||
          seg === '.cache' ||
          seg.startsWith('.lock') ||
          seg.includes('.tmp')
        ) {
          return true;
        }
      }
      if (scope === 'board-configs') {
        const boardsRel = path.relative(this.boardsDir, filePath);
        if (boardsRel.startsWith('..') || path.isAbsolute(boardsRel)) {
          return filePath !== this.boardsDir && filePath !== this.deckDir;
        }
        const parts = boardsRel.split(path.sep).filter(Boolean);
        if (parts.length === 1) return false;
        if (parts.length === 2 && parts[1] === 'board.yaml') return false;
        if (parts.length > 0) return true;
      }
      return false;
    };

    const watchRoot = scope === 'board-configs' ? this.boardsDir : this.deckDir;
    const watcher = chokidar.watch(watchRoot, {
      ignoreInitial: true,
      depth: scope === 'board-configs' ? 2 : undefined,
      ignored: isIgnoredPath,
    });

    const trigger = (filePath: string) => {
      if (isIgnoredPath(filePath)) return;
      const rel = path.relative(this.boardsDir, filePath);
      const parts = rel.split(path.sep);
      const slug = parts.length > 0 && parts[0] && !parts[0].startsWith('..') ? parts[0] : null;
      const key = slug ?? '__workspace__';
      const existing = timers.get(key);
      if (existing) clearTimeout(existing);
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          onChange(slug, filePath);
        }, debounceMs),
      );
    };

    watcher.on('add', trigger).on('change', trigger).on('unlink', trigger);
    const origClose = watcher.close.bind(watcher);
    watcher.close = async () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      await origClose();
    };
    return watcher;
  }
}
