import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import {
  AckReaderCursorInputSchema,
  ActorSchema,
  ClaimJobInputSchema,
  CompleteJobInputSchema,
  ContextDeckError,
  ContextDeckStore,
  CreateBoardInputSchema,
  CreateQuizInputSchema,
  CreateRefreshJobInputSchema,
  MediaKindSchema,
  PatchTaskInputSchema,
  PayloadTooLargeError,
  RecordDecisionInputSchema,
  RefreshJobArtifactTypeSchema,
  RefreshJobStatusSchema,
  RegisterSessionInputSchema,
  ReleaseJobInputSchema,
  RenewJobInputSchema,
  RestAddMediaInputSchema,
  RestConfirmArtifactInputSchema,
  RestUpdateDiagramInputSchema,
  SubmitQuizAttemptInputSchema,
  SyncSessionInputSchema,
  UpdateBoardInputSchema,
  UpdateBriefInputSchema,
  UpdateDecisionPatchSchema,
  UpdateMediaPatchSchema,
  UpdateQuizPatchSchema,
  UpdateSessionPatchSchema,
  UpsertDiagramInputSchema,
  UpsertTaskInputSchema,
  ValidationError,
  generateContextPack,
  parseContextUpdatePayload,
  redactJobLease,
  redactJobsLeases,
  resolveDefaultReaderLabel,
  seedDemoBoard,
  validateBoardSlug,
  validateEntityId,
  type Actor,
  type MediaKind,
  type RefreshJobArtifactType,
  type RefreshJobStatus,
} from '@contextdeck/core';
import { createContextDeckMcpServer } from './mcp.js';
import { parseStreamingMultipartUpload } from './multipart.js';
import {
  DEFAULT_BOOTSTRAP_TTL_MS,
  JSON_BODY_LIMIT_BYTES,
  buildHostPolicy,
  ensureWorkspaceTokenSync,
  resolveMediaServePolicy,
  timingSafeStringEqual,
} from './security.js';

export interface AppOptions {
  store: ContextDeckStore;
  webDistDir?: string;
  host?: string;
  port?: number;
  allowRemote?: boolean;
  allowedHosts?: string[];
  bootstrapTtlMs?: number;
  maxMediaBytes?: number;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

type SseListener = (event: { type: string; boardSlug?: string | null; timestamp: string }) => void;

interface BrowserSession {
  id: string;
  csrfToken: string;
  createdAt: number;
}

interface AuthContext {
  kind: 'bearer' | 'cookie';
  session?: BrowserSession;
}

type AppVariables = {
  auth?: AuthContext;
};

// R3-1 / R4-1 defense-in-depth CSP for SPA HTML responses: blocks all remote
// subresource fetches (img/font/connect/script/style) while permitting inline styles
// (Mermaid/Excalidraw), inline scripts needed by inherited-CSP srcdoc HTML artifacts,
// and https: media-src for explicit external video/audio artifacts. Only <video>/<audio>
// use media-src; the diagram sanitizer already forbids <video>/<audio>/<source> tags
// and src/poster attributes, so allowing https: media-src does not reopen R3-1.
export const WEB_UI_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

const STATIC_MIME_MAP: Record<string, string> = {
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
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

function guessStaticMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return STATIC_MIME_MAP[ext] ?? 'application/octet-stream';
}

function parseCookies(headerValue: string | undefined): Record<string, string> {
  if (!headerValue) return {};
  const out: Record<string, string> = {};
  for (const part of headerValue.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function readByteCountedJson(c: Context, maxBytes = JSON_BODY_LIMIT_BYTES): Promise<unknown> {
  const ct = (c.req.header('content-type') ?? '').toLowerCase();
  if (!ct.includes('application/json')) {
    throw new ContextDeckError(
      'Unsupported Content-Type: expected application/json.',
      'UNSUPPORTED_MEDIA_TYPE',
      415,
    );
  }

  const rawBody = c.req.raw.body;
  if (!rawBody) {
    throw new ValidationError('Empty JSON request body.');
  }

  const reader = rawBody.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new PayloadTooLargeError(`JSON payload exceeds limit of ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }

  const combined = Buffer.concat(chunks);
  const text = combined.toString('utf8');
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ValidationError(
      `Invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function parseBodyStrict<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
      .join('; ');
    throw new ValidationError(`Invalid request payload: ${msg}`);
  }
  return parsed.data;
}

export function createApp(options: AppOptions): {
  app: Hono<{ Variables: AppVariables }>;
  token: string;
  cookieName: string;
  mintBootstrapCode: () => string;
  broadcast: (type: string, boardSlug?: string | null) => void;
  close: () => Promise<void>;
} {
  const {
    store,
    webDistDir,
    host = '127.0.0.1',
    port,
    allowRemote = false,
    allowedHosts = [],
    bootstrapTtlMs = DEFAULT_BOOTSTRAP_TTL_MS,
    env,
    homeDir,
  } = options;
  const maxMediaBytes = options.maxMediaBytes ?? store.maxMediaBytes;

  // Validate Host/Origin policy immediately (fails fast if non-loopback without --allow-remote)
  const hostPolicy = buildHostPolicy({ host, port, allowRemote, allowedHosts });
  const token = ensureWorkspaceTokenSync(store.runtimeDir);
  const cookieName = `cdeck_sess_${port ?? 4310}`;

  const bootstrapCodes = new Map<string, { expiresAt: number }>();
  const browserSessions = new Map<string, BrowserSession>();

  const purgeExpiredCodes = () => {
    const now = Date.now();
    for (const [code, entry] of bootstrapCodes.entries()) {
      if (entry.expiresAt <= now) {
        bootstrapCodes.delete(code);
      }
    }
  };

  const mintBootstrapCode = (): string => {
    purgeExpiredCodes();
    const code = crypto.randomBytes(32).toString('hex');
    bootstrapCodes.set(code, { expiresAt: Date.now() + bootstrapTtlMs });
    return code;
  };

  const app = new Hono<{ Variables: AppVariables }>();
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

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    if (err instanceof ContextDeckError) {
      return c.json(
        {
          error: err.message,
          code: err.code,
          ...(err.details ?? {}),
        },
        err.statusCode as 400 | 401 | 403 | 404 | 409 | 413 | 415 | 500 | 503,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('not found') || message.includes('does not exist') ? 404 : 400;
    return c.json({ error: message }, status);
  });

  // 1. Global security headers + Host allowlist (AC2.1, AC2.2, D6, D8)
  app.use('*', async (c, next) => {
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');

    // Never trust X-Forwarded-Host / Forwarded — inspect Host directly (with URL host fallback for synthetic Request)
    const rawHost = (c.req.header('host') ?? new URL(c.req.url).host).trim().toLowerCase();
    if (!rawHost || !hostPolicy.allowedHosts.has(rawHost)) {
      return c.json({ error: 'Host not allowed' }, 421);
    }

    if (
      c.req.path.startsWith('/api/') ||
      c.req.path === '/auth' ||
      c.req.path === '/mcp'
    ) {
      c.header('Cache-Control', 'no-store');
    }

    await next();
  });

  // 2. Unauthenticated minimal health endpoint (Bug 4 / AC2.3)
  app.get('/api/health', (c) => {
    return c.json({
      ok: true,
      name: 'contextdeck',
    });
  });

  // 3. Single-use bootstrap code exchange -> HttpOnly SameSite=Strict port-scoped cookie (D8)
  app.get('/auth', (c) => {
    purgeExpiredCodes();
    const code = c.req.query('code') ?? '';
    const entry = code ? bootstrapCodes.get(code) : undefined;
    // Immediately delete on first lookup attempt to guarantee single-use
    if (code) bootstrapCodes.delete(code);

    if (!entry || entry.expiresAt <= Date.now()) {
      return c.text(
        'Invalid or expired launch code. Run `cdeck open` to generate a fresh launch URL.',
        401,
        {
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        },
      );
    }

    const sessionId = crypto.randomBytes(32).toString('hex');
    const csrfToken = crypto.randomBytes(32).toString('hex');
    browserSessions.set(sessionId, {
      id: sessionId,
      csrfToken,
      createdAt: Date.now(),
    });

    return new Response(null, {
      status: 302,
      headers: {
        Location: '/',
        'Set-Cookie': `${cookieName}=${sessionId}; HttpOnly; SameSite=Strict; Path=/`,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });

  // 4. Authentication + Origin + CSRF middleware for all /api/* and /mcp (AC2.3, AC2.4, D8)
  const authMiddleware = async (
    c: Context<{ Variables: AppVariables }>,
    next: () => Promise<void>,
  ) => {
    if (c.req.path === '/api/health') {
      await next();
      return;
    }

    const authHeader = c.req.header('authorization');
    if (authHeader !== undefined) {
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (!match || !timingSafeStringEqual(match[1].trim(), token)) {
        return c.json({ error: 'Invalid bearer token.' }, 401);
      }
      c.set('auth', { kind: 'bearer' });
      await next();
      return;
    }

    // Non-bearer request: check Origin and Sec-Fetch-Site strictly BEFORE cookie/auth (blocks cross-origin requests cleanly with 403)
    const origin = c.req.header('origin');
    if (origin !== undefined) {
      const hostHeader = (c.req.header('host') ?? new URL(c.req.url).host).trim().toLowerCase();
      const expectedOrigin = `http://${hostHeader}`;
      if (
        origin === 'null' ||
        origin.toLowerCase() !== expectedOrigin ||
        !hostPolicy.allowedOrigins.has(origin.toLowerCase())
      ) {
        return c.json({ error: 'Cross-origin request forbidden.' }, 403);
      }
    }

    const secFetchSite = c.req.header('sec-fetch-site')?.toLowerCase();
    if (secFetchSite === 'cross-site') {
      return c.json({ error: 'Cross-site request forbidden.' }, 403);
    }

    // Cookie session lookup
    const cookies = parseCookies(c.req.header('cookie'));
    const sessionId = cookies[cookieName];
    const session = sessionId ? browserSessions.get(sessionId) : undefined;
    if (!session) {
      return c.json(
        { error: 'Unauthorized. Open via launch URL or run `cdeck open`.' },
        401,
      );
    }

    // Cookie-authenticated mutations require X-CSRF-Token (D8)
    if (MUTATING_METHODS.has(c.req.method.toUpperCase())) {
      const providedCsrf = c.req.header('x-csrf-token') ?? '';
      if (!providedCsrf || !timingSafeStringEqual(providedCsrf, session.csrfToken)) {
        return c.json({ error: 'Missing or invalid X-CSRF-Token.' }, 403);
      }
    }

    c.set('auth', { kind: 'cookie', session });
    await next();
  };

  app.use('/api/*', authMiddleware);
  app.use('/mcp', authMiddleware);

  // 5. Streaming JSON body limit (1 MB) on JSON endpoints and /mcp (AC2.8, D5)
  const jsonBodyLimit = bodyLimit({
    maxSize: JSON_BODY_LIMIT_BYTES,
    onError: (c) => c.json({ error: 'Payload too large (1 MB JSON limit).' }, 413),
  });

  app.use('/api/*', async (c, next) => {
    const ct = (c.req.header('content-type') ?? '').toLowerCase();
    // Multipart uploads stream directly through busboy with maxMediaBytes cap (never buffered here)
    if (ct.includes('multipart/form-data')) {
      await next();
      return;
    }
    return jsonBodyLimit(c, next);
  });
  app.use('/mcp', jsonBodyLimit);

  // Token-authenticated endpoint for `cdeck open` to mint a fresh single-use launch code
  app.post('/api/auth/bootstrap', (c) => {
    const auth = c.get('auth');
    if (auth?.kind !== 'bearer') {
      return c.json({ error: 'Bearer token required to mint bootstrap codes.' }, 403);
    }
    const code = mintBootstrapCode();
    return c.json({
      code,
      path: `/auth?code=${code}`,
      expiresInSec: Math.floor(bootstrapTtlMs / 1000),
    });
  });

  // Cookie-authenticated session check returning CSRF token (D8)
  app.get('/api/session', (c) => {
    const auth = c.get('auth');
    if (auth?.kind !== 'cookie' || !auth.session) {
      return c.json({ error: 'Browser session cookie required.' }, 401);
    }
    return c.json({
      authenticated: true,
      csrfToken: auth.session.csrfToken,
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

  // Boards — GET is strictly read-only (no ensureDefaultBoard side effects!)
  app.get('/api/boards', async (c) => {
    const boards = await store.listBoards();
    const defaultBoard = boards.length > 0 ? await store.getDefaultBoardSlug() : null;
    return c.json({ defaultBoard, boards });
  });

  app.post('/api/boards', async (c) => {
    const body = parseBodyStrict(CreateBoardInputSchema, await readByteCountedJson(c));
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
    const slug = validateBoardSlug(c.req.param('slug'));
    const snapshot = await store.getSnapshot(slug);
    const includeAllEvents = c.req.query('events') === 'all';
    if (!includeAllEvents && snapshot.events.length > 200) {
      return c.json({
        ...snapshot,
        events: snapshot.events.slice(-200),
      });
    }
    return c.json(snapshot);
  });

  app.patch('/api/boards/:slug', async (c) => {
    const slug = validateBoardSlug(c.req.param('slug'));
    const { actor, ...patch } = parseBodyStrict(
      UpdateBoardInputSchema,
      await readByteCountedJson(c),
    );
    const updated = await store.updateBoard(slug, patch, actor ?? { type: 'human', label: 'web-ui' });
    broadcast('board.changed', slug);
    return c.json(updated);
  });

  app.get('/api/boards/:slug/context-pack', async (c) => {
    const slug = validateBoardSlug(c.req.param('slug'));
    const includeProtocol = c.req.query('protocol') !== 'false';
    const snapshot = await store.getSnapshot(slug);
    const markdown = generateContextPack(snapshot, { includeUpdateProtocol: includeProtocol });
    return c.json({ slug, revision: snapshot.config.revision, markdown });
  });

  app.post('/api/boards/:slug/apply-update', async (c) => {
    const slug = validateBoardSlug(c.req.param('slug'));
    const rawBody = (await readByteCountedJson(c)) as Record<string, unknown>;
    const raw =
      rawBody && typeof rawBody.raw === 'string' ? rawBody.raw : JSON.stringify(rawBody);
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
    const slug = validateBoardSlug(c.req.param('slug'));
    const body = parseBodyStrict(UpdateBriefInputSchema, await readByteCountedJson(c));
    const actor: Actor = body.actor ?? { type: 'human', label: 'web-ui' };
    const res = await store.updateBrief(slug, body.brief, actor, {
      baseRevision: body.baseRevision,
    });
    broadcast('board.changed', slug);
    return c.json(res);
  });

  // Sessions
  app.post('/api/boards/:slug/sessions', async (c) => {
    const slug = validateBoardSlug(c.req.param('slug'));
    const { actor, ...input } = parseBodyStrict(
      RegisterSessionInputSchema,
      await readByteCountedJson(c),
    );
    const session = await store.registerSession(slug, input, actor ?? { type: 'human', label: 'web-ui' });
    broadcast('board.changed', slug);
    return c.json(session, 201);
  });

  app.patch('/api/boards/:slug/sessions/:id', async (c) => {
    const slug = validateBoardSlug(c.req.param('slug'));
    const id = validateEntityId(c.req.param('id'), 'sessionId');
    const { actor, ...patch } = parseBodyStrict(
      UpdateSessionPatchSchema,
      await readByteCountedJson(c),
    );
    const session = await store.updateSession(slug, id, patch, actor ?? { type: 'human', label: 'web-ui' });
    broadcast('board.changed', slug);
    return c.json(session);
  });

  app.post('/api/boards/:slug/sessions/:id/sync', async (c) => {
    const slug = validateBoardSlug(c.req.param('slug'));
    const id = validateEntityId(c.req.param('id'), 'sessionId');
    let ackRevision: number | undefined;
    const ct = (c.req.header('content-type') ?? '').toLowerCase();
    if (ct.includes('application/json')) {
      const parsed = parseBodyStrict(SyncSessionInputSchema, await readByteCountedJson(c));
      ackRevision = parsed.ackRevision;
    }
    const res = await store.syncSession(slug, id, { ackRevision });
    broadcast('board.changed', slug);
    return c.json(res);
  });

  app.delete('/api/boards/:slug/sessions/:id', async (c) => {
    const slug = validateBoardSlug(c.req.param('slug'));
    const id = validateEntityId(c.req.param('id'), 'sessionId');
    await store.deleteSession(slug, id);
    broadcast('board.changed', slug);
    return c.json({ deleted: true });
  });

  // Decisions
  app.post('/api/boards/:slug/decisions', async (c) => {
    const slug = validateBoardSlug(c.req.param('slug'));
    const { actor, ...input } = parseBodyStrict(
      RecordDecisionInputSchema,
      await readByteCountedJson(c),
    );
    const decision = await store.recordDecision(slug, input, actor ?? { type: 'human', label: 'web-ui' });
    broadcast('board.changed', slug);
    return c.json(decision, 201);
  });

  app.patch('/api/boards/:slug/decisions/:id', async (c) => {
    const slug = validateBoardSlug(c.req.param('slug'));
    const id = validateEntityId(c.req.param('id'), 'decisionId');
    const { actor, ...patch } = parseBodyStrict(
      UpdateDecisionPatchSchema,
      await readByteCountedJson(c),
    );
    const decision = await store.updateDecision(slug, id, patch, actor ?? { type: 'human', label: 'web-ui' });
    broadcast('board.changed', slug);
    return c.json(decision);
  });

  // Tasks — PATCH uses locked store.patchTask (never read-outside-lock!)
  app.post('/api/boards/:slug/tasks', async (c) => {
    const slug = validateBoardSlug(c.req.param('slug'));
    const { actor, ...input } = parseBodyStrict(
      UpsertTaskInputSchema,
      await readByteCountedJson(c),
    );
    const task = await store.upsertTask(slug, input, actor ?? { type: 'human', label: 'web-ui' });
    broadcast('board.changed', slug);
    return c.json(task, 201);
  });

  app.patch('/api/boards/:slug/tasks/:id', async (c) => {
    const slug = validateBoardSlug(c.req.param('slug'));
    const id = validateEntityId(c.req.param('id'), 'taskId');
    const { actor, ...patch } = parseBodyStrict(
      PatchTaskInputSchema,
      await readByteCountedJson(c),
    );
    const task = await store.patchTask(slug, id, patch, actor ?? { type: 'human', label: 'web-ui' });
    broadcast('board.changed', slug);
    return c.json(task);
  });

  app.delete('/api/boards/:slug/tasks/:id', async (c) => {
    const slug = validateBoardSlug(c.req.param('slug'));
    const id = validateEntityId(c.req.param('id'), 'taskId');
    await store.deleteTask(slug, id);
    broadcast('board.changed', slug);
    return c.json({ deleted: true });
  });

  // Diagrams
  app.post('/api/boards/:slug/diagrams', async (c) => {
    const slug = validateBoardSlug(c.req.param('slug'));
    const { actor, ...input } = parseBodyStrict(
      UpsertDiagramInputSchema,
      await readByteCountedJson(c),
    );
    const diagram = await store.upsertDiagram(slug, input, actor ?? { type: 'human', label: 'web-ui' });
    broadcast('board.changed', slug);
    return c.json(diagram, 201);
  });

  app.put('/api/boards/:slug/diagrams/:id', async (c) => {
    const slug = validateBoardSlug(c.req.param('slug'));
    const id = validateEntityId(c.req.param('id'), 'diagramId');
    const { actor, ...input } = parseBodyStrict(
      RestUpdateDiagramInputSchema,
      await readByteCountedJson(c),
    );
    const diagram = await store.upsertDiagram(
      slug,
      { ...input, id },
      actor ?? { type: 'human', label: 'web-ui' },
    );
    broadcast('board.changed', slug);
    return c.json(diagram);
  });

  app.delete('/api/boards/:slug/diagrams/:id', async (c) => {
    const slug = validateBoardSlug(c.req.param('slug'));
    const id = validateEntityId(c.req.param('id'), 'diagramId');
    await store.deleteDiagram(slug, id);
    broadcast('board.changed', slug);
    return c.json({ deleted: true });
  });

  // Media (JSON without sourceFilePath, OR streaming busboy multipart upload with byte cap)
  app.post('/api/boards/:slug/media', async (c) => {
    const slug = validateBoardSlug(c.req.param('slug'));
    const contentType = (c.req.header('content-type') ?? '').toLowerCase();

    if (contentType.includes('multipart/form-data')) {
      const { mediaDir } = await store.createUploadTempFilePath(slug);
      const parsed = await parseStreamingMultipartUpload({
        request: c.req.raw,
        mediaDir,
        maxMediaBytes,
      });

      let title: string;
      let kind: MediaKind;
      let transcript: string | undefined;
      let basedOnDecisions: string[];
      let tags: string[];
      try {
        title = (parsed.fields.title || parsed.file?.fileName || 'Uploaded Media').slice(0, 300);
        const kindParsed = MediaKindSchema.safeParse(parsed.fields.kind || 'video');
        if (!kindParsed.success) {
          throw new ValidationError('Invalid media kind.');
        }
        kind = kindParsed.data;
        transcript = parsed.fields.transcript || undefined;
        basedOnDecisions = parsed.fields.basedOnDecisions
          ? parsed.fields.basedOnDecisions
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
              .map((id) => validateEntityId(id, 'decisionId'))
          : [];
        tags = parsed.fields.tags
          ? parsed.fields.tags
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
      } catch (err) {
        if (parsed.file?.tmpPath) {
          await fsp.rm(parsed.file.tmpPath, { force: true }).catch(() => {});
        }
        throw err;
      }

      // Ownership of parsed.file.tmpPath transfers to store.addMedia (H2):
      // addMedia removes it on error ONLY if txn.json was not yet committed.
      const media = await store.addMedia(
        slug,
        {
          title,
          kind,
          stagedTempPath: parsed.file?.tmpPath,
          fileName: parsed.file?.fileName,
          mimeType: parsed.file?.mimeType,
          transcript,
          basedOnDecisions,
          tags,
          maxBytes: maxMediaBytes,
        },
        { type: 'human', label: 'web-ui' },
      );
      broadcast('board.changed', slug);
      return c.json(media, 201);
    }

    // Strict REST schema: sourceFilePath is completely removed!
    const { actor, ...input } = parseBodyStrict(
      RestAddMediaInputSchema,
      await readByteCountedJson(c),
    );
    const media = await store.addMedia(slug, input, actor ?? { type: 'human', label: 'web-ui' });
    broadcast('board.changed', slug);
    return c.json(media, 201);
  });

  app.patch('/api/boards/:slug/media/:id', async (c) => {
    const slug = validateBoardSlug(c.req.param('slug'));
    const id = validateEntityId(c.req.param('id'), 'mediaId');
    const contentType = (c.req.header('content-type') ?? '').toLowerCase();

    if (contentType.includes('multipart/form-data')) {
      const { mediaDir } = await store.createUploadTempFilePath(slug);
      const parsed = await parseStreamingMultipartUpload({
        request: c.req.raw,
        mediaDir,
        maxMediaBytes,
      });

      let title: string | undefined;
      let transcript: string | undefined;
      let basedOnDecisions: string[] | undefined;
      let tags: string[] | undefined;
      let jobId: string | undefined;
      let leaseToken: string | undefined;
      let note: string | undefined;
      let bodyActor: Actor | undefined;
      try {
        title = parsed.fields.title?.trim() ? parsed.fields.title.trim().slice(0, 300) : undefined;
        transcript = parsed.fields.transcript !== undefined ? parsed.fields.transcript : undefined;
        basedOnDecisions = parsed.fields.basedOnDecisions
          ? parsed.fields.basedOnDecisions
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
              .map((decId) => validateEntityId(decId, 'decisionId'))
          : undefined;
        tags = parsed.fields.tags
          ? parsed.fields.tags
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined;
        jobId = parsed.fields.jobId?.trim()
          ? validateEntityId(parsed.fields.jobId.trim(), 'jobId')
          : undefined;
        leaseToken = parsed.fields.leaseToken?.trim()
          ? parsed.fields.leaseToken.trim().slice(0, 128)
          : undefined;
        note = parsed.fields.note?.trim() ? parsed.fields.note.trim().slice(0, 500) : undefined;
        if (parsed.fields.actor?.trim()) {
          let rawActor: unknown;
          try {
            rawActor = JSON.parse(parsed.fields.actor);
          } catch {
            throw new ValidationError('Invalid actor JSON field.');
          }
          bodyActor = parseBodyStrict(ActorSchema, rawActor);
        }
      } catch (err) {
        if (parsed.file?.tmpPath) {
          await fsp.rm(parsed.file.tmpPath, { force: true }).catch(() => {});
        }
        throw err;
      }

      // H19 / Claude N3: Cookie auth (browser) records human actor; bearer auth defaults to agent actor.
      const auth = c.get('auth');
      const defaultHumanLabel = resolveDefaultReaderLabel({ projectRoot: store.projectRoot });
      const actor: Actor =
        auth?.kind === 'cookie'
          ? { type: 'human', label: bodyActor?.label || defaultHumanLabel }
          : bodyActor ?? { type: 'agent', label: 'api-bearer' };

      const media = await store.updateMedia(
        slug,
        id,
        {
          ...(title !== undefined ? { title } : {}),
          ...(transcript !== undefined ? { transcript } : {}),
          ...(basedOnDecisions !== undefined ? { basedOnDecisions } : {}),
          ...(tags !== undefined ? { tags } : {}),
          ...(jobId !== undefined ? { jobId } : {}),
          ...(leaseToken !== undefined ? { leaseToken } : {}),
          ...(note !== undefined ? { note } : {}),
          ...(parsed.file
            ? {
                stagedTempPath: parsed.file.tmpPath,
                fileName: parsed.file.fileName,
                mimeType: parsed.file.mimeType,
              }
            : {}),
          maxBytes: maxMediaBytes,
        },
        actor,
      );
      broadcast('board.changed', slug);
      return c.json(media);
    }

    const { actor, ...patch } = parseBodyStrict(
      UpdateMediaPatchSchema,
      await readByteCountedJson(c),
    );
    const media = await store.updateMedia(slug, id, patch, actor ?? { type: 'human', label: 'web-ui' });
    broadcast('board.changed', slug);
    return c.json(media);
  });

  app.delete('/api/boards/:slug/media/:id', async (c) => {
    const slug = validateBoardSlug(c.req.param('slug'));
    const id = validateEntityId(c.req.param('id'), 'mediaId');
    await store.deleteMedia(slug, id);
    broadcast('board.changed', slug);
    return c.json({ deleted: true });
  });

  // Range-capable binary streaming with server-controlled MIME allowlist, nosniff, and sandbox CSP (AC2.7, D5)
  app.get('/api/boards/:slug/media/:id/file', async (c) => {
    const slug = validateBoardSlug(c.req.param('slug'));
    const id = validateEntityId(c.req.param('id'), 'mediaId');
    const resolved = await store.resolveMediaFilePath(slug, id);
    if (!resolved) {
      return c.json({ error: 'Media file not found' }, 404);
    }

    const stat = await fsp.stat(resolved.absolutePath);
    const totalSize = stat.size;
    // Server-controlled MIME allowlist by extension ONLY (ignore artifact.mimeType!)
    const servePolicy = resolveMediaServePolicy(resolved.absolutePath);

    const commonHeaders: Record<string, string> = {
      'Content-Type': servePolicy.contentType,
      'Content-Disposition': servePolicy.contentDisposition,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    };

    const range = c.req.header('range');
    if (range) {
      const match = range.match(/^bytes=(\d+)-(\d*)$/);
      if (match) {
        const start = Number.parseInt(match[1], 10);
        const end = match[2]
          ? Math.min(Number.parseInt(match[2], 10), totalSize - 1)
          : totalSize - 1;
        if (totalSize === 0 || start >= totalSize || start > end) {
          return new Response(null, {
            status: 416,
            headers: {
              ...commonHeaders,
              'Content-Range': `bytes */${totalSize}`,
            },
          });
        }
        const chunkSize = end - start + 1;
        const stream = fs.createReadStream(resolved.absolutePath, { start, end });
        const webStream = Readable.toWeb(stream) as ReadableStream;
        return new Response(webStream, {
          status: 206,
          headers: {
            ...commonHeaders,
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(chunkSize),
          },
        });
      }
    }

    const stream = fs.createReadStream(resolved.absolutePath);
    const webStream = Readable.toWeb(stream) as ReadableStream;
    return new Response(webStream, {
      status: 200,
      headers: {
        ...commonHeaders,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(totalSize),
      },
    });
  });

  // Quizzes
  app.post('/api/boards/:slug/quizzes', async (c) => {
    const slug = validateBoardSlug(c.req.param('slug'));
    const { actor, ...input } = parseBodyStrict(
      CreateQuizInputSchema,
      await readByteCountedJson(c),
    );
    const quiz = await store.createQuiz(slug, input, actor ?? { type: 'human', label: 'web-ui' });
    broadcast('board.changed', slug);
    return c.json(quiz, 201);
  });

  app.patch('/api/boards/:slug/quizzes/:id', async (c) => {
    const slug = validateBoardSlug(c.req.param('slug'));
    const id = validateEntityId(c.req.param('id'), 'quizId');
    const { actor, ...patch } = parseBodyStrict(
      UpdateQuizPatchSchema,
      await readByteCountedJson(c),
    );
    const quiz = await store.updateQuiz(slug, id, patch, actor ?? { type: 'human', label: 'web-ui' });
    broadcast('board.changed', slug);
    return c.json(quiz);
  });

  app.post('/api/boards/:slug/quizzes/:id/attempts', async (c) => {
    const slug = validateBoardSlug(c.req.param('slug'));
    const id = validateEntityId(c.req.param('id'), 'quizId');
    const { actor, ...input } = parseBodyStrict(
      SubmitQuizAttemptInputSchema,
      await readByteCountedJson(c),
    );
    const res = await store.submitQuizAttempt(slug, id, input, actor ?? { type: 'human', label: 'web-ui' });
    broadcast('board.changed', slug);
    return c.json(res, 201);
  });

  // Catch up & reader cursor (AC7.1, AC7.2, D16 — never appends events.jsonl)
  app.get('/api/boards/:slug/catchup', async (c) => {
    const slug = validateBoardSlug(c.req.param('slug'));
    const rawReaderId = c.req.query('readerId');
    const readerId = rawReaderId ? validateEntityId(rawReaderId, 'readerId') : undefined;
    const report = await store.getCatchUp(slug, { readerId });
    return c.json(report);
  });

  app.post('/api/boards/:slug/reader/ack', async (c) => {
    const slug = validateBoardSlug(c.req.param('slug'));
    const body = parseBodyStrict(AckReaderCursorInputSchema, await readByteCountedJson(c));
    const cursor = await store.ackReaderCursor(slug, body.revision, {
      readerId: body.readerId,
      reviewedAt: body.reviewedAt,
    });
    const catchUp = await store.getCatchUp(slug, { readerId: body.readerId });
    return c.json({ cursor, catchUp });
  });

  // Human confirmation for stale artifact (AC7.3, D14, D17, H9, H10; old /refresh removed!)
  app.post('/api/boards/:slug/artifacts/:type/:id/confirm', async (c) => {
    const slug = validateBoardSlug(c.req.param('slug'));
    const rawType = c.req.param('type');
    const parsedType = RefreshJobArtifactTypeSchema.safeParse(rawType);
    if (!parsedType.success) {
      throw new ValidationError(
        `Invalid artifact type "${rawType}". Only diagram, media, and quiz can be confirmed (tasks are not refresh targets).`,
      );
    }
    const id = validateEntityId(c.req.param('id'), 'artifactId');
    const rawBody = await readByteCountedJson(c);
    const { actor: bodyActor, ...input } = parseBodyStrict(RestConfirmArtifactInputSchema, rawBody);
    const auth = c.get('auth');
    const defaultHumanLabel = resolveDefaultReaderLabel({ projectRoot: store.projectRoot });
    const actor: Actor =
      auth?.kind === 'cookie'
        ? { type: 'human', label: bodyActor?.label || defaultHumanLabel }
        : bodyActor ?? { type: 'human', label: defaultHumanLabel };
    const updated = await store.confirmArtifact(slug, parsedType.data, id, input, actor);
    broadcast('board.changed', slug);
    return c.json(updated);
  });

  // Refresh jobs (AC7.4, D19)
  app.get('/api/boards/:slug/jobs', async (c) => {
    const slug = validateBoardSlug(c.req.param('slug'));
    const rawStatus = c.req.query('status');
    const rawType = c.req.query('artifactType');
    let status: RefreshJobStatus | undefined;
    let artifactType: RefreshJobArtifactType | undefined;
    if (rawStatus) {
      const parsed = RefreshJobStatusSchema.safeParse(rawStatus);
      if (!parsed.success) throw new ValidationError(`Invalid job status "${rawStatus}".`);
      status = parsed.data;
    }
    if (rawType) {
      const parsed = RefreshJobArtifactTypeSchema.safeParse(rawType);
      if (!parsed.success) throw new ValidationError(`Invalid artifactType "${rawType}".`);
      artifactType = parsed.data;
    }
    const jobs = await store.listJobs(slug, { status, artifactType });
    return c.json({ jobs: redactJobsLeases(jobs) });
  });

  app.post('/api/boards/:slug/jobs', async (c) => {
    const slug = validateBoardSlug(c.req.param('slug'));
    const { actor, ...input } = parseBodyStrict(
      CreateRefreshJobInputSchema,
      await readByteCountedJson(c),
    );
    const res = await store.createRefreshJob(slug, input, actor ?? { type: 'human', label: 'web-ui' });
    if (!res.deduplicated) {
      broadcast('board.changed', slug);
    }
    return c.json(
      { job: redactJobLease(res.job), deduplicated: res.deduplicated },
      res.deduplicated ? 200 : 201,
    );
  });

  app.post('/api/boards/:slug/jobs/:id/claim', async (c) => {
    const slug = validateBoardSlug(c.req.param('slug'));
    const id = validateEntityId(c.req.param('id'), 'jobId');
    const { actor, ...input } = parseBodyStrict(
      ClaimJobInputSchema.omit({ jobId: true }),
      await readByteCountedJson(c),
    );
    const claimed = await store.claimJob(
      slug,
      { ...input, jobId: id },
      actor ?? { type: 'agent', label: input.claimedBy },
    );
    broadcast('board.changed', slug);
    return c.json(claimed);
  });

  app.post('/api/boards/:slug/jobs/:id/renew', async (c) => {
    const slug = validateBoardSlug(c.req.param('slug'));
    const id = validateEntityId(c.req.param('id'), 'jobId');
    const { actor, ...input } = parseBodyStrict(
      RenewJobInputSchema,
      await readByteCountedJson(c),
    );
    const renewed = await store.renewJob(slug, id, input, actor ?? { type: 'agent', label: 'worker' });
    return c.json(renewed);
  });

  app.post('/api/boards/:slug/jobs/:id/release', async (c) => {
    const slug = validateBoardSlug(c.req.param('slug'));
    const id = validateEntityId(c.req.param('id'), 'jobId');
    const { actor, ...input } = parseBodyStrict(
      ReleaseJobInputSchema,
      await readByteCountedJson(c),
    );
    const released = await store.releaseJob(slug, id, input, actor ?? { type: 'agent', label: 'worker' });
    broadcast('board.changed', slug);
    return c.json(redactJobLease(released));
  });

  app.post('/api/boards/:slug/jobs/:id/complete', async (c) => {
    const slug = validateBoardSlug(c.req.param('slug'));
    const id = validateEntityId(c.req.param('id'), 'jobId');
    const { actor, ...input } = parseBodyStrict(
      CompleteJobInputSchema,
      await readByteCountedJson(c),
    );
    const completed = await store.completeJob(slug, id, input, actor ?? { type: 'agent', label: 'worker' });
    broadcast('board.changed', slug);
    return c.json(redactJobLease(completed));
  });

  // Streamable HTTP MCP Endpoint (/mcp) — authenticated by authMiddleware
  app.all('/mcp', async (c) => {
    const mcpServer = createContextDeckMcpServer(store, {
      onMutate: (slug) => broadcast('board.changed', slug),
      env,
      homeDir,
      maxMediaBytes,
      enableResourceSubscriptions: false,
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await mcpServer.connect(transport);
    try {
      const rawRes = await transport.handleRequest(c.req.raw);
      const headers = new Headers(rawRes.headers);
      headers.set('Cache-Control', 'no-store');
      headers.set('Referrer-Policy', 'no-referrer');
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(rawRes.body, {
        status: rawRes.status,
        statusText: rawRes.statusText,
        headers,
      });
    } finally {
      await transport.close();
      await mcpServer.close();
    }
  });

  // Static built Web UI (when served in production / CLI mode)
  if (webDistDir && fs.existsSync(webDistDir)) {
    const resolvedDist = fs.realpathSync(webDistDir);
    app.get('*', async (c) => {
      const reqPath = c.req.path === '/' ? '/index.html' : c.req.path;
      const safePath = path.normalize(reqPath).replace(/^(\.\.(\/|\\|$))+/, '');
      const candidate = path.resolve(resolvedDist, `.${safePath.startsWith('/') ? safePath : `/${safePath}`}`);
      const insideDist =
        candidate === resolvedDist || candidate.startsWith(`${resolvedDist}${path.sep}`);
      const target =
        insideDist && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
          ? candidate
          : path.join(resolvedDist, 'index.html');
      const data = await fsp.readFile(target);
      const contentType = guessStaticMime(target);
      const headers: Record<string, string> = {
        'Content-Type': contentType,
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      };
      if (contentType.startsWith('text/html')) {
        headers['Content-Security-Policy'] = WEB_UI_CSP;
      }
      return new Response(data, {
        status: 200,
        headers,
      });
    });
  }

  return {
    app,
    token,
    cookieName,
    mintBootstrapCode,
    broadcast,
    close: async () => {
      if (watcher) await watcher.close();
    },
  };
}
