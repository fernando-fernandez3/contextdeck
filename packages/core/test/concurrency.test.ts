import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextDeckStore } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerScript = path.join(here, 'helpers', 'concurrent-worker.mjs');
const tmpDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdeck-conc-'));
  tmpDirs.push(dir);
  return dir;
}

function runWorker(
  deckDir: string,
  projectRoot: string,
  idx: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [workerScript, deckDir, projectRoot, String(idx)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    await fs.rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('AC1.4 / Bug 1: 32 concurrent separate Node processes', () => {
  it('loses zero decisions, zero tasks, preserves unique strictly increasing revisions, and surfaces brief conflicts', async () => {
    const dir = await makeTempDir();
    const deckDir = path.join(dir, '.contextdeck');
    const store = new ContextDeckStore({ deckDir, projectRoot: dir });
    await store.createBoard({ title: 'Concurrency Test', slug: 'main', brief: '# Initial\n' });

    const N = 32;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => runWorker(deckDir, dir, i)),
    );

    const failures = results.filter((r) => r.code !== 0);
    expect(failures).toEqual([]);

    const parsed = results.map((r) => JSON.parse(r.stdout));
    const briefSuccesses = parsed.filter((p) => p.briefStatus === 'ok');
    const briefConflicts = parsed.filter((p) => p.briefStatus === 'conflict');
    expect(briefSuccesses).toHaveLength(1);
    expect(briefConflicts).toHaveLength(N - 1);
    expect(briefConflicts.every((c) => c.conflictHasCurrentBrief)).toBe(true);

    const snapshot = await store.getSnapshot('main');
    expect(snapshot.decisions).toHaveLength(N);
    expect(snapshot.tasks).toHaveLength(N);

    // 1 board.init + 32 decisions + 32 tasks + 1 brief update = 66 events
    expect(snapshot.events).toHaveLength(1 + N + N + 1);
    expect(snapshot.config.revision).toBe(1 + N + N + 1);

    const revisions = snapshot.events.map((e) => e.revision);
    expect(new Set(revisions).size).toBe(revisions.length);
    for (let i = 1; i < revisions.length; i += 1) {
      expect(revisions[i]).toBeGreaterThan(revisions[i - 1]);
    }
  }, 30_000);
});
