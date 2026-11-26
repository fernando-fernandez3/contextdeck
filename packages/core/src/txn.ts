import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { CorruptDataError, LockCompromisedError, PayloadTooLargeError } from './errors.js';

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

function isTransientRenameError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

export async function renameWithRetry(src: string, dst: string, attempts = 5): Promise<void> {
  let delayMs = 15;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await fs.rename(src, dst);
      return;
    } catch (err) {
      if (i === attempts - 1 || !isTransientRenameError(err)) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs *= 2;
    }
  }
}

export async function linkCreateAtomic(src: string, dst: string): Promise<void> {
  try {
    await fs.link(src, dst);
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
  await fs.unlink(src).catch((err) => {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  });
}

export async function writeTempFileFsync(
  targetDir: string,
  content: string | Buffer,
  prefix = '.tmp-',
): Promise<string> {
  await fs.mkdir(targetDir, { recursive: true });
  const tmpPath = path.join(targetDir, `${prefix}${crypto.randomBytes(8).toString('hex')}`);
  const fh = await fs.open(tmpPath, 'wx', 0o644);
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

export async function appendLineFdatasync(filePath: string, line: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const fh = await fs.open(filePath, 'a', 0o644);
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

/**
 * Execute a prepared transaction journal (or roll forward an existing journal after crash).
 * Idempotent across retries at every step:
 *   entity renames/links/unlinks -> append events + fdatasync -> board.yaml rename LAST -> delete txn.json
 */
export async function executeTxnJournal(
  txnPath: string,
  txn: TxnJournal,
  options: { assertActive?: () => void; allowFaultInjection?: boolean } = {},
): Promise<void> {
  const { assertActive, allowFaultInjection = false } = options;

  for (let i = 0; i < txn.ops.length; i += 1) {
    assertActive?.();
    const op = txn.ops[i];
    if (op.kind === 'unlink') {
      await fs.rm(op.finalPath, { force: true });
    } else if (op.kind === 'rename') {
      try {
        await fs.access(op.tmpPath);
        await renameWithRetry(op.tmpPath, op.finalPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          // Already renamed before crash
          await fs.access(op.finalPath).catch(() => {
            throw new CorruptDataError(
              `Transaction recovery missing both temp "${op.tmpPath}" and target "${op.finalPath}"`,
            );
          });
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
              `Transaction recovery missing both temp "${op.tmpPath}" and target "${op.finalPath}"`,
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

  if (allowFaultInjection) {
    maybeInjectFault('after-renames');
  }

  for (const ev of txn.events) {
    assertActive?.();
    const alreadyPresent = await eventIdExistsInFile(ev.eventsPath, ev.eventId);
    if (!alreadyPresent) {
      await appendLineFdatasync(ev.eventsPath, ev.line);
    }
  }

  if (allowFaultInjection) {
    maybeInjectFault('after-event');
  }

  if (txn.boardCommit) {
    assertActive?.();
    try {
      await fs.access(txn.boardCommit.tmpPath);
      await renameWithRetry(txn.boardCommit.tmpPath, txn.boardCommit.finalPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        await fs.access(txn.boardCommit.finalPath).catch(() => {
          throw new CorruptDataError(
            `Transaction recovery missing board commit file "${txn.boardCommit!.finalPath}"`,
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
    assertActive,
    allowFaultInjection: false,
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
): Promise<T> {
  await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const sentinelPath = path.join(runtimeDir, LOCK_SENTINEL_NAME);
  const fh = await fs.open(sentinelPath, 'a', 0o600);
  await fh.close();

  const { stale, update } = getLockTimings();
  let compromised = false;
  let compromisedError: Error | null = null;

  const release = await lockfile.lock(sentinelPath, {
    stale,
    update,
    retries: {
      retries: 100,
      factor: 1.15,
      minTimeout: 20,
      maxTimeout: 350,
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
    await recoverPendingTxn(runtimeDir, assertActive);
    assertActive();
    return await fn(assertActive);
  } finally {
    if (!compromised) {
      await release().catch(() => {});
    }
  }
}
