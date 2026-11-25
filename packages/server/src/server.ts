import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { serve } from '@hono/node-server';
import { ContextDeckStore } from '@contextdeck/core';
import { createApp } from './app.js';

export interface StartServerOptions {
  rootDir: string;
  port?: number;
  host?: string;
  webDistDir?: string;
}

export function resolveDefaultWebDistDir(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../web/dist'),
    path.resolve(here, '../../../web/dist'),
  ];
  return candidates.find((p) => fs.existsSync(path.join(p, 'index.html')));
}

export async function startServer(options: StartServerOptions): Promise<{
  url: string;
  mcpUrl: string;
  close: () => Promise<void>;
}> {
  const port = options.port ?? 4310;
  const host = options.host ?? '127.0.0.1';
  const store = new ContextDeckStore(options.rootDir);
  await store.ensureDefaultBoard();

  const webDistDir = options.webDistDir ?? resolveDefaultWebDistDir();
  const { app, close: closeApp } = createApp({ store, webDistDir });

  const server = serve({
    fetch: app.fetch,
    port,
    hostname: host,
  });

  const url = `http://${host}:${port}`;
  const mcpUrl = `${url}/mcp`;

  return {
    url,
    mcpUrl,
    close: async () => {
      await closeApp();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
