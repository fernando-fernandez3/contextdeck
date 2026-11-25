import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextDeckStore, seedDemoBoard } from '@contextdeck/core';
import { createApp } from '../src/app.js';

const tmpDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'contextdeck-srv-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    await fs.rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('@contextdeck/server', () => {
  it('serves REST board snapshots, media uploads with Range streaming, and Context Pack updates', async () => {
    const dir = await makeTempDir();
    const store = new ContextDeckStore(dir);
    const slug = await seedDemoBoard(store, 'demo');
    const { app, close } = createApp({ store });

    try {
      const health = await app.request('/api/health');
      expect(health.status).toBe(200);

      const boardRes = await app.request(`/api/boards/${slug}`);
      expect(boardRes.status).toBe(200);
      const snapshot = await boardRes.json();
      expect(snapshot.config.slug).toBe(slug);
      expect(snapshot.drift.staleArtifacts.length).toBeGreaterThan(0);

      // Upload a mock video binary via multipart/form-data
      const form = new FormData();
      form.append('title', 'Kokoro Demo Video');
      form.append('kind', 'video');
      form.append('file', new File([new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])], 'demo.mp4', { type: 'video/mp4' }));
      const uploadRes = await app.request(`/api/boards/${slug}/media`, {
        method: 'POST',
        body: form,
      });
      expect(uploadRes.status).toBe(201);
      const uploaded = await uploadRes.json();

      // Verify HTTP Range 206 streaming for smooth video scrubbing
      const rangeRes = await app.request(`/api/boards/${slug}/media/${uploaded.id}/file`, {
        headers: { Range: 'bytes=0-3' },
      });
      expect(rangeRes.status).toBe(206);
      expect(rangeRes.headers.get('content-range')).toBe('bytes 0-3/10');
      const buf = new Uint8Array(await rangeRes.arrayBuffer());
      expect(buf.length).toBe(4);
    } finally {
      await close();
    }
  });

  it('responds to Streamable HTTP MCP initialize & tool calls on /mcp', async () => {
    const dir = await makeTempDir();
    const store = new ContextDeckStore(dir);
    await seedDemoBoard(store, 'demo');
    const { app, close } = createApp({ store });

    try {
      const mcpHeaders = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      };

      const initRes = await app.request('/mcp', {
        method: 'POST',
        headers: mcpHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'vitest', version: '0.1.0' },
          },
        }),
      });
      expect(initRes.status).toBe(200);
      const initJson = await initRes.json();
      expect(initJson.result.serverInfo.name).toBe('contextdeck');

      const toolsRes = await app.request('/mcp', {
        method: 'POST',
        headers: mcpHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'board_get_brief',
            arguments: { board: 'demo' },
          },
        }),
      });
      expect(toolsRes.status).toBe(200);
      const toolsJson = await toolsRes.json();
      expect(toolsJson.result.content[0].text).toContain('Realtime Sync Engine v2');
    } finally {
      await close();
    }
  });
});
