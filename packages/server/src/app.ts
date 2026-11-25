import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  ContextDeckStore,
  generateContextPack,
  parseContextUpdatePayload,
  seedDemoBoard,
  type Actor,
  type MediaKind,
} from '@contextdeck/core';
import { createContextDeckMcpServer } from './mcp.js';

export interface AppOptions {
  store: ContextDeckStore;
  webDistDir?: string;
}

type SseListener = (event: { type: string; boardSlug?: string | null; timestamp: string }) => void;

const MIME_MAP: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

function guessMime(filePath: string, fallback = 'application/octet-stream'): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? fallback;
}

export function createApp(options: AppOptions): {
  app: Hono;
  broadcast: (type: string, boardSlug?: string | null) => void;
  close: () => Promise<void>;
} {
  const { store, webDistDir } = options;
  const app = new Hono();
  const listeners = new Set<SseListener>();

  const broadcast = (type: string, boardSlug?: string | null) => {
    const payload = { type, boardSlug: boardSlug ?? null, timestamp: new Date().toISOString() };
    for (const listener of listeners) {
      listener(payload);
    }
  };

  const watcher = store.isInitialized()
    ? store.watch((slug) => {
        broadcast('board.changed', slug);
      })
    : null;

  app.use('*', cors());

  app.onError((err, c) => {
    const status = err.message.includes('not found') || err.message.includes('does not exist') ? 404 : 400;
    return c.json({ error: err.message }, status);
  });

  app.get('/api/health', async (c) => {
    const boards = await store.listBoards();
    return c.json({
      ok: true,
      name: 'contextdeck',
      version: '0.1.0',
      rootDir: store.rootDir,
      boardCount: boards.length,
    });
  });

  // Live SSE stream for real-time UI updates
  app.get('/api/events', (c) => {
    return streamSSE(c, async (stream) => {
      const listener: SseListener = (evt) => {
        void stream.writeSSE({
          event: evt.type,
          data: JSON.stringify(evt),
        });
      };
      listeners.add(listener);
      await stream.writeSSE({
        event: 'connected',
        data: JSON.stringify({ timestamp: new Date().toISOString() }),
      });

      const keepAlive = setInterval(() => {
        void stream.writeSSE({ event: 'ping', data: '{}' });
      }, 20000);

      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          clearInterval(keepAlive);
          listeners.delete(listener);
          resolve();
        });
      });
    });
  });

  // Boards
  app.get('/api/boards', async (c) => {
    await store.ensureDefaultBoard();
    const [boards, defaultBoard] = await Promise.all([
      store.listBoards(),
      store.getDefaultBoardSlug(),
    ]);
    return c.json({ defaultBoard, boards });
  });

  app.post('/api/boards', async (c) => {
    const body = await c.req.json();
    const board = await store.createBoard(body, { type: 'human', label: 'web-ui' });
    broadcast('board.created', board.slug);
    return c.json(board, 201);
  });

  app.post('/api/boards/demo', async (c) => {
    const slug = await seedDemoBoard(store);
    broadcast('board.created', slug);
    const snapshot = await store.getSnapshot(slug);
    return c.json(snapshot, 201);
  });

  app.get('/api/boards/:slug', async (c) => {
    const slug = c.req.param('slug');
    const snapshot = await store.getSnapshot(slug);
    return c.json(snapshot);
  });

  app.get('/api/boards/:slug/context-pack', async (c) => {
    const slug = c.req.param('slug');
    const includeProtocol = c.req.query('protocol') !== 'false';
    const snapshot = await store.getSnapshot(slug);
    const markdown = generateContextPack(snapshot, { includeUpdateProtocol: includeProtocol });
    return c.json({ slug, revision: snapshot.config.revision, markdown });
  });

  app.post('/api/boards/:slug/apply-update', async (c) => {
    const slug = c.req.param('slug');
    const body = await c.req.json();
    const raw = typeof body.raw === 'string' ? body.raw : JSON.stringify(body);
    const parsed = parseContextUpdatePayload(raw);
    const result = await store.applyContextUpdate(slug, parsed, {
      type: 'agent',
      harness: parsed.harness ?? 'web-chat',
      label: 'context-pack-import',
    });
    broadcast('board.changed', slug);
    return c.json(result);
  });

  // Brief
  app.put('/api/boards/:slug/brief', async (c) => {
    const slug = c.req.param('slug');
    const body = await c.req.json();
    const actor: Actor = body.actor ?? { type: 'human', label: 'web-ui' };
    const res = await store.updateBrief(slug, String(body.brief ?? ''), actor);
    broadcast('board.changed', slug);
    return c.json(res);
  });

  // Sessions
  app.post('/api/boards/:slug/sessions', async (c) => {
    const slug = c.req.param('slug');
    const body = await c.req.json();
    const session = await store.registerSession(slug, body, body.actor ?? { type: 'human', label: 'web-ui' });
    broadcast('board.changed', slug);
    return c.json(session, 201);
  });

  app.patch('/api/boards/:slug/sessions/:id', async (c) => {
    const slug = c.req.param('slug');
    const id = c.req.param('id');
    const body = await c.req.json();
    const session = await store.updateSession(slug, id, body, body.actor ?? { type: 'human', label: 'web-ui' });
    broadcast('board.changed', slug);
    return c.json(session);
  });

  app.post('/api/boards/:slug/sessions/:id/sync', async (c) => {
    const slug = c.req.param('slug');
    const id = c.req.param('id');
    const res = await store.syncSession(slug, id);
    broadcast('board.changed', slug);
    return c.json(res);
  });

  app.delete('/api/boards/:slug/sessions/:id', async (c) => {
    const slug = c.req.param('slug');
    const id = c.req.param('id');
    await store.deleteSession(slug, id);
    broadcast('board.changed', slug);
    return c.json({ deleted: true });
  });

  // Decisions
  app.post('/api/boards/:slug/decisions', async (c) => {
    const slug = c.req.param('slug');
    const body = await c.req.json();
    const decision = await store.recordDecision(slug, body, body.actor ?? { type: 'human', label: 'web-ui' });
    broadcast('board.changed', slug);
    return c.json(decision, 201);
  });

  app.patch('/api/boards/:slug/decisions/:id', async (c) => {
    const slug = c.req.param('slug');
    const id = c.req.param('id');
    const body = await c.req.json();
    const decision = await store.updateDecision(slug, id, body, body.actor ?? { type: 'human', label: 'web-ui' });
    broadcast('board.changed', slug);
    return c.json(decision);
  });

  // Tasks
  app.post('/api/boards/:slug/tasks', async (c) => {
    const slug = c.req.param('slug');
    const body = await c.req.json();
    const task = await store.upsertTask(slug, body, body.actor ?? { type: 'human', label: 'web-ui' });
    broadcast('board.changed', slug);
    return c.json(task, 201);
  });

  app.patch('/api/boards/:slug/tasks/:id', async (c) => {
    const slug = c.req.param('slug');
    const id = c.req.param('id');
    const body = await c.req.json();
    const existingList = await store.listTasks(slug);
    const existing = existingList.find((t) => t.id === id);
    if (!existing) {
      return c.json({ error: `Task "${id}" not found` }, 404);
    }
    const task = await store.upsertTask(
      slug,
      { ...existing, ...body, id },
      body.actor ?? { type: 'human', label: 'web-ui' },
    );
    broadcast('board.changed', slug);
    return c.json(task);
  });

  app.delete('/api/boards/:slug/tasks/:id', async (c) => {
    const slug = c.req.param('slug');
    const id = c.req.param('id');
    await store.deleteTask(slug, id);
    broadcast('board.changed', slug);
    return c.json({ deleted: true });
  });

  // Diagrams
  app.post('/api/boards/:slug/diagrams', async (c) => {
    const slug = c.req.param('slug');
    const body = await c.req.json();
    const diagram = await store.upsertDiagram(slug, body, body.actor ?? { type: 'human', label: 'web-ui' });
    broadcast('board.changed', slug);
    return c.json(diagram, 201);
  });

  app.put('/api/boards/:slug/diagrams/:id', async (c) => {
    const slug = c.req.param('slug');
    const id = c.req.param('id');
    const body = await c.req.json();
    const diagram = await store.upsertDiagram(
      slug,
      { ...body, id },
      body.actor ?? { type: 'human', label: 'web-ui' },
    );
    broadcast('board.changed', slug);
    return c.json(diagram);
  });

  app.delete('/api/boards/:slug/diagrams/:id', async (c) => {
    const slug = c.req.param('slug');
    const id = c.req.param('id');
    await store.deleteDiagram(slug, id);
    broadcast('board.changed', slug);
    return c.json({ deleted: true });
  });

  // Media (JSON or multipart file upload)
  app.post('/api/boards/:slug/media', async (c) => {
    const slug = c.req.param('slug');
    const contentType = c.req.header('content-type') ?? '';
    if (contentType.includes('multipart/form-data')) {
      const form = await c.req.formData();
      const file = form.get('file');
      const title = String(form.get('title') ?? (file instanceof File ? file.name : 'Uploaded Media'));
      const kind = String(form.get('kind') ?? 'video') as MediaKind;
      const transcript = form.get('transcript') ? String(form.get('transcript')) : undefined;
      const basedOnRaw = form.get('basedOnDecisions') ? String(form.get('basedOnDecisions')) : '';
      const basedOnDecisions = basedOnRaw
        ? basedOnRaw.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
      const tagsRaw = form.get('tags') ? String(form.get('tags')) : '';
      const tags = tagsRaw ? tagsRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];

      let fileBuffer: Buffer | undefined;
      let fileName: string | undefined;
      let mimeType: string | undefined;
      if (file instanceof File) {
        fileBuffer = Buffer.from(await file.arrayBuffer());
        fileName = file.name;
        mimeType = file.type || guessMime(file.name);
      }

      const media = await store.addMedia(
        slug,
        { title, kind, fileBuffer, fileName, mimeType, transcript, basedOnDecisions, tags },
        { type: 'human', label: 'web-ui' },
      );
      broadcast('board.changed', slug);
      return c.json(media, 201);
    }

    const body = await c.req.json();
    const media = await store.addMedia(slug, body, body.actor ?? { type: 'human', label: 'web-ui' });
    broadcast('board.changed', slug);
    return c.json(media, 201);
  });

  app.patch('/api/boards/:slug/media/:id', async (c) => {
    const slug = c.req.param('slug');
    const id = c.req.param('id');
    const body = await c.req.json();
    const media = await store.updateMedia(slug, id, body, body.actor ?? { type: 'human', label: 'web-ui' });
    broadcast('board.changed', slug);
    return c.json(media);
  });

  app.delete('/api/boards/:slug/media/:id', async (c) => {
    const slug = c.req.param('slug');
    const id = c.req.param('id');
    await store.deleteMedia(slug, id);
    broadcast('board.changed', slug);
    return c.json({ deleted: true });
  });

  // Range-capable binary streaming for video/audio media
  app.get('/api/boards/:slug/media/:id/file', async (c) => {
    const slug = c.req.param('slug');
    const id = c.req.param('id');
    const resolved = await store.resolveMediaFilePath(slug, id);
    if (!resolved) {
      return c.json({ error: 'Media file not found' }, 404);
    }

    const stat = await fsp.stat(resolved.absolutePath);
    const totalSize = stat.size;
    const mimeType = resolved.artifact.mimeType || guessMime(resolved.absolutePath);
    const range = c.req.header('range');

    if (range) {
      const match = range.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = Number.parseInt(match[1], 10);
        const end = match[2] ? Math.min(Number.parseInt(match[2], 10), totalSize - 1) : totalSize - 1;
        const chunkSize = end - start + 1;
        const stream = fs.createReadStream(resolved.absolutePath, { start, end });
        const webStream = Readable.toWeb(stream) as ReadableStream;
        return new Response(webStream, {
          status: 206,
          headers: {
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(chunkSize),
            'Content-Type': mimeType,
          },
        });
      }
    }

    const stream = fs.createReadStream(resolved.absolutePath);
    const webStream = Readable.toWeb(stream) as ReadableStream;
    return new Response(webStream, {
      status: 200,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Length': String(totalSize),
        'Content-Type': mimeType,
      },
    });
  });

  // Quizzes
  app.post('/api/boards/:slug/quizzes', async (c) => {
    const slug = c.req.param('slug');
    const body = await c.req.json();
    const quiz = await store.createQuiz(slug, body, body.actor ?? { type: 'human', label: 'web-ui' });
    broadcast('board.changed', slug);
    return c.json(quiz, 201);
  });

  app.post('/api/boards/:slug/quizzes/:id/attempts', async (c) => {
    const slug = c.req.param('slug');
    const id = c.req.param('id');
    const body = await c.req.json();
    const res = await store.submitQuizAttempt(slug, id, body);
    broadcast('board.changed', slug);
    return c.json(res, 201);
  });

  // Refresh stale artifact
  app.post('/api/boards/:slug/artifacts/:type/:id/refresh', async (c) => {
    const slug = c.req.param('slug');
    const type = c.req.param('type') as 'diagram' | 'media' | 'quiz' | 'task';
    const id = c.req.param('id');
    await store.refreshArtifactDecisions(slug, type, id, { type: 'human', label: 'web-ui' });
    broadcast('board.changed', slug);
    return c.json({ refreshed: true });
  });

  // Streamable HTTP MCP Endpoint (/mcp) — stateless per-request for zero-friction multi-client compatibility
  app.all('/mcp', async (c) => {
    const mcpServer = createContextDeckMcpServer(store, undefined, (slug) => {
      broadcast('board.changed', slug);
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await mcpServer.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await transport.close();
      await mcpServer.close();
    }
  });

  // Static built Web UI (when served in production / CLI mode)
  if (webDistDir && fs.existsSync(webDistDir)) {
    app.get('*', async (c) => {
      const reqPath = c.req.path === '/' ? '/index.html' : c.req.path;
      const safePath = path.normalize(reqPath).replace(/^(\.\.(\/|\\|$))+/, '');
      const candidate = path.join(webDistDir, safePath);
      const target =
        fs.existsSync(candidate) && fs.statSync(candidate).isFile()
          ? candidate
          : path.join(webDistDir, 'index.html');
      const data = await fsp.readFile(target);
      return new Response(data, {
        status: 200,
        headers: { 'Content-Type': guessMime(target) },
      });
    });
  }

  return {
    app,
    broadcast,
    close: async () => {
      if (watcher) await watcher.close();
    },
  };
}
