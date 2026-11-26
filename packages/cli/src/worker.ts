import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  ContextDeckStore,
  assertWorkerConfigTrusted,
  loadWorkerConfig,
  type RefreshJob,
  type WorkerConfig,
  type WorkerHandlerConfig,
} from '@contextdeck/core';

export function resolveHandlerForJob(
  config: WorkerConfig,
  job: RefreshJob,
): { key: string; handler: WorkerHandlerConfig } | null {
  if (job.artifactType === 'media') {
    if (job.mediaKind && config.handlers[job.mediaKind]) {
      return { key: job.mediaKind, handler: config.handlers[job.mediaKind] };
    }
    if (config.handlers.media) {
      return { key: 'media', handler: config.handlers.media };
    }
    return null;
  }
  if (job.artifactType === 'diagram') {
    if (job.diagramKind && config.handlers[job.diagramKind]) {
      return { key: job.diagramKind, handler: config.handlers[job.diagramKind] };
    }
    if (config.handlers.diagram) {
      return { key: 'diagram', handler: config.handlers.diagram };
    }
    return null;
  }
  if (job.artifactType === 'quiz' && config.handlers.quiz) {
    return { key: 'quiz', handler: config.handlers.quiz };
  }
  return null;
}

function isJobClaimableNow(job: RefreshJob, nowMs: number): boolean {
  if (job.status === 'queued') return true;
  if (job.status === 'claimed' && job.leaseExpiresAt) {
    const exp = Date.parse(job.leaseExpiresAt);
    return Number.isFinite(exp) && exp <= nowMs;
  }
  return false;
}

function executeHandlerSpawn(params: {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutSec: number;
}): Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = params.argv;
    // D18: Always spawn with shell: false; never interpolate untrusted board data into shell strings.
    const child = spawn(cmd, args, {
      cwd: params.cwd,
      env: params.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const MAX_CAPTURE = 16 * 1024;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_CAPTURE) {
        stdout += String(chunk).slice(0, MAX_CAPTURE - stdout.length);
      }
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_CAPTURE) {
        stderr += String(chunk).slice(0, MAX_CAPTURE - stderr.length);
      }
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 2_000);
      killTimer.unref();
    }, params.timeoutSec * 1000);
    timeoutTimer.unref();

    child.on('error', (err) => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ code, signal, timedOut, stdout, stderr });
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

export async function runWorkerOnce(
  store: ContextDeckStore,
  options: {
    boardSlug?: string;
    workerName?: string;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
  } = {},
): Promise<RunWorkerOnceResult> {
  const env = options.env ?? process.env;
  const workerName = options.workerName ?? `cdeck-worker:${os.hostname()}`;

  // D18: Load and verify trust hash of user-local ~/.contextdeck/worker.yaml ONLY
  const loaded = await loadWorkerConfig({ env, homeDir: options.homeDir });
  await assertWorkerConfigTrusted(loaded);

  const boards = options.boardSlug
    ? [await store.readBoardConfig(options.boardSlug)]
    : await store.listBoards();

  const nowMs = Date.now();
  let chosen: { slug: string; job: RefreshJob; handlerKey: string; handler: WorkerHandlerConfig } | null = null;

  for (const board of boards) {
    const jobs = await store.listJobs(board.slug);
    for (const job of jobs) {
      if (!isJobClaimableNow(job, nowMs)) continue;
      const resolved = resolveHandlerForJob(loaded.config, job);
      if (!resolved) continue;
      chosen = { slug: board.slug, job, handlerKey: resolved.key, handler: resolved.handler };
      break;
    }
    if (chosen) break;
  }

  if (!chosen) {
    return { processed: false };
  }

  const claimed = await store.claimJob(
    chosen.slug,
    { jobId: chosen.job.id, claimedBy: workerName },
    { type: 'agent', harness: 'worker', label: workerName },
  );
  if (!claimed || !claimed.leaseToken) {
    return { processed: false };
  }

  const snapshot = await store.getSnapshot(chosen.slug);
  const artifact =
    claimed.artifactType === 'diagram'
      ? snapshot.diagrams.find((d) => d.id === claimed.artifactId) ?? null
      : claimed.artifactType === 'media'
        ? snapshot.media.find((m) => m.id === claimed.artifactId) ?? null
        : snapshot.quizzes.find((q) => q.id === claimed.artifactId) ?? null;

  const decisionMap = new Map(snapshot.decisions.map((d) => [d.id, d]));
  const jobPayload = {
    job: claimed,
    board: chosen.slug,
    boardTitle: snapshot.config.title,
    boardRevision: snapshot.config.revision,
    deckDir: store.deckDir,
    projectRoot: store.projectRoot ?? null,
    brief: snapshot.brief,
    artifact,
    decisionsBefore: claimed.decisionsBefore.map((id) => decisionMap.get(id)).filter(Boolean),
    decisionsNow: claimed.decisionsNow.map((id) => decisionMap.get(id)).filter(Boolean),
  };

  const jobFile = path.join(
    os.tmpdir(),
    `cdeck-job-${claimed.id}-${crypto.randomBytes(6).toString('hex')}.json`,
  );
  await fs.writeFile(jobFile, `${JSON.stringify(jobPayload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });

  // Periodic lease renewal for long-running handlers (e.g. video renders)
  const renewTimer = setInterval(() => {
    void store
      .renewJob(
        chosen!.slug,
        claimed.id,
        { leaseToken: claimed.leaseToken! },
        { type: 'agent', harness: 'worker', label: workerName },
      )
      .catch(() => {});
  }, 5 * 60 * 1000);
  renewTimer.unref();

  try {
    const childEnv: NodeJS.ProcessEnv = {
      ...env,
      ...(chosen.handler.env ?? {}),
      CONTEXTDECK_JOB_FILE: jobFile,
      CONTEXTDECK_JOB_ID: claimed.id,
      CONTEXTDECK_LEASE_TOKEN: claimed.leaseToken,
      CONTEXTDECK_BOARD: chosen.slug,
      CONTEXTDECK_ARTIFACT_TYPE: claimed.artifactType,
      CONTEXTDECK_ARTIFACT_ID: claimed.artifactId,
      CONTEXTDECK_DECK_DIR: store.deckDir,
    };

    const execRes = await executeHandlerSpawn({
      argv: chosen.handler.argv,
      cwd: chosen.handler.cwd ?? store.projectRoot ?? process.cwd(),
      env: childEnv,
      timeoutSec: chosen.handler.timeoutSec,
    });

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
      await store.completeJob(
        chosen.slug,
        claimed.id,
        { leaseToken: claimed.leaseToken, status: 'failed', error: msg },
        { type: 'agent', harness: 'worker', label: workerName },
      );
      return { processed: true, boardSlug: chosen.slug, jobId: claimed.id, status: 'failed', message: msg };
    }

    if (execRes.code !== 0) {
      const errDetail = execRes.stderr.trim() || `Handler exited with code ${execRes.code ?? 'null'}`;
      await store.completeJob(
        chosen.slug,
        claimed.id,
        { leaseToken: claimed.leaseToken, status: 'failed', error: errDetail.slice(0, 1500) },
        { type: 'agent', harness: 'worker', label: workerName },
      );
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
          leaseToken: claimed.leaseToken,
          status: 'done',
          summary: execRes.stdout.trim().slice(0, 1500) || `Completed by handler "${chosen.handlerKey}"`,
        },
        { type: 'agent', harness: 'worker', label: workerName },
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
      await store.completeJob(
        chosen.slug,
        claimed.id,
        { leaseToken: claimed.leaseToken, status: 'failed', error: errMsg.slice(0, 1500) },
        { type: 'agent', harness: 'worker', label: workerName },
      );
      return {
        processed: true,
        boardSlug: chosen.slug,
        jobId: claimed.id,
        status: 'failed',
        message: errMsg,
      };
    }
  } finally {
    clearInterval(renewTimer);
    await fs.rm(jobFile, { force: true }).catch(() => {});
  }
}
