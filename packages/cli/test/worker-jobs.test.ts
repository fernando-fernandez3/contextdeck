import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextDeckStore } from '@contextdeck/core';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI_BIN = path.resolve(here, '../dist/index.js');
const tmpDirs: string[] = [];

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
