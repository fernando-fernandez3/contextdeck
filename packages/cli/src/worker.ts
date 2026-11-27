import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  ConflictError,
  ContextDeckStore,
  CorruptDataError,
  NotFoundError,
  SecurityError,
  assertWorkerConfigTrusted,
  loadWorkerConfig,
  type ClaimedRefreshJob,
  type PublicRefreshJob,
  type RefreshJob,
  type WorkerConfig,
  type WorkerHandlerConfig,
} from '@contextdeck/core';

/**
 * Resolve handler for a refresh job following docs/handlers.md priority (H4):
 * - media: `media:<kind>` -> `<kind>` (legacy fallback) -> `media` -> `*`
 * - diagram: `diagram:<kind>` -> `<kind>` (legacy fallback) -> `diagram` -> `*`
 * - quiz: `quiz` -> `*`
 */
export function resolveHandlerForJob(
  config: WorkerConfig,
  job: Pick<RefreshJob, 'artifactType' | 'mediaKind' | 'diagramKind'>,
): { key: string; handler: WorkerHandlerConfig } | null {
  const candidates: string[] = [];
  if (job.artifactType === 'media') {
    if (job.mediaKind) {
      candidates.push(`media:${job.mediaKind}`, job.mediaKind);
    }
    candidates.push('media', '*');
  } else if (job.artifactType === 'diagram') {
    if (job.diagramKind) {
      candidates.push(`diagram:${job.diagramKind}`, job.diagramKind);
    }
    candidates.push('diagram', '*');
  } else if (job.artifactType === 'quiz') {
    candidates.push('quiz', '*');
  }

  for (const key of candidates) {
    const handler = config.handlers[key];
    if (handler) {
      return { key, handler };
    }
  }
  return null;
}

function isJobClaimableNow(job: Pick<PublicRefreshJob, 'status' | 'leaseExpiresAt'>, nowMs: number): boolean {
  if (job.status === 'queued') return true;
  if (job.status === 'claimed' && job.leaseExpiresAt) {
    const exp = Date.parse(job.leaseExpiresAt);
    return Number.isFinite(exp) && exp <= nowMs;
  }
  return false;
}

function killProcessTree(pid: number | undefined, signal: 'SIGTERM' | 'SIGKILL', child: ReturnType<typeof spawn>): void {
  if (process.platform === 'win32') {
    if (pid) {
      try {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          shell: false,
        });
        killer.on('error', () => {});
        killer.unref();
      } catch {
        // ignore
      }
    }
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
    return;
  }

  if (pid) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to direct child kill if process group no longer exists
    }
  }
  try {
    child.kill(signal);
  } catch {
    // ignore
  }
}

function executeHandlerSpawn(params: {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutSec: number;
  signal?: AbortSignal;
}): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = params.argv;
    const isPosix = process.platform !== 'win32';
    // D18 + H6: Always spawn with shell: false; on POSIX use detached: true so the
    // handler owns its own process group and timeout/abort kills all descendants via -pid.
    const child = spawn(cmd, args, {
      cwd: params.cwd,
      env: params.env,
      shell: false,
      detached: isPosix,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const MAX_CAPTURE = 16 * 1024;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let terminating = false;
    // R2-1: On POSIX, once timeout/abort fires, keep the SIGTERM -> SIGKILL process-group
    // escalation running to completion even if the direct child closes early (e.g., grandchild
    // ignoring SIGTERM with stdio: 'ignore'), and resolve only after escalation finishes.
    let escalationDone = !isPosix;
    let childClosed = false;
    let closeCode: number | null = null;
    let closeSignal: NodeJS.Signals | null = null;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let pipeCloseTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanupTimers = () => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (pipeCloseTimer) clearTimeout(pipeCloseTimer);
      if (params.signal) {
        params.signal.removeEventListener('abort', onAbort);
      }
    };

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      resolve({ code, signal, timedOut, aborted, stdout, stderr });
    };

    const forceClosePipes = (code: number | null, signal: NodeJS.Signals | null) => {
      try {
        child.stdout?.destroy();
      } catch {
        // ignore
      }
      try {
        child.stderr?.destroy();
      } catch {
        // ignore
      }
      finish(code, signal);
    };

    const schedulePipeDeadline = (ms: number, code: number | null, signal: NodeJS.Signals | null) => {
      if (pipeCloseTimer) return;
      pipeCloseTimer = setTimeout(() => {
        forceClosePipes(code, signal);
      }, ms);
      pipeCloseTimer.unref();
    };

    const terminateTree = (reason: 'timeout' | 'abort') => {
      if (reason === 'timeout') timedOut = true;
      if (reason === 'abort') aborted = true;
      if (terminating) return;
      terminating = true;

      killProcessTree(child.pid, 'SIGTERM', child);
      if (!isPosix) {
        // Windows: killProcessTree already issued taskkill /T /F
        escalationDone = true;
        schedulePipeDeadline(1_000, null, 'SIGKILL');
        return;
      }

      escalationDone = false;
      killTimer = setTimeout(() => {
        killProcessTree(child.pid, 'SIGKILL', child);
        escalationDone = true;
        if (childClosed) {
          finish(closeCode, closeSignal);
        } else {
          // H6: Bound waiting for pipe closure even if a detached descendant held an fd open
          schedulePipeDeadline(1_000, null, 'SIGKILL');
        }
      }, 1_000);
    };

    const onAbort = () => {
      terminateTree('abort');
    };

    if (params.signal) {
      if (params.signal.aborted) {
        onAbort();
      } else {
        params.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    child.stdout?.on('data', (chunk) => {
      if (terminating) return;
      if (stdout.length < MAX_CAPTURE) {
        stdout += String(chunk).slice(0, MAX_CAPTURE - stdout.length);
      }
    });
    child.stderr?.on('data', (chunk) => {
      if (terminating) return;
      if (stderr.length < MAX_CAPTURE) {
        stderr += String(chunk).slice(0, MAX_CAPTURE - stderr.length);
      }
    });

    const timeoutTimer = setTimeout(() => {
      terminateTree('timeout');
    }, params.timeoutSec * 1000);
    timeoutTimer.unref();

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      reject(err);
    });

    child.on('exit', (code, signal) => {
      if (terminating && escalationDone) {
        // Ensure pipes close promptly if direct child exited after SIGKILL
        schedulePipeDeadline(1_000, code, signal);
      }
    });

    child.on('close', (code, signal) => {
      childClosed = true;
      closeCode = code;
      closeSignal = signal;
      if (!terminating || escalationDone) {
        finish(code, signal);
      }
    });
  });
}

export interface RunWorkerOnceResult {
  processed: boolean;
  boardSlug?: string;
  jobId?: string;
  status?: 'done' | 'failed';
  message?: string;
}

export function isFatalWorkerConfigError(err: unknown): boolean {
  if (err instanceof SecurityError || err instanceof CorruptDataError) {
    return true;
  }
  if (err instanceof NotFoundError && /worker\.yaml/i.test(err.message)) {
    return true;
  }
  return false;
}

export async function runWorkerOnce(
  store: ContextDeckStore,
  options: {
    boardSlug?: string;
    workerName?: string;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    renewIntervalMs?: number;
  } = {},
): Promise<RunWorkerOnceResult> {
  const env = options.env ?? process.env;
  const workerName = options.workerName ?? `cdeck-worker:${os.hostname()}`;
  const renewIntervalMs = options.renewIntervalMs ?? 5 * 60 * 1000;

  // D18: Load and verify trust hash of user-local ~/.contextdeck/worker.yaml ONLY
  const loaded = await loadWorkerConfig({ env, homeDir: options.homeDir });
  await assertWorkerConfigTrusted(loaded);

  const boards = options.boardSlug
    ? [await store.readBoardConfig(options.boardSlug)]
    : await store.listBoards();

  const nowMs = Date.now();
  let claimed: ClaimedRefreshJob | null = null;
  let chosen: { slug: string; handlerKey: string; handler: WorkerHandlerConfig } | null = null;

  // H5: Scan claimable jobs; if another worker races and wins the claim (ConflictError),
  // skip cleanly to the next claimable job rather than crashing the worker.
  outer: for (const board of boards) {
    const jobs = await store.listJobs(board.slug);
    for (const job of jobs) {
      if (!isJobClaimableNow(job, nowMs)) continue;
      const resolved = resolveHandlerForJob(loaded.config, job);
      if (!resolved) continue;
      try {
        const attempt = await store.claimJob(
          board.slug,
          { jobId: job.id, claimedBy: workerName },
          { type: 'agent', harness: 'worker', label: workerName },
        );
        if (attempt && attempt.leaseToken) {
          claimed = attempt;
          chosen = { slug: board.slug, handlerKey: resolved.key, handler: resolved.handler };
          break outer;
        }
      } catch (err) {
        if (err instanceof ConflictError) {
          continue;
        }
        throw err;
      }
    }
  }

  if (!claimed || !claimed.leaseToken || !chosen) {
    return { processed: false };
  }

  const leaseToken = claimed.leaseToken;
  const workerActor = { type: 'agent' as const, harness: 'worker', label: workerName };

  const safeFailJob = async (errorMessage: string): Promise<void> => {
    try {
      await store.completeJob(
        chosen!.slug,
        claimed!.id,
        { leaseToken, status: 'failed', error: errorMessage.slice(0, 1500) },
        workerActor,
      );
    } catch (err) {
      if (err instanceof ConflictError) {
        // Lease was already lost or job was completed/reclaimed; do not crash.
        return;
      }
      throw err;
    }
  };

  // R2-7: Open try/finally immediately after acquiring the claim so any pre-spawn
  // setup failure fails the job cleanly and cleans up temp dir/timer without wedging it.
  let jobDir: string | null = null;
  let renewTimer: ReturnType<typeof setInterval> | null = null;

  try {
    let jobFile: string;
    try {
      // H4 & H13: Load ONLY the board config, brief, decisions, and target artifact (no full snapshot!)
      const ctx = await store.getWorkerJobContext(chosen.slug, claimed);
      const decisionMap = new Map(ctx.decisions.map((d) => [d.id, d]));
      const jobPayload = {
        job: claimed,
        board: chosen.slug,
        boardSlug: chosen.slug,
        boardTitle: ctx.config.title,
        boardRevision: ctx.config.revision,
        deckDir: store.deckDir,
        projectRoot: store.projectRoot ?? null,
        brief: ctx.brief,
        artifact: ctx.artifact,
        decisions: ctx.decisions,
        decisionsBefore: claimed.decisionsBefore.map((id) => decisionMap.get(id)).filter(Boolean),
        decisionsNow: claimed.decisionsNow.map((id) => decisionMap.get(id)).filter(Boolean),
      };

      // H8: Write job.json with wx + 0600 inside a private 0700 mkdtemp directory
      jobDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdeck-job-'));
      if (process.platform !== 'win32') {
        await fs.chmod(jobDir, 0o700);
      }
      jobFile = path.join(jobDir, 'job.json');
      await fs.writeFile(jobFile, `${JSON.stringify(jobPayload, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
    } catch (setupErr) {
      const msg = `Handler "${chosen.handlerKey}" setup failed: ${
        setupErr instanceof Error ? setupErr.message : String(setupErr)
      }`;
      await safeFailJob(msg);
      return {
        processed: true,
        boardSlug: chosen.slug,
        jobId: claimed.id,
        status: 'failed',
        message: msg,
      };
    }

    // Periodic lease renewal for long-running handlers; stop handler immediately if renewal fails (H6)
    const abortController = new AbortController();
    let leaseRenewalError: unknown = null;
    let renewInFlight = false;
    renewTimer = setInterval(() => {
      if (renewInFlight || abortController.signal.aborted) return;
      renewInFlight = true;
      void store
        .renewJob(chosen!.slug, claimed!.id, { leaseToken }, workerActor)
        .catch((err) => {
          leaseRenewalError = err;
          if (renewTimer) clearInterval(renewTimer);
          abortController.abort();
        })
        .finally(() => {
          renewInFlight = false;
        });
    }, renewIntervalMs);
    renewTimer.unref();

    const childEnv: NodeJS.ProcessEnv = {
      ...env,
      ...(chosen.handler.env ?? {}),
      CONTEXTDECK_JOB_FILE: jobFile,
      CONTEXTDECK_JOB_ID: claimed.id,
      CONTEXTDECK_LEASE_TOKEN: leaseToken,
      CONTEXTDECK_BOARD: chosen.slug,
      CONTEXTDECK_ARTIFACT_TYPE: claimed.artifactType,
      CONTEXTDECK_ARTIFACT_ID: claimed.artifactId,
      CONTEXTDECK_BASE_VERSION: String(claimed.baseVersion),
      CONTEXTDECK_DECK_DIR: store.deckDir,
      CONTEXTDECK_PROJECT_ROOT: store.projectRoot ?? '',
    };

    let execRes: Awaited<ReturnType<typeof executeHandlerSpawn>>;
    try {
      execRes = await executeHandlerSpawn({
        argv: chosen.handler.argv,
        cwd: chosen.handler.cwd ?? store.projectRoot ?? process.cwd(),
        env: childEnv,
        timeoutSec: chosen.handler.timeoutSec,
        signal: abortController.signal,
      });
    } catch (spawnErr) {
      // H5: Spawn error (e.g. ENOENT) -> fail job cleanly instead of leaving it wedged in claimed
      const msg = `Handler "${chosen.handlerKey}" failed to spawn: ${
        spawnErr instanceof Error ? spawnErr.message : String(spawnErr)
      }`;
      await safeFailJob(msg);
      return {
        processed: true,
        boardSlug: chosen.slug,
        jobId: claimed.id,
        status: 'failed',
        message: msg,
      };
    }

    if (leaseRenewalError) {
      const reason =
        leaseRenewalError instanceof Error ? leaseRenewalError.message : String(leaseRenewalError);
      const msg = `Lease renewal failed mid-run for "${chosen.handlerKey}": ${reason}`;
      if (!(leaseRenewalError instanceof ConflictError)) {
        await safeFailJob(msg);
      }
      return {
        processed: true,
        boardSlug: chosen.slug,
        jobId: claimed.id,
        status: 'failed',
        message: msg,
      };
    }

    const latestJob = await store.getJob(chosen.slug, claimed.id);
    if (latestJob && (latestJob.status === 'done' || latestJob.status === 'failed')) {
      return {
        processed: true,
        boardSlug: chosen.slug,
        jobId: claimed.id,
        status: latestJob.status,
        message: latestJob.result?.summary ?? latestJob.result?.error,
      };
    }

    if (execRes.timedOut) {
      const msg = `Handler "${chosen.handlerKey}" timed out after ${chosen.handler.timeoutSec}s`;
      await safeFailJob(msg);
      return { processed: true, boardSlug: chosen.slug, jobId: claimed.id, status: 'failed', message: msg };
    }

    if (execRes.code !== 0) {
      const errDetail = execRes.stderr.trim() || `Handler exited with code ${execRes.code ?? 'null'}`;
      await safeFailJob(errDetail);
      return {
        processed: true,
        boardSlug: chosen.slug,
        jobId: claimed.id,
        status: 'failed',
        message: errDetail.slice(0, 1500),
      };
    }

    try {
      const doneJob = await store.completeJob(
        chosen.slug,
        claimed.id,
        {
          leaseToken,
          status: 'done',
          summary: execRes.stdout.trim().slice(0, 1500) || `Completed by handler "${chosen.handlerKey}"`,
        },
        workerActor,
      );
      return {
        processed: true,
        boardSlug: chosen.slug,
        jobId: doneJob.id,
        status: 'done',
        message: doneJob.result?.summary,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (err instanceof ConflictError) {
        // H5: Lease lost before completion -> do NOT call completeJob(failed) with dead token!
        return {
          processed: true,
          boardSlug: chosen.slug,
          jobId: claimed.id,
          status: 'failed',
          message: errMsg,
        };
      }
      await safeFailJob(errMsg);
      return {
        processed: true,
        boardSlug: chosen.slug,
        jobId: claimed.id,
        status: 'failed',
        message: errMsg,
      };
    }
  } finally {
    if (renewTimer) clearInterval(renewTimer);
    if (jobDir) {
      await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export async function runWorkerLoop(
  store: ContextDeckStore,
  options: {
    boardSlug?: string;
    workerName?: string;
    pollMs: number;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    shouldStop?: () => boolean;
    onResult?: (res: RunWorkerOnceResult) => void;
    onTransientError?: (err: unknown) => void;
  },
): Promise<void> {
  const shouldStop = options.shouldStop ?? (() => false);

  // Fail fast before polling if config is missing, corrupt, or untrusted (H5)
  const initialConfig = await loadWorkerConfig({ env: options.env, homeDir: options.homeDir });
  await assertWorkerConfigTrusted(initialConfig);

  while (!shouldStop()) {
    try {
      const res = await runWorkerOnce(store, {
        boardSlug: options.boardSlug,
        workerName: options.workerName,
        env: options.env,
        homeDir: options.homeDir,
      });
      if (res.processed) {
        options.onResult?.(res);
        continue;
      }
    } catch (err) {
      if (isFatalWorkerConfigError(err)) {
        throw err;
      }
      options.onTransientError?.(err);
    }

    if (!shouldStop()) {
      await new Promise((r) => setTimeout(r, options.pollMs));
    }
  }
}
