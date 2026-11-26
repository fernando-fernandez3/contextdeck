import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {
  ContextDeckStore,
  UNTRUSTED_BOARD_CONTENT_FOOTER,
  WorkspaceNotFoundError,
  generateContextPack,
  resolveWorkspace,
  type ResolvedWorkspace,
} from '@contextdeck/core';

export type HookHarness = 'claude-code' | 'codex' | 'cursor';

const HOOK_MAX_STDIN_BYTES = 256 * 1024; // D12: 256 KB
const HOOK_DEADLINE_MS = 1_750; // C5 / D12: strict internal timeout well under 2 s
const HOOK_STDIN_TIMEOUT_MS = 900;
const HOOK_LOCK_WAIT_MS = 800; // D12: lock wait <= 800 ms
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

function extractPayloadCwd(
  harness: HookHarness,
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): { cwd: string; explicitFromPayload: boolean } {
  if (typeof payload.cwd === 'string' && payload.cwd.trim()) {
    return { cwd: payload.cwd.trim(), explicitFromPayload: true };
  }
  if (Array.isArray(payload.workspace_roots)) {
    for (const root of payload.workspace_roots) {
      if (typeof root === 'string' && root.trim()) {
        return { cwd: root.trim(), explicitFromPayload: true };
      }
    }
  }
  if (harness === 'cursor' && env.CURSOR_PROJECT_DIR?.trim()) {
    return { cwd: env.CURSOR_PROJECT_DIR.trim(), explicitFromPayload: false };
  }
  return { cwd: process.cwd(), explicitFromPayload: false };
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

function resolveHookWorkspace(
  payloadCwd: string,
  explicitFromPayload: boolean,
  env: NodeJS.ProcessEnv,
): ResolvedWorkspace | null {
  try {
    if (env.CONTEXTDECK_DIR?.trim()) {
      return resolveWorkspace({ env });
    }
    if (explicitFromPayload) {
      const envWithoutClaude = { ...env };
      delete envWithoutClaude.CLAUDE_PROJECT_DIR;
      try {
        return resolveWorkspace({ cwd: payloadCwd, env: envWithoutClaude });
      } catch (err) {
        if (err instanceof WorkspaceNotFoundError && env.CLAUDE_PROJECT_DIR?.trim()) {
          return resolveWorkspace({ env });
        }
        throw err;
      }
    }
    return resolveWorkspace({ cwd: payloadCwd, env });
  } catch (err) {
    if (err instanceof WorkspaceNotFoundError) {
      return null;
    }
    throw err;
  }
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

/**
 * Execute `cdeck hook <harness> <event>` adhering strictly to C5, C6, AC5.1-AC5.4, D11, D12, D14:
 * - Unknown harness or unknown event -> silent exit 0.
 * - Any error, corrupt workspace, stalled stdin, or lock timeout -> print NOTHING to stdout,
 *   log to `.contextdeck/.runtime/hooks.log`, and exit 0 well within 2 seconds.
 */
export async function runHookCli(
  rawHarness: string | undefined,
  rawEvent: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  // Unknown harness/event -> immediate silent exit 0 (Deliverable 1)
  if (!isKnownHarness(rawHarness) || !rawEvent) {
    return;
  }
  const eventAction = SUPPORTED_EVENTS[rawHarness][rawEvent];
  if (!eventAction) {
    return;
  }

  const deadlineAt = Date.now() + HOOK_DEADLINE_MS;
  let resolvedDeckDir: string | undefined;
  let deadlineTriggered = false;

  const hardTimer = setTimeout(() => {
    deadlineTriggered = true;
    appendHookLogSync(
      resolvedDeckDir,
      rawHarness,
      rawEvent,
      `Hook aborted at internal deadline (${HOOK_DEADLINE_MS}ms)`,
    );
    process.exit(0);
  }, HOOK_DEADLINE_MS);
  hardTimer.unref();

  try {
    // Best-effort deckDir lookup for logging early stdin errors
    try {
      const fallbackWs = resolveHookWorkspace(process.cwd(), false, env);
      resolvedDeckDir = fallbackWs?.deckDir;
    } catch {
      // ignore
    }

    const stdinTimeout = Math.min(HOOK_STDIN_TIMEOUT_MS, Math.max(100, deadlineAt - Date.now() - 400));
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

    const { cwd: payloadCwd, explicitFromPayload } = extractPayloadCwd(rawHarness, payload, env);
    const workspace = resolveHookWorkspace(payloadCwd, explicitFromPayload, env);
    if (!workspace) {
      return;
    }
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
    const remainingForLock = Math.max(
      50,
      Math.min(HOOK_LOCK_WAIT_MS, deadlineAt - Date.now() - 250),
    );

    if (eventAction === 'start') {
      const { session, boardSlug, snapshot } = await store.upsertHookSession({
        externalRef,
        harness: rawHarness,
        defaultTitle,
        cwd: payloadCwd,
        maxWaitMs: remainingForLock,
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
        process.stdout.write(`${output}\n`);
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
      const header = `[ContextDeck] Board "${result.boardConfig.title}" (${result.boardConfig.slug}) updated to rev ${result.boardConfig.revision} (${count} change${count === 1 ? '' : 's'} since your last sync; session ${result.session.id}):`;
      const additionalContext = capBoundedDigest(
        `${header}\n${result.digestResult.digestText}`,
        HOOK_DIGEST_MAX_CHARS,
      );
      const output = formatHookOutput(rawHarness, rawEvent, additionalContext);
      if (output && !deadlineTriggered) {
        process.stdout.write(`${output}\n`);
      }
      return;
    }

    if (eventAction === 'end') {
      await store.markHookSessionIdle({
        externalRef,
        maxWaitMs: remainingForLock,
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
    clearTimeout(hardTimer);
  }
}
