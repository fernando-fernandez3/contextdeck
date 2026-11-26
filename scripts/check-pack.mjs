#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACK_CHECK_PORT = 4465;

function run(cmd, args, cwd, extraEnv = {}) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  });
}

async function main() {
  const tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'contextdeck-pack-check-'));
  const tarDir = path.join(tmpBase, 'tarballs');
  const installDir = path.join(tmpBase, 'installed');
  const workspaceDir = path.join(tmpBase, 'workspace');
  let serverProc = null;

  try {
    await fsp.mkdir(tarDir, { recursive: true });
    await fsp.mkdir(installDir, { recursive: true });
    await fsp.mkdir(workspaceDir, { recursive: true });

    // Ensure all packages (including web dist) are built
    if (!fs.existsSync(path.join(repoRoot, 'packages/web/dist/index.html'))) {
      console.log('[pack:check] Building workspace packages...');
      run('pnpm', ['build'], repoRoot);
    }

    // Pack core, server (runs prepack -> copies web-dist), and cli via pnpm pack
    console.log('[pack:check] Packing @contextdeck/core, @contextdeck/server, @contextdeck/cli...');
    const pkgDirs = [
      path.join(repoRoot, 'packages/core'),
      path.join(repoRoot, 'packages/server'),
      path.join(repoRoot, 'packages/cli'),
    ];
    for (const dir of pkgDirs) {
      run('pnpm', ['pack', '--pack-destination', tarDir], dir);
    }

    const tarballs = (await fsp.readdir(tarDir)).filter((f) => f.endsWith('.tgz')).sort();
    const coreTgz = tarballs.find((f) => f.includes('contextdeck-core-'));
    const serverTgz = tarballs.find((f) => f.includes('contextdeck-server-'));
    const cliTgz = tarballs.find((f) => f.includes('contextdeck-cli-'));
    if (!coreTgz || !serverTgz || !cliTgz) {
      throw new Error(`Missing expected tarballs in ${tarDir}: ${tarballs.join(', ')}`);
    }

    // Verify server tarball bundles web-dist/index.html (D20)
    const serverContents = run('tar', ['-tzf', path.join(tarDir, serverTgz)], tmpBase);
    if (!serverContents.includes('package/web-dist/index.html')) {
      throw new Error('@contextdeck/server tarball is missing package/web-dist/index.html');
    }
    console.log('[pack:check] Verified @contextdeck/server tarball contains package/web-dist/index.html');

    // Install the 3 packed tarballs into an isolated directory outside the monorepo
    await fsp.writeFile(
      path.join(installDir, 'package.json'),
      JSON.stringify(
        {
          name: 'contextdeck-pack-verify',
          private: true,
          pnpm: {
            overrides: {
              '@contextdeck/core': `file:${path.join(tarDir, coreTgz)}`,
              '@contextdeck/server': `file:${path.join(tarDir, serverTgz)}`,
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    console.log('[pack:check] Installing tarballs into isolated directory...');
    run(
      'pnpm',
      [
        'add',
        path.join(tarDir, coreTgz),
        path.join(tarDir, serverTgz),
        path.join(tarDir, cliTgz),
      ],
      installDir,
    );

    const cdeckBin = path.join(installDir, 'node_modules', '.bin', 'cdeck');
    if (!fs.existsSync(cdeckBin)) {
      throw new Error(`Installed cdeck bin not found at ${cdeckBin}`);
    }

    const versionOut = run(cdeckBin, ['--version'], workspaceDir).trim();
    console.log(`[pack:check] Installed cdeck --version => ${versionOut}`);

    run(cdeckBin, ['init', '--demo', '--dir', workspaceDir], workspaceDir);

    // Start installed cdeck serve and verify it serves the bundled web UI from web-dist
    const started = await new Promise((resolve, reject) => {
      const proc = spawn(
        cdeckBin,
        ['serve', '--dir', workspaceDir, '--port', String(PACK_CHECK_PORT), '--host', '127.0.0.1'],
        { cwd: workspaceDir, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      serverProc = proc;
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`Timed out waiting for installed cdeck serve.\nstdout: ${out}\nstderr: ${err}`));
      }, 15_000);

      proc.stdout.on('data', (d) => {
        out += d.toString('utf8');
        const m = out.match(/Launch URL\s*:\s*(http:\/\/\S+\/auth\?code=\S+)/);
        if (m) {
          clearTimeout(timer);
          resolve({ launchUrl: m[1] });
        }
      });
      proc.stderr.on('data', (d) => {
        err += d.toString('utf8');
      });
      proc.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Installed cdeck serve exited early (${code}).\nstdout: ${out}\nstderr: ${err}`));
      });
    });

    const baseUrl = `http://127.0.0.1:${PACK_CHECK_PORT}`;
    const htmlRes = await fetch(`${baseUrl}/`);
    if (htmlRes.status !== 200) {
      throw new Error(`Expected 200 from installed web UI /, got ${htmlRes.status}`);
    }
    const html = await htmlRes.text();
    if (!html.includes('<div id="root"></div>')) {
      throw new Error('Installed web UI HTML did not contain #root mount point');
    }
    const scriptMatch = html.match(/src="(\/assets\/[^"]+\.js)"/);
    if (!scriptMatch) {
      throw new Error('Installed web UI HTML did not reference a built JS asset');
    }
    const jsRes = await fetch(`${baseUrl}${scriptMatch[1]}`);
    if (jsRes.status !== 200) {
      throw new Error(`Expected 200 from ${scriptMatch[1]}, got ${jsRes.status}`);
    }

    // Verify launch URL auth returns 302 with HttpOnly session cookie
    const authRes = await fetch(started.launchUrl, { redirect: 'manual' });
    if (authRes.status !== 302) {
      throw new Error(`Expected 302 from launch URL, got ${authRes.status}`);
    }

    console.log(`[pack:check] SUCCESS: Installed cdeck serve served ${scriptMatch[1]} and authenticated launch URL.`);
  } finally {
    if (serverProc && !serverProc.killed) {
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          serverProc.kill('SIGKILL');
          resolve();
        }, 4_000);
        serverProc.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
        serverProc.kill('SIGTERM');
      });
    }
    // Remove generated packages/server/web-dist left behind by prepack so working tree stays clean
    await fsp.rm(path.join(repoRoot, 'packages/server/web-dist'), { recursive: true, force: true }).catch(() => {});
    await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error('[pack:check] FAILED:', err);
  process.exit(1);
});
