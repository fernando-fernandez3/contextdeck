import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { serve } from '@hono/node-server';
import { ContextDeckStore } from '@contextdeck/core';
import { createApp } from './app.js';
import { buildHostPolicy, formatHostForUrl, isLoopbackHost } from './security.js';

export interface StartServerOptions {
  deckDir?: string;
  projectRoot?: string;
  defaultBoard?: string;
  rootDir?: string;
  port?: number;
  host?: string;
  allowRemote?: boolean;
  allowedHosts?: string[];
  webDistDir?: string;
  maxMediaBytes?: number;
  bootstrapTtlMs?: number;
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
  launchUrl: string;
  mcpUrl: string;
  token: string;
  mintBootstrapCode: () => string;
  close: () => Promise<void>;
}> {
  const port = options.port ?? 4310;
  const host = options.host ?? '127.0.0.1';
  const allowRemote = options.allowRemote === true;
  const allowedHosts = options.allowedHosts ?? [];

  // Validate Host / --allow-remote policy before binding socket
  buildHostPolicy({ host, port, allowRemote, allowedHosts });

  if (!isLoopbackHost(host) || allowedHosts.length > 0) {
    console.warn(
      `[ContextDeck WARNING] Remote HTTP access enabled on ${host}:${port}. Traffic is PLAIN HTTP (unencrypted). Only expose on a trusted local network or behind a TLS reverse proxy.`,
    );
  }

  const store = options.deckDir
    ? new ContextDeckStore({
        deckDir: options.deckDir,
        projectRoot: options.projectRoot,
        defaultBoard: options.defaultBoard,
        maxMediaBytes: options.maxMediaBytes,
      })
    : new ContextDeckStore(options.rootDir ?? process.cwd());

  const webDistDir = options.webDistDir ?? resolveDefaultWebDistDir();
  const { app, token, mintBootstrapCode, close: closeApp } = createApp({
    store,
    webDistDir,
    host,
    port,
    allowRemote,
    allowedHosts,
    maxMediaBytes: options.maxMediaBytes,
    bootstrapTtlMs: options.bootstrapTtlMs,
  });

  const server = serve({
    fetch: app.fetch,
    port,
    hostname: host,
  });

  // Wait for listening event (or error) so caller can immediately connect
  await new Promise<void>((resolve, reject) => {
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    server.once('listening', onListening);
    server.once('error', onError);
  });

  const displayHost =
    host === '0.0.0.0' || host === '::'
      ? (allowedHosts[0]?.replace(/:\d+$/, '') || '127.0.0.1')
      : formatHostForUrl(host);
  const url = `http://${displayHost}:${port}`;
  const mcpUrl = `${url}/mcp`;
  const initialCode = mintBootstrapCode();
  const launchUrl = `${url}/auth?code=${initialCode}`;

  return {
    url,
    launchUrl,
    mcpUrl,
    token,
    mintBootstrapCode,
    close: async () => {
      await closeApp();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
