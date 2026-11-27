import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextDeckStore } from '@contextdeck/core';
import { resolveHandlerForJob, runWorkerLoop, runWorkerOnce } from '../src/worker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI_BIN = path.resolve(here, '../dist/index.js');
const tmpDirs: string[] = [];
const spawnedPids: number[] = [];

async function makeTempDir(prefix = 'cdeck-b3-cli-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function runCli(
  args: string[],
  options: { cwd: string; env?: Record<string, string | undefined> },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
    delete cleanEnv.CONTEXTDECK_DIR;
    delete cleanEnv.CLAUDE_PROJECT_DIR;
    delete cleanEnv.CONTEXTDECK_HOME;
    if (options.env) {
      for (const [k, v] of Object.entries(options.env)) {
        if (v === undefined) delete cleanEnv[k];
        else cleanEnv[k] = v;
      }
    }
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd: options.cwd,
      env: cleanEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    await fs.rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('B3 CLI: cdeck job, cdeck media update/prune, cdeck worker + trust (AC7.4-AC7.6, D18-D19)', () => {
  it('drives job create/list/claim/renew/release/complete and media update/prune via CLI', async () => {
    const dir = await makeTempDir();
    expect((await runCli(['init', '--slug', 'main'], { cwd: dir })).code).toBe(0);

    const v1 = path.join(dir, 'video-v1.mp4');
    const v2 = path.join(dir, 'video-v2.mp4');
    await fs.writeFile(v1, Buffer.from('mp4-v1'));
    await fs.writeFile(v2, Buffer.from('mp4-v2'));

    const d1Res = await runCli(['decision', 'add', 'Old Flow'], { cwd: dir });
    const d1 = JSON.parse(d1Res.stdout) as { id: string };
    const mRes = await runCli(
      ['media', 'add', 'Flow Video', '--type', 'video', '--file', v1, '--based-on', d1.id],
      { cwd: dir },
    );
    expect(mRes.code).toBe(0);
    const media = JSON.parse(mRes.stdout) as { id: string; filePath: string };
    expect(media.filePath).toBe(`${media.id}.v1.mp4`);

    const d2Res = await runCli(['decision', 'add', 'New Flow', '--supersedes', d1.id], { cwd: dir });
    const d2 = JSON.parse(d2Res.stdout) as { id: string };

    // Queue job via CLI
    const createRes = await runCli(['job', 'create', 'media', media.id], { cwd: dir });
    expect(createRes.code).toBe(0);
    const created = JSON.parse(createRes.stdout) as { job: { id: string } };

    // List queued jobs
    const listRes = await runCli(['job', 'list', '--status', 'queued'], { cwd: dir });
    expect(listRes.code).toBe(0);
    expect(listRes.stdout).toContain(created.job.id);

    // Claim -> renew -> release -> reclaim
    const claim1 = await runCli(['job', 'claim', created.job.id, '--by', 'cli-user'], { cwd: dir });
    expect(claim1.code).toBe(0);
    const c1 = JSON.parse(claim1.stdout) as { leaseToken: string };

    const renew = await runCli(['job', 'renew', created.job.id, '--lease', c1.leaseToken], { cwd: dir });
    expect(renew.code).toBe(0);

    const rel = await runCli(['job', 'release', created.job.id, '--lease', c1.leaseToken], { cwd: dir });
    expect(rel.code).toBe(0);

    const claim2 = await runCli(['job', 'claim', created.job.id, '--by', 'cli-user-2'], { cwd: dir });
    expect(claim2.code).toBe(0);
    const c2 = JSON.parse(claim2.stdout) as { leaseToken: string };

    // Update media with --job without --lease must fail (H1)
    const noLeaseUpd = await runCli(
      ['media', 'update', media.id, '--file', v2, '--based-on', d2.id, '--job', created.job.id],
      { cwd: dir },
    );
    expect(noLeaseUpd.code).not.toBe(0);

    // Update media with --job and --lease succeeds
    const updRes = await runCli(
      [
        'media',
        'update',
        media.id,
        '--file',
        v2,
        '--based-on',
        d2.id,
        '--job',
        created.job.id,
        '--lease',
        c2.leaseToken,
      ],
      { cwd: dir },
    );
    expect(updRes.code).toBe(0);
    const updated = JSON.parse(updRes.stdout) as { version: number; filePath: string };
    expect(updated.version).toBe(2);
    expect(updated.filePath).toBe(`${media.id}.v2.mp4`);

    // Complete job
    const doneRes = await runCli(
      ['job', 'complete', created.job.id, '--lease', c2.leaseToken, '--artifact-version', '2'],
      { cwd: dir },
    );
    expect(doneRes.code).toBe(0);
    const doneJob = JSON.parse(doneRes.stdout) as { status: string; result?: { artifactVersion?: number } };
    expect(doneJob.status).toBe('done');
    expect(doneJob.result?.artifactVersion).toBe(2);

    // Prune v1
    const pruneRes = await runCli(['media', 'prune'], { cwd: dir });
    expect(pruneRes.code).toBe(0);
    const pruned = JSON.parse(pruneRes.stdout) as { prunedFiles: string[] };
    expect(pruned.prunedFiles).toContain(`${media.id}.v1.mp4`);
  });

  it('cdeck worker enforces user-local worker.yaml trust gate, uses shell:false with env+JSON file, ignores repo-local worker.yaml, and completes job', async () => {
    const base = await makeTempDir('cdeck-b3-worker-');
    const fakeHome = path.join(base, 'home');
    const repo = path.join(base, 'repo');
    await fs.mkdir(fakeHome, { recursive: true });
    await fs.mkdir(repo, { recursive: true });

    const env = { CONTEXTDECK_HOME: fakeHome };
    expect((await runCli(['init', '--slug', 'main'], { cwd: repo, env })).code).toBe(0);

    // Malicious repo-local worker.yaml MUST BE IGNORED (D18: user-local config ONLY)
    await fs.writeFile(
      path.join(repo, '.contextdeck', 'worker.yaml'),
      'handlers:\n  video:\n    argv: ["echo", "pwned"]\n',
      'utf8',
    );

    const store = new ContextDeckStore(repo);
    const d1 = await store.recordDecision('main', { title: 'V1 spec' });
    const srcV1 = path.join(repo, 'clip1.mp4');
    await fs.writeFile(srcV1, Buffer.from('clip-v1'));
    const media = await store.addMedia('main', {
      title: 'Explainer $(touch pwned)',
      kind: 'video',
      sourceFilePath: srcV1,
      basedOnDecisions: [d1.id],
    });
    const d2 = await store.recordDecision('main', { title: 'V2 spec', supersedes: d1.id });
    const { job } = await store.createRefreshJob('main', {
      artifactType: 'media',
      artifactId: media.id,
    });

    // Without user-local worker.yaml -> worker must fail cleanly (not run repo-local yaml!)
    const noConfig = await runCli(['worker', '--once'], { cwd: repo, env });
    expect(noConfig.code).not.toBe(0);
    expect(noConfig.stderr).toMatch(/worker\.yaml/i);

    // Write a generic handler script in temp dir that reads CONTEXTDECK_JOB_FILE and calls `cdeck media update`
    const handlerScript = path.join(base, 'video-handler.mjs');
    const outVideo = path.join(base, 'rendered-v2.mp4');
    await fs.writeFile(
      handlerScript,
      `import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const payload = JSON.parse(fs.readFileSync(process.env.CONTEXTDECK_JOB_FILE, 'utf8'));
if (payload.job.id !== process.env.CONTEXTDECK_JOB_ID) process.exit(2);
fs.writeFileSync(${JSON.stringify(outVideo)}, 'rendered-v2-bytes');
execFileSync(process.execPath, [
  ${JSON.stringify(CLI_BIN)},
  'media', 'update', payload.job.artifactId,
  '--board', payload.board,
  '--file', ${JSON.stringify(outVideo)},
  '--based-on', payload.job.decisionsNow.join(','),
  '--job', payload.job.id,
  '--lease', process.env.CONTEXTDECK_LEASE_TOKEN,
], { cwd: ${JSON.stringify(repo)}, stdio: 'inherit' });
`,
      'utf8',
    );

    await fs.writeFile(
      path.join(fakeHome, 'worker.yaml'),
      `handlers:\n  video:\n    argv:\n      - ${JSON.stringify(process.execPath)}\n      - ${JSON.stringify(handlerScript)}\n    timeoutSec: 30\n`,
      'utf8',
    );

    // Before trust -> MUST refuse and instruct `cdeck worker trust`
    const untrusted = await runCli(['worker', '--once'], { cwd: repo, env });
    expect(untrusted.code).not.toBe(0);
    expect(untrusted.stderr).toContain('cdeck worker trust');

    // Run `cdeck worker trust`
    const trustRes = await runCli(['worker', 'trust'], { cwd: repo, env });
    expect(trustRes.code).toBe(0);
    expect(trustRes.stdout).toMatch(/trusted/i);

    // Now `cdeck worker --once` claims, runs handler (shell:false), and completes job!
    const runRes = await runCli(['worker', '--once'], { cwd: repo, env });
    expect(runRes.code).toBe(0);

    const afterJob = await store.getJob('main', job.id);
    expect(afterJob?.status).toBe('done');
    expect(afterJob?.result?.artifactVersion).toBe(2);

    const snap = await store.getSnapshot('main');
    const updatedMedia = snap.media.find((m) => m.id === media.id)!;
    expect(updatedMedia.version).toBe(2);
    expect(updatedMedia.basedOnDecisions).toEqual([d2.id]);
    expect(snap.drift.staleArtifacts).toHaveLength(0);

    // Modifying worker.yaml invalidates trust hash -> worker refuses again!
    await fs.appendFile(path.join(fakeHome, 'worker.yaml'), '# modified\n', 'utf8');
    const reUntrusted = await runCli(['worker', '--once'], { cwd: repo, env });
    expect(reUntrusted.code).not.toBe(0);
    expect(reUntrusted.stderr).toContain('cdeck worker trust');
  });
});

describe('B3 Hardening G2: Worker contract, robustness, process-tree timeout, and temp dir (H4-H6, H8)', () => {
  it('H4: matches docs/handlers.md resolution order, env vars, payload fields, --interval flag, and runs documented media:video + quiz handlers', async () => {
    const base = await makeTempDir('cdeck-h4-');
    const fakeHome = path.join(base, 'home');
    const repo = path.join(base, 'repo');
    await fs.mkdir(fakeHome, { recursive: true });
    await fs.mkdir(repo, { recursive: true });
    const env = { CONTEXTDECK_HOME: fakeHome };

    // Resolution priority: media:<kind> -> <kind> -> media -> *; diagram:<kind> -> <kind> -> diagram -> *; quiz -> *
    const dummyJob = (over: Partial<import('@contextdeck/core').RefreshJob>) =>
      ({
        id: 'job_1',
        kind: 'refresh',
        artifactType: 'media',
        artifactId: 'art_1',
        artifactTitle: 'T',
        mediaKind: 'video',
        reason: 'r',
        decisionsBefore: [],
        decisionsNow: [],
        baseVersion: 1,
        status: 'queued',
        claimedBy: null,
        leaseToken: null,
        claimedAt: null,
        leaseExpiresAt: null,
        result: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...over,
      }) as import('@contextdeck/core').RefreshJob;

    expect(
      resolveHandlerForJob(
        {
          handlers: {
            'media:video': { argv: ['node', 'mv.mjs'], timeoutSec: 60 },
            video: { argv: ['node', 'v.mjs'], timeoutSec: 60 },
            media: { argv: ['node', 'm.mjs'], timeoutSec: 60 },
            '*': { argv: ['node', 'star.mjs'], timeoutSec: 60 },
          },
        },
        dummyJob({ artifactType: 'media', mediaKind: 'video' }),
      )?.key,
    ).toBe('media:video');
    expect(
      resolveHandlerForJob(
        { handlers: { '*': { argv: ['node', 'star.mjs'], timeoutSec: 60 } } },
        dummyJob({ artifactType: 'media', mediaKind: 'video' }),
      )?.key,
    ).toBe('*');
    expect(
      resolveHandlerForJob(
        {
          handlers: {
            'diagram:mermaid': { argv: ['node', 'dm.mjs'], timeoutSec: 60 },
            diagram: { argv: ['node', 'd.mjs'], timeoutSec: 60 },
          },
        },
        dummyJob({ artifactType: 'diagram', mediaKind: undefined, diagramKind: 'mermaid' }),
      )?.key,
    ).toBe('diagram:mermaid');
    expect(
      resolveHandlerForJob(
        { handlers: { '*': { argv: ['node', 'star.mjs'], timeoutSec: 60 } } },
        dummyJob({ artifactType: 'quiz', mediaKind: undefined }),
      )?.key,
    ).toBe('*');

    expect((await runCli(['init', '--slug', 'main'], { cwd: repo, env })).code).toBe(0);
    const store = new ContextDeckStore({ deckDir: path.join(repo, '.contextdeck'), projectRoot: repo });
    const d1 = await store.recordDecision('main', { title: 'Old Auth', summary: 'Legacy' });
    const v1 = path.join(repo, 'v1.mp4');
    await fs.writeFile(v1, Buffer.from('v1-bytes'));
    const video = await store.addMedia('main', {
      title: 'Auth Explainer',
      kind: 'video',
      sourceFilePath: v1,
      basedOnDecisions: [d1.id],
    });
    const quiz = await store.createQuiz('main', {
      title: 'Auth Quiz',
      basedOnDecisions: [d1.id],
      questions: [
        {
          id: 'q1',
          prompt: 'Old auth?',
          type: 'true_false',
          correctAnswer: 'true',
          explanation: 'Old',
          relatedDecisionIds: [d1.id],
        },
      ],
    });
    const d2 = await store.recordDecision('main', {
      title: 'Passkeys',
      supersedes: d1.id,
      summary: 'WebAuthn passkeys',
    });
    const { job: videoJob } = await store.createRefreshJob('main', {
      artifactType: 'media',
      artifactId: video.id,
    });
    const { job: quizJob } = await store.createRefreshJob('main', {
      artifactType: 'quiz',
      artifactId: quiz.id,
    });

    const videoHandler = path.join(base, 'docs-video-handler.mjs');
    const quizHandler = path.join(base, 'docs-quiz-handler.mjs');
    const outVideo = path.join(base, 'docs-v2.mp4');
    const outQuiz = path.join(base, 'docs-quiz.json');
    await fs.writeFile(
      videoHandler,
      `import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const payload = JSON.parse(await fs.readFile(process.env.CONTEXTDECK_JOB_FILE, 'utf8'));
if (!process.env.CONTEXTDECK_BASE_VERSION) throw new Error('missing CONTEXTDECK_BASE_VERSION');
if (!process.env.CONTEXTDECK_PROJECT_ROOT) throw new Error('missing CONTEXTDECK_PROJECT_ROOT');
const accepted = payload.decisions.filter((d) => d.status === 'accepted');
const decisionIds = accepted.map((d) => d.id).join(',');
await fs.writeFile(${JSON.stringify(outVideo)}, 'rendered-docs-v2');
execFileSync(process.execPath, [
  ${JSON.stringify(CLI_BIN)},
  'media', 'update', payload.job.artifactId,
  '--dir', payload.projectRoot,
  '--board', payload.boardSlug,
  '--file', ${JSON.stringify(outVideo)},
  '--based-on', decisionIds,
  '--job', process.env.CONTEXTDECK_JOB_ID,
  '--lease', process.env.CONTEXTDECK_LEASE_TOKEN,
], { stdio: 'inherit' });
`,
      'utf8',
    );
    await fs.writeFile(
      quizHandler,
      `import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const payload = JSON.parse(await fs.readFile(process.env.CONTEXTDECK_JOB_FILE, 'utf8'));
if (!process.env.CONTEXTDECK_BASE_VERSION) throw new Error('missing CONTEXTDECK_BASE_VERSION');
if (!process.env.CONTEXTDECK_PROJECT_ROOT) throw new Error('missing CONTEXTDECK_PROJECT_ROOT');
const accepted = payload.decisions.filter((d) => d.status === 'accepted');
const decisionIds = accepted.map((d) => d.id);
await fs.writeFile(${JSON.stringify(outQuiz)}, JSON.stringify({
  basedOnDecisions: decisionIds,
  questions: [{
    id: 'q1',
    prompt: 'Passkeys active?',
    type: 'true_false',
    correctAnswer: 'true',
    explanation: 'Per ' + decisionIds.join(','),
    relatedDecisionIds: decisionIds,
  }],
}), 'utf8');
execFileSync(process.execPath, [
  ${JSON.stringify(CLI_BIN)},
  'quiz', 'update', payload.job.artifactId,
  '--dir', payload.projectRoot,
  '--board', payload.boardSlug,
  '--file', ${JSON.stringify(outQuiz)},
  '--job', process.env.CONTEXTDECK_JOB_ID,
  '--lease', process.env.CONTEXTDECK_LEASE_TOKEN,
], { stdio: 'inherit' });
`,
      'utf8',
    );

    await fs.writeFile(
      path.join(fakeHome, 'worker.yaml'),
      `handlers:\n  "media:video":\n    argv: [${JSON.stringify(process.execPath)}, ${JSON.stringify(videoHandler)}]\n    timeoutSec: 30\n  quiz:\n    argv: [${JSON.stringify(process.execPath)}, ${JSON.stringify(quizHandler)}]\n    timeoutSec: 30\n`,
      'utf8',
    );
    expect((await runCli(['worker', 'trust'], { cwd: repo, env })).code).toBe(0);

    // --interval + --poll-ms together MUST error
    const bothFlags = await runCli(['worker', '--once', '--interval', '5', '--poll-ms', '1000'], {
      cwd: repo,
      env,
    });
    expect(bothFlags.code).not.toBe(0);

    // --interval 5 works with --once
    const pass1 = await runCli(['worker', '--once', '--interval', '5'], { cwd: repo, env });
    expect(pass1.code).toBe(0);
    const pass2 = await runCli(['worker', '--once', '--interval', '5'], { cwd: repo, env });
    expect(pass2.code).toBe(0);

    expect((await store.getJob('main', videoJob.id))?.status).toBe('done');
    expect((await store.getJob('main', quizJob.id))?.status).toBe('done');
    expect((await store.getSnapshot('main')).media.find((m) => m.id === video.id)?.basedOnDecisions).toEqual([d2.id]);
  });

  it('H5: handles spawn ENOENT, concurrent claim races, and lost-lease completion cleanly without crashing or wedging jobs', async () => {
    const base = await makeTempDir('cdeck-h5-');
    const fakeHome = path.join(base, 'home');
    const repo = path.join(base, 'repo');
    await fs.mkdir(fakeHome, { recursive: true });
    await fs.mkdir(repo, { recursive: true });
    const env = { CONTEXTDECK_HOME: fakeHome };

    const store = new ContextDeckStore({ deckDir: path.join(repo, '.contextdeck'), projectRoot: repo });
    await store.createBoard({ title: 'H5', slug: 'main' });
    const d1 = await store.recordDecision('main', { title: 'D1' });
    const diag1 = await store.upsertDiagram('main', {
      title: 'D1 Diag',
      kind: 'mermaid',
      content: 'flowchart LR\nA-->1',
      basedOnDecisions: [d1.id],
    });
    const diag2 = await store.upsertDiagram('main', {
      title: 'D2 Diag',
      kind: 'mermaid',
      content: 'flowchart LR\nA-->2',
      basedOnDecisions: [d1.id],
    });
    await store.recordDecision('main', { title: 'D2', supersedes: d1.id });

    // (1) Spawn ENOENT -> fails job cleanly instead of throwing and leaving it claimed
    const { job: enoentJob } = await store.createRefreshJob('main', {
      artifactType: 'diagram',
      artifactId: diag1.id,
    });
    await fs.writeFile(
      path.join(fakeHome, 'worker.yaml'),
      `handlers:\n  diagram:\n    argv: ["definitely-nonexistent-binary-99999"]\n    timeoutSec: 10\n`,
      'utf8',
    );
    expect((await runCli(['worker', 'trust'], { cwd: repo, env })).code).toBe(0);

    const enoentRes = await runWorkerOnce(store, { workerName: 'w-enoent', env });
    expect(enoentRes.processed).toBe(true);
    expect(enoentRes.status).toBe('failed');
    expect((await store.getJob('main', enoentJob.id))?.status).toBe('failed');

    // (2) Two workers racing one queued job -> neither throws ConflictError
    const okHandler = path.join(base, 'ok-diag.mjs');
    await fs.writeFile(
      okHandler,
      `import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const payload = JSON.parse(await fs.readFile(process.env.CONTEXTDECK_JOB_FILE, 'utf8'));
const mmd = payload.projectRoot + '/updated-' + payload.job.artifactId + '.mmd';
await fs.writeFile(mmd, 'flowchart LR\\nA-->Updated_' + payload.job.id, 'utf8');
execFileSync(process.execPath, [
  ${JSON.stringify(CLI_BIN)},
  'diagram', 'add', payload.artifact.title,
  '--id', payload.job.artifactId,
  '--file', mmd,
  '--dir', payload.projectRoot,
  '--board', payload.boardSlug,
  '--job', process.env.CONTEXTDECK_JOB_ID,
  '--lease', process.env.CONTEXTDECK_LEASE_TOKEN,
], { stdio: 'inherit' });
`,
      'utf8',
    );
    await fs.writeFile(
      path.join(fakeHome, 'worker.yaml'),
      `handlers:\n  diagram:\n    argv: [${JSON.stringify(process.execPath)}, ${JSON.stringify(okHandler)}]\n    timeoutSec: 30\n`,
      'utf8',
    );
    expect((await runCli(['worker', 'trust'], { cwd: repo, env })).code).toBe(0);

    const { job: raceJob } = await store.createRefreshJob('main', {
      artifactType: 'diagram',
      artifactId: diag2.id,
    });
    const [r1, r2] = await Promise.all([
      runWorkerOnce(store, { workerName: 'w1', env }),
      runWorkerOnce(store, { workerName: 'w2', env }),
    ]);
    const processedCount = [r1, r2].filter((r) => r.processed).length;
    expect(processedCount).toBe(1);
    expect((await store.getJob('main', raceJob.id))?.status).toBe('done');

    // (3) Lost lease before handler exits 0 -> does NOT throw unhandled ConflictError
    const releaseSelfHandler = path.join(base, 'release-self.mjs');
    await fs.writeFile(
      releaseSelfHandler,
      `import { execFileSync } from 'node:child_process';
execFileSync(process.execPath, [
  ${JSON.stringify(CLI_BIN)},
  'job', 'release', process.env.CONTEXTDECK_JOB_ID,
  '--lease', process.env.CONTEXTDECK_LEASE_TOKEN,
  '--dir', process.env.CONTEXTDECK_PROJECT_ROOT,
  '--board', process.env.CONTEXTDECK_BOARD,
], { stdio: 'inherit' });
`,
      'utf8',
    );
    await fs.writeFile(
      path.join(fakeHome, 'worker.yaml'),
      `handlers:\n  diagram:\n    argv: [${JSON.stringify(process.execPath)}, ${JSON.stringify(releaseSelfHandler)}]\n    timeoutSec: 30\n`,
      'utf8',
    );
    expect((await runCli(['worker', 'trust'], { cwd: repo, env })).code).toBe(0);

    const { job: lostJob } = await store.createRefreshJob('main', {
      artifactType: 'diagram',
      artifactId: diag1.id,
    });
    const lostRes = await runWorkerOnce(store, { workerName: 'w-lost', env });
    expect(lostRes.processed).toBe(true);
    expect(lostRes.status).toBe('failed');
    // Job was released back to queued and NOT overwritten by the dead lease token
    expect((await store.getJob('main', lostJob.id))?.status).toBe('queued');

    // (4) Polling loop catches transient errors and keeps polling, while exiting on missing/untrusted config
    await expect(
      runWorkerLoop(store, {
        pollMs: 20,
        env: { CONTEXTDECK_HOME: path.join(base, 'no-such-home') },
      }),
    ).rejects.toThrow(/worker\.yaml/i);

    let ticks = 0;
    const transientErrors: unknown[] = [];
    const origListBoards = store.listBoards.bind(store);
    store.listBoards = async () => {
      ticks += 1;
      if (ticks === 1) throw new Error('simulated transient EIO');
      return origListBoards();
    };
    try {
      await runWorkerLoop(store, {
        pollMs: 20,
        env,
        shouldStop: () => ticks >= 2,
        onTransientError: (e) => transientErrors.push(e),
      });
    } finally {
      store.listBoards = origListBoards;
    }
    expect(transientErrors).toHaveLength(1);
    expect(ticks).toBeGreaterThanOrEqual(2);
  });

  it.skipIf(process.platform === 'win32')(
    'H6 & H8: kills process-tree descendants on timeout without hanging on open pipes, stops on lease renewal failure, and uses 0700 temp dir + 0600 job.json',
    async () => {
      const base = await makeTempDir('cdeck-h6-h8-');
      const fakeHome = path.join(base, 'home');
      const repo = path.join(base, 'repo');
      await fs.mkdir(fakeHome, { recursive: true });
      await fs.mkdir(repo, { recursive: true });
      const env = { CONTEXTDECK_HOME: fakeHome };

      const store = new ContextDeckStore({ deckDir: path.join(repo, '.contextdeck'), projectRoot: repo });
      await store.createBoard({ title: 'H6H8', slug: 'main' });
      const d1 = await store.recordDecision('main', { title: 'D1' });
      const diag = await store.upsertDiagram('main', {
        title: 'Timeout Diag',
        kind: 'mermaid',
        content: 'flowchart LR\nA-->1',
        basedOnDecisions: [d1.id],
      });
      await store.recordDecision('main', { title: 'D2', supersedes: d1.id });
      const { job } = await store.createRefreshJob('main', {
        artifactType: 'diagram',
        artifactId: diag.id,
      });

      const metaOut = path.join(base, 'probe.json');
      const grandchildMarker = path.join(base, 'grandchild-ran.txt');
      const timeoutHandler = path.join(base, 'timeout-grandchild.mjs');
      await fs.writeFile(
        timeoutHandler,
        `import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const jobFile = process.env.CONTEXTDECK_JOB_FILE;
const jobDir = path.dirname(jobFile);
const dirMode = fs.statSync(jobDir).mode & 0o777;
const fileMode = fs.statSync(jobFile).mode & 0o777;
const child = spawn(process.execPath, [
  '-e',
  'setTimeout(() => { console.log("GRANDCHILD STILL RUNNING"); require("node:fs").writeFileSync(' + ${JSON.stringify(JSON.stringify(grandchildMarker))} + ', "alive"); }, 4000);'
], { stdio: 'inherit' });
fs.writeFileSync(${JSON.stringify(metaOut)}, JSON.stringify({ jobDir, jobFile, dirMode, fileMode, grandchildPid: child.pid }));
setInterval(() => {}, 1000);
`,
        'utf8',
      );
      await fs.writeFile(
        path.join(fakeHome, 'worker.yaml'),
        `handlers:\n  diagram:\n    argv: [${JSON.stringify(process.execPath)}, ${JSON.stringify(timeoutHandler)}]\n    timeoutSec: 1\n`,
        'utf8',
      );
      expect((await runCli(['worker', 'trust'], { cwd: repo, env })).code).toBe(0);

      const startedAt = Date.now();
      const res = await runWorkerOnce(store, { workerName: 'w-timeout', env });
      const elapsedMs = Date.now() - startedAt;

      expect(res.processed).toBe(true);
      expect(res.status).toBe('failed');
      expect(elapsedMs).toBeLessThan(3_500);
      expect((await store.getJob('main', job.id))?.status).toBe('failed');

      const probe = JSON.parse(await fs.readFile(metaOut, 'utf8')) as {
        jobDir: string;
        jobFile: string;
        dirMode: number;
        fileMode: number;
        grandchildPid: number;
      };
      // H8: 0700 private dir, 0600 job.json, removed after exit
      expect(path.basename(probe.jobFile)).toBe('job.json');
      expect(probe.dirMode).toBe(0o700);
      expect(probe.fileMode).toBe(0o600);
      await expect(fs.stat(probe.jobDir)).rejects.toThrow();

      // H6: grandchild process is dead
      let grandchildAlive = true;
      try {
        process.kill(probe.grandchildPid, 0);
      } catch {
        grandchildAlive = false;
      }
      expect(grandchildAlive).toBe(false);
      await expect(fs.stat(grandchildMarker)).rejects.toThrow();

      // H6b: lease renewal failure mid-run stops the handler immediately instead of waiting for timeoutSec
      const { job: renewFailJob } = await store.createRefreshJob('main', {
        artifactType: 'diagram',
        artifactId: diag.id,
      });
      const slowHandler = path.join(base, 'slow-renew-fail.mjs');
      await fs.writeFile(
        slowHandler,
        `import { execFileSync } from 'node:child_process';
// Release our own lease right away, then sleep 10s; the worker's renewal tick should kill us promptly.
execFileSync(process.execPath, [
  ${JSON.stringify(CLI_BIN)},
  'job', 'release', process.env.CONTEXTDECK_JOB_ID,
  '--lease', process.env.CONTEXTDECK_LEASE_TOKEN,
  '--dir', process.env.CONTEXTDECK_PROJECT_ROOT,
  '--board', process.env.CONTEXTDECK_BOARD,
], { stdio: 'inherit' });
setTimeout(() => {}, 10000);
`,
        'utf8',
      );
      await fs.writeFile(
        path.join(fakeHome, 'worker.yaml'),
        `handlers:\n  diagram:\n    argv: [${JSON.stringify(process.execPath)}, ${JSON.stringify(slowHandler)}]\n    timeoutSec: 15\n`,
        'utf8',
      );
      expect((await runCli(['worker', 'trust'], { cwd: repo, env })).code).toBe(0);

      const renewStart = Date.now();
      const renewRes = await runWorkerOnce(store, {
        workerName: 'w-renew-fail',
        env,
        renewIntervalMs: 300,
      });
      const renewElapsed = Date.now() - renewStart;
      expect(renewRes.processed).toBe(true);
      expect(renewRes.status).toBe('failed');
      expect(renewRes.message).toMatch(/renewal/i);
      expect(renewElapsed).toBeLessThan(4_500);
      expect((await store.getJob('main', renewFailJob.id))?.status).toBe('queued');
    },
  );
});

describe('B3 Hardening Round 2 G1: CLI dedupe redaction, pre-spawn failure cleanup, and SIGTERM-ignoring grandchild kill (R2-3, R2-7, R2-1)', () => {
  afterEach(() => {
    while (spawnedPids.length > 0) {
      const pid = spawnedPids.pop()!;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already dead
      }
    }
  });

  it('R2-3: cdeck job create deduplication against a claimed job does not print leaseToken to stdout', async () => {
    const dir = await makeTempDir('cdeck-r2-3-cli-');
    const store = new ContextDeckStore({ deckDir: path.join(dir, '.contextdeck'), projectRoot: dir });
    await store.createBoard({ title: 'R2-3 CLI', slug: 'main' });
    const d1 = await store.recordDecision('main', { title: 'D1' });
    const diag = await store.upsertDiagram('main', {
      title: 'Flow',
      kind: 'mermaid',
      content: 'flowchart LR\nA-->B',
      basedOnDecisions: [d1.id],
    });
    await store.recordDecision('main', { title: 'D2', supersedes: d1.id });
    const { job } = await store.createRefreshJob('main', {
      artifactType: 'diagram',
      artifactId: diag.id,
    });
    const claimed = await store.claimJob('main', { jobId: job.id, claimedBy: 'worker-cli-secret' });
    expect(claimed?.leaseToken).toBeTruthy();

    const dedupeRes = await runCli(
      ['job', 'create', 'diagram', diag.id, '--dir', dir, '--board', 'main'],
      { cwd: dir },
    );
    expect(dedupeRes.code).toBe(0);
    expect(dedupeRes.stdout).not.toContain(claimed!.leaseToken!);
    const parsed = JSON.parse(dedupeRes.stdout) as { deduplicated: boolean; job: Record<string, unknown> };
    expect(parsed.deduplicated).toBe(true);
    expect('leaseToken' in parsed.job).toBe(false);
    expect('leaseTokenHash' in parsed.job).toBe(false);
  });

  it('R2-7: pre-spawn setup failure (corrupt quiz JSON) fails the claimed job cleanly with no leftover temp dir', async () => {
    const base = await makeTempDir('cdeck-r2-7-');
    const fakeHome = path.join(base, 'home');
    const repo = path.join(base, 'repo');
    await fs.mkdir(fakeHome, { recursive: true });
    await fs.mkdir(repo, { recursive: true });
    const env = { CONTEXTDECK_HOME: fakeHome };

    const store = new ContextDeckStore({ deckDir: path.join(repo, '.contextdeck'), projectRoot: repo });
    await store.createBoard({ title: 'R2-7', slug: 'main' });
    const d1 = await store.recordDecision('main', { title: 'D1' });
    const quiz = await store.createQuiz('main', {
      title: 'Corruptible Quiz',
      basedOnDecisions: [d1.id],
      questions: [
        {
          id: 'q1',
          prompt: 'Ok?',
          type: 'true_false',
          correctAnswer: 'true',
          explanation: 'yes',
          relatedDecisionIds: [d1.id],
        },
      ],
    });
    await store.recordDecision('main', { title: 'D2', supersedes: d1.id });
    const { job } = await store.createRefreshJob('main', {
      artifactType: 'quiz',
      artifactId: quiz.id,
    });

    // Corrupt quiz JSON on disk after job is queued
    const quizPath = path.join(repo, '.contextdeck', 'boards', 'main', 'quizzes', `${quiz.id}.quiz.json`);
    await fs.writeFile(quizPath, '{ not valid json', 'utf8');

    await fs.writeFile(
      path.join(fakeHome, 'worker.yaml'),
      `handlers:\n  quiz:\n    argv: [${JSON.stringify(process.execPath)}, "-e", "process.exit(0)"]\n    timeoutSec: 10\n`,
      'utf8',
    );
    expect((await runCli(['worker', 'trust'], { cwd: repo, env })).code).toBe(0);

    const beforeTmp = new Set((await fs.readdir(os.tmpdir())).filter((n) => n.startsWith('cdeck-job-')));
    const res = await runWorkerOnce(store, { workerName: 'w-r2-7', env });
    const afterTmp = (await fs.readdir(os.tmpdir())).filter(
      (n) => n.startsWith('cdeck-job-') && !beforeTmp.has(n),
    );

    expect(res.processed).toBe(true);
    expect(res.status).toBe('failed');
    expect(res.jobId).toBe(job.id);
    expect(res.message).toMatch(/corrupt|setup/i);
    const persisted = await store.getJob('main', job.id);
    expect(persisted?.status).toBe('failed');
    expect(afterTmp).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'R2-1: timeout finishes process-group SIGKILL escalation even when direct child closes early and grandchild ignores SIGTERM',
    async () => {
      const base = await makeTempDir('cdeck-r2-1-');
      const fakeHome = path.join(base, 'home');
      const repo = path.join(base, 'repo');
      await fs.mkdir(fakeHome, { recursive: true });
      await fs.mkdir(repo, { recursive: true });
      const env = { CONTEXTDECK_HOME: fakeHome };

      const store = new ContextDeckStore({ deckDir: path.join(repo, '.contextdeck'), projectRoot: repo });
      await store.createBoard({ title: 'R2-1', slug: 'main' });
      const d1 = await store.recordDecision('main', { title: 'D1' });
      const diag = await store.upsertDiagram('main', {
        title: 'Sigterm Grandchild',
        kind: 'mermaid',
        content: 'flowchart LR\nA-->1',
        basedOnDecisions: [d1.id],
      });
      await store.recordDecision('main', { title: 'D2', supersedes: d1.id });
      const { job } = await store.createRefreshJob('main', {
        artifactType: 'diagram',
        artifactId: diag.id,
      });

      const pidFile = path.join(base, 'grandchild.pid');
      const handlerScript = path.join(base, 'sigterm-ignore-grandchild.cjs');
      // Exact Codex H6 repro: grandchild ignores SIGTERM and uses stdio: 'ignore' so direct child closes immediately on SIGTERM
      await fs.writeFile(
        handlerScript,
        `const fs = require('node:fs');
const child = require('node:child_process').spawn(process.execPath, [
  '-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid), 'utf8');
console.log(child.pid);
setInterval(()=>{},1000);
`,
        'utf8',
      );
      await fs.writeFile(
        path.join(fakeHome, 'worker.yaml'),
        `handlers:\n  diagram:\n    argv: [${JSON.stringify(process.execPath)}, ${JSON.stringify(handlerScript)}]\n    timeoutSec: 1\n`,
        'utf8',
      );
      expect((await runCli(['worker', 'trust'], { cwd: repo, env })).code).toBe(0);

      const res = await runWorkerOnce(store, { workerName: 'w-r2-1', env });
      const grandchildPid = Number((await fs.readFile(pidFile, 'utf8')).trim());
      expect(Number.isInteger(grandchildPid) && grandchildPid > 0).toBe(true);
      spawnedPids.push(grandchildPid);

      expect(res.processed).toBe(true);
      expect(res.status).toBe('failed');
      expect((await store.getJob('main', job.id))?.status).toBe('failed');

      await new Promise((r) => setTimeout(r, 500));
      let errCode: string | undefined;
      try {
        process.kill(grandchildPid, 0);
      } catch (err) {
        errCode = (err as NodeJS.ErrnoException).code;
      }
      expect(errCode).toBe('ESRCH');
    },
  );
});

describe('B3 Hardening Round 2 G2: CLI diagram add --id preserves kind and basedOnDecisions (R2-9)', () => {
  it('R2-9: cdeck diagram add --id preserves excalidraw kind and basedOnDecisions when flags are omitted, while new diagrams still default to mermaid', async () => {
    const dir = await makeTempDir('cdeck-r2-9-');
    const store = new ContextDeckStore({ deckDir: path.join(dir, '.contextdeck'), projectRoot: dir });
    await store.createBoard({ title: 'R2-9', slug: 'main' });
    const d1 = await store.recordDecision('main', { title: 'Use Excalidraw' });

    const created = await store.upsertDiagram('main', {
      title: 'Canvas',
      kind: 'excalidraw',
      content: JSON.stringify({ type: 'excalidraw', version: 2, elements: [{ id: 'e1' }] }),
      basedOnDecisions: [d1.id],
    });
    expect(created.kind).toBe('excalidraw');
    expect(created.basedOnDecisions).toEqual([d1.id]);

    const updatedFile = path.join(dir, 'updated.excalidraw');
    await fs.writeFile(
      updatedFile,
      JSON.stringify({ type: 'excalidraw', version: 2, elements: [{ id: 'e1' }, { id: 'e2' }] }),
      'utf8',
    );

    const updateRes = await runCli(
      ['diagram', 'add', 'Canvas', '--id', created.id, '--file', updatedFile, '--dir', dir, '--board', 'main'],
      { cwd: dir },
    );
    expect(updateRes.code).toBe(0);
    const updated = JSON.parse(updateRes.stdout) as {
      id: string;
      kind: string;
      version: number;
      basedOnDecisions: string[];
    };
    expect(updated.id).toBe(created.id);
    expect(updated.version).toBe(2);
    expect(updated.kind).toBe('excalidraw');
    expect(updated.basedOnDecisions).toEqual([d1.id]);

    // No stray .mmd file created for the excalidraw diagram
    const diagramsDir = path.join(dir, '.contextdeck', 'boards', 'main', 'diagrams');
    const files = await fs.readdir(diagramsDir);
    expect(files).toContain(`${created.id}.excalidraw`);
    expect(files).not.toContain(`${created.id}.mmd`);

    // New diagram without --kind still defaults to mermaid
    const mmdFile = path.join(dir, 'new.mmd');
    await fs.writeFile(mmdFile, 'flowchart LR\nA-->B\n', 'utf8');
    const newRes = await runCli(
      ['diagram', 'add', 'New Flow', '--file', mmdFile, '--dir', dir, '--board', 'main'],
      { cwd: dir },
    );
    expect(newRes.code).toBe(0);
    const newDiag = JSON.parse(newRes.stdout) as { kind: string; basedOnDecisions: string[] };
    expect(newDiag.kind).toBe('mermaid');
    expect(newDiag.basedOnDecisions).toEqual([]);
  });
});
