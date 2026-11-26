import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {
  ContextDeckStore,
  UNTRUSTED_BOARD_CONTENT_FOOTER,
  UNTRUSTED_BOARD_CONTENT_HEADER,
  WorkspaceNotFoundError,
  capSingleLine,
  generateContextPack,
  neutralizeUntrustedDelimiters,
  resolveWorkspace,
  type ResolvedWorkspace,
} from '@contextdeck/core';

export type HookHarness = 'claude-code' | 'codex' | 'cursor';

const HOOK_MAX_STDIN_BYTES = 256 * 1024; // D12: 256 KB
const HOOK_DEADLINE_MS = 1_750; // C5 / D12: strict internal timeout well under 2 s
const HOOK_END_DEADLINE_MS = 800; // N2: tighter deadline for SessionEnd (Codex defaults to 1s, Claude to 1.5s)
const HOOK_STDIN_TIMEOUT_MS = 900;
const HOOK_END_STDIN_TIMEOUT_MS = 350;
const HOOK_LOCK_WAIT_MS = 800; // D12: lock wait <= 800 ms
const HOOK_END_LOCK_WAIT_MS = 350;
const CURSOR_THROTTLE_MS = 60_000; // AC5.4 / D12: at most once per 60 s per session
const HOOK_PACK_MAX_CHARS = 6_000; // ~1,500 tokens (well under Codex 2,500 token additionalContextLimit)
const HOOK_DIGEST_MAX_CHARS = 4_000;

type EventAction = 'start' | 'sync' | 'end';

const SUPPORTED_EVENTS: Record<HookHarness, Record<string, EventAction>> = {
  'claude-code': {
    SessionStart: 'start',
    UserPromptSubmit: 'sync',
    SessionEnd: 'end',
  },
  codex: {
    SessionStart: 'start',
    UserPromptSubmit: 'sync',
    SessionEnd: 'end',
  },
  cursor: {
    sessionStart: 'start',
    postToolUse: 'sync',
    sessionEnd: 'end',
  },
};

function isKnownHarness(harness: string | undefined): harness is HookHarness {
  return harness === 'claude-code' || harness === 'codex' || harness === 'cursor';
}

function appendHookLogSync(
  deckDir: string | undefined,
  harness: string,
  event: string,
  message: string,
): void {
  if (!deckDir || !fsSync.existsSync(deckDir)) return;
  try {
    const runtimeDir = path.join(deckDir, '.runtime');
    fsSync.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    const logPath = path.join(runtimeDir, 'hooks.log');
    const safeMsg = message.replace(/[\r\n]+/g, ' ').slice(0, 500);
    fsSync.appendFileSync(
      logPath,
      `${new Date().toISOString()} [${harness}/${event}] ${safeMsg}\n`,
      'utf8',
    );
  } catch {
    // Never fail the host harness because of hook logging
  }
}

async function appendHookLog(
  deckDir: string | undefined,
  harness: string,
  event: string,
  message: string,
): Promise<void> {
  if (!deckDir || !fsSync.existsSync(deckDir)) return;
  try {
    const runtimeDir = path.join(deckDir, '.runtime');
    await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    const logPath = path.join(runtimeDir, 'hooks.log');
    const safeMsg = message.replace(/[\r\n]+/g, ' ').slice(0, 500);
    await fs.appendFile(
      logPath,
      `${new Date().toISOString()} [${harness}/${event}] ${safeMsg}\n`,
      'utf8',
    );
  } catch {
    // Never fail the host harness because of hook logging
  }
}

function readBoundedStdin(maxBytes: number, timeoutMs: number): Promise<string> {
  if (process.stdin.isTTY) {
    return Promise.resolve('');
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onError);
      process.stdin.pause();
      (process.stdin as { unref?: () => void }).unref?.();
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onData = (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        fail(new Error(`Hook stdin payload exceeded ${maxBytes} bytes limit`));
        return;
      }
      chunks.push(buf);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };

    const onError = (err: Error) => {
      fail(err);
    };

    const timer = setTimeout(() => {
      fail(new Error(`Hook stdin read timed out after ${timeoutMs}ms`));
    }, Math.max(50, timeoutMs));
    timer.unref();

    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
    process.stdin.resume();
  });
}

function formatDefaultHookSessionTitle(harness: HookHarness, now: Date): string {
  // D11: Never store raw prompt text; default title is "<harness> session" + short time.
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  return `${harness} session ${hh}:${mm} UTC`;
}

interface CandidateCwd {
  cwd: string;
  explicitFromPayload: boolean;
}

function extractCandidateCwds(
  harness: HookHarness,
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): CandidateCwd[] {
  const candidates: CandidateCwd[] = [];
  const seen = new Set<string>();
  const add = (raw: unknown, explicitFromPayload: boolean) => {
    if (typeof raw !== 'string') return;
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push({ cwd: trimmed, explicitFromPayload });
  };

  add(payload.cwd, true);
  if (Array.isArray(payload.workspace_roots)) {
    for (const root of payload.workspace_roots) {
      add(root, true);
    }
  }
  if (harness === 'cursor') {
    add(env.CURSOR_PROJECT_DIR, false);
  }
  add(process.cwd(), false);
  return candidates;
}

function extractExternalSessionId(
  harness: HookHarness,
  payload: Record<string, unknown>,
): string | null {
  if (harness === 'cursor') {
    const conv =
      typeof payload.conversation_id === 'string' && payload.conversation_id.trim()
        ? payload.conversation_id.trim()
        : typeof payload.session_id === 'string' && payload.session_id.trim()
          ? payload.session_id.trim()
          : null;
    return conv;
  }
  if (typeof payload.session_id === 'string' && payload.session_id.trim()) {
    return payload.session_id.trim();
  }
  return null;
}

function resolveHookWorkspaceFromCandidates(
  candidates: CandidateCwd[],
  env: NodeJS.ProcessEnv,
): { workspace: ResolvedWorkspace; matchedCwd: string } | null {
  const primaryCwd = candidates[0]?.cwd ?? process.cwd();
  if (env.CONTEXTDECK_DIR?.trim()) {
    try {
      return { workspace: resolveWorkspace({ env }), matchedCwd: primaryCwd };
    } catch (err) {
      if (err instanceof WorkspaceNotFoundError) return null;
      throw err;
    }
  }

  const envWithoutClaude = { ...env };
  delete envWithoutClaude.CLAUDE_PROJECT_DIR;

  // 1. Try explicit payload candidates in order (payload.cwd, then every workspace_roots entry — H10)
  for (const cand of candidates) {
    if (!cand.explicitFromPayload) continue;
    try {
      const workspace = resolveWorkspace({ cwd: cand.cwd, env: envWithoutClaude });
      return { workspace, matchedCwd: cand.cwd };
    } catch (err) {
      if (err instanceof WorkspaceNotFoundError) continue;
      throw err;
    }
  }

  // 2. Fallback to CLAUDE_PROJECT_DIR if set
  if (env.CLAUDE_PROJECT_DIR?.trim()) {
    try {
      const workspace = resolveWorkspace({ env });
      return { workspace, matchedCwd: env.CLAUDE_PROJECT_DIR.trim() };
    } catch (err) {
      if (!(err instanceof WorkspaceNotFoundError)) throw err;
    }
  }

  // 3. Try non-explicit candidates (CURSOR_PROJECT_DIR, process.cwd())
  for (const cand of candidates) {
    if (cand.explicitFromPayload) continue;
    try {
      const workspace = resolveWorkspace({ cwd: cand.cwd, env: envWithoutClaude });
      return { workspace, matchedCwd: cand.cwd };
    } catch (err) {
      if (err instanceof WorkspaceNotFoundError) continue;
      throw err;
    }
  }

  return null;
}

function formatHookOutput(
  harness: HookHarness,
  event: string,
  additionalContext: string,
): string {
  if (!additionalContext) return '';
  if (harness === 'cursor') {
    return JSON.stringify({ additional_context: additionalContext });
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext,
    },
  });
}

function capBoundedDigest(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const suffix = `\n… [truncated, call board_get_brief]\n${UNTRUSTED_BOARD_CONTENT_FOOTER}`;
  const sliceLen = Math.max(0, maxChars - suffix.length);
  return `${text.slice(0, sliceLen).trimEnd()}${suffix}`;
}

function writeStdoutBounded(
  stdout: NodeJS.WritableStream,
  text: string,
  remainingMs: number,
  onLateDrain?: () => void,
): Promise<{ ok: boolean; pending: boolean }> {
  if (remainingMs <= 0) {
    return Promise.resolve({ ok: false, pending: false });
  }
  return new Promise<{ ok: boolean; pending: boolean }>((resolve) => {
    let settled = false;
    const finish = (ok: boolean, pending: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdout.removeListener('error', onError);
      resolve({ ok, pending });
    };
    const onError = () => finish(false, false);
    const timer = setTimeout(() => finish(false, true), Math.max(10, remainingMs));
    timer.unref();
    stdout.once('error', onError);
    try {
      stdout.write(text, 'utf8', (err?: Error | null) => {
        if (settled) {
          onLateDrain?.();
          return;
        }
        finish(!err, false);
      });
    } catch {
      finish(false, false);
    }
  });
}

export interface RunHookCliOptions {
  /** Only enabled by the CLI entrypoint (`cdeck hook`) as a last-resort safeguard after deadline. */
  exitOnHardDeadline?: boolean;
  /** Injectable stdout stream for testing (defaults to `process.stdout`). */
  stdout?: NodeJS.WritableStream;
  /** Injectable exit handler for hard-deadline termination (defaults to `process.exit`). */
  exit?: (code: number) => void;
}

/**
 * Execute `cdeck hook <harness> <event>` adhering strictly to C5, C6, AC5.1-AC5.4, D11, D12, D14:
 * - Unknown harness or unknown event -> silent exit 0.
 * - Any error, corrupt workspace, stalled stdin, or lock timeout -> print NOTHING to stdout,
 *   log to `.contextdeck/.runtime/hooks.log`, and exit 0 well within 2 seconds.
 * - At-least-once delivery: write & flush stdout BEFORE acknowledging the cursor.
 */
export async function runHookCli(
  rawHarness: string | undefined,
  rawEvent: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  options: RunHookCliOptions = {},
): Promise<void> {
  // Unknown harness/event -> immediate silent exit 0 (Deliverable 1)
  if (!isKnownHarness(rawHarness) || !rawEvent) {
    return;
  }
  const eventAction = SUPPORTED_EVENTS[rawHarness][rawEvent];
  if (!eventAction) {
    return;
  }

  const effectiveDeadlineMs = eventAction === 'end' ? HOOK_END_DEADLINE_MS : HOOK_DEADLINE_MS;
  const deadlineAt = Date.now() + effectiveDeadlineMs;
  const stdoutStream = options.stdout ?? process.stdout;
  const exitFn = options.exit ?? ((code: number) => process.exit(code));
  let resolvedDeckDir: string | undefined;
  let deadlineTriggered = false;
  let stdoutWritePending = false;

  const softTimer = setTimeout(() => {
    deadlineTriggered = true;
    appendHookLogSync(
      resolvedDeckDir,
      rawHarness,
      rawEvent,
      `Hook aborted at internal deadline (${effectiveDeadlineMs}ms)`,
    );
  }, effectiveDeadlineMs);
  softTimer.unref();

  let killTimer: ReturnType<typeof setTimeout> | undefined;
  if (options.exitOnHardDeadline) {
    // Last-resort safety kill slightly after the soft deadline (still < 2s) if a handle hangs.
    killTimer = setTimeout(() => {
      if (stdoutWritePending) {
        try {
          stdoutStream.on('error', () => {});
          (stdoutStream as { destroy?: () => void }).destroy?.();
        } catch {
          // ignore
        }
      }
      exitFn(0);
    }, effectiveDeadlineMs + 100);
    killTimer.unref();
  }

  try {
    // Best-effort deckDir lookup for logging early stdin errors
    try {
      const fallbackWs = resolveHookWorkspaceFromCandidates(
        [{ cwd: process.cwd(), explicitFromPayload: false }],
        env,
      );
      resolvedDeckDir = fallbackWs?.workspace.deckDir;
    } catch {
      // ignore
    }

    const maxStdinTimeout =
      eventAction === 'end' ? HOOK_END_STDIN_TIMEOUT_MS : HOOK_STDIN_TIMEOUT_MS;
    const stdinMargin = eventAction === 'end' ? 200 : 400;
    const stdinTimeout = Math.min(
      maxStdinTimeout,
      Math.max(100, deadlineAt - Date.now() - stdinMargin),
    );
    const rawStdin = await readBoundedStdin(HOOK_MAX_STDIN_BYTES, stdinTimeout);
    if (deadlineTriggered || !rawStdin.trim()) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawStdin);
    } catch (err) {
      await appendHookLog(
        resolvedDeckDir,
        rawHarness,
        rawEvent,
        `Invalid hook stdin JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      await appendHookLog(resolvedDeckDir, rawHarness, rawEvent, 'Hook stdin JSON must be an object');
      return;
    }
    const payload = parsed as Record<string, unknown>;

    const candidates = extractCandidateCwds(rawHarness, payload, env);
    const resolvedMatch = resolveHookWorkspaceFromCandidates(candidates, env);
    if (!resolvedMatch) {
      return;
    }
    const { workspace, matchedCwd: payloadCwd } = resolvedMatch;
    resolvedDeckDir = workspace.deckDir;

    const store = new ContextDeckStore({
      deckDir: workspace.deckDir,
      projectRoot: workspace.projectRoot,
      defaultBoard: workspace.defaultBoard,
    });
    if (!store.isInitialized()) {
      return;
    }

    const externalSessionId = extractExternalSessionId(rawHarness, payload);
    if (!externalSessionId) {
      await appendHookLog(
        resolvedDeckDir,
        rawHarness,
        rawEvent,
        'Hook payload missing session_id / conversation_id',
      );
      return;
    }

    const externalRef = `${rawHarness}:${externalSessionId}`;
    const now = new Date();
    const defaultTitle = formatDefaultHookSessionTitle(rawHarness, now);
    const maxLockWait = eventAction === 'end' ? HOOK_END_LOCK_WAIT_MS : HOOK_LOCK_WAIT_MS;
    const lockMargin = eventAction === 'end' ? 120 : 250;
    const remainingForLock = Math.max(
      50,
      Math.min(maxLockWait, deadlineAt - Date.now() - lockMargin),
    );

    const onCorruptSession = (filePath: string, message: string) => {
      appendHookLogSync(
        resolvedDeckDir,
        rawHarness,
        rawEvent,
        `Skipped corrupt session ${filePath}: ${message}`,
      );
    };

    if (eventAction === 'start') {
      const { session, boardSlug, snapshot, pendingAck } = await store.upsertHookSession({
        externalRef,
        harness: rawHarness,
        defaultTitle,
        cwd: payloadCwd,
        maxWaitMs: remainingForLock,
        deferCursorCommit: true,
        onCorruptSession,
      });

      if (deadlineTriggered) return;

      const sessionLine = `Your ContextDeck session id is ${session.id}; pass sessionId on ContextDeck tool calls (board: ${boardSlug}).`;
      const packBudget = Math.max(500, HOOK_PACK_MAX_CHARS - sessionLine.length - 2);
      const pack = generateContextPack(snapshot, {
        includeUpdateProtocol: false,
        maxChars: packBudget,
      });
      const additionalContext = `${pack}\n\n${sessionLine}`;
      const output = formatHookOutput(rawHarness, rawEvent, additionalContext);
      if (output && !deadlineTriggered) {
        const writeRes = await writeStdoutBounded(
          stdoutStream,
          `${output}\n`,
          deadlineAt - Date.now(),
          () => {
            stdoutWritePending = false;
            if (killTimer) clearTimeout(killTimer);
          },
        );
        if (writeRes.pending) {
          stdoutWritePending = true;
          appendHookLogSync(
            resolvedDeckDir,
            rawHarness,
            rawEvent,
            'Hook stdout write timed out; keeping hard deadline timer armed',
          );
        }
        if (writeRes.ok && !deadlineTriggered) {
          const ackWait = Math.max(50, Math.min(HOOK_LOCK_WAIT_MS, deadlineAt - Date.now()));
          await store.commitHookDelivery(pendingAck, { maxWaitMs: ackWait });
        }
      }
      return;
    }

    if (eventAction === 'sync') {
      const result = await store.checkAndSyncHookDrift({
        externalRef,
        harness: rawHarness,
        defaultTitle,
        cwd: payloadCwd,
        throttleMs: rawHarness === 'cursor' ? CURSOR_THROTTLE_MS : undefined,
        maxWaitMs: remainingForLock,
        now,
        deferCursorCommit: true,
        onCorruptSession,
      });

      if (
        deadlineTriggered ||
        result.action !== 'digest' ||
        !result.session ||
        !result.boardConfig ||
        !result.digestResult ||
        !result.digestResult.digestText
      ) {
        return;
      }

      const count = result.digestResult.behindBy;
      const safeSlug = neutralizeUntrustedDelimiters(capSingleLine(result.boardConfig.slug, 100));
      const safeTitle = neutralizeUntrustedDelimiters(capSingleLine(result.boardConfig.title, 160));
      const header = `[ContextDeck] Board (${safeSlug}) updated to rev ${result.boardConfig.revision} (${count} change${count === 1 ? '' : 's'} since your last sync; session ${result.session.id}):`;
      const digestLines = result.digestResult.digestText.split('\n');
      const wrappedDigest =
        digestLines[0] === UNTRUSTED_BOARD_CONTENT_HEADER
          ? [digestLines[0], `Board title: ${safeTitle}`, ...digestLines.slice(1)].join('\n')
          : `${UNTRUSTED_BOARD_CONTENT_HEADER}\nBoard title: ${safeTitle}\n${neutralizeUntrustedDelimiters(result.digestResult.digestText)}\n${UNTRUSTED_BOARD_CONTENT_FOOTER}`;
      const additionalContext = capBoundedDigest(
        `${header}\n${wrappedDigest}`,
        HOOK_DIGEST_MAX_CHARS,
      );
      const output = formatHookOutput(rawHarness, rawEvent, additionalContext);
      if (output && !deadlineTriggered) {
        const writeRes = await writeStdoutBounded(
          stdoutStream,
          `${output}\n`,
          deadlineAt - Date.now(),
          () => {
            stdoutWritePending = false;
            if (killTimer) clearTimeout(killTimer);
          },
        );
        if (writeRes.pending) {
          stdoutWritePending = true;
          appendHookLogSync(
            resolvedDeckDir,
            rawHarness,
            rawEvent,
            'Hook stdout write timed out; keeping hard deadline timer armed',
          );
        }
        if (writeRes.ok && !deadlineTriggered && result.pendingAck) {
          const ackWait = Math.max(50, Math.min(HOOK_LOCK_WAIT_MS, deadlineAt - Date.now()));
          await store.commitHookDelivery(result.pendingAck, { maxWaitMs: ackWait });
        }
      }
      return;
    }

    if (eventAction === 'end') {
      await store.markHookSessionIdle({
        externalRef,
        maxWaitMs: remainingForLock,
        onCorruptSession,
      });
      return;
    }
  } catch (err) {
    await appendHookLog(
      resolvedDeckDir,
      rawHarness,
      rawEvent,
      err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    );
  } finally {
    clearTimeout(softTimer);
    if (killTimer && !stdoutWritePending) {
      clearTimeout(killTimer);
    }
  }
}
