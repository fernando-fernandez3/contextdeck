#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..');
const webDistSource = path.resolve(serverDir, '../web/dist');
const webDistTarget = path.resolve(serverDir, 'web-dist');

const sourceIndex = path.join(webDistSource, 'index.html');
if (!fs.existsSync(sourceIndex)) {
  console.error(
    `[copy-web-dist] Missing built web UI at ${sourceIndex}. Run \`pnpm --filter @contextdeck/web build\` first.`,
  );
  process.exit(1);
}

fs.rmSync(webDistTarget, { recursive: true, force: true });
fs.cpSync(webDistSource, webDistTarget, { recursive: true });
console.log(`[copy-web-dist] Copied web dist to ${webDistTarget}`);
