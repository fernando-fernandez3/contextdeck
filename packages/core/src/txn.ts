import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { CorruptDataError, LockCompromisedError, PayloadTooLargeError } from './errors.js';
import { BOARD_SLUG_REGEX, ENTITY_ID_REGEX } from './ids.js';
import { assertContainedPath, canonicalizePath, canonicalizePathSync } from './paths.js';

export const TXN_FILENAME = 'txn.json';
export const LOCK_SENTINEL_NAME = 'lock';

const TxnOpSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('rename'),
    tmpPath: z.string().min(1),
    finalPath: z.string().min(1),
  }),
  z.object({
    kind: z.literal('link_create'),
    tmpPath: z.string().min(1),
    finalPath: z.string().min(1),
  }),
  z.object({
    kind: z.literal('unlink'),
    finalPath: z.string().min(1),
  }),
]);

const TxnEventSchema = z.object({
  eventsPath: z.string().min(1),
  eventId: z.string().min(1),
  line: z.string().min(1),
});

export const TxnJournalSchema = z.object({
  id: z.string().min(1),
  boardSlug: z.string().optional(),
  ops: z.array(TxnOpSchema),
  events: z.array(TxnEventSchema),
  boardCommit: z
    .object({
      tmpPath: z.string().min(1),
      finalPath: z.string().min(1),
    })
    .optional(),
});

export type TxnOp = z.infer<typeof TxnOpSchema>;
export type TxnEventEntry = z.infer<typeof TxnEventSchema>;
export type TxnJournal = z.infer<typeof TxnJournalSchema>;

function isTransientFsError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

export async function retryOnTransientFsError<T>(
  op: () => Promise<T>,
  options: { attempts?: number; initialDelayMs?: number } = {},
): Promise<T> {
  const { attempts = 5, initialDelayMs = 15 } = options;
  let delayMs = initialDelayMs;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await op();
    } catch (err) {
      if (i === attempts - 1 || !isTransientFsError(err)) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs *= 2;
    }
  }
  throw new Error('retryOnTransientFsError exhausted without result');
}

export async function renameWithRetry(src: string, dst: string, attempts = 5): Promise<void> {
  await retryOnTransientFsError(() => fs.rename(src, dst), { attempts });
}

export async function linkCreateAtomic(src: string, dst: string, attempts = 5): Promise<void> {
  try {
    await retryOnTransientFsError(() => fs.link(src, dst), { attempts });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      // If crashing between link and unlink during roll-forward, inodes match.
      const [srcStat, dstStat] = await Promise.all([fs.lstat(src), fs.lstat(dst)]);
      if (srcStat.ino !== dstStat.ino || srcStat.dev !== dstStat.dev) {
        throw err;
      }
    } else {
      throw err;
    }
  }
  await retryOnTransientFsError(() => fs.unlink(src), { attempts }).catch((err) => {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  });
}

export async function writeTempFileFsync(
  targetDir: string,
  content: string | Buffer,
  prefix = '.tmp-',
): Promise<string> {
  const tmpPath = path.join(targetDir, `${prefix}${crypto.randomBytes(8).toString('hex')}`);
  let fh: fs.FileHandle;
  try {
    fh = await fs.open(tmpPath, 'wx', 0o644);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.mkdir(targetDir, { recursive: true });
      fh = await fs.open(tmpPath, 'wx', 0o644);
    } else {
      throw err;
    }
  }
  try {
    if (typeof content === 'string') {
      await fh.writeFile(content, 'utf8');
    } else {
      await fh.writeFile(content);
    }
    await fh.sync();
  } catch (err) {
    await fh.close().catch(() => {});
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
  await fh.close();
  return tmpPath;
}

export async function atomicWriteFile(
  finalPath: string,
  content: string | Buffer,
  mode?: number,
): Promise<void> {
  const dir = path.dirname(finalPath);
  const tmpPath = await writeTempFileFsync(dir, content);
  try {
    if (mode !== undefined) {
      await fs.chmod(tmpPath, mode).catch(() => {});
    }
    await renameWithRetry(tmpPath, finalPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Stream a file from `sourcePath` into a newly created temp file inside `targetDir`,
 * enforcing `maxBytes` while streaming (never buffering the full file in memory).
 */
export async function streamFileToTempFsync(
  sourcePath: string,
  targetDir: string,
  maxBytes: number,
): Promise<{ tmpPath: string; bytesWritten: number }> {
  await fs.mkdir(targetDir, { recursive: true });
  const tmpPath = path.join(targetDir, `.tmp-media-${crypto.randomBytes(8).toString('hex')}`);
  const fh = await fs.open(tmpPath, 'wx', 0o644);
  let bytesWritten = 0;

  try {
    const rs = createReadStream(sourcePath, { highWaterMark: 64 * 1024 });
    for await (const chunk of rs) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesWritten += buf.length;
      if (bytesWritten > maxBytes) {
        rs.destroy();
        throw new PayloadTooLargeError(
          `File exceeds maximum allowed media size of ${maxBytes} bytes.`,
        );
      }
      await fh.write(buf);
    }
    await fh.sync();
  } catch (err) {
    await fh.close().catch(() => {});
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
  await fh.close();
  return { tmpPath, bytesWritten };
}

export async function repairTornJsonlTail(filePath: string): Promise<boolean> {
  let fh: fs.FileHandle;
  try {
    fh = await fs.open(filePath, 'r+');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw err;
  }

  try {
    const stat = await fh.stat();
    if (stat.size === 0) return false;

    const lastByte = Buffer.allocUnsafe(1);
    await fh.read(lastByte, 0, 1, stat.size - 1);
    if (lastByte[0] === 0x0a) {
      return false;
    }

    // Torn tail without trailing newline: scan backwards for the last '\n'
    const CHUNK = 4096;
    let pos = stat.size;
    let truncateTo = 0;
    while (pos > 0) {
      const size = Math.min(CHUNK, pos);
      pos -= size;
      const buf = Buffer.allocUnsafe(size);
      await fh.read(buf, 0, size, pos);
      const nlIdx = buf.lastIndexOf(0x0a);
      if (nlIdx !== -1) {
        truncateTo = pos + nlIdx + 1;
        break;
      }
    }

    await fh.truncate(truncateTo);
    await fh.sync();
    return true;
  } finally {
    await fh.close();
  }
}

export async function appendLineFdatasync(filePath: string, line: string): Promise<void> {
  await repairTornJsonlTail(filePath);
  let fh: fs.FileHandle;
  try {
    fh = await fs.open(filePath, 'a', 0o644);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      fh = await fs.open(filePath, 'a', 0o644);
    } else {
      throw err;
    }
  }
  try {
    await fh.write(line, null, 'utf8');
    await fh.datasync();
  } finally {
    await fh.close();
  }
}

async function eventIdExistsInFile(eventsPath: string, eventId: string): Promise<boolean> {
  let fh: fs.FileHandle;
  try {
    fh = await fs.open(eventsPath, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }

  try {
    const stat = await fh.stat();
    const tailBytes = Math.min(stat.size, 256 * 1024);
    if (tailBytes === 0) return false;
    const buf = Buffer.allocUnsafe(tailBytes);
    await fh.read(buf, 0, tailBytes, stat.size - tailBytes);
    const text = buf.toString('utf8');
    // Fast substring pre-check, then verify parsed JSON id match
    if (!text.includes(eventId)) {
      if (stat.size <= tailBytes) return false;
      // Fallback full scan if events file is very large and older event is checked
      const full = await fs.readFile(eventsPath, 'utf8');
      return full.includes(`"id":"${eventId}"`);
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as { id?: unknown };
        if (obj.id === eventId) return true;
      } catch {
        // partial first line of chunk; ignore
      }
    }
    return false;
  } finally {
    await fh.close();
  }
}

export function maybeInjectFault(stage: string): void {
  const fault = process.env.CONTEXTDECK_FAULT;
  if (!fault || fault !== stage) return;
  if (process.env.CONTEXTDECK_FAULT_EXIT === '1') {
    process.exit(99);
  }
  throw new Error(`Simulated fault injection at stage "${stage}"`);
}

const TMP_BASENAME_REGEX = /^\.tmp-[A-Za-z0-9._-]+$/;
const MEDIA_BLOB_FILENAME_REGEX = /^([A-Za-z0-9][A-Za-z0-9_-]{0,80})(?:\.[a-z0-9]{1,12})?$/;

export function toDeckRelativePath(deckDir: string, targetPath: string): string {
  const canonicalDeck = canonicalizePathSync(path.resolve(deckDir));
  const canonicalTarget = canonicalizePathSync(path.resolve(targetPath));
  const rel = path.relative(canonicalDeck, canonicalTarget);
  if (!rel || rel === '.' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new CorruptDataError(`Transaction path "${targetPath}" is outside deckDir "${deckDir}".`);
  }
  return rel.split(path.sep).join('/');
}

function parseStrictRelativeSegments(rawPath: string, label: string): string[] {
  if (
    !rawPath ||
    rawPath.includes('\0') ||
    rawPath.includes('\\') ||
    rawPath.startsWith('/') ||
    /^[A-Za-z]:/.test(rawPath) ||
    path.isAbsolute(rawPath)
  ) {
    throw new CorruptDataError(`Invalid transaction journal ${label}: must be a safe relative path.`);
  }
  const segments = rawPath.split('/');
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') {
      throw new CorruptDataError(`Invalid transaction journal ${label}: illegal path segment "${seg}".`);
    }
  }
  return segments;
}

function validateEntitySegments(
  segments: string[],
  kind: 'rename' | 'link_create' | 'unlink',
  expectedBoardSlug?: string,
): { isMediaBlob: boolean; mediaId?: string; boardSlug: string } {
  if (segments.length < 3 || segments[0] !== 'boards') {
    throw new CorruptDataError(
      `Invalid transaction journal path "${segments.join('/')}": must reside under boards/<slug>/.`,
    );
  }
  const slug = segments[1];
  if (!BOARD_SLUG_REGEX.test(slug)) {
    throw new CorruptDataError(`Invalid transaction journal board slug "${slug}".`);
  }
  if (expectedBoardSlug && slug !== expectedBoardSlug) {
    throw new CorruptDataError(
      `Invalid transaction journal path "${segments.join('/')}": board slug "${slug}" does not match "${expectedBoardSlug}".`,
    );
  }

  if (segments.length === 3) {
    if (kind === 'rename' && segments[2] === 'brief.md') {
      return { isMediaBlob: false, boardSlug: slug };
    }
    throw new CorruptDataError(
      `Invalid transaction journal ${kind} target "${segments.join('/')}".`,
    );
  }

  if (segments.length !== 4) {
    throw new CorruptDataError(
      `Invalid transaction journal target "${segments.join('/')}": unexpected path depth.`,
    );
  }

  const subdir = segments[2];
  const file = segments[3];
  const stripSuffix = (name: string, suffix: string): string | null =>
    name.endsWith(suffix) ? name.slice(0, -suffix.length) : null;

  if (subdir === 'sessions') {
    const id = stripSuffix(file, '.yaml');
    if (id && ENTITY_ID_REGEX.test(id)) return { isMediaBlob: false, boardSlug: slug };
  } else if (subdir === 'decisions') {
    const id = stripSuffix(file, '.md');
    if (id && ENTITY_ID_REGEX.test(id)) return { isMediaBlob: false, boardSlug: slug };
  } else if (subdir === 'tasks') {
    const id = stripSuffix(file, '.md');
    if (id && ENTITY_ID_REGEX.test(id)) return { isMediaBlob: false, boardSlug: slug };
  } else if (subdir === 'diagrams') {
    const id =
      stripSuffix(file, '.meta.yaml') ??
      stripSuffix(file, '.mmd') ??
      stripSuffix(file, '.excalidraw');
    if (id && ENTITY_ID_REGEX.test(id)) return { isMediaBlob: false, boardSlug: slug };
  } else if (subdir === 'quizzes') {
    const id = stripSuffix(file, '.quiz.json');
    if (id && ENTITY_ID_REGEX.test(id)) return { isMediaBlob: false, boardSlug: slug };
  } else if (subdir === 'media') {
    const metaId = stripSuffix(file, '.meta.yaml');
    if (metaId && ENTITY_ID_REGEX.test(metaId)) {
      return { isMediaBlob: false, boardSlug: slug };
    }
    const blobMatch = file.match(MEDIA_BLOB_FILENAME_REGEX);
    if (blobMatch) {
      return { isMediaBlob: true, mediaId: blobMatch[1], boardSlug: slug };
    }
  }

  throw new CorruptDataError(
    `Invalid transaction journal ${kind} target "${segments.join('/')}": unrecognized entity file.`,
  );
}

type ResolvedTxnOp =
  | {
      kind: 'rename' | 'link_create';
      rawTmpPath: string;
      rawFinalPath: string;
      tmpPath: string;
      finalPath: string;
      isMediaBlob: boolean;
      mediaId?: string;
    }
  | {
      kind: 'unlink';
      rawFinalPath: string;
      finalPath: string;
    };

interface ResolvedTxnJournal {
  ops: ResolvedTxnOp[];
  events: Array<{ eventsPath: string; eventId: string; line: string }>;
  boardCommit?: { tmpPath: string; finalPath: string; rawTmpPath: string; rawFinalPath: string };
}

async function validateAndResolveTxnJournal(
  deckDir: string,
  txn: TxnJournal,
): Promise<ResolvedTxnJournal> {
  let canonicalDeckDir: string;
  try {
    canonicalDeckDir = await canonicalizePath(path.resolve(deckDir));
  } catch (err) {
    throw new CorruptDataError(
      `Invalid transaction journal deckDir "${deckDir}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const canonicalBoardsDir = path.join(canonicalDeckDir, 'boards');

  const checkedBoardSlugs = new Set<string>();
  const assertBoardDirSafe = async (slug: string, label: string): Promise<void> => {
    if (!BOARD_SLUG_REGEX.test(slug)) {
      throw new CorruptDataError(`Invalid transaction journal ${label} board slug "${slug}".`);
    }
    if (checkedBoardSlugs.has(slug)) return;
    const candidateBoardDir = path.join(canonicalBoardsDir, slug);
    let realBoardDir: string;
    try {
      realBoardDir = await assertContainedPath(canonicalBoardsDir, candidateBoardDir, {
        allowEqual: false,
        label: `${label} board "${slug}"`,
      });
    } catch (err) {
      throw new CorruptDataError(
        `Invalid transaction journal ${label} board "${slug}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (realBoardDir !== candidateBoardDir) {
      throw new CorruptDataError(
        `Invalid transaction journal ${label}: board directory "boards/${slug}" is a symlink alias.`,
      );
    }
    checkedBoardSlugs.add(slug);
  };

  if (txn.boardSlug !== undefined) {
    await assertBoardDirSafe(txn.boardSlug, 'boardSlug');
  }

  const resolveContained = async (
    rawPath: string,
    label: string,
  ): Promise<{ segments: string[]; canonicalSegments: string[]; absPath: string }> => {
    const segments = parseStrictRelativeSegments(rawPath, label);
    const candidate = path.resolve(canonicalDeckDir, ...segments);
    let absPath: string;
    try {
      absPath = await assertContainedPath(canonicalDeckDir, candidate, {
        allowEqual: false,
        label,
      });
    } catch (err) {
      throw new CorruptDataError(
        `Invalid transaction journal ${label} "${rawPath}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const canonicalRel = path.relative(canonicalDeckDir, absPath);
    if (
      !canonicalRel ||
      canonicalRel === '.' ||
      canonicalRel.startsWith('..') ||
      path.isAbsolute(canonicalRel)
    ) {
      throw new CorruptDataError(
        `Invalid transaction journal ${label} "${rawPath}": canonical path escapes deckDir.`,
      );
    }
    const canonicalSegments = canonicalRel.split(path.sep);
    if (canonicalSegments.join('/') !== segments.join('/')) {
      throw new CorruptDataError(
        `Invalid transaction journal ${label} "${rawPath}": canonical target "${canonicalSegments.join('/')}" aliases a different path.`,
      );
    }
    return { segments, canonicalSegments, absPath };
  };

  const resolvedOps: ResolvedTxnOp[] = [];
  for (let i = 0; i < txn.ops.length; i += 1) {
    const op = txn.ops[i];
    const finalInfo = await resolveContained(op.finalPath, `ops[${i}].finalPath`);
    const lexicalInfo = validateEntitySegments(finalInfo.segments, op.kind, txn.boardSlug);
    await assertBoardDirSafe(lexicalInfo.boardSlug, `ops[${i}].finalPath`);
    const canonicalInfo = validateEntitySegments(
      finalInfo.canonicalSegments,
      op.kind,
      txn.boardSlug ?? lexicalInfo.boardSlug,
    );
    if (
      canonicalInfo.boardSlug !== lexicalInfo.boardSlug ||
      canonicalInfo.isMediaBlob !== lexicalInfo.isMediaBlob ||
      canonicalInfo.mediaId !== lexicalInfo.mediaId
    ) {
      throw new CorruptDataError(
        `Invalid transaction journal ops[${i}].finalPath "${op.finalPath}": canonical target does not match lexical entity.`,
      );
    }

    if (op.kind === 'unlink') {
      resolvedOps.push({
        kind: 'unlink',
        rawFinalPath: op.finalPath,
        finalPath: finalInfo.absPath,
      });
    } else {
      const tmpInfo = await resolveContained(op.tmpPath, `ops[${i}].tmpPath`);
      const tmpBase = tmpInfo.canonicalSegments[tmpInfo.canonicalSegments.length - 1];
      if (!TMP_BASENAME_REGEX.test(tmpBase)) {
        throw new CorruptDataError(
          `Invalid transaction journal ops[${i}].tmpPath "${op.tmpPath}": temp file must use .tmp- prefix.`,
        );
      }
      const tmpDirRel = tmpInfo.canonicalSegments.slice(0, -1).join('/');
      const finalDirRel = finalInfo.canonicalSegments.slice(0, -1).join('/');
      if (tmpDirRel !== finalDirRel || path.dirname(tmpInfo.absPath) !== path.dirname(finalInfo.absPath)) {
        throw new CorruptDataError(
          `Invalid transaction journal ops[${i}]: temp file "${op.tmpPath}" must reside in the same directory as "${op.finalPath}".`,
        );
      }
      resolvedOps.push({
        kind: op.kind,
        rawTmpPath: op.tmpPath,
        rawFinalPath: op.finalPath,
        tmpPath: tmpInfo.absPath,
        finalPath: finalInfo.absPath,
        isMediaBlob: canonicalInfo.isMediaBlob,
        mediaId: canonicalInfo.mediaId,
      });
    }
  }

  const resolvedEvents: Array<{ eventsPath: string; eventId: string; line: string }> = [];
  for (let i = 0; i < txn.events.length; i += 1) {
    const ev = txn.events[i];
    const evInfo = await resolveContained(ev.eventsPath, `events[${i}].eventsPath`);
    for (const segs of [evInfo.segments, evInfo.canonicalSegments]) {
      if (
        segs.length !== 3 ||
        segs[0] !== 'boards' ||
        !BOARD_SLUG_REGEX.test(segs[1]) ||
        segs[2] !== 'events.jsonl'
      ) {
        throw new CorruptDataError(
          `Invalid transaction journal events[${i}].eventsPath "${ev.eventsPath}": must be boards/<slug>/events.jsonl.`,
        );
      }
      if (txn.boardSlug && segs[1] !== txn.boardSlug) {
        throw new CorruptDataError(
          `Invalid transaction journal events[${i}].eventsPath "${ev.eventsPath}": board slug mismatch.`,
        );
      }
    }
    await assertBoardDirSafe(evInfo.canonicalSegments[1], `events[${i}].eventsPath`);
    const trimmedLine = ev.line.trim();
    if (!trimmedLine || trimmedLine.includes('\n') || trimmedLine.includes('\r')) {
      throw new CorruptDataError(
        `Invalid transaction journal events[${i}].line: must be a single JSON line.`,
      );
    }
    let parsedEvent: unknown;
    try {
      parsedEvent = JSON.parse(trimmedLine);
    } catch (err) {
      throw new CorruptDataError(
        `Invalid transaction journal events[${i}].line: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (
      !parsedEvent ||
      typeof parsedEvent !== 'object' ||
      Array.isArray(parsedEvent) ||
      (parsedEvent as { id?: unknown }).id !== ev.eventId
    ) {
      throw new CorruptDataError(
        `Invalid transaction journal events[${i}].line: parsed event id does not match eventId "${ev.eventId}".`,
      );
    }
    resolvedEvents.push({
      eventsPath: evInfo.absPath,
      eventId: ev.eventId,
      line: ev.line.endsWith('\n') ? ev.line : `${trimmedLine}\n`,
    });
  }

  let resolvedBoardCommit: ResolvedTxnJournal['boardCommit'];
  if (txn.boardCommit) {
    const finalInfo = await resolveContained(txn.boardCommit.finalPath, 'boardCommit.finalPath');
    for (const segs of [finalInfo.segments, finalInfo.canonicalSegments]) {
      if (
        segs.length !== 3 ||
        segs[0] !== 'boards' ||
        !BOARD_SLUG_REGEX.test(segs[1]) ||
        segs[2] !== 'board.yaml'
      ) {
        throw new CorruptDataError(
          `Invalid transaction journal boardCommit.finalPath "${txn.boardCommit.finalPath}": must be boards/<slug>/board.yaml.`,
        );
      }
      if (txn.boardSlug && segs[1] !== txn.boardSlug) {
        throw new CorruptDataError(
          `Invalid transaction journal boardCommit.finalPath "${txn.boardCommit.finalPath}": board slug mismatch.`,
        );
      }
    }
    await assertBoardDirSafe(finalInfo.canonicalSegments[1], 'boardCommit.finalPath');
    const tmpInfo = await resolveContained(txn.boardCommit.tmpPath, 'boardCommit.tmpPath');
    const tmpBase = tmpInfo.canonicalSegments[tmpInfo.canonicalSegments.length - 1];
    if (!TMP_BASENAME_REGEX.test(tmpBase)) {
      throw new CorruptDataError(
        `Invalid transaction journal boardCommit.tmpPath "${txn.boardCommit.tmpPath}": temp file must use .tmp- prefix.`,
      );
    }
    const tmpDirRel = tmpInfo.canonicalSegments.slice(0, -1).join('/');
    const finalDirRel = finalInfo.canonicalSegments.slice(0, -1).join('/');
    if (tmpDirRel !== finalDirRel || path.dirname(tmpInfo.absPath) !== path.dirname(finalInfo.absPath)) {
      throw new CorruptDataError(
        `Invalid transaction journal boardCommit: temp file must reside in the same directory as board.yaml.`,
      );
    }
    resolvedBoardCommit = {
      rawTmpPath: txn.boardCommit.tmpPath,
      rawFinalPath: txn.boardCommit.finalPath,
      tmpPath: tmpInfo.absPath,
      finalPath: finalInfo.absPath,
    };
  }

  return {
    ops: resolvedOps,
    events: resolvedEvents,
    boardCommit: resolvedBoardCommit,
  };
}

/**
 * Execute a prepared transaction journal (or roll forward an existing journal after crash).
 * Validates the ENTIRE journal against `deckDir` before executing a single op.
 * Idempotent across retries at every step:
 *   entity renames/links/unlinks -> append events + fdatasync -> board.yaml rename LAST -> delete txn.json
 */
export async function executeTxnJournal(
  txnPath: string,
  txn: TxnJournal,
  options: {
    deckDir?: string;
    assertActive?: () => void;
    allowFaultInjection?: boolean;
    checkEventDedupe?: boolean;
  } = {},
): Promise<void> {
  const {
    deckDir = path.dirname(path.dirname(txnPath)),
    assertActive,
    allowFaultInjection = false,
    checkEventDedupe = true,
  } = options;

  // H1: Validate and canonicalize EVERY path in the journal BEFORE running op 0.
  const resolved = await validateAndResolveTxnJournal(deckDir, txn);
  const missingMediaBlobs: Array<{ mediaDir: string; mediaId: string; expectedBlobPath: string }> = [];

  for (let i = 0; i < resolved.ops.length; i += 1) {
    assertActive?.();
    const op = resolved.ops[i];
    if (op.kind === 'unlink') {
      await fs.rm(op.finalPath, { force: true });
    } else if (op.kind === 'rename') {
      try {
        await fs.access(op.tmpPath);
        await renameWithRetry(op.tmpPath, op.finalPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          // Already renamed before crash
          const targetExists = await fs
            .access(op.finalPath)
            .then(() => true)
            .catch(() => false);
          if (!targetExists) {
            if (checkEventDedupe && op.isMediaBlob && op.mediaId) {
              console.warn(
                `[ContextDeck] Transaction recovery skipping missing media blob "${op.rawFinalPath}" (temp "${op.rawTmpPath}" also missing); reconciling metadata.`,
              );
              missingMediaBlobs.push({
                mediaDir: path.dirname(op.finalPath),
                mediaId: op.mediaId,
                expectedBlobPath: op.finalPath,
              });
            } else {
              throw new CorruptDataError(
                `Transaction recovery missing both temp "${op.rawTmpPath}" and target "${op.rawFinalPath}"`,
              );
            }
          }
        } else {
          throw err;
        }
      }
    } else if (op.kind === 'link_create') {
      try {
        await fs.access(op.tmpPath);
        await linkCreateAtomic(op.tmpPath, op.finalPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          await fs.access(op.finalPath).catch(() => {
            throw new CorruptDataError(
              `Transaction recovery missing both temp "${op.rawTmpPath}" and target "${op.rawFinalPath}"`,
            );
          });
        } else {
          throw err;
        }
      }
    }

    if (allowFaultInjection && i === 0) {
      maybeInjectFault('after-rename-1');
    }
  }

  // Reconcile metadata for any media blobs that went missing prior to recovery (H2)
  for (const missing of missingMediaBlobs) {
    assertActive?.();
    const metaPath = path.join(missing.mediaDir, `${missing.mediaId}.meta.yaml`);
    try {
      const rawMeta = await fs.readFile(metaPath, 'utf8');
      const parsed = yaml.load(rawMeta);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if ('filePath' in record && !existsSync(missing.expectedBlobPath)) {
          delete record.filePath;
          const dumped = yaml.dump(record, { lineWidth: 100, noRefs: true, sortKeys: false });
          await atomicWriteFile(metaPath, dumped);
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(
          `[ContextDeck] Could not reconcile metadata for missing media blob ${missing.mediaId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  if (allowFaultInjection) {
    maybeInjectFault('after-renames');
  }

  if (resolved.events.length > 0) {
    if (checkEventDedupe) {
      for (const ev of resolved.events) {
        assertActive?.();
        // H3: Repair any torn partial line BEFORE checking dedupe or appending
        await repairTornJsonlTail(ev.eventsPath);
        const alreadyPresent = await eventIdExistsInFile(ev.eventsPath, ev.eventId);
        if (!alreadyPresent) {
          await appendLineFdatasync(ev.eventsPath, ev.line);
        }
      }
    } else {
      // Fresh commit: event IDs were just minted in this transaction; skip scanning events.jsonl
      // and coalesce contiguous events per target path into one write + fdatasync.
      let idx = 0;
      while (idx < resolved.events.length) {
        assertActive?.();
        const targetPath = resolved.events[idx].eventsPath;
        let batch = resolved.events[idx].line;
        idx += 1;
        while (idx < resolved.events.length && resolved.events[idx].eventsPath === targetPath) {
          batch += resolved.events[idx].line;
          idx += 1;
        }
        await appendLineFdatasync(targetPath, batch);
      }
    }
  }

  if (allowFaultInjection) {
    maybeInjectFault('after-event');
  }

  if (resolved.boardCommit) {
    assertActive?.();
    try {
      await fs.access(resolved.boardCommit.tmpPath);
      await renameWithRetry(resolved.boardCommit.tmpPath, resolved.boardCommit.finalPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        await fs.access(resolved.boardCommit.finalPath).catch(() => {
          throw new CorruptDataError(
            `Transaction recovery missing board commit file "${resolved.boardCommit!.rawFinalPath}"`,
          );
        });
      } else {
        throw err;
      }
    }
  }

  if (allowFaultInjection) {
    maybeInjectFault('after-board-commit');
  }

  assertActive?.();
  await fs.rm(txnPath, { force: true });
}

export async function recoverPendingTxn(
  runtimeDir: string,
  assertActive?: () => void,
  deckDir?: string,
): Promise<boolean> {
  const txnPath = path.join(runtimeDir, TXN_FILENAME);
  let raw: string;
  try {
    raw = await fs.readFile(txnPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw err;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    throw new CorruptDataError(
      `Corrupt transaction journal at ${txnPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const validated = TxnJournalSchema.safeParse(parsedJson);
  if (!validated.success) {
    throw new CorruptDataError(`Invalid transaction journal at ${txnPath}: ${validated.error.message}`);
  }

  await executeTxnJournal(txnPath, validated.data, {
    deckDir: deckDir ?? path.dirname(runtimeDir),
    assertActive,
    allowFaultInjection: false,
    checkEventDedupe: true,
  });
  return true;
}

function getLockTimings(): { stale: number; update: number } {
  const envStale = process.env.CONTEXTDECK_LOCK_STALE_MS
    ? Number.parseInt(process.env.CONTEXTDECK_LOCK_STALE_MS, 10)
    : Number.NaN;
  const stale = Number.isFinite(envStale) && envStale >= 200 ? envStale : 10_000;
  const update = Math.max(50, Math.floor(stale / 3));
  return { stale, update };
}

/**
 * Acquire cross-process workspace lock via proper-lockfile on `<runtimeDir>/lock`,
 * roll forward any pending `txn.json`, and abort immediately if the lock is compromised.
 */
export async function withWorkspaceLock<T>(
  runtimeDir: string,
  fn: (assertActive: () => void) => Promise<T>,
  deckDir?: string,
): Promise<T> {
  const sentinelPath = path.join(runtimeDir, LOCK_SENTINEL_NAME);
  if (!existsSync(sentinelPath)) {
    await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    const fh = await fs.open(sentinelPath, 'a', 0o600);
    await fh.close();
  }

  const { stale, update } = getLockTimings();
  let compromised = false;
  let compromisedError: Error | null = null;

  const release = await lockfile.lock(sentinelPath, {
    stale,
    update,
    retries: {
      retries: 150,
      factor: 1.12,
      minTimeout: 10,
      maxTimeout: 200,
      randomize: true,
    },
    onCompromised: (err: Error) => {
      compromised = true;
      compromisedError = err;
    },
  });

  const lockDirPath = `${sentinelPath}.lock`;
  let initialLockIno: number | undefined;
  let initialLockDev: number | undefined;
  try {
    const st = statSync(lockDirPath);
    initialLockIno = st.ino;
    initialLockDev = st.dev;
  } catch {
    compromised = true;
    compromisedError = new Error('Lock directory vanished immediately after acquisition');
  }

  const assertActive = (): void => {
    if (!compromised && initialLockIno !== undefined) {
      try {
        const st = statSync(lockDirPath);
        if (st.ino !== initialLockIno || st.dev !== initialLockDev) {
          compromised = true;
          compromisedError = new Error('Lock directory inode changed (lock stolen by another process)');
        }
      } catch {
        compromised = true;
        compromisedError = new Error('Lock directory no longer exists');
      }
    }
    if (compromised) {
      throw new LockCompromisedError(
        `Workspace lock was compromised; aborting mutation: ${compromisedError?.message ?? 'unknown reason'}`,
      );
    }
  };

  try {
    assertActive();
    await recoverPendingTxn(runtimeDir, assertActive, deckDir);
    assertActive();
    return await fn(assertActive);
  } finally {
    if (!compromised) {
      await release().catch(() => {});
    }
  }
}
