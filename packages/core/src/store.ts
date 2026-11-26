import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync, type Dirent } from 'node:fs';
import yaml from 'js-yaml';
import chokidar, { type FSWatcher } from 'chokidar';
import type { ZodType, ZodTypeDef } from 'zod';
import {
  ActorSchema,
  ArtifactConfirmationSchema,
  ArtifactVersionEntrySchema,
  BoardConfigSchema,
  BoardEventSchema,
  ClaimJobInputSchema,
  CompleteJobInputSchema,
  ConfirmArtifactInputSchema,
  ContextUpdatePayloadSchema,
  CreateBoardInputSchema,
  CreateQuizInputSchema,
  CreateRefreshJobInputSchema,
  DEFAULT_LENSES,
  DecisionSchema,
  DiagramSchema,
  LegacySessionFileSchema,
  MediaArtifactSchema,
  PatchTaskInputSchema,
  QuizAttemptSchema,
  QuizSchema,
  ReaderCursorFileSchema,
  RecordDecisionInputSchema,
  RefreshJobArtifactTypeSchema,
  RefreshJobSchema,
  RegisterSessionInputSchema,
  ReleaseJobInputSchema,
  RenewJobInputSchema,
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
  UpdateQuizPatchSchema,
  UpdateSessionPatchSchema,
  UpsertDiagramInputSchema,
  UpsertTaskInputSchema,
  type Actor,
  type ArtifactConfirmation,
  type ArtifactVersionEntry,
  type BoardConfig,
  type BoardEvent,
  type BoardSnapshot,
  type CatchUpReport,
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
  type ReaderBoardCursor,
  type ReaderCursorFile,
  type RefreshJob,
  type RefreshJobArtifactType,
  type RefreshJobStatus,
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
  LockTimeoutError,
  NotFoundError,
  SecurityError,
  ValidationError,
} from './errors.js';
import {
  BOARD_SLUG_REGEX,
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
import { CONTEXTDECK_DIR_NAME, readGlobalWorkspacePointerBoard } from './workspace.js';
import { routeBoardForCwd, validateBoardParentHierarchy } from './routing.js';
import { parseFrontmatter, stringifyFrontmatter } from './markdown.js';
import {
  buildSessionDriftDigest,
  computeDriftReport,
  evaluateDecisionStaleness,
  isMeaningfulEvent,
  resolveLatestDecision,
  type SessionDigestResult,
} from './drift.js';
import { computeCatchUp, resolveDefaultReaderId } from './catchup.js';
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
export const DEFAULT_JOB_LEASE_TTL_MS = 15 * 60 * 1000; // 15 minutes (D19)
const MAX_ARTIFACT_HISTORY = 10; // AC7.6

function appendArtifactHistory(
  existing: {
    version: number;
    updatedAt: string;
    boardRevisionAtUpdate: number;
    basedOnDecisions: string[];
    filePath?: string;
    history: ArtifactVersionEntry[];
  },
  nextEntry: ArtifactVersionEntry,
): ArtifactVersionEntry[] {
  const base: ArtifactVersionEntry[] =
    existing.history.length > 0
      ? [...existing.history]
      : [
          ArtifactVersionEntrySchema.parse({
            version: existing.version,
            updatedAt: existing.updatedAt,
            boardRevision: existing.boardRevisionAtUpdate,
            basedOnDecisions: existing.basedOnDecisions,
            ...(existing.filePath ? { filePath: existing.filePath } : {}),
          }),
        ];
  base.push(ArtifactVersionEntrySchema.parse(nextEntry));
  return base.slice(-MAX_ARTIFACT_HISTORY);
}

function retainRelevantConfirmations(
  confirmations: Record<string, ArtifactConfirmation>,
  basedOnDecisions: string[],
): Record<string, ArtifactConfirmation> {
  const allowed = new Set(basedOnDecisions);
  const out: Record<string, ArtifactConfirmation> = {};
  for (const [k, v] of Object.entries(confirmations)) {
    if (allowed.has(k)) out[k] = v;
  }
  return out;
}

export interface ContextDeckStoreOptions {
  deckDir: string;
  projectRoot?: string;
  defaultBoard?: string;
  /** Path to `.contextdeck.yaml` pointer in global mode so default board changes are observed dynamically (R2-7). */
  pointerPath?: string;
  maxMediaBytes?: number;
}

export interface WatchOptions {
  scope?: 'all' | 'board-configs';
  debounceMs?: number;
}

export interface HookDeliveryAck {
  sessionId: string;
  boardSlug: string;
  revision: number;
  stampCursorThrottle?: boolean;
  now?: string;
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
  public readonly readersDir: string;
  public readonly pointerPath?: string;
  private _defaultBoardHint?: string;
  public readonly maxMediaBytes: number;

  public get defaultBoardHint(): string | undefined {
    return this._defaultBoardHint;
  }

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
      this.pointerPath = rootDirOrOptions.pointerPath
        ? canonicalizePathSync(path.resolve(rootDirOrOptions.pointerPath))
        : undefined;
      this._defaultBoardHint = rootDirOrOptions.defaultBoard
        ? validateBoardSlug(rootDirOrOptions.defaultBoard, 'defaultBoard')
        : undefined;
      this.maxMediaBytes = rootDirOrOptions.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES;
    }
    this.runtimeDir = path.join(this.deckDir, '.runtime');
    this.boardsDir = path.join(this.deckDir, 'boards');
    this.sessionsDir = path.join(this.deckDir, 'sessions');
    this.cursorsDir = path.join(this.runtimeDir, 'cursors');
    this.readersDir = path.join(this.runtimeDir, 'readers');
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

  private async assertCursorsDirSafe(): Promise<string> {
    let canonicalDeckDir: string;
    let canonicalRuntimeDir: string;
    let canonicalCursorsDir: string;
    try {
      [canonicalDeckDir, canonicalRuntimeDir, canonicalCursorsDir] = await Promise.all([
        canonicalizePath(this.deckDir),
        canonicalizePath(this.runtimeDir),
        canonicalizePath(this.cursorsDir),
      ]);
    } catch (err) {
      if (err instanceof SecurityError) {
        throw new CorruptDataError(err.message);
      }
      throw err;
    }
    const expectedRuntimeDir = path.join(canonicalDeckDir, '.runtime');
    if (canonicalRuntimeDir !== expectedRuntimeDir) {
      throw new CorruptDataError(
        `Unsafe runtime directory "${this.runtimeDir}": resolves outside workspace deck.`,
      );
    }
    const expectedCursorsDir = path.join(expectedRuntimeDir, 'cursors');
    if (canonicalCursorsDir !== expectedCursorsDir) {
      throw new CorruptDataError(
        `Unsafe cursors directory "${this.cursorsDir}": resolves outside workspace deck.`,
      );
    }
    return canonicalCursorsDir;
  }

  private async safeCursorFilePath(sessionId: string): Promise<string> {
    const validId = validateEntityId(sessionId, 'sessionId');
    const canonicalCursorsDir = await this.assertCursorsDirSafe();
    const candidate = path.join(canonicalCursorsDir, `${validId}.json`);
    let resolved: string;
    try {
      resolved = await assertContainedPath(canonicalCursorsDir, candidate, {
        label: `cursor "${validId}"`,
      });
    } catch (err) {
      if (err instanceof SecurityError) {
        throw new CorruptDataError(err.message);
      }
      throw err;
    }
    if (resolved !== candidate) {
      throw new CorruptDataError(
        `Unsafe cursor file: cursor "${validId}" resolves to an aliased file.`,
      );
    }
    return resolved;
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

  private async assertReadersDirSafe(): Promise<string> {
    let canonicalDeckDir: string;
    let canonicalRuntimeDir: string;
    let canonicalReadersDir: string;
    try {
      [canonicalDeckDir, canonicalRuntimeDir, canonicalReadersDir] = await Promise.all([
        canonicalizePath(this.deckDir),
        canonicalizePath(this.runtimeDir),
        canonicalizePath(this.readersDir),
      ]);
    } catch (err) {
      if (err instanceof SecurityError) {
        throw new CorruptDataError(err.message);
      }
      throw err;
    }
    const expectedRuntimeDir = path.join(canonicalDeckDir, '.runtime');
    if (canonicalRuntimeDir !== expectedRuntimeDir) {
      throw new CorruptDataError(
        `Unsafe runtime directory "${this.runtimeDir}": resolves outside workspace deck.`,
      );
    }
    const expectedReadersDir = path.join(expectedRuntimeDir, 'readers');
    if (canonicalReadersDir !== expectedReadersDir) {
      throw new CorruptDataError(
        `Unsafe readers directory "${this.readersDir}": resolves outside workspace deck.`,
      );
    }
    return canonicalReadersDir;
  }

  private async safeReaderFilePath(readerId: string): Promise<string> {
    const validId = validateEntityId(readerId, 'readerId');
    const canonicalReadersDir = await this.assertReadersDirSafe();
    const candidate = path.join(canonicalReadersDir, `${validId}.yaml`);
    let resolved: string;
    try {
      resolved = await assertContainedPath(canonicalReadersDir, candidate, {
        label: `reader "${validId}"`,
      });
    } catch (err) {
      if (err instanceof SecurityError) {
        throw new CorruptDataError(err.message);
      }
      throw err;
    }
    if (resolved !== candidate) {
      throw new CorruptDataError(`Unsafe reader file: reader "${validId}" resolves to an aliased file.`);
    }
    return resolved;
  }

  public async readReaderCursorFile(readerId?: string): Promise<ReaderCursorFile | null> {
    const id = readerId
      ? validateEntityId(readerId, 'readerId')
      : resolveDefaultReaderId({ projectRoot: this.projectRoot });
    const filePath = await this.safeReaderFilePath(id);
    return readYamlStrict(filePath, ReaderCursorFileSchema);
  }

  /**
   * Read per-human, per-board reader cursor from `.runtime/readers/<readerId>.yaml` (AC7.1, D16).
   */
  public async getReaderCursor(
    boardSlug?: string,
    readerId?: string,
  ): Promise<ReaderBoardCursor | null> {
    const slug = await this.resolveBoardSlug(boardSlug);
    const file = await this.readReaderCursorFile(readerId);
    return file?.boards[slug] ?? null;
  }

  /**
   * Acknowledge a displayed board revision for a human reader (AC7.1, AC7.2, D16).
   * Writes ONLY `.runtime/readers/<readerId>.yaml` (never appends reader events to events.jsonl
   * and never bumps board.yaml). Monotonically advances via max().
   */
  public async ackReaderCursor(
    boardSlug: string | undefined,
    ackRevision: number,
    options: { readerId?: string; now?: string } = {},
  ): Promise<ReaderBoardCursor> {
    if (!Number.isInteger(ackRevision) || ackRevision < 0) {
      throw new ValidationError('ackRevision must be a non-negative integer.');
    }
    const id = options.readerId
      ? validateEntityId(options.readerId, 'readerId')
      : resolveDefaultReaderId({ projectRoot: this.projectRoot });
    const slug = await this.resolveBoardSlug(boardSlug);

    return withWorkspaceLock(
      this.runtimeDir,
      async (assertActive) => {
        const config = await this.readBoardConfig(slug);
        const existingFile = await this.readReaderCursorFile(id);
        const prev = existingFile?.boards[slug];
        const clamped = Math.min(ackRevision, config.revision);
        const nextRev = Math.max(prev?.lastReviewedRevision ?? 0, clamped);
        const nowStr = options.now ?? nowIso();
        const nextEntry: ReaderBoardCursor = {
          lastReviewedRevision: nextRev,
          lastReviewedAt: nowStr,
        };
        const nextFile: ReaderCursorFile = ReaderCursorFileSchema.parse({
          readerId: id,
          boards: {
            ...(existingFile?.boards ?? {}),
            [slug]: nextEntry,
          },
          updatedAt: nowStr,
        });
        const filePath = await this.safeReaderFilePath(id);
        await ensureDir(path.dirname(filePath));
        assertActive();
        await atomicWriteFile(filePath, dumpYaml(nextFile));
        return nextEntry;
      },
      this.deckDir,
    );
  }

  public async getCatchUp(
    boardSlug?: string,
    options: { readerId?: string } = {},
  ): Promise<CatchUpReport> {
    const slug = await this.resolveBoardSlug(boardSlug);
    const [snapshot, cursor] = await Promise.all([
      this.getSnapshot(slug),
      this.getReaderCursor(slug, options.readerId),
    ]);
    return computeCatchUp(snapshot, cursor);
  }

  private sessionMetadataFingerprint(meta: SessionMetadata): string {
    return JSON.stringify({
      id: meta.id,
      title: meta.title,
      harness: meta.harness,
      externalRef: meta.externalRef ?? null,
      board: meta.board,
      parentSessionId: meta.parentSessionId,
      relatedSessionIds: meta.relatedSessionIds,
      status: meta.status,
      summary: meta.summary,
      focusFiles: meta.focusFiles,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
    });
  }

  /**
   * Migrate pre-B2 board-scoped session files (`boards/<slug>/sessions/<id>.yaml`)
   * to workspace-scoped `<deck>/sessions/<id>.yaml` (metadata only) +
   * `<deck>/.runtime/cursors/<id>.json` (volatile sync state) on first write (D11).
   * Must be called while holding the workspace lock. Does not bump board revisions.
   *
   * - Ignores stray non-slug directories or directories without `board.yaml` (H12).
   * - Detects colliding same-ID sessions with differing board/content before deleting anything:
   *   preserves all conflicting originals, migrates non-conflicting sessions, cleans up empty
   *   legacy `sessions/` dirs, and raises a clear CorruptDataError naming the conflicting paths (H3).
   */
  private async migrateLegacySessionsUnlocked(
    assertActive: () => void,
    options: {
      skipCorrupt?: boolean;
      onCorrupt?: (filePath: string, err: unknown) => void;
    } = {},
  ): Promise<void> {
    const { skipCorrupt = false, onCorrupt } = options;
    let boardEntries;
    try {
      boardEntries = await fs.readdir(this.boardsDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }

    const legacyDirs: Array<{ slug: string; safeDir: string }> = [];
    for (const entry of boardEntries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (!BOARD_SLUG_REGEX.test(entry.name)) continue;
      if (!existsSync(path.join(this.boardsDir, entry.name, 'board.yaml'))) continue;
      const legacySessionDir = path.join(this.boardsDir, entry.name, 'sessions');
      if (existsSync(legacySessionDir)) {
        const safeDir = await this.safeBoardFilePath(entry.name, 'sessions');
        legacyDirs.push({ slug: entry.name, safeDir });
      }
    }
    if (legacyDirs.length === 0) return;

    interface LegacyRecord {
      slug: string;
      safeDir: string;
      legacyPath: string;
      parsed: LegacySessionFile;
      meta: SessionMetadata;
    }

    const byId = new Map<string, LegacyRecord[]>();
    const touchedDirs = new Set<string>();

    for (const { slug, safeDir } of legacyDirs) {
      assertActive();
      touchedDirs.add(safeDir);
      const files = await listFilesStrict(safeDir, '.yaml');
      if (files.length === 0) continue;

      for (const file of files) {
        assertActive();
        const legacyPath = await assertContainedPath(safeDir, path.join(safeDir, file), {
          label: `legacy session ${file}`,
        });
        let parsed: LegacySessionFile | null;
        try {
          parsed = await readYamlStrict(legacyPath, LegacySessionFileSchema);
        } catch (err) {
          if (skipCorrupt && err instanceof CorruptDataError) {
            // R2-9: On hook paths, leave corrupt original in place, log it, and migrate the rest
            onCorrupt?.(legacyPath, err);
            continue;
          }
          throw err;
        }
        if (!parsed) continue;

        let meta: SessionMetadata;
        try {
          meta = SessionMetadataSchema.parse({
            id: parsed.id,
            title: parsed.title,
            harness: parsed.harness,
            ...(parsed.externalRef !== undefined ? { externalRef: parsed.externalRef } : {}),
            board: parsed.board ?? slug,
            parentSessionId: parsed.parentSessionId,
            relatedSessionIds: parsed.relatedSessionIds,
            status: parsed.status,
            summary: parsed.summary,
            focusFiles: parsed.focusFiles,
            createdAt: parsed.createdAt,
            updatedAt: parsed.updatedAt,
          });
        } catch (err) {
          if (skipCorrupt) {
            onCorrupt?.(legacyPath, err);
            continue;
          }
          throw err;
        }

        const group = byId.get(parsed.id) ?? [];
        group.push({ slug, safeDir, legacyPath, parsed, meta });
        byId.set(parsed.id, group);
      }
    }

    if (byId.size > 0) {
      await ensureDir(this.sessionsDir);
      await this.assertSessionsDirSafe();
    }

    const conflicts: Array<{ id: string; paths: string[] }> = [];

    for (const [id, group] of byId.entries()) {
      assertActive();
      const targetSessionPath = await this.safeSessionFilePath(id);
      let existingWsMeta: SessionMetadata | null = null;
      if (existsSync(targetSessionPath)) {
        try {
          existingWsMeta = await readYamlStrict(targetSessionPath, SessionMetadataSchema);
        } catch (err) {
          if (skipCorrupt && err instanceof CorruptDataError) {
            onCorrupt?.(targetSessionPath, err);
            continue;
          }
          throw err;
        }
      }

      const baselineFingerprint = this.sessionMetadataFingerprint(
        existingWsMeta ?? group[0].meta,
      );
      const hasConflict = group.some(
        (rec) => this.sessionMetadataFingerprint(rec.meta) !== baselineFingerprint,
      );

      if (hasConflict) {
        const conflictPaths = [
          ...(existingWsMeta ? [targetSessionPath] : []),
          ...group.map((rec) => rec.legacyPath),
        ];
        conflicts.push({ id, paths: conflictPaths });
        // Fail closed for this ID: keep all originals untouched on disk
        continue;
      }

      let existingCursor: SessionCursor | null;
      try {
        existingCursor = await this.readSessionCursor(id);
      } catch (err) {
        if (skipCorrupt && err instanceof CorruptDataError) {
          onCorrupt?.(path.join(this.cursorsDir, `${id}.json`), err);
          continue;
        }
        throw err;
      }

      if (!existingWsMeta) {
        assertActive();
        await atomicWriteFile(targetSessionPath, dumpYaml(group[0].meta));
      }

      const nextSynced: Record<string, number> = {
        ...(existingCursor?.syncedRevisions ?? {}),
      };
      let lastActiveAt = existingCursor?.lastActiveAt ?? group[0].parsed.updatedAt;
      for (const rec of group) {
        if (nextSynced[rec.slug] === undefined) {
          nextSynced[rec.slug] = rec.parsed.lastSyncedRevision ?? 0;
        }
        if (rec.parsed.updatedAt > lastActiveAt) {
          lastActiveAt = rec.parsed.updatedAt;
        }
      }

      assertActive();
      await this.writeSessionCursor({
        sessionId: id,
        syncedRevisions: nextSynced,
        lastActiveAt,
        ...(existingCursor?.lastCursorInjectAt
          ? { lastCursorInjectAt: existingCursor.lastCursorInjectAt }
          : {}),
      });

      for (const rec of group) {
        assertActive();
        await fs.rm(rec.legacyPath, { force: true });
      }
    }

    // Best-effort cleanup of now-empty legacy `boards/<slug>/sessions/` dirs (H12)
    for (const safeDir of touchedDirs) {
      await fs.rmdir(safeDir).catch(() => {});
    }

    if (conflicts.length > 0) {
      const details = conflicts
        .map((c) => `${c.id} (${c.paths.join(' vs ')})`)
        .join('; ');
      const conflictErr = new CorruptDataError(
        `Legacy session migration conflict detected; conflicting originals preserved on disk: ${details}`,
      );
      if (skipCorrupt) {
        onCorrupt?.(conflicts[0].paths[0] ?? this.boardsDir, conflictErr);
      } else {
        throw conflictErr;
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
      ensureDir(path.join(dir, 'jobs')),
    ]);
    return dir;
  }

  private workspaceMetaPath(): string {
    return path.join(this.deckDir, 'workspace.yaml');
  }

  public async getDefaultBoardSlug(): Promise<string> {
    if (this.pointerPath) {
      // R2-7: Re-read global `.contextdeck.yaml` pointer dynamically so long-running
      // MCP/serve processes immediately observe `cdeck board use <slug>`.
      const pointerBoard = await readGlobalWorkspacePointerBoard(this.pointerPath);
      if (pointerBoard && existsSync(this.boardPath(pointerBoard))) {
        return pointerBoard;
      }
    } else if (this.defaultBoardHint && existsSync(this.boardPath(this.defaultBoardHint))) {
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
    this._defaultBoardHint = validSlug;
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
      if (!BOARD_SLUG_REGEX.test(entry.name)) continue;
      if (!existsSync(path.join(this.boardsDir, entry.name, 'board.yaml'))) continue;
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

  /**
   * Reverse-chunk tail reader returning at most the latest `maxMeaningful` meaningful events
   * (plus any intervening events encountered while scanning backward from EOF) with revision <= maxRevision.
   * Keeps SessionStart Context Pack generation O(1) chunks even with 5,000+ events (H7).
   */
  public async readRecentEvents(
    slug: string,
    maxMeaningful = 16,
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
    const targetMeaningful = Math.max(1, maxMeaningful);
    const collected: BoardEvent[] = [];
    let meaningfulFound = 0;

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
          if (maxRevision !== undefined && ev.revision > maxRevision) continue;
          collected.push(ev);
          if (isMeaningfulEvent(ev.kind)) {
            meaningfulFound += 1;
            if (meaningfulFound >= targetMeaningful) {
              done = true;
              break;
            }
          }
        }
      }

      if (!done && carry.length > 0) {
        const ev = parseEventLine(carry);
        if (ev && (maxRevision === undefined || ev.revision <= maxRevision)) {
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

  private async listAllRawSessions(options?: {
    skipCorrupt?: boolean;
    onCorrupt?: (filePath: string, err: unknown) => void;
  }): Promise<Array<LegacySessionFile & { board: string }>> {
    const skipCorrupt = Boolean(options?.skipCorrupt);
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
      let parsed: LegacySessionFile | null;
      try {
        parsed = await readYamlStrict(filePath, LegacySessionFileSchema);
      } catch (err) {
        if (skipCorrupt && err instanceof CorruptDataError) {
          options?.onCorrupt?.(filePath, err);
          continue;
        }
        throw err;
      }
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
      if (!BOARD_SLUG_REGEX.test(entry.name)) continue;
      if (!existsSync(path.join(this.boardsDir, entry.name, 'board.yaml'))) continue;
      const legacyDir = path.join(this.boardsDir, entry.name, 'sessions');
      if (!existsSync(legacyDir)) continue;
      const safeDir = await this.safeBoardFilePath(entry.name, 'sessions');
      const legacyFiles = await listFilesStrict(safeDir, '.yaml');
      for (const file of legacyFiles) {
        const filePath = await assertContainedPath(safeDir, path.join(safeDir, file), {
          label: `legacy session ${file}`,
        });
        let parsed: LegacySessionFile | null;
        try {
          parsed = await readYamlStrict(filePath, LegacySessionFileSchema);
        } catch (err) {
          if (skipCorrupt && err instanceof CorruptDataError) {
            options?.onCorrupt?.(filePath, err);
            continue;
          }
          throw err;
        }
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
      if (!BOARD_SLUG_REGEX.test(entry.name)) continue;
      if (!existsSync(path.join(this.boardsDir, entry.name, 'board.yaml'))) continue;
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

  public async listDiagrams(
    slug: string,
    options: { loadContent?: boolean } = {},
  ): Promise<Diagram[]> {
    const { loadContent = true } = options;
    const dir = await this.safeBoardFilePath(slug, 'diagrams');
    const metaFiles = await listFilesStrict(dir, '.meta.yaml');
    const out: Diagram[] = [];
    for (const metaFile of metaFiles) {
      const metaPath = await assertContainedPath(dir, path.join(dir, metaFile), {
        label: `diagram meta ${metaFile}`,
      });
      const meta = await readYamlStrict<Record<string, unknown>>(metaPath);
      if (!meta) continue;
      let content = '';
      if (loadContent) {
        const baseName = metaFile.replace(/\.meta\.yaml$/, '');
        const ext = meta.kind === 'excalidraw' ? '.excalidraw' : '.mmd';
        const contentPath = await assertContainedPath(dir, path.join(dir, `${baseName}${ext}`), {
          label: `diagram content ${baseName}${ext}`,
        });
        content = (await readFileStrict(contentPath)) ?? '';
      }
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

  public async listJobs(
    boardSlug?: string,
    filter?: { status?: RefreshJobStatus; artifactType?: RefreshJobArtifactType },
  ): Promise<RefreshJob[]> {
    const slug = await this.resolveBoardSlug(boardSlug);
    const dir = await this.safeBoardFilePath(slug, 'jobs');
    const files = await listFilesStrict(dir, '.yaml');
    const out: RefreshJob[] = [];
    for (const file of files) {
      const filePath = await assertContainedPath(dir, path.join(dir, file), { label: `job ${file}` });
      const parsed = await readYamlStrict(filePath, RefreshJobSchema);
      if (!parsed) continue;
      if (filter?.status && parsed.status !== filter.status) continue;
      if (filter?.artifactType && parsed.artifactType !== filter.artifactType) continue;
      out.push(parsed);
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private async readJobById(slug: string, jobId: string): Promise<RefreshJob | null> {
    const validId = validateEntityId(jobId, 'jobId');
    const jobPath = await this.safeBoardFilePath(slug, 'jobs', `${validId}.yaml`);
    return readYamlStrict(jobPath, RefreshJobSchema);
  }

  public async getJob(boardSlug: string | undefined, jobId: string): Promise<RefreshJob | null> {
    const slug = await this.resolveBoardSlug(boardSlug);
    return this.readJobById(slug, jobId);
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

    const [sessions, decisions, tasks, diagrams, media, quizzes, jobs, events] = await Promise.all([
      this.listSessions(slug),
      this.listDecisions(slug),
      this.listTasks(slug),
      this.listDiagrams(slug),
      this.listMedia(slug),
      this.listQuizzes(slug),
      this.listJobs(slug),
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
      jobs,
      events,
      drift,
    };
  }

  private async readContextPackSnapshotOnce(
    validSlug: string,
    options: {
      maxRecentEvents?: number;
      skipCorruptSessions?: boolean;
      onCorruptSession?: (filePath: string, message: string) => void;
    } = {},
  ): Promise<BoardSnapshot> {
    const config = await this.readBoardConfig(validSlug);
    const briefPath = await this.safeBoardFilePath(validSlug, 'brief.md');
    const brief = (await readFileStrict(briefPath)) ?? '';
    const skipCorrupt = Boolean(options.skipCorruptSessions);

    const loadLightweightSessions = async (): Promise<Session[]> => {
      const rawAll = await this.listAllRawSessions({
        skipCorrupt,
        onCorrupt: (filePath, err) => {
          options.onCorruptSession?.(
            filePath,
            err instanceof Error ? err.message : String(err),
          );
        },
      });
      const matching = rawAll.filter((s) => s.board === validSlug);
      return Promise.all(
        matching.map(async (raw) => {
          let cursor: SessionCursor | null = null;
          try {
            cursor = await this.readSessionCursor(raw.id);
          } catch (err) {
            if (skipCorrupt && err instanceof CorruptDataError) {
              options.onCorruptSession?.(
                path.join(this.cursorsDir, `${raw.id}.json`),
                err.message,
              );
            } else {
              throw err;
            }
          }
          return this.hydrateSession(raw, validSlug, cursor);
        }),
      );
    };

    const [sessions, decisions, tasks, diagrams, media, quizzes, jobs, events] = await Promise.all([
      loadLightweightSessions(),
      this.listDecisions(validSlug),
      this.listTasks(validSlug),
      this.listDiagrams(validSlug, { loadContent: false }),
      this.listMedia(validSlug, { loadContent: false }),
      this.listQuizzes(validSlug),
      this.listJobs(validSlug),
      this.readRecentEvents(validSlug, options.maxRecentEvents ?? 16, config.revision),
    ]);

    const drift = {
      ...computeDriftReport({
        config,
        sessions: [], // H7: Omit O(S x E) per-session drift computation for hook startup packs
        decisions,
        tasks,
        diagrams,
        media,
        quizzes,
        events: [],
      }),
      // R2-5: Signal that per-session drift was intentionally omitted so formatters do not claim "synced"
      sessionDriftComputed: false,
    };

    return {
      config,
      brief,
      sessions,
      decisions,
      tasks,
      diagrams,
      media,
      quizzes,
      jobs,
      events,
      drift,
    };
  }

  /**
   * Lightweight consistent snapshot reader tailored for hook startup Context Packs (H7, R2-3, R2-5):
   * - Skips loading media file contents (`loadContent: false`) and diagram bodies (`loadContent: false`).
   * - Reads only the recent tail of `events.jsonl` via reverse-chunk scanning (`readRecentEvents`).
   * - Computes stale artifacts accurately while omitting O(sessions x events) per-session drift scans
   *   (marking `drift.sessionDriftComputed = false` so formatters omit sync claims).
   * - Verifies transaction journal absence + unchanged board revision before/after reading (matching
   *   `getSnapshot()`), retrying with bounded backoff and falling back to a bounded locked read so
   *   uncommitted/torn content is never returned (R2-3).
   * - Optionally skips and reports single corrupt session files (N3).
   */
  public async readContextPackSnapshot(
    slug: string,
    options: {
      maxRecentEvents?: number;
      skipCorruptSessions?: boolean;
      onCorruptSession?: (filePath: string, message: string) => void;
      maxWaitMs?: number;
    } = {},
  ): Promise<BoardSnapshot> {
    const validSlug = validateBoardSlug(slug);
    const txnPath = path.join(this.runtimeDir, TXN_FILENAME);
    const maxRetries = 4;
    const deadlineAt =
      options.maxWaitMs !== undefined ? Date.now() + Math.max(0, options.maxWaitMs) : undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const txnBefore = await this.txnJournalExists(txnPath);
      if (txnBefore) {
        if (attempt < maxRetries) {
          const waitMs = 15 * (attempt + 1);
          if (deadlineAt !== undefined && Date.now() + waitMs >= deadlineAt) {
            break;
          }
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        break;
      }

      const snapshot = await this.readContextPackSnapshotOnce(validSlug, options);
      // Same R5-1 ordering as getSnapshot(): check txn.json BEFORE re-reading board.yaml
      const txnAfter = await this.txnJournalExists(txnPath);
      if (!txnAfter) {
        const configAfter = await this.readBoardConfig(validSlug);
        if (configAfter.revision === snapshot.config.revision) {
          return snapshot;
        }
      }

      if (attempt < maxRetries) {
        const waitMs = 15 * (attempt + 1);
        if (deadlineAt !== undefined && Date.now() + waitMs >= deadlineAt) {
          break;
        }
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }

    const remainingLockWaitMs =
      deadlineAt !== undefined ? Math.max(10, deadlineAt - Date.now()) : undefined;
    return withWorkspaceLock(
      this.runtimeDir,
      async (assertActive) => {
        // C12: withWorkspaceLock's acquire-time txn recovery (B1) guarantees no pending txn.json inside the lock.
        assertActive();
        return this.readContextPackSnapshotOnce(validSlug, options);
      },
      this.deckDir,
      remainingLockWaitMs !== undefined ? { maxWaitMs: remainingLockWaitMs } : {},
    );
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

    // D11 / R3-2: Resolve BOTH externalRef and explicit id under the lock so conflicting
    // identity assignments reject with ValidationError and we never clobber an existing session.
    const requestedId = input.id ? validateEntityId(input.id, 'sessionId') : undefined;
    let existingByRef: (LegacySessionFile & { board: string }) | null = null;
    if (input.externalRef !== undefined) {
      const all = await this.listAllRawSessions();
      existingByRef = all.find((s) => s.externalRef === input.externalRef) ?? null;
    }
    const existingById = requestedId ? await this.readWorkspaceSessionRaw(requestedId) : null;

    if (existingByRef && requestedId && existingByRef.id !== requestedId) {
      throw new ValidationError(
        `Session identity conflict: externalRef "${input.externalRef}" already belongs to session "${existingByRef.id}", which differs from requested id "${requestedId}".`,
      );
    }
    if (
      existingById &&
      input.externalRef !== undefined &&
      existingById.externalRef !== undefined &&
      existingById.externalRef !== input.externalRef
    ) {
      throw new ValidationError(
        `Session "${existingById.id}" already has externalRef "${existingById.externalRef}"; cannot reassign to "${input.externalRef}".`,
      );
    }

    const existing = existingByRef ?? existingById;
    const sessionPathExists = async (candidatePath: string): Promise<boolean> => {
      try {
        await fs.lstat(candidatePath);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw err;
      }
    };

    let id: string;
    if (existing) {
      id = existing.id;
    } else if (requestedId) {
      id = requestedId;
    } else {
      id = shortId('sess');
      while (await sessionPathExists(await this.safeSessionFilePath(id))) {
        id = shortId('sess');
      }
    }
    const filePath = await this.safeSessionFilePath(id);
    if (!existing && (await sessionPathExists(filePath))) {
      throw new ValidationError(`Session "${id}" already exists on disk.`);
    }
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

    // R4-1: externalRef is a unique hook identity. Apply registration's policy (R3-2) on the
    // update path too, under the same lock: never reassign an existing ref, never take one
    // that already belongs to another session.
    if (patch.externalRef !== undefined && patch.externalRef !== existing.externalRef) {
      if (existing.externalRef !== undefined) {
        throw new ValidationError(
          `Session "${existing.id}" already has externalRef "${existing.externalRef}"; cannot reassign to "${patch.externalRef}".`,
        );
      }
      const all = await this.listAllRawSessions();
      const owner = all.find((s) => s.externalRef === patch.externalRef && s.id !== existing.id);
      if (owner) {
        throw new ValidationError(
          `Session identity conflict: externalRef "${patch.externalRef}" already belongs to session "${owner.id}".`,
        );
      }
    }

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

  private static sha256Hex(value: string): string {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
  }

  private static computeClaimFingerprint(leaseToken: string): string {
    return ContextDeckStore.sha256Hex(leaseToken).slice(0, 16);
  }

  private async validateActiveJobClaim(
    slug: string,
    jobId: string | undefined,
    leaseToken: string | undefined,
    artifactType: RefreshJobArtifactType,
    artifactId: string,
    nowMs: number,
  ): Promise<{ job: RefreshJob; claimFingerprint: string } | null> {
    if (!jobId) {
      if (leaseToken !== undefined) {
        throw new ValidationError('leaseToken can only be supplied together with jobId.');
      }
      return null;
    }
    if (!leaseToken) {
      throw new ValidationError(`Refresh job write for "${jobId}" requires an active leaseToken.`);
    }
    const job = await this.readJobById(slug, jobId);
    if (!job) {
      throw new NotFoundError(`Refresh job "${jobId}" not found on board "${slug}".`);
    }
    if (job.artifactType !== artifactType || job.artifactId !== artifactId) {
      throw new ValidationError(
        `Refresh job "${jobId}" targets ${job.artifactType}/${job.artifactId}, not ${artifactType}/${artifactId}.`,
      );
    }
    if (job.status !== 'claimed' || !job.leaseToken) {
      throw new ConflictError(
        `Refresh job "${jobId}" is not actively claimed (status: ${job.status}).`,
      );
    }
    if (job.leaseToken !== leaseToken) {
      throw new ConflictError(`Invalid lease token for refresh job "${jobId}".`);
    }
    if (job.leaseExpiresAt && Date.parse(job.leaseExpiresAt) <= nowMs) {
      throw new ConflictError(`Lease for refresh job "${jobId}" has expired.`);
    }
    return {
      job,
      claimFingerprint: ContextDeckStore.computeClaimFingerprint(leaseToken),
    };
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
      jobId?: string;
      leaseToken?: string;
      note?: string;
      now?: Date;
    },
    actorOverride?: Actor,
  ): Promise<Diagram> {
    const { now: nowOpt, ...schemaInput } = rawInput;
    const input = parseStrict(UpsertDiagramInputSchema.omit({ actor: true }), schemaInput, 'diagram');
    const effActor = actorOverride ?? tx.actor;
    const existing = input.id ? ((await this.readDiagramById(tx.slug, input.id)) ?? undefined) : undefined;
    const nowDate = nowOpt ?? new Date();
    const now = nowDate.toISOString();

    const kind = input.kind ?? existing?.kind ?? 'mermaid';
    const id = existing?.id ?? input.id ?? `diag_${slugify(input.title)}_${shortId('x').slice(2, 6)}`;
    validateEntityId(id, 'diagramId');

    const activeClaim = await this.validateActiveJobClaim(
      tx.slug,
      input.jobId,
      input.leaseToken,
      'diagram',
      id,
      nowDate.getTime(),
    );
    if (activeClaim && existing && input.content.trim() === existing.content.trim()) {
      throw new ValidationError(
        'Cannot record refresh job version without changing diagram content.',
      );
    }

    // H10: Attribute the event ONLY to the actual caller's sessionId (never existing.sessionId),
    // while keeping existing.sessionId preserved as diagram metadata.
    const actorSessionId = input.sessionId ?? effActor.sessionId ?? undefined;
    const diagramSessionId =
      input.sessionId !== undefined ? input.sessionId : (effActor.sessionId ?? existing?.sessionId ?? null);
    const eventActor: Actor = actorSessionId ? { ...effActor, sessionId: actorSessionId } : effActor;
    const nextVersion = existing ? existing.version + 1 : 1;
    const nextBasedOn = input.basedOnDecisions ?? existing?.basedOnDecisions ?? [];
    const ev = tx.addEvent({
      kind: existing ? 'diagram.updated' : 'diagram.created',
      entityId: id,
      summary: `${existing ? 'Updated' : 'Created'} ${kind} diagram "${input.title}" (v${nextVersion})`,
      actor: eventActor,
    });

    const versionEntry: ArtifactVersionEntry = ArtifactVersionEntrySchema.parse({
      version: nextVersion,
      updatedAt: now,
      boardRevision: ev.revision,
      actor: eventActor,
      basedOnDecisions: nextBasedOn,
      contentHash: ContextDeckStore.sha256Hex(input.content),
      ...(activeClaim
        ? { createdByJob: activeClaim.job.id, createdByClaim: activeClaim.claimFingerprint }
        : {}),
      ...(input.note ? { note: input.note } : {}),
    });

    const nextHistory = existing
      ? appendArtifactHistory(existing, versionEntry)
      : [versionEntry];

    const contentChanged = !existing || input.content !== existing.content;
    const nextConfirmations =
      existing && !contentChanged
        ? retainRelevantConfirmations(existing.confirmations, nextBasedOn)
        : {};

    const diagram = DiagramSchema.parse({
      id,
      title: input.title,
      kind,
      content: input.content,
      description: input.description ?? existing?.description ?? '',
      basedOnDecisions: nextBasedOn,
      version: nextVersion,
      history: nextHistory,
      confirmations: nextConfirmations,
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
    stagedBinary?: { tmpPath: string; ext: string; mimeType?: string },
    nowOpt?: Date,
  ): Promise<MediaArtifact> {
    validateEntityId(mediaId, 'mediaId');
    const patch = parseStrict(UpdateMediaPatchSchema.omit({ actor: true }), rawPatch, 'media patch');
    const effActor = actorOverride ?? tx.actor;
    const nowDate = nowOpt ?? new Date();
    const now = nowDate.toISOString();

    const existing = await this.readMediaById(tx.slug, mediaId, { loadContent: true });
    if (!existing) {
      throw new NotFoundError(`Media artifact "${mediaId}" not found on board "${tx.slug}".`);
    }

    const activeClaim = await this.validateActiveJobClaim(
      tx.slug,
      patch.jobId,
      patch.leaseToken,
      'media',
      existing.id,
      nowDate.getTime(),
    );
    if (activeClaim) {
      const hasNewBinary = Boolean(stagedBinary);
      const hasNewContent = patch.content !== undefined && patch.content !== existing.content;
      const hasNewTranscript =
        patch.transcript !== undefined && patch.transcript !== existing.transcript;
      const hasNewUrl =
        patch.externalUrl !== undefined && patch.externalUrl !== existing.externalUrl;
      if (existing.kind === 'video' || existing.kind === 'audio') {
        if (existing.filePath) {
          if (!hasNewBinary) {
            throw new ValidationError(
              'Cannot record refresh job version for file-backed video/audio without a new media file.',
            );
          }
        } else if (!hasNewBinary && !hasNewUrl) {
          throw new ValidationError(
            'Cannot record refresh job version for video/audio without a new media file or URL.',
          );
        }
      }
      if (
        (existing.kind === 'doc' || existing.kind === 'html' || existing.kind === 'json') &&
        !hasNewBinary &&
        !hasNewContent
      ) {
        throw new ValidationError(
          'Cannot record refresh job version for document/html/json without changed content or a new file.',
        );
      }
      if (!hasNewBinary && !hasNewContent && !hasNewTranscript && !hasNewUrl) {
        throw new ValidationError(
          'Cannot record refresh job version without updated media content or file.',
        );
      }
    }

    const nextVersion = existing.version + 1;
    const mediaDir = await this.safeBoardFilePath(tx.slug, 'media');
    let nextFilePath = existing.filePath;
    let nextMimeType = stagedBinary?.mimeType ?? existing.mimeType;

    // D19: Immutable versioned media files `<id>.v<N>.<ext>` (keep previous versions on disk!)
    if (stagedBinary) {
      nextFilePath = `${existing.id}.v${nextVersion}${stagedBinary.ext}`;
      const finalFilePath = await assertContainedPath(
        mediaDir,
        path.join(mediaDir, nextFilePath),
        { label: `media file "${nextFilePath}"` },
      );
      if (existsSync(finalFilePath)) {
        throw new ConflictError(`Immutable media version "${nextFilePath}" already exists.`);
      }
      tx.stagePreStagedFile(stagedBinary.tmpPath, finalFilePath);
    } else if (
      patch.content !== undefined &&
      (existing.kind === 'doc' || existing.kind === 'html' || existing.kind === 'json')
    ) {
      const ext = existing.kind === 'html' ? '.html' : existing.kind === 'json' ? '.json' : '.md';
      nextFilePath = `${existing.id}.v${nextVersion}${ext}`;
      const targetContentPath = await assertContainedPath(
        mediaDir,
        path.join(mediaDir, nextFilePath),
        { label: `media file "${nextFilePath}"` },
      );
      if (existsSync(targetContentPath)) {
        throw new ConflictError(`Immutable media version "${nextFilePath}" already exists.`);
      }
      tx.stageFile(targetContentPath, patch.content);
    }

    const nextBasedOn = patch.basedOnDecisions ?? existing.basedOnDecisions;
    const ev = tx.addEvent({
      kind: 'media.updated',
      entityId: existing.id,
      summary: `Updated ${existing.kind} artifact "${patch.title ?? existing.title}" (v${nextVersion})`,
      actor: effActor,
    });

    const nextContentForHash = patch.content !== undefined ? patch.content : existing.content;
    const versionEntry: ArtifactVersionEntry = ArtifactVersionEntrySchema.parse({
      version: nextVersion,
      updatedAt: now,
      boardRevision: ev.revision,
      actor: effActor,
      basedOnDecisions: nextBasedOn,
      ...(nextFilePath ? { filePath: nextFilePath } : {}),
      ...(nextContentForHash !== undefined
        ? { contentHash: ContextDeckStore.sha256Hex(nextContentForHash) }
        : {}),
      ...(activeClaim
        ? { createdByJob: activeClaim.job.id, createdByClaim: activeClaim.claimFingerprint }
        : {}),
      ...(patch.note ? { note: patch.note } : {}),
    });

    const nextHistory = appendArtifactHistory(existing, versionEntry);
    const substantiveChange =
      Boolean(stagedBinary) ||
      patch.content !== undefined ||
      patch.transcript !== undefined ||
      patch.externalUrl !== undefined;

    const updated = MediaArtifactSchema.parse({
      ...existing,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.transcript !== undefined ? { transcript: patch.transcript } : {}),
      ...(patch.chapters !== undefined ? { chapters: patch.chapters } : {}),
      ...(patch.durationSec !== undefined ? { durationSec: patch.durationSec } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.basedOnDecisions !== undefined ? { basedOnDecisions: patch.basedOnDecisions } : {}),
      ...(patch.externalUrl !== undefined ? { externalUrl: patch.externalUrl } : {}),
      ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
      id: existing.id,
      mimeType: nextMimeType,
      filePath: nextFilePath,
      version: nextVersion,
      history: nextHistory,
      confirmations: substantiveChange
        ? {}
        : retainRelevantConfirmations(existing.confirmations, nextBasedOn),
      createdAt: existing.createdAt,
      boardRevisionAtUpdate: ev.revision,
      updatedAt: now,
    });

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
    const basedOnDecisions = input.basedOnDecisions ?? [];
    const versionEntry = ArtifactVersionEntrySchema.parse({
      version: 1,
      updatedAt: now,
      boardRevision: ev.revision,
      actor: eventActor,
      basedOnDecisions,
    });

    const quiz = QuizSchema.parse({
      id,
      title: input.title,
      topic: input.topic ?? '',
      description: input.description ?? '',
      questions: input.questions,
      attempts: [],
      basedOnDecisions,
      version: 1,
      history: [versionEntry],
      confirmations: {},
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
    let targetBoard = boardSlug;
    // H9: When board is omitted and an existing session matches externalRef/id, keep its bound board
    if (targetBoard === undefined || targetBoard === '') {
      let existing: { board?: string } | null = null;
      if (input.externalRef) {
        existing = await this.findSessionByExternalRef(input.externalRef);
      }
      if (!existing && input.id) {
        existing = await this.readSessionRawAcrossWorkspace(input.id);
      }
      if (existing?.board) targetBoard = existing.board;
    }
    return this.mutate(targetBoard, actor, (tx) => this.registerSessionUnlocked(tx, input));
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
   * Internal unlocked cursor merge helper — caller MUST already hold the workspace lock (R2-2).
   * Monotonically merges `syncedRevisions[board]` with `max()`, preserves all other boards,
   * and preserves the newer `lastActiveAt` and `lastCursorInjectAt`.
   */
  private async commitHookDeliveryUnlocked(ack: HookDeliveryAck): Promise<SessionCursor> {
    const validId = validateEntityId(ack.sessionId, 'sessionId');
    const validBoard = validateBoardSlug(ack.boardSlug);
    const nowStr = ack.now ?? nowIso();

    const existingCursor = await this.readSessionCursor(validId);
    const prevSynced = existingCursor?.syncedRevisions[validBoard] ?? 0;
    const lastActiveAt =
      existingCursor?.lastActiveAt && existingCursor.lastActiveAt > nowStr
        ? existingCursor.lastActiveAt
        : nowStr;
    const existingInjectAt = existingCursor?.lastCursorInjectAt;
    const nextInjectAt = ack.stampCursorThrottle
      ? existingInjectAt && existingInjectAt > nowStr
        ? existingInjectAt
        : nowStr
      : existingInjectAt;

    const nextCursor: SessionCursor = {
      sessionId: validId,
      syncedRevisions: {
        ...(existingCursor?.syncedRevisions ?? {}),
        [validBoard]: Math.max(prevSynced, ack.revision),
      },
      lastActiveAt,
      ...(nextInjectAt ? { lastCursorInjectAt: nextInjectAt } : {}),
    };
    await this.writeSessionCursor(nextCursor);
    return nextCursor;
  }

  /**
   * Commit a hook delivery cursor acknowledgement AFTER stdout has been flushed (D12, R2-2).
   * Acquires the workspace lock bounded by `maxWaitMs` and monotonically merges `.runtime/cursors/<sessionId>.json`
   * so concurrent hooks / `syncSession` never rewind revisions, drop other boards, or lose `lastCursorInjectAt`.
   * On `LockTimeoutError`, skips the ack and returns `null` (duplicate next turn is acceptable per D12; loss/rewind is not).
   */
  public async commitHookDelivery(
    ack: HookDeliveryAck,
    options: { maxWaitMs?: number } = {},
  ): Promise<SessionCursor | null> {
    const maxWaitMs = options.maxWaitMs ?? 800;
    try {
      return await withWorkspaceLock(
        this.runtimeDir,
        async (assertActive) => {
          assertActive();
          return this.commitHookDeliveryUnlocked(ack);
        },
        this.deckDir,
        { maxWaitMs },
      );
    } catch (err) {
      if (err instanceof LockTimeoutError) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Hook helper for SessionStart / sessionStart (AC5.1-AC5.4, D11, D12, D15, H7, N3):
   * - Holds the workspace lock ONLY for session metadata upsert (never during snapshot reads).
   * - Deduplicates by `externalRef`; never stores raw prompt text; routes new sessions via board `paths` globs.
   * - Builds the startup pack from lightweight lock-free `readContextPackSnapshot` (H7).
   * - Does NOT bump `board.yaml` revision or churn `events.jsonl`.
   * - When `deferCursorCommit` is true, returns `pendingAck` without advancing the cursor yet so the
   *   caller can flush stdout first and then call `commitHookDelivery(pendingAck)` (at-least-once).
   */
  public async upsertHookSession(params: {
    externalRef: string;
    harness: string;
    defaultTitle: string;
    cwd?: string;
    maxWaitMs?: number;
    deferCursorCommit?: boolean;
    onCorruptSession?: (filePath: string, message: string) => void;
  }): Promise<{
    session: Session;
    boardSlug: string;
    snapshot: BoardSnapshot;
    created: boolean;
    pendingAck: HookDeliveryAck;
  }> {
    const maxWaitMs = params.maxWaitMs ?? 800;
    const now = nowIso();
    const onCorrupt = (filePath: string, err: unknown) => {
      params.onCorruptSession?.(filePath, err instanceof Error ? err.message : String(err));
    };

    const { meta, boardSlug, created } = await withWorkspaceLock(
      this.runtimeDir,
      async (assertActive) => {
        await this.migrateLegacySessionsUnlocked(assertActive, { skipCorrupt: true, onCorrupt });
        const boards = await this.listBoards();
        if (boards.length === 0) {
          throw new NotFoundError('No ContextDeck boards exist in this workspace.');
        }
        const defaultBoard = await this.getDefaultBoardSlug();
        const existingBoardsSet = new Set(boards.map((b) => b.slug));

        const allRaw = await this.listAllRawSessions({ skipCorrupt: true, onCorrupt });
        const existing = allRaw.find((s) => s.externalRef === params.externalRef);

        let nextMeta: SessionMetadata;
        let wasCreated = false;
        let resolvedBoardSlug: string;

        if (existing) {
          resolvedBoardSlug = existingBoardsSet.has(existing.board)
            ? existing.board
            : routeBoardForCwd(boards, params.cwd, this.projectRoot, defaultBoard);
          nextMeta = SessionMetadataSchema.parse({
            id: existing.id,
            title: existing.title,
            harness: existing.harness,
            externalRef: existing.externalRef,
            board: resolvedBoardSlug,
            parentSessionId: existing.parentSessionId,
            relatedSessionIds: existing.relatedSessionIds,
            status: existing.status === 'idle' || existing.status === 'paused' ? 'active' : existing.status,
            summary: existing.summary,
            focusFiles: existing.focusFiles,
            createdAt: existing.createdAt,
            updatedAt:
              existing.status === 'idle' ||
              existing.status === 'paused' ||
              resolvedBoardSlug !== existing.board
                ? now
                : existing.updatedAt,
          });
          // Only write metadata YAML if status or bound board actually changed (keeps git clean on resume)
          if (nextMeta.status !== existing.status || nextMeta.board !== existing.board) {
            await ensureDir(this.sessionsDir);
            const filePath = await this.safeSessionFilePath(nextMeta.id);
            assertActive();
            await atomicWriteFile(filePath, dumpYaml(nextMeta));
          }
        } else {
          wasCreated = true;
          resolvedBoardSlug = routeBoardForCwd(boards, params.cwd, this.projectRoot, defaultBoard);
          nextMeta = SessionMetadataSchema.parse({
            id: shortId('sess'),
            title: params.defaultTitle,
            harness: params.harness,
            externalRef: params.externalRef,
            board: resolvedBoardSlug,
            parentSessionId: null,
            relatedSessionIds: [],
            status: 'active',
            summary: '',
            focusFiles: [],
            createdAt: now,
            updatedAt: now,
          });
          await ensureDir(this.sessionsDir);
          const filePath = await this.safeSessionFilePath(nextMeta.id);
          assertActive();
          await atomicWriteFile(filePath, dumpYaml(nextMeta));
        }

        return { meta: nextMeta, boardSlug: resolvedBoardSlug, created: wasCreated };
      },
      this.deckDir,
      { maxWaitMs },
    );

    // H7 + R2-3: Build verified lightweight context pack OUTSIDE the workspace lock
    const [snapshot, existingCursor] = await Promise.all([
      this.readContextPackSnapshot(boardSlug, {
        skipCorruptSessions: true,
        onCorruptSession: params.onCorruptSession,
        maxWaitMs,
      }),
      this.readSessionCursor(meta.id),
    ]);

    const pendingAck: HookDeliveryAck = {
      sessionId: meta.id,
      boardSlug,
      revision: snapshot.config.revision,
      now,
    };

    let hydratedCursor = existingCursor;
    if (!params.deferCursorCommit) {
      const committed = await this.commitHookDelivery(pendingAck, { maxWaitMs });
      if (committed) {
        hydratedCursor = committed;
      }
    }

    return {
      session: this.hydrateSession(meta, boardSlug, hydratedCursor),
      boardSlug,
      snapshot,
      created,
      pendingAck,
    };
  }

  /**
   * Hook fast-path helper for UserPromptSubmit / postToolUse (AC5.2-AC5.4, D11, D12, H8, H11, N3):
   * 1. Lock-free read of session, board.yaml, cursor, and events tail; exits immediately with 'noop' if not behind.
   *    Fast-forwards the runtime cursor past self-authored / housekeeping events when behindBy === 0 (H8).
   * 2. Enforces optional throttleMs (Cursor 60s) without advancing cursor when throttled.
   * 3. Acquires bounded workspace lock (`maxWaitMs`, default 800ms) only when registering, reactivating, or emitting a digest.
   *    If the lock times out, throws LockTimeoutError and leaves the cursor unchanged.
   * 4. When `deferCursorCommit` is true, returns `pendingAck` WITHOUT writing the advanced cursor yet so the
   *    caller can write & drain stdout first and then call `commitHookDelivery(pendingAck)` (at-least-once).
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
    deferCursorCommit?: boolean;
    onCorruptSession?: (filePath: string, message: string) => void;
  }): Promise<{
    action: 'noop' | 'throttled' | 'registered_silent' | 'digest';
    session?: Session;
    boardConfig?: BoardConfig;
    digestResult?: SessionDigestResult;
    pendingAck?: HookDeliveryAck;
  }> {
    const maxWaitMs = params.maxWaitMs ?? 800;
    const nowDate = params.now ?? new Date();
    const nowMs = nowDate.getTime();
    const nowStr = nowDate.toISOString();
    const onCorrupt = (filePath: string, err: unknown) => {
      params.onCorruptSession?.(filePath, err instanceof Error ? err.message : String(err));
    };

    // --- Lock-free fast path (D12, H8, N3) ---
    const fastMatch = (await this.listAllRawSessions({ skipCorrupt: true, onCorrupt })).find(
      (s) => s.externalRef === params.externalRef,
    );
    if (fastMatch) {
      const boardSlug = fastMatch.board;
      const needsReactivate = fastMatch.status === 'idle' || fastMatch.status === 'paused';
      let config: BoardConfig | null = null;
      try {
        config = await this.readBoardConfig(boardSlug);
      } catch (err) {
        if (!(err instanceof NotFoundError)) throw err;
      }
      if (config) {
        const cursor = await this.readSessionCursor(fastMatch.id);
        const lastSynced =
          cursor?.syncedRevisions[boardSlug] ?? fastMatch.lastSyncedRevision ?? 0;

        if (lastSynced >= config.revision) {
          if (!needsReactivate) {
            return { action: 'noop' };
          }
        } else {
          const tailEvents = await this.readEventsSince(boardSlug, lastSynced, config.revision);
          const fastDigest = buildSessionDriftDigest({
            sessionId: fastMatch.id,
            lastSyncedRevision: lastSynced,
            currentRevision: config.revision,
            events: tailEvents,
            maxLines: params.maxDigestLines,
          });

          if (fastDigest.behindBy === 0 || fastDigest.digest.length === 0) {
            // H8 + R2-2: Fast-forward runtime cursor via bounded locked commit (swallows lock timeout)
            await this.commitHookDelivery(
              {
                sessionId: fastMatch.id,
                boardSlug,
                revision: config.revision,
                stampCursorThrottle: false,
                now: nowStr,
              },
              { maxWaitMs: Math.min(maxWaitMs, 250) },
            );
            if (!needsReactivate) {
              return { action: 'noop' };
            }
          } else if (params.throttleMs !== undefined && cursor?.lastCursorInjectAt) {
            const lastInjectMs = Date.parse(cursor.lastCursorInjectAt);
            if (Number.isFinite(lastInjectMs) && nowMs - lastInjectMs < params.throttleMs) {
              // D12: Never advance cursor when throttled
              if (!needsReactivate) {
                return { action: 'throttled' };
              }
            }
          }
        }
      }
    }

    // --- Locked commit path (only when registering a new session, reactivating, OR emitting a real digest) ---
    return withWorkspaceLock(
      this.runtimeDir,
      async (assertActive) => {
        await this.migrateLegacySessionsUnlocked(assertActive, { skipCorrupt: true, onCorrupt });
        const boards = await this.listBoards();
        if (boards.length === 0) {
          throw new NotFoundError('No ContextDeck boards exist in this workspace.');
        }
        const defaultBoard = await this.getDefaultBoardSlug();
        const existingBoardsSet = new Set(boards.map((b) => b.slug));

        const allRaw = await this.listAllRawSessions({ skipCorrupt: true, onCorrupt });
        const existing = allRaw.find((s) => s.externalRef === params.externalRef);

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

        // H11: Activity via UserPromptSubmit / postToolUse restores idle/paused session back to active
        let activeExisting = existing;
        if (existing.status === 'idle' || existing.status === 'paused') {
          const reactivatedMeta = SessionMetadataSchema.parse({
            id: existing.id,
            title: existing.title,
            harness: existing.harness,
            ...(existing.externalRef !== undefined ? { externalRef: existing.externalRef } : {}),
            board: boardSlug,
            parentSessionId: existing.parentSessionId,
            relatedSessionIds: existing.relatedSessionIds,
            status: 'active',
            summary: existing.summary,
            focusFiles: existing.focusFiles,
            createdAt: existing.createdAt,
            updatedAt: nowStr,
          });
          await ensureDir(this.sessionsDir);
          const filePath = await this.safeSessionFilePath(reactivatedMeta.id);
          assertActive();
          await atomicWriteFile(filePath, dumpYaml(reactivatedMeta));
          activeExisting = { ...existing, ...reactivatedMeta };
        }

        const [boardConfig, existingCursor] = await Promise.all([
          this.readBoardConfig(boardSlug),
          this.readSessionCursor(activeExisting.id),
        ]);
        const lastSynced =
          existingCursor?.syncedRevisions[boardSlug] ??
          (boardSlug === activeExisting.board ? (activeExisting.lastSyncedRevision ?? 0) : 0);

        if (lastSynced >= boardConfig.revision) {
          return { action: 'noop' as const };
        }

        const tailEvents = await this.readEventsSince(boardSlug, lastSynced, boardConfig.revision);
        const digestResult = buildSessionDriftDigest({
          sessionId: activeExisting.id,
          lastSyncedRevision: lastSynced,
          currentRevision: boardConfig.revision,
          events: tailEvents,
          maxLines: params.maxDigestLines,
        });

        if (digestResult.behindBy === 0 || digestResult.digest.length === 0) {
          // H8 + R2-2: Fast-forward runtime cursor using unlocked helper (workspace lock already held)
          assertActive();
          await this.commitHookDeliveryUnlocked({
            sessionId: activeExisting.id,
            boardSlug,
            revision: boardConfig.revision,
            stampCursorThrottle: false,
            now: nowStr,
          });
          return { action: 'noop' as const };
        }

        if (params.throttleMs !== undefined && existingCursor?.lastCursorInjectAt) {
          const lastInjectMs = Date.parse(existingCursor.lastCursorInjectAt);
          if (Number.isFinite(lastInjectMs) && nowMs - lastInjectMs < params.throttleMs) {
            return { action: 'throttled' as const };
          }
        }

        const pendingAck: HookDeliveryAck = {
          sessionId: activeExisting.id,
          boardSlug,
          revision: boardConfig.revision,
          stampCursorThrottle: params.throttleMs !== undefined,
          now: nowStr,
        };

        let hydratedCursor = existingCursor;
        if (!params.deferCursorCommit) {
          assertActive();
          hydratedCursor = await this.commitHookDeliveryUnlocked(pendingAck);
        }

        return {
          action: 'digest' as const,
          session: this.hydrateSession(activeExisting, boardSlug, hydratedCursor),
          boardConfig,
          digestResult,
          pendingAck,
        };
      },
      this.deckDir,
      { maxWaitMs },
    );
  }

  /**
   * Hook helper for SessionEnd / sessionEnd (AC5.2, D11, D12, N3):
   * Marks the matching session `idle` without bumping board.yaml.
   */
  public async markHookSessionIdle(params: {
    externalRef: string;
    maxWaitMs?: number;
    onCorruptSession?: (filePath: string, message: string) => void;
  }): Promise<boolean> {
    const onCorrupt = (filePath: string, err: unknown) => {
      params.onCorruptSession?.(filePath, err instanceof Error ? err.message : String(err));
    };
    const fastMatch = (await this.listAllRawSessions({ skipCorrupt: true, onCorrupt })).find(
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
        await this.migrateLegacySessionsUnlocked(assertActive, { skipCorrupt: true, onCorrupt });
        const current = (await this.listAllRawSessions({ skipCorrupt: true, onCorrupt })).find(
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
      jobId?: string;
      leaseToken?: string;
      note?: string;
      now?: Date;
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

      // Stage file bytes OUTSIDE the lock (D1). Immutable `<id>.v1<ext>` naming (D19).
      if (input.stagedTempPath) {
        const ext = input.fileName ? safeExt(input.fileName) : safeExt(input.stagedTempPath);
        storedFileName = `${id}.v1${ext}`;
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
        storedFileName = `${id}.v1${ext}`;
        const staged = await streamFileToTempFsync(input.sourceFilePath, mediaDir, limit);
        preStagedTmp = staged.tmpPath;
        ownPreStagedTmp = true;
      } else if (input.fileBuffer) {
        if (input.fileBuffer.length > limit) {
          throw new ValidationError(`Uploaded file exceeds limit of ${limit} bytes.`);
        }
        const ext = input.fileName ? safeExt(input.fileName) : '';
        storedFileName = `${id}.v1${ext}`;
        preStagedTmp = await writeTempFileFsync(mediaDir, input.fileBuffer, '.tmp-media-');
        ownPreStagedTmp = true;
      } else if (
        input.content !== undefined &&
        (input.kind === 'doc' || input.kind === 'html' || input.kind === 'json')
      ) {
        const ext = input.kind === 'html' ? '.html' : input.kind === 'json' ? '.json' : '.md';
        storedFileName = `${id}.v1${ext}`;
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

        const basedOnDecisions = input.basedOnDecisions ?? [];
        const versionEntry = ArtifactVersionEntrySchema.parse({
          version: 1,
          updatedAt: now,
          boardRevision: ev.revision,
          actor: eventActor,
          basedOnDecisions,
          ...(storedFileName ? { filePath: storedFileName } : {}),
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
          basedOnDecisions,
          version: 1,
          history: [versionEntry],
          confirmations: {},
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
        | 'durationSec'
        | 'tags'
        | 'basedOnDecisions'
        | 'externalUrl'
        | 'metadata'
      >
    > & {
      mimeType?: string;
      sourceFilePath?: string;
      stagedTempPath?: string;
      fileBuffer?: Buffer;
      fileName?: string;
      maxBytes?: number;
      jobId?: string;
      leaseToken?: string;
      note?: string;
      now?: Date;
    },
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<MediaArtifact> {
    validateEntityId(mediaId, 'mediaId');
    const {
      sourceFilePath,
      stagedTempPath,
      fileBuffer,
      fileName,
      mimeType,
      maxBytes,
      now: nowOpt,
      ...metadataPatch
    } = patch;
    const limit = maxBytes ?? this.maxMediaBytes;

    let preStagedTmp: string | undefined;
    let stagedExt = '';
    let ownPreStagedTmp = false;

    const safeExt = (rawName: string): string => {
      const ext = path.extname(rawName).toLowerCase();
      return /^\.[a-z0-9]{1,12}$/.test(ext) ? ext : '';
    };

    try {
      const slug = await this.resolveBoardSlug(boardSlug);
      await this.readBoardConfig(slug);
      const mediaDir = await this.safeBoardFilePath(slug, 'media');
      await ensureDir(mediaDir);

      // Stage big binary files OUTSIDE the workspace lock (D1, D17, D19)
      if (stagedTempPath) {
        stagedExt = fileName ? safeExt(fileName) : safeExt(stagedTempPath);
        const canonicalStagedTmp = await canonicalizePath(stagedTempPath);
        preStagedTmp = await assertContainedPath(mediaDir, canonicalStagedTmp, {
          label: 'staged media update file',
        });
        ownPreStagedTmp = true;
      } else if (sourceFilePath) {
        stagedExt = safeExt(sourceFilePath);
        const staged = await streamFileToTempFsync(sourceFilePath, mediaDir, limit);
        preStagedTmp = staged.tmpPath;
        ownPreStagedTmp = true;
      } else if (fileBuffer) {
        if (fileBuffer.length > limit) {
          throw new ValidationError(`Uploaded file exceeds limit of ${limit} bytes.`);
        }
        stagedExt = fileName ? safeExt(fileName) : '';
        preStagedTmp = await writeTempFileFsync(mediaDir, fileBuffer, '.tmp-media-');
        ownPreStagedTmp = true;
      }

      const stagedBinary = preStagedTmp
        ? { tmpPath: preStagedTmp, ext: stagedExt, mimeType }
        : undefined;

      return await this.mutate(slug, actor, (tx) =>
        this.updateMediaUnlocked(tx, mediaId, metadataPatch as Record<string, unknown>, undefined, stagedBinary, nowOpt),
      );
    } catch (err) {
      const txnExists = existsSync(path.join(this.runtimeDir, TXN_FILENAME));
      if (!txnExists && ownPreStagedTmp && preStagedTmp) {
        await fs.rm(preStagedTmp, { force: true }).catch(() => {});
      }
      throw err;
    }
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

      // D19: Delete removes ALL immutable versions `<id>.v<N>.<ext>` + current filePath + history filePaths
      const filesToDelete = new Set<string>();
      if (existing?.filePath) filesToDelete.add(existing.filePath);
      for (const h of existing?.history ?? []) {
        if (h.filePath) filesToDelete.add(h.filePath);
      }
      const allMediaFiles = await listFilesStrict(mediaDir);
      const versionRegex = new RegExp(`^${mediaId}\\.v\\d+(?:\\.[a-z0-9]{1,12})?$`);
      for (const file of allMediaFiles) {
        if (versionRegex.test(file)) {
          filesToDelete.add(file);
        }
      }

      for (const relFile of filesToDelete) {
        const assetPath = await assertContainedPath(mediaDir, path.join(mediaDir, relFile), {
          label: `media file "${relFile}"`,
        });
        tx.stageDelete(assetPath);
      }

      tx.addEvent({
        kind: 'media.deleted',
        entityId: mediaId,
        summary: `Removed media artifact ${mediaId}`,
      });
    });
  }

  /**
   * Prune historical `<id>.v<N>.<ext>` media files (AC7.6, D19).
   * Keeps the active `filePath`, the newest `keepVersions` files per artifact, and
   * NEVER removes versions referenced by open (`queued` or `claimed`) jobs.
   */
  public async pruneMedia(
    boardSlug?: string,
    options: { keepVersions?: number; dryRun?: boolean } = {},
  ): Promise<{ prunedFiles: string[]; keptFiles: string[]; freedBytes: number }> {
    const keepVersions = Math.max(1, options.keepVersions ?? 1);
    const dryRun = Boolean(options.dryRun);
    const slug = await this.resolveBoardSlug(boardSlug);

    return withWorkspaceLock(
      this.runtimeDir,
      async (assertActive) => {
        await this.readBoardConfig(slug);
        const mediaDir = await this.safeBoardFilePath(slug, 'media');
        const [artifacts, jobs, allFiles] = await Promise.all([
          this.listMedia(slug, { loadContent: false }),
          this.listJobs(slug),
          listFilesStrict(mediaDir),
        ]);

        const openJobsByMedia = new Map<string, RefreshJob[]>();
        for (const job of jobs) {
          if (job.artifactType !== 'media') continue;
          if (job.status !== 'queued' && job.status !== 'claimed') continue;
          const arr = openJobsByMedia.get(job.artifactId) ?? [];
          arr.push(job);
          openJobsByMedia.set(job.artifactId, arr);
        }

        const protectedFiles = new Set<string>();
        const candidateVersionFiles: Array<{ file: string; mediaId: string; version: number }> = [];
        const versionPattern = /^([A-Za-z0-9][A-Za-z0-9_-]{0,80})\.v([1-9]\d*)(?:\.[a-z0-9]{1,12})?$/;

        for (const art of artifacts) {
          if (art.filePath) protectedFiles.add(art.filePath);
          const openJobs = openJobsByMedia.get(art.id) ?? [];
          const openJobIds = new Set(openJobs.map((j) => j.id));
          for (const openJob of openJobs) {
            if (openJob.inputFilePath) {
              protectedFiles.add(openJob.inputFilePath);
            }
          }
          const minProtectedVer =
            openJobs.length > 0 ? Math.min(...openJobs.map((j) => j.baseVersion)) : Infinity;

          for (const h of art.history) {
            if (!h.filePath) continue;
            if (h.version >= minProtectedVer || (h.createdByJob && openJobIds.has(h.createdByJob))) {
              protectedFiles.add(h.filePath);
            }
          }

          const versionsOnDisk: Array<{ file: string; version: number }> = [];
          for (const file of allFiles) {
            if (file.endsWith('.meta.yaml')) continue;
            const m = file.match(versionPattern);
            if (!m || m[1] !== art.id) continue;
            const ver = Number.parseInt(m[2], 10);
            if (ver >= minProtectedVer) {
              protectedFiles.add(file);
            }
            versionsOnDisk.push({ file, version: ver });
          }

          versionsOnDisk.sort((a, b) => b.version - a.version);
          for (const keep of versionsOnDisk.slice(0, keepVersions)) {
            protectedFiles.add(keep.file);
          }
          for (const item of versionsOnDisk) {
            candidateVersionFiles.push({ file: item.file, mediaId: art.id, version: item.version });
          }
        }

        const prunedFiles: string[] = [];
        const keptFiles: string[] = [];
        let freedBytes = 0;

        for (const cand of candidateVersionFiles) {
          if (protectedFiles.has(cand.file)) {
            keptFiles.push(cand.file);
            continue;
          }
          const absPath = await assertContainedPath(mediaDir, path.join(mediaDir, cand.file), {
            label: `prune media "${cand.file}"`,
          });
          const st = await fs.stat(absPath).catch(() => null);
          if (!dryRun) {
            assertActive();
            await fs.rm(absPath, { force: true });
          }
          prunedFiles.push(cand.file);
          if (st) freedBytes += st.size;
        }

        return { prunedFiles: prunedFiles.sort(), keptFiles: keptFiles.sort(), freedBytes };
      },
      this.deckDir,
    );
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

  /**
   * Update a quiz while preserving all existing attempts (AC7.6, D17).
   * Bumps version and records history (capped at 10). Validates jobId if linked to a refresh job.
   */
  public async updateQuiz(
    boardSlug: string | undefined,
    quizId: string,
    rawPatch: {
      title?: string;
      topic?: string;
      description?: string;
      questions?: QuizQuestion[];
      basedOnDecisions?: string[];
      jobId?: string;
      leaseToken?: string;
      note?: string;
      now?: Date;
    },
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<Quiz> {
    validateEntityId(quizId, 'quizId');
    const { now: nowOpt, ...schemaPatch } = rawPatch;
    const patch = parseStrict(UpdateQuizPatchSchema.omit({ actor: true }), schemaPatch, 'quiz update');
    const nowDate = nowOpt ?? new Date();
    const now = nowDate.toISOString();

    return this.mutate(boardSlug, actor, async (tx) => {
      const existing = await this.readQuizById(tx.slug, quizId);
      if (!existing) {
        throw new NotFoundError(`Quiz "${quizId}" not found on board "${tx.slug}".`);
      }

      const activeClaim = await this.validateActiveJobClaim(
        tx.slug,
        patch.jobId,
        patch.leaseToken,
        'quiz',
        existing.id,
        nowDate.getTime(),
      );
      if (activeClaim) {
        if (
          !patch.questions ||
          JSON.stringify(patch.questions) === JSON.stringify(existing.questions)
        ) {
          throw new ValidationError(
            'Cannot record refresh job version for quiz without updated questions.',
          );
        }
      }

      const nextVersion = existing.version + 1;
      const nextQuestions = patch.questions ?? existing.questions;
      const nextBasedOn = patch.basedOnDecisions ?? existing.basedOnDecisions;
      const ev = tx.addEvent({
        kind: 'quiz.updated',
        entityId: existing.id,
        summary: `Updated quiz "${patch.title ?? existing.title}" (v${nextVersion})`,
      });

      const versionEntry = ArtifactVersionEntrySchema.parse({
        version: nextVersion,
        updatedAt: now,
        boardRevision: ev.revision,
        actor: tx.actor,
        basedOnDecisions: nextBasedOn,
        contentHash: ContextDeckStore.sha256Hex(JSON.stringify(nextQuestions)),
        ...(activeClaim
          ? { createdByJob: activeClaim.job.id, createdByClaim: activeClaim.claimFingerprint }
          : {}),
        ...(patch.note ? { note: patch.note } : {}),
      });

      const questionsChanged =
        patch.questions !== undefined &&
        JSON.stringify(patch.questions) !== JSON.stringify(existing.questions);
      const allowedConfDecisions = [
        ...nextBasedOn,
        ...nextQuestions.flatMap((q) => q.relatedDecisionIds ?? []),
      ];

      const updated = QuizSchema.parse({
        ...existing,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.topic !== undefined ? { topic: patch.topic } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        questions: nextQuestions,
        // D17: Always preserve attempts across quiz updates
        attempts: existing.attempts,
        basedOnDecisions: nextBasedOn,
        version: nextVersion,
        history: appendArtifactHistory(existing, versionEntry),
        confirmations: questionsChanged
          ? {}
          : retainRelevantConfirmations(existing.confirmations, allowedConfDecisions),
        boardRevisionAtUpdate: ev.revision,
        updatedAt: now,
      });

      const quizPath = await this.safeBoardFilePath(tx.slug, 'quizzes', `${updated.id}.quiz.json`);
      tx.stageFile(quizPath, `${JSON.stringify(updated, null, 2)}\n`);
      return updated;
    });
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

  /**
   * Record a confirmation that a stale artifact (diagram, media, or quiz) is still accurate
   * against the current superseding decision(s), WITHOUT rewriting `basedOnDecisions` (AC7.3, D14, D17).
   * Drift clears only while the latest replacement equals `againstDecisionId` (auto re-stale on next supersede).
   * Tasks are NOT refresh/confirm targets (D17).
   */
  public async confirmArtifact(
    boardSlug: string | undefined,
    artifactType: RefreshJobArtifactType,
    artifactId: string,
    rawInput: { note?: string; decisionIds?: string[] } = {},
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<Diagram | MediaArtifact | Quiz> {
    const validType = parseStrict(RefreshJobArtifactTypeSchema, artifactType, 'artifactType');
    validateEntityId(artifactId, 'artifactId');
    const input = parseStrict(ConfirmArtifactInputSchema.omit({ actor: true }), rawInput, 'artifact confirmation');

    return this.mutate(boardSlug, actor, async (tx) => {
      const decisions = await this.listDecisions(tx.slug);
      const decisionMap = new Map(decisions.map((d) => [d.id, d]));
      const now = nowIso();
      const actorType: 'human' | 'agent' = tx.actor.type === 'human' ? 'human' : 'agent';
      const confirmedBy =
        tx.actor.label ??
        (tx.actor.harness ? `${tx.actor.harness}${tx.actor.sessionId ? `:${tx.actor.sessionId}` : ''}` : undefined) ??
        tx.actor.sessionId ??
        actorType;

      const buildConfirmations = (
        existingConfirmations: Record<string, ArtifactConfirmation>,
        referencedDecisionIds: string[],
      ): {
        nextConfirmations: Record<string, ArtifactConfirmation>;
        confirmedAgainst: Array<{ staleId: string; againstId: string }>;
      } => {
        const { staleIds } = evaluateDecisionStaleness(
          referencedDecisionIds,
          decisionMap,
          existingConfirmations,
        );
        const targetIds = input.decisionIds
          ? staleIds.filter((id) => input.decisionIds!.includes(id))
          : staleIds;

        const nextConfirmations: Record<string, ArtifactConfirmation> = { ...existingConfirmations };
        const confirmedAgainst: Array<{ staleId: string; againstId: string }> = [];

        for (const staleId of targetIds) {
          const dec = decisionMap.get(staleId);
          if (!dec) continue;
          const latest =
            dec.status === 'superseded' ? resolveLatestDecision(dec.id, decisionMap) : dec;
          const againstId = latest?.id ?? dec.id;
          nextConfirmations[staleId] = ArtifactConfirmationSchema.parse({
            againstDecisionId: againstId,
            confirmedBy,
            actorType,
            confirmedAt: now,
            note: input.note ?? '',
          });
          confirmedAgainst.push({ staleId, againstId });
        }

        return { nextConfirmations, confirmedAgainst };
      };

      if (validType === 'diagram') {
        const item = await this.readDiagramById(tx.slug, artifactId);
        if (!item) throw new NotFoundError(`Diagram "${artifactId}" not found.`);
        const { nextConfirmations, confirmedAgainst } = buildConfirmations(
          item.confirmations,
          item.basedOnDecisions,
        );
        const updated = DiagramSchema.parse({
          ...item,
          confirmations: nextConfirmations,
          updatedAt: now,
        });
        const { content: _content, ...meta } = updated;
        const metaPath = await this.safeBoardFilePath(tx.slug, 'diagrams', `${updated.id}.meta.yaml`);
        tx.stageFile(metaPath, dumpYaml(meta));
        tx.addEvent({
          kind: 'artifact.confirmed',
          entityId: updated.id,
          summary: `Confirmed diagram "${updated.title}" still accurate (${actorType}: ${confirmedBy})`,
          details: {
            artifactType: 'diagram',
            artifactId: updated.id,
            actorType,
            confirmedBy,
            confirmedAgainst,
            note: input.note ?? '',
          },
        });
        return updated;
      }

      if (validType === 'media') {
        const item = await this.readMediaById(tx.slug, artifactId, { loadContent: true });
        if (!item) throw new NotFoundError(`Media "${artifactId}" not found.`);
        const { nextConfirmations, confirmedAgainst } = buildConfirmations(
          item.confirmations,
          item.basedOnDecisions,
        );
        const updated = MediaArtifactSchema.parse({
          ...item,
          confirmations: nextConfirmations,
          updatedAt: now,
        });
        const mediaDir = await this.safeBoardFilePath(tx.slug, 'media');
        const metaPath = await assertContainedPath(
          mediaDir,
          path.join(mediaDir, `${updated.id}.meta.yaml`),
          { label: `media meta "${updated.id}"` },
        );
        const { content: _inlineContent, ...metaOnly } = updated;
        tx.stageFile(metaPath, dumpYaml(updated.filePath ? metaOnly : updated));
        tx.addEvent({
          kind: 'artifact.confirmed',
          entityId: updated.id,
          summary: `Confirmed ${updated.kind} "${updated.title}" still accurate (${actorType}: ${confirmedBy})`,
          details: {
            artifactType: 'media',
            artifactId: updated.id,
            actorType,
            confirmedBy,
            confirmedAgainst,
            note: input.note ?? '',
          },
        });
        return updated;
      }

      const quiz = await this.readQuizById(tx.slug, artifactId);
      if (!quiz) throw new NotFoundError(`Quiz "${artifactId}" not found.`);
      const allQuizDecs = [
        ...quiz.basedOnDecisions,
        ...quiz.questions.flatMap((q) => q.relatedDecisionIds ?? []),
      ];
      const { nextConfirmations, confirmedAgainst } = buildConfirmations(
        quiz.confirmations,
        allQuizDecs,
      );
      const updated = QuizSchema.parse({
        ...quiz,
        confirmations: nextConfirmations,
        updatedAt: now,
      });
      const quizPath = await this.safeBoardFilePath(tx.slug, 'quizzes', `${updated.id}.quiz.json`);
      tx.stageFile(quizPath, `${JSON.stringify(updated, null, 2)}\n`);
      tx.addEvent({
        kind: 'artifact.confirmed',
        entityId: updated.id,
        summary: `Confirmed quiz "${updated.title}" still accurate (${actorType}: ${confirmedBy})`,
        details: {
          artifactType: 'quiz',
          artifactId: updated.id,
          actorType,
          confirmedBy,
          confirmedAgainst,
          note: input.note ?? '',
        },
      });
      return updated;
    });
  }

  /**
   * Queue a refresh job for a stale artifact (diagram, media, or quiz) with active-job dedupe (AC7.4, D19).
   */
  public async createRefreshJob(
    boardSlug: string | undefined,
    rawInput: {
      artifactType: RefreshJobArtifactType;
      artifactId: string;
      reason?: string;
    },
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<{ job: RefreshJob; deduplicated: boolean }> {
    const input = parseStrict(CreateRefreshJobInputSchema.omit({ actor: true }), rawInput, 'refresh job');

    return this.mutate(boardSlug, actor, async (tx) => {
      // Dedupe active (queued or claimed) jobs per artifact (D19)
      const existingJobs = await this.listJobs(tx.slug);
      const active = existingJobs.find(
        (j) =>
          j.artifactType === input.artifactType &&
          j.artifactId === input.artifactId &&
          (j.status === 'queued' || j.status === 'claimed'),
      );
      if (active) {
        return { job: active, deduplicated: true };
      }

      const decisions = await this.listDecisions(tx.slug);
      const decisionMap = new Map(decisions.map((d) => [d.id, d]));

      let artifactTitle: string;
      let baseVersion: number;
      let basedOnDecisions: string[];
      let mediaKind: MediaKind | undefined;
      let diagramKind: DiagramKind | undefined;
      let inputFilePath: string | undefined;
      let inputContentHash: string | undefined;
      let kindLabel: string = input.artifactType;

      if (input.artifactType === 'diagram') {
        const diag = await this.readDiagramById(tx.slug, input.artifactId);
        if (!diag) throw new NotFoundError(`Diagram "${input.artifactId}" not found.`);
        artifactTitle = diag.title;
        baseVersion = diag.version;
        basedOnDecisions = diag.basedOnDecisions;
        diagramKind = diag.kind;
        inputContentHash = ContextDeckStore.sha256Hex(diag.content);
        kindLabel = `${diag.kind} diagram`;
      } else if (input.artifactType === 'media') {
        const media = await this.readMediaById(tx.slug, input.artifactId, { loadContent: true });
        if (!media) throw new NotFoundError(`Media "${input.artifactId}" not found.`);
        artifactTitle = media.title;
        baseVersion = media.version;
        basedOnDecisions = media.basedOnDecisions;
        mediaKind = media.kind;
        inputFilePath = media.filePath;
        if (media.content !== undefined) {
          inputContentHash = ContextDeckStore.sha256Hex(media.content);
        }
        kindLabel = media.kind;
      } else {
        const quiz = await this.readQuizById(tx.slug, input.artifactId);
        if (!quiz) throw new NotFoundError(`Quiz "${input.artifactId}" not found.`);
        artifactTitle = quiz.title;
        baseVersion = quiz.version;
        basedOnDecisions = [
          ...quiz.basedOnDecisions,
          ...quiz.questions.flatMap((q) => q.relatedDecisionIds ?? []),
        ];
        inputContentHash = ContextDeckStore.sha256Hex(JSON.stringify(quiz.questions));
        kindLabel = 'quiz';
      }

      const { staleIds } = evaluateDecisionStaleness(basedOnDecisions, decisionMap);
      const decisionsBefore = staleIds.length > 0 ? staleIds : Array.from(new Set(basedOnDecisions));
      const decisionsNowSet = new Set<string>();
      for (const decId of decisionsBefore) {
        const latest = resolveLatestDecision(decId, decisionMap);
        if (latest) decisionsNowSet.add(latest.id);
      }
      const decisionsNow = Array.from(decisionsNowSet);

      const defaultReason =
        decisionsNow.length > 0
          ? `regenerate ${kindLabel} "${artifactTitle}" for ${decisionsNow.join(', ')}`
          : `regenerate ${kindLabel} "${artifactTitle}"`;
      const reason = input.reason?.trim() || defaultReason;

      const now = nowIso();
      const id = shortId('job');
      const job = RefreshJobSchema.parse({
        id,
        kind: 'refresh',
        artifactType: input.artifactType,
        artifactId: input.artifactId,
        artifactTitle,
        ...(mediaKind ? { mediaKind } : {}),
        ...(diagramKind ? { diagramKind } : {}),
        reason,
        decisionsBefore,
        decisionsNow,
        baseVersion,
        ...(inputFilePath ? { inputFilePath } : {}),
        ...(inputContentHash ? { inputContentHash } : {}),
        status: 'queued',
        claimedBy: null,
        leaseToken: null,
        claimedAt: null,
        leaseExpiresAt: null,
        result: null,
        createdAt: now,
        updatedAt: now,
      });

      const jobsDir = await this.safeBoardFilePath(tx.slug, 'jobs');
      await ensureDir(jobsDir);
      const jobPath = await assertContainedPath(jobsDir, path.join(jobsDir, `${job.id}.yaml`), {
        label: `job "${job.id}"`,
      });
      tx.stageFile(jobPath, dumpYaml(job), { noClobber: true });
      tx.addEvent({
        kind: 'job.created',
        entityId: job.id,
        summary: `Refresh job waiting: ${reason}`,
        details: {
          artifactType: job.artifactType,
          artifactId: job.artifactId,
          artifactTitle: job.artifactTitle,
          decisionsBefore: job.decisionsBefore,
          decisionsNow: job.decisionsNow,
          baseVersion: job.baseVersion,
        },
      });

      return { job, deduplicated: false };
    });
  }

  /**
   * Atomically claim a queued (or lease-expired) refresh job with a lease token and 15 min TTL (AC7.4, D19).
   */
  public async claimJob(
    boardSlug: string | undefined,
    rawInput: {
      jobId?: string;
      artifactType?: RefreshJobArtifactType;
      mediaKind?: MediaKind;
      claimedBy: string;
      ttlMs?: number;
      now?: Date;
    },
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<RefreshJob | null> {
    const { now: nowOpt, ...schemaInput } = rawInput;
    const input = parseStrict(ClaimJobInputSchema.omit({ actor: true }), schemaInput, 'job claim');
    const nowDate = nowOpt ?? new Date();
    const nowMs = nowDate.getTime();
    const nowStr = nowDate.toISOString();
    const ttlMs = input.ttlMs ?? DEFAULT_JOB_LEASE_TTL_MS;

    const isClaimable = (job: RefreshJob): boolean => {
      if (job.status === 'queued') return true;
      if (job.status === 'claimed' && job.leaseExpiresAt) {
        const expMs = Date.parse(job.leaseExpiresAt);
        return Number.isFinite(expMs) && expMs <= nowMs;
      }
      return false;
    };

    return this.mutate(boardSlug, actor, async (tx) => {
      let target: RefreshJob | null = null;
      if (input.jobId) {
        const found = await this.readJobById(tx.slug, input.jobId);
        if (!found) {
          throw new NotFoundError(`Refresh job "${input.jobId}" not found on board "${tx.slug}".`);
        }
        if (!isClaimable(found)) {
          throw new ConflictError(
            `Refresh job "${found.id}" cannot be claimed (status: ${found.status}, active lease until ${found.leaseExpiresAt ?? 'n/a'}).`,
          );
        }
        target = found;
      } else {
        const allJobs = await this.listJobs(tx.slug);
        target =
          allJobs.find((j) => {
            if (!isClaimable(j)) return false;
            if (input.artifactType && j.artifactType !== input.artifactType) return false;
            if (input.mediaKind && j.mediaKind !== input.mediaKind) return false;
            return true;
          }) ?? null;
        if (!target) return null;
      }

      const leaseToken = crypto.randomBytes(16).toString('hex');
      const leaseExpiresAt = new Date(nowMs + ttlMs).toISOString();
      const updated = RefreshJobSchema.parse({
        ...target,
        status: 'claimed',
        claimedBy: input.claimedBy,
        leaseToken,
        claimedAt: nowStr,
        leaseExpiresAt,
        updatedAt: nowStr,
      });

      const jobPath = await this.safeBoardFilePath(tx.slug, 'jobs', `${updated.id}.yaml`);
      tx.stageFile(jobPath, dumpYaml(updated));
      tx.addEvent({
        kind: 'job.claimed',
        entityId: updated.id,
        summary: `Claimed refresh job ${updated.id} by ${input.claimedBy}`,
      });
      return updated;
    });
  }

  /**
   * Renew an active job lease with a matching lease token (D19).
   */
  public async renewJob(
    boardSlug: string | undefined,
    jobId: string,
    rawInput: { leaseToken: string; ttlMs?: number; now?: Date },
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<RefreshJob> {
    validateEntityId(jobId, 'jobId');
    const { now: nowOpt, ...schemaInput } = rawInput;
    const input = parseStrict(RenewJobInputSchema.omit({ actor: true }), schemaInput, 'job renew');
    const nowDate = nowOpt ?? new Date();
    const nowMs = nowDate.getTime();
    const nowStr = nowDate.toISOString();
    const ttlMs = input.ttlMs ?? DEFAULT_JOB_LEASE_TTL_MS;

    return this.mutate(boardSlug, actor, async (tx) => {
      const existing = await this.readJobById(tx.slug, jobId);
      if (!existing) {
        throw new NotFoundError(`Refresh job "${jobId}" not found on board "${tx.slug}".`);
      }
      if (existing.status !== 'claimed' || !existing.leaseToken || existing.leaseToken !== input.leaseToken) {
        throw new ConflictError(`Invalid lease token or job "${jobId}" is not actively claimed.`);
      }
      if (existing.leaseExpiresAt && Date.parse(existing.leaseExpiresAt) <= nowMs) {
        throw new ConflictError(`Lease for refresh job "${jobId}" has already expired.`);
      }

      const updated = RefreshJobSchema.parse({
        ...existing,
        leaseExpiresAt: new Date(nowMs + ttlMs).toISOString(),
        updatedAt: nowStr,
      });
      const jobPath = await this.safeBoardFilePath(tx.slug, 'jobs', `${updated.id}.yaml`);
      tx.stageFile(jobPath, dumpYaml(updated));
      tx.addEvent({
        kind: 'job.renewed',
        entityId: updated.id,
        summary: `Renewed lease for refresh job ${updated.id}`,
      });
      return updated;
    });
  }

  /**
   * Release a claimed job back to `queued` using its lease token (D19).
   */
  public async releaseJob(
    boardSlug: string | undefined,
    jobId: string,
    rawInput: { leaseToken: string; reason?: string },
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<RefreshJob> {
    validateEntityId(jobId, 'jobId');
    const input = parseStrict(ReleaseJobInputSchema.omit({ actor: true }), rawInput, 'job release');

    return this.mutate(boardSlug, actor, async (tx) => {
      const existing = await this.readJobById(tx.slug, jobId);
      if (!existing) {
        throw new NotFoundError(`Refresh job "${jobId}" not found on board "${tx.slug}".`);
      }
      if (existing.status !== 'claimed' || !existing.leaseToken || existing.leaseToken !== input.leaseToken) {
        throw new ConflictError(`Invalid lease token or job "${jobId}" is not claimed.`);
      }

      const updated = RefreshJobSchema.parse({
        ...existing,
        status: 'queued',
        claimedBy: null,
        leaseToken: null,
        claimedAt: null,
        leaseExpiresAt: null,
        updatedAt: nowIso(),
      });
      const jobPath = await this.safeBoardFilePath(tx.slug, 'jobs', `${updated.id}.yaml`);
      tx.stageFile(jobPath, dumpYaml(updated));
      tx.addEvent({
        kind: 'job.released',
        entityId: updated.id,
        summary: input.reason
          ? `Released refresh job ${updated.id}: ${input.reason}`
          : `Released refresh job ${updated.id} back to queue`,
      });
      return updated;
    });
  }

  /**
   * Complete (or fail) a claimed refresh job (AC7.4, D19).
   * When completing as `done`, strictly requires that the target artifact has a new version
   * (`version > baseVersion`) whose history entry has `createdByJob === job.id`.
   */
  public async completeJob(
    boardSlug: string | undefined,
    jobId: string,
    rawInput: {
      leaseToken: string;
      status?: 'done' | 'failed';
      artifactVersion?: number;
      summary?: string;
      error?: string;
      now?: Date;
    },
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<RefreshJob> {
    validateEntityId(jobId, 'jobId');
    const { now: nowOpt, ...schemaInput } = rawInput;
    const input = parseStrict(CompleteJobInputSchema.omit({ actor: true }), schemaInput, 'job complete');
    const nowDate = nowOpt ?? new Date();
    const nowMs = nowDate.getTime();
    const nowStr = nowDate.toISOString();
    const targetStatus = input.status ?? 'done';

    return this.mutate(boardSlug, actor, async (tx) => {
      const existing = await this.readJobById(tx.slug, jobId);
      if (!existing) {
        throw new NotFoundError(`Refresh job "${jobId}" not found on board "${tx.slug}".`);
      }
      if (existing.status !== 'claimed' || !existing.leaseToken || existing.leaseToken !== input.leaseToken) {
        throw new ConflictError(`Invalid lease token or job "${jobId}" is not claimed.`);
      }
      if (existing.leaseExpiresAt && Date.parse(existing.leaseExpiresAt) <= nowMs) {
        throw new ConflictError(`Lease for refresh job "${jobId}" has expired; reclaim before completing.`);
      }

      if (targetStatus === 'failed') {
        const failed = RefreshJobSchema.parse({
          ...existing,
          status: 'failed',
          leaseToken: null,
          leaseExpiresAt: null,
          result: {
            ...(input.error ? { error: input.error } : {}),
            ...(input.summary ? { summary: input.summary } : {}),
          },
          updatedAt: nowStr,
        });
        const jobPath = await this.safeBoardFilePath(tx.slug, 'jobs', `${failed.id}.yaml`);
        tx.stageFile(jobPath, dumpYaml(failed));
        tx.addEvent({
          kind: 'job.failed',
          entityId: failed.id,
          summary: `Refresh job ${failed.id} failed${input.error ? `: ${input.error}` : ''}`,
        });
        return failed;
      }

      // D19 / AC7.4 strict verification: artifact must have version > baseVersion,
      // createdByJob === job.id AND createdByClaim === fingerprint(leaseToken),
      // and must have changed the underlying media file / diagram content / quiz questions.
      const expectedClaim = ContextDeckStore.computeClaimFingerprint(existing.leaseToken);
      let artifactVersion: number;
      let history: ArtifactVersionEntry[];
      let currentDiagram: Diagram | null = null;
      let currentMedia: MediaArtifact | null = null;
      let currentQuiz: Quiz | null = null;
      if (existing.artifactType === 'diagram') {
        const diag = await this.readDiagramById(tx.slug, existing.artifactId);
        if (!diag) throw new NotFoundError(`Target diagram "${existing.artifactId}" no longer exists.`);
        currentDiagram = diag;
        artifactVersion = diag.version;
        history = diag.history;
      } else if (existing.artifactType === 'media') {
        const media = await this.readMediaById(tx.slug, existing.artifactId, { loadContent: true });
        if (!media) throw new NotFoundError(`Target media "${existing.artifactId}" no longer exists.`);
        currentMedia = media;
        artifactVersion = media.version;
        history = media.history;
      } else {
        const quiz = await this.readQuizById(tx.slug, existing.artifactId);
        if (!quiz) throw new NotFoundError(`Target quiz "${existing.artifactId}" no longer exists.`);
        currentQuiz = quiz;
        artifactVersion = quiz.version;
        history = quiz.history;
      }

      const claimedVersion = input.artifactVersion ?? artifactVersion;
      if (artifactVersion <= existing.baseVersion || claimedVersion <= existing.baseVersion) {
        throw new ValidationError(
          `Cannot complete refresh job "${existing.id}": artifact version (${claimedVersion}) must be greater than baseVersion (${existing.baseVersion}).`,
        );
      }

      const matchingEntry = history.find(
        (h) =>
          h.version === claimedVersion &&
          h.createdByJob === existing.id &&
          h.createdByClaim === expectedClaim,
      );
      if (!matchingEntry) {
        throw new ValidationError(
          `Cannot complete refresh job "${existing.id}": artifact version ${claimedVersion} was not created by the active claim for job "${existing.id}".`,
        );
      }

      if (currentMedia) {
        const isFileBackedAv =
          (currentMedia.kind === 'video' || currentMedia.kind === 'audio') &&
          Boolean(existing.inputFilePath || currentMedia.filePath);
        if (isFileBackedAv) {
          if (!matchingEntry.filePath || matchingEntry.filePath === existing.inputFilePath) {
            throw new ValidationError(
              `Cannot complete refresh job "${existing.id}": file-backed ${currentMedia.kind} version ${claimedVersion} did not produce a new media file.`,
            );
          }
        } else if (
          existing.inputFilePath &&
          (currentMedia.kind === 'doc' || currentMedia.kind === 'html' || currentMedia.kind === 'json')
        ) {
          const currentHash =
            matchingEntry.contentHash ??
            (currentMedia.content !== undefined
              ? ContextDeckStore.sha256Hex(currentMedia.content)
              : undefined);
          if (
            matchingEntry.filePath === existing.inputFilePath &&
            existing.inputContentHash &&
            currentHash === existing.inputContentHash
          ) {
            throw new ValidationError(
              `Cannot complete refresh job "${existing.id}": ${currentMedia.kind} content is unchanged.`,
            );
          }
        }
      } else if (currentDiagram && existing.inputContentHash) {
        const currentHash =
          matchingEntry.contentHash ?? ContextDeckStore.sha256Hex(currentDiagram.content);
        if (currentHash === existing.inputContentHash) {
          throw new ValidationError(
            `Cannot complete refresh job "${existing.id}": diagram content is unchanged from base version.`,
          );
        }
      } else if (currentQuiz && existing.inputContentHash) {
        const currentHash =
          matchingEntry.contentHash ??
          ContextDeckStore.sha256Hex(JSON.stringify(currentQuiz.questions));
        if (currentHash === existing.inputContentHash) {
          throw new ValidationError(
            `Cannot complete refresh job "${existing.id}": quiz questions are unchanged from base version.`,
          );
        }
      }

      const completed = RefreshJobSchema.parse({
        ...existing,
        status: 'done',
        leaseToken: null,
        leaseExpiresAt: null,
        result: {
          artifactVersion: claimedVersion,
          ...(input.summary ? { summary: input.summary } : {}),
        },
        updatedAt: nowStr,
      });
      const jobPath = await this.safeBoardFilePath(tx.slug, 'jobs', `${completed.id}.yaml`);
      tx.stageFile(jobPath, dumpYaml(completed));
      tx.addEvent({
        kind: 'job.completed',
        entityId: completed.id,
        summary: `Completed refresh job ${completed.id} (${completed.artifactType} "${completed.artifactTitle}" → v${claimedVersion})`,
        details: {
          artifactType: completed.artifactType,
          artifactId: completed.artifactId,
          artifactVersion: claimedVersion,
        },
      });
      return completed;
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
