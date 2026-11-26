import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { ContextDeckStore } from '@contextdeck/core';
import { createApp } from '../src/app.js';
import { createContextDeckMcpServer, attachMcpResourceWatcher } from '../src/mcp.js';

const tmpDirs: string[] = [];

async function makeTempDir(prefix = 'cdeck-mcp-b2-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    await fs.rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('AC5.8 + AC6.1 + D10 MCP live sync, resource subscriptions, and session-bound board routing', () => {
  it('advertises resources.subscribe capability and sends notifications/resources/updated on board.yaml changes', async () => {
    const dir = await makeTempDir();
    const store = new ContextDeckStore(dir);
    await store.createBoard({ title: 'Main', slug: 'main' });

    const mcpServer = createContextDeckMcpServer(store, { defaultBoard: 'main' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: 'vitest-client', version: '0.1.0' },
      { capabilities: {} },
    );

    const receivedUris: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      receivedUris.push(notification.params.uri);
    });

    const watcherHandle = attachMcpResourceWatcher(mcpServer, store, { debounceMs: 50 });

    try {
      await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

      const caps = client.getServerCapabilities();
      expect(caps?.resources?.subscribe).toBe(true);

      await client.subscribeResource({ uri: 'contextdeck://brief' });
      // Allow chokidar watcher to finish initial ready scan
      await new Promise((r) => setTimeout(r, 200));

      await store.recordDecision('main', { title: 'Trigger resource update notification' });

      // Wait up to 2s for debounced watcher notification
      const deadline = Date.now() + 2000;
      while (receivedUris.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 40));
      }
      expect(receivedUris).toContain('contextdeck://brief');

      // After unsubscribe, subsequent updates must NOT notify for contextdeck://brief
      await client.unsubscribeResource({ uri: 'contextdeck://brief' });
      const countAfterUnsub = receivedUris.length;
      await store.recordDecision('main', { title: 'Should not trigger after unsubscribe' });
      await new Promise((r) => setTimeout(r, 350));
      expect(receivedUris.length).toBe(countAfterUnsub);
    } finally {
      await watcherHandle?.close();
      await client.close();
      await mcpServer.close();
    }
  });

  it('defaults MCP tools to the session bound board when sessionId is passed (AC6.1) and dedupes externalRef', async () => {
    const dir = await makeTempDir();
    const store = new ContextDeckStore(dir);
    await store.createBoard({ title: 'Main', slug: 'main', setAsDefault: true });
    await store.createBoard({ title: 'Frontend', slug: 'frontend' });

    const mcpServer = createContextDeckMcpServer(store, { defaultBoard: 'main' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'vitest-routing', version: '0.1.0' }, { capabilities: {} });

    try {
      await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

      // Register session on 'frontend' with externalRef
      const reg1 = await client.callTool({
        name: 'session_register',
        arguments: {
          board: 'frontend',
          title: 'Frontend Agent',
          harness: 'antigravity',
          externalRef: 'antigravity:conv-1',
        },
      });
      const sess1 = JSON.parse((reg1.content as Array<{ text: string }>)[0].text) as {
        id: string;
        board: string;
      };
      expect(sess1.board).toBe('frontend');

      // Repeating session_register with same externalRef reuses the session (no bloat)
      const reg2 = await client.callTool({
        name: 'session_register',
        arguments: {
          board: 'frontend',
          title: 'Frontend Agent',
          harness: 'antigravity',
          externalRef: 'antigravity:conv-1',
        },
      });
      const sess2 = JSON.parse((reg2.content as Array<{ text: string }>)[0].text) as { id: string };
      expect(sess2.id).toBe(sess1.id);

      // H9: Repeating session_register with same externalRef and OMITTED board must keep existing 'frontend' binding (not rebind to 'main')
      const reg3 = await client.callTool({
        name: 'session_register',
        arguments: {
          title: 'Frontend Agent Resumed',
          harness: 'antigravity',
          externalRef: 'antigravity:conv-1',
        },
      });
      const sess3 = JSON.parse((reg3.content as Array<{ text: string }>)[0].text) as {
        id: string;
        board: string;
      };
      expect(sess3.id).toBe(sess1.id);
      expect(sess3.board).toBe('frontend');

      // Call board_get_brief with sessionId and NO board -> must return Frontend board!
      const briefRes = await client.callTool({
        name: 'board_get_brief',
        arguments: { sessionId: sess1.id },
      });
      const briefText = (briefRes.content as Array<{ text: string }>)[0].text;
      expect(briefText).toContain('Board: `frontend`');

      // Record decision with sessionId and NO board -> must land on frontend, NOT main
      await client.callTool({
        name: 'decision_record',
        arguments: {
          title: 'Use CSS Grid for layout',
          sessionId: sess1.id,
        },
      });

      // Upsert task with sessionId and NO board -> must land on frontend, NOT main
      await client.callTool({
        name: 'task_upsert',
        arguments: {
          title: 'Implement responsive grid',
          sessionId: sess1.id,
        },
      });

      // Update brief with sessionId and NO board -> must update frontend brief
      const feSnapBeforeBrief = await store.getSnapshot('frontend');
      await client.callTool({
        name: 'board_update_brief',
        arguments: {
          brief: '# Updated Frontend Brief\n',
          baseRevision: feSnapBeforeBrief.config.revision,
          sessionId: sess1.id,
        },
      });

      // Explicit board override still works even when sessionId is passed
      await client.callTool({
        name: 'decision_record',
        arguments: {
          board: 'main',
          title: 'Main platform decision',
          sessionId: sess1.id,
        },
      });

      const mainSnap = await store.getSnapshot('main');
      const feSnap = await store.getSnapshot('frontend');

      expect(mainSnap.decisions.map((d) => d.title)).toEqual(['Main platform decision']);
      expect(mainSnap.tasks).toHaveLength(0);

      expect(feSnap.decisions.map((d) => d.title)).toEqual(['Use CSS Grid for layout']);
      expect(feSnap.tasks.map((t) => t.title)).toEqual(['Implement responsive grid']);
      expect(feSnap.brief).toContain('# Updated Frontend Brief');
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });

  it('supports board parentBoard/paths via REST API and rejects hierarchy cycles', async () => {
    const dir = await makeTempDir();
    const store = new ContextDeckStore(dir);
    const { app, token, close } = createApp({ store, port: 4310 });
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    try {
      const r1 = await app.request('http://127.0.0.1:4310/api/boards', {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: 'Root', slug: 'root', paths: ['**'] }),
      });
      expect(r1.status).toBe(201);

      const r2 = await app.request('http://127.0.0.1:4310/api/boards', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: 'Child',
          slug: 'child',
          parentBoard: 'root',
          paths: ['packages/web/**'],
        }),
      });
      expect(r2.status).toBe(201);
      const child = (await r2.json()) as { parentBoard?: string; paths?: string[] };
      expect(child.parentBoard).toBe('root');
      expect(child.paths).toEqual(['packages/web/**']);

      // Setting root.parentBoard = 'child' must be rejected as a cycle
      const cycleRes = await app.request('http://127.0.0.1:4310/api/boards/root', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ parentBoard: 'child' }),
      });
      expect(cycleRes.status).toBe(400);
    } finally {
      await close();
    }
  });
});
