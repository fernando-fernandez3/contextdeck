import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextDeckStore, seedDemoBoard } from '@contextdeck/core';
import { buildHostPolicy, createApp, startServer } from '../src/index.js';

const tmpDirs: string[] = [];

async function makeTempDir(prefix = 'cdeck-sec-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    await fs.rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('E2 Server & MCP security (reproducing Bugs 2, 3, 4, 7-media, 8 + D5/D6/D8)', () => {
  it('reproduces Bug 4: /api/health returns only {ok,name} without rootDir or CORS header', async () => {
    const dir = await makeTempDir();
    const store = new ContextDeckStore(dir);
    await seedDemoBoard(store, 'demo');
    const { app, close } = createApp({ store, port: 4310 });

    try {
      const res = await app.request('http://127.0.0.1:4310/api/health', {
        headers: { Origin: 'https://evil.example' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      const body = await res.json();
      expect(body).toEqual({ ok: true, name: 'contextdeck' });
      expect(body.rootDir).toBeUndefined();
      expect(body.boardCount).toBeUndefined();
    } finally {
      await close();
    }
  });

  it('reproduces Bug 2: cross-origin text/plain POST with sourceFilePath and cross-origin GET are blocked', async () => {
    const dir = await makeTempDir();
    const outside = await makeTempDir('cdeck-secret-');
    const secretFile = path.join(outside, 'secret.txt');
    await fs.writeFile(secretFile, 'SUPER_SECRET_DATA', 'utf8');

    const store = new ContextDeckStore(dir);
    await seedDemoBoard(store, 'demo');
    const { app, token, close } = createApp({ store, port: 4310 });

    try {
      // Exact Bug 2 repro: cross-origin text/plain POST
      const evilPost = await app.request('http://127.0.0.1:4310/api/boards/demo/media', {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          Origin: 'https://evil.example',
        },
        body: JSON.stringify({ title: 'x', kind: 'doc', sourceFilePath: secretFile }),
      });
      expect(evilPost.status).toBe(403);
      expect(evilPost.headers.get('access-control-allow-origin')).toBeNull();

      // Even authenticated REST must NOT accept sourceFilePath (removed from REST)
      const authPost = await app.request('http://127.0.0.1:4310/api/boards/demo/media', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title: 'x', kind: 'doc', sourceFilePath: secretFile }),
      });
      expect(authPost.status).toBe(400);

      // Cross-origin GET of an existing media file is blocked and has no ACAO
      const snap = await store.getSnapshot('demo');
      const mediaId = snap.media[0].id;
      const evilGet = await app.request(
        `http://127.0.0.1:4310/api/boards/demo/media/${mediaId}/file`,
        {
          headers: { Origin: 'https://evil.example' },
        },
      );
      expect([401, 403]).toContain(evilGet.status);
      expect(evilGet.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await close();
    }
  });

  it('reproduces Bug 3: DELETE /api/boards/demo/sessions/..%2Fboard is rejected and board.yaml survives', async () => {
    const dir = await makeTempDir();
    const store = new ContextDeckStore(dir);
    await seedDemoBoard(store, 'demo');
    const { app, token, close } = createApp({ store, port: 4310 });

    try {
      const res = await app.request('http://127.0.0.1:4310/api/boards/demo/sessions/..%2Fboard', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect([400, 403]).toContain(res.status);

      const boardYaml = path.join(store.boardPath('demo'), 'board.yaml');
      await expect(fs.stat(boardYaml)).resolves.toBeTruthy();
      const snap = await store.getSnapshot('demo');
      expect(snap.config.slug).toBe('demo');
    } finally {
      await close();
    }
  });

  it('reproduces Bug 8: PATCH /api/boards/demo/media/:id with filePath="../brief.md" is rejected and brief is untouched', async () => {
    const dir = await makeTempDir();
    const store = new ContextDeckStore(dir);
    await seedDemoBoard(store, 'demo');
    const beforeSnap = await store.getSnapshot('demo');
    const docMedia = beforeSnap.media.find((m) => m.kind === 'doc')!;
    const { app, token, close } = createApp({ store, port: 4310 });

    try {
      const res = await app.request(`http://127.0.0.1:4310/api/boards/demo/media/${docMedia.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ filePath: '../brief.md', content: 'PWNED_BRIEF' }),
      });
      expect(res.status).toBe(400);

      const afterSnap = await store.getSnapshot('demo');
      expect(afterSnap.brief).toBe(beforeSnap.brief);
    } finally {
      await close();
    }
  });

  it('enforces Host allowlist, auth, single-use & expiring bootstrap code, cookie CSRF, and Origin checks', async () => {
    const dir = await makeTempDir();
    const store = new ContextDeckStore(dir);
    await seedDemoBoard(store, 'demo');
    const { app, token, mintBootstrapCode, close } = createApp({
      store,
      port: 4310,
      bootstrapTtlMs: 80,
    });

    try {
      // Token persisted with mode 0600 inside <deckDir>/.runtime/token
      const tokenPath = path.join(store.runtimeDir, 'token');
      const st = await fs.stat(tokenPath);
      expect(st.mode & 0o777).toBe(0o600);
      expect((await fs.readFile(tokenPath, 'utf8')).trim()).toBe(token);

      // Wrong Host -> 421/403 (DNS rebinding blocked)
      const wrongHost = await app.request('http://evil.example:4310/api/health');
      expect([403, 421]).toContain(wrongHost.status);

      // Missing auth -> 401
      const unauth = await app.request('http://127.0.0.1:4310/api/boards');
      expect(unauth.status).toBe(401);

      // Expired bootstrap code -> 401
      const expiringCode = mintBootstrapCode();
      await new Promise((r) => setTimeout(r, 120));
      const expiredRes = await app.request(`http://127.0.0.1:4310/auth?code=${expiringCode}`);
      expect(expiredRes.status).toBe(401);

      // Mint via bearer-authenticated endpoint -> single-use exchange
      const mintRes = await app.request('http://127.0.0.1:4310/api/auth/bootstrap', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(mintRes.status).toBe(200);
      const { code } = (await mintRes.json()) as { code: string };

      const authRes = await app.request(`http://127.0.0.1:4310/auth?code=${code}`);
      expect(authRes.status).toBe(302);
      expect(authRes.headers.get('location')).toBe('/');
      expect(authRes.headers.get('cache-control')).toContain('no-store');
      expect(authRes.headers.get('referrer-policy')).toBe('no-referrer');
      const setCookie = authRes.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('cdeck_sess_4310=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Strict');
      const cookiePair = setCookie.split(';')[0];

      // Reuse same bootstrap code -> 401 (single-use!)
      const reuseRes = await app.request(`http://127.0.0.1:4310/auth?code=${code}`);
      expect(reuseRes.status).toBe(401);

      // GET /api/session (cookie-auth only) returns csrfToken
      const sessBearer = await app.request('http://127.0.0.1:4310/api/session', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(sessBearer.status).toBe(401);

      const sessCookie = await app.request('http://127.0.0.1:4310/api/session', {
        headers: { Cookie: cookiePair },
      });
      expect(sessCookie.status).toBe(200);
      const { csrfToken } = (await sessCookie.json()) as { csrfToken: string };
      expect(csrfToken).toBeTruthy();

      // Cookie mutation without CSRF -> 403
      const noCsrf = await app.request('http://127.0.0.1:4310/api/boards/demo/tasks', {
        method: 'POST',
        headers: {
          Cookie: cookiePair,
          Origin: 'http://127.0.0.1:4310',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: 'No CSRF' }),
      });
      expect(noCsrf.status).toBe(403);

      // Cookie mutation with Origin: null (even with valid CSRF) -> 403
      const nullOrigin = await app.request('http://127.0.0.1:4310/api/boards/demo/tasks', {
        method: 'POST',
        headers: {
          Cookie: cookiePair,
          Origin: 'null',
          'X-CSRF-Token': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: 'Null Origin' }),
      });
      expect(nullOrigin.status).toBe(403);

      // Cookie mutation with foreign Origin (even with valid CSRF) -> 403
      const foreignOrigin = await app.request('http://127.0.0.1:4310/api/boards/demo/tasks', {
        method: 'POST',
        headers: {
          Cookie: cookiePair,
          Origin: 'https://evil.example',
          'X-CSRF-Token': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: 'Foreign Origin' }),
      });
      expect(foreignOrigin.status).toBe(403);

      // Valid cookie + valid Origin + valid CSRF -> 201
      const validMut = await app.request('http://127.0.0.1:4310/api/boards/demo/tasks', {
        method: 'POST',
        headers: {
          Cookie: cookiePair,
          Origin: 'http://127.0.0.1:4310',
          'X-CSRF-Token': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: 'Valid Cookie Task' }),
      });
      expect(validMut.status).toBe(201);
    } finally {
      await close();
    }
  });

  it('keeps GET routes read-only (no ensureDefaultBoard side effects on empty workspace)', async () => {
    const dir = await makeTempDir();
    const store = new ContextDeckStore(dir);
    const { app, token, close } = createApp({ store, port: 4310 });

    try {
      const res = await app.request('http://127.0.0.1:4310/api/boards', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.boards).toEqual([]);
      expect(store.isInitialized()).toBe(false);
    } finally {
      await close();
    }
  });

  it('serves media with server-controlled MIME allowlist, attachment for non-allowlisted (.bin/.html/.svg), nosniff & sandbox CSP on 200 and 206', async () => {
    const dir = await makeTempDir();
    const store = new ContextDeckStore(dir);
    await seedDemoBoard(store, 'demo');

    // Attach .bin file claiming mimeType: text/html (XSS attempt!)
    const binArt = await store.addMedia('demo', {
      title: 'Sneaky bin',
      kind: 'custom',
      mimeType: 'text/html',
      fileName: 'payload.bin',
      fileBuffer: Buffer.from('<script>alert(1)</script>'),
    });
    const svgArt = await store.addMedia('demo', {
      title: 'SVG file',
      kind: 'custom',
      mimeType: 'image/svg+xml',
      fileName: 'diagram.svg',
      fileBuffer: Buffer.from('<svg onload="alert(1)"/>'),
    });
    const mp4Art = await store.addMedia('demo', {
      title: 'Safe video',
      kind: 'video',
      fileName: 'clip.mp4',
      fileBuffer: Buffer.from('0123456789'),
    });

    const { app, token, close } = createApp({ store, port: 4310 });
    try {
      // .bin with stored mimeType text/html -> application/octet-stream + attachment + nosniff + sandbox
      for (const headers of [
        { Authorization: `Bearer ${token}` },
        { Authorization: `Bearer ${token}`, Range: 'bytes=0-5' },
      ]) {
        const res = await app.request(`http://127.0.0.1:4310/api/boards/demo/media/${binArt.id}/file`, {
          headers,
        });
        expect(res.status).toBe(headers.Range ? 206 : 200);
        expect(res.headers.get('content-type')).toBe('application/octet-stream');
        expect(res.headers.get('content-disposition')).toContain('attachment');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('content-security-policy')).toBe('sandbox');
      }

      // .svg -> application/octet-stream + attachment
      const svgRes = await app.request(
        `http://127.0.0.1:4310/api/boards/demo/media/${svgArt.id}/file`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(svgRes.status).toBe(200);
      expect(svgRes.headers.get('content-type')).toBe('application/octet-stream');
      expect(svgRes.headers.get('content-disposition')).toContain('attachment');

      // .mp4 -> video/mp4 + inline + nosniff + sandbox on 206
      const mp4Res = await app.request(
        `http://127.0.0.1:4310/api/boards/demo/media/${mp4Art.id}/file`,
        { headers: { Authorization: `Bearer ${token}`, Range: 'bytes=0-3' } },
      );
      expect(mp4Res.status).toBe(206);
      expect(mp4Res.headers.get('content-type')).toBe('video/mp4');
      expect(mp4Res.headers.get('content-disposition')).toContain('inline');
      expect(mp4Res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(mp4Res.headers.get('content-security-policy')).toBe('sandbox');
    } finally {
      await close();
    }
  });

  it('enforces JSON 1 MB limit and streaming multipart cap including chunked requests without Content-Length', async () => {
    const dir = await makeTempDir();
    const store = new ContextDeckStore({
      deckDir: path.join(dir, '.contextdeck'),
      projectRoot: dir,
      maxMediaBytes: 1024, // 1 KB cap for fast streaming test
    });
    await seedDemoBoard(store, 'demo');
    const { app, token, close } = createApp({ store, port: 4310, maxMediaBytes: 1024 });

    try {
      // Chunked JSON > 1 MB without Content-Length
      const bigJson = JSON.stringify({ title: 'x', description: 'a'.repeat(1_100_000) });
      const chunkedStream = new ReadableStream({
        start(controller) {
          const bytes = new TextEncoder().encode(bigJson);
          for (let i = 0; i < bytes.length; i += 65536) {
            controller.enqueue(bytes.subarray(i, i + 65536));
          }
          controller.close();
        },
      });
      const jsonReq = new Request('http://127.0.0.1:4310/api/boards/demo/tasks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: chunkedStream,
        // @ts-expect-error duplex is required by Node fetch for streaming body
        duplex: 'half',
      });
      const jsonRes = await app.request(jsonReq);
      expect(jsonRes.status).toBe(413);

      // Oversized multipart upload (2 KB > 1 KB cap) without Content-Length
      const boundary = '----cdeckTestBoundary';
      const bodyStr =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="title"\r\n\r\nBig File\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="kind"\r\n\r\nvideo\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="big.mp4"\r\n` +
        `Content-Type: video/mp4\r\n\r\n` +
        'X'.repeat(2048) +
        `\r\n--${boundary}--\r\n`;
      const mpStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(bodyStr));
          controller.close();
        },
      });
      const mpReq = new Request('http://127.0.0.1:4310/api/boards/demo/media', {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          Authorization: `Bearer ${token}`,
        },
        body: mpStream,
        // @ts-expect-error duplex is required by Node fetch for streaming body
        duplex: 'half',
      });
      const mpRes = await app.request(mpReq);
      expect(mpRes.status).toBe(413);

      // Verify no temp upload file left behind
      const mediaFiles = await fs.readdir(path.join(store.boardPath('demo'), 'media'));
      expect(mediaFiles.some((f) => f.startsWith('.tmp-'))).toBe(false);
    } finally {
      await close();
    }
  });

  it('H2: failed multipart upload after txn.json write does not delete staged temp or brick workspace', async () => {
    const dir = await makeTempDir('cdeck-h2-');
    const store = new ContextDeckStore(dir);
    await seedDemoBoard(store, 'demo');
    const { app, token, close } = createApp({ store, port: 4310 });

    try {
      const boundary = '----cdeckH2Boundary';
      const bodyStr =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="title"\r\n\r\nFaulted Upload\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="kind"\r\n\r\nvideo\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="clip.mp4"\r\n` +
        `Content-Type: video/mp4\r\n\r\n` +
        'VIDEO_PAYLOAD_BYTES' +
        `\r\n--${boundary}--\r\n`;

      process.env.CONTEXTDECK_FAULT = 'after-txn-write';
      const res = await app.request('http://127.0.0.1:4310/api/boards/demo/media', {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          Authorization: `Bearer ${token}`,
        },
        body: bodyStr,
      });
      delete process.env.CONTEXTDECK_FAULT;
      expect(res.status).toBeGreaterThanOrEqual(400);

      // Next mutation must cleanly roll forward txn.json and succeed
      const task = await store.upsertTask('demo', { title: 'Post-fault task' });
      expect(task.title).toBe('Post-fault task');

      const snap = await store.getSnapshot('demo');
      expect(snap.tasks.some((t) => t.title === 'Post-fault task')).toBe(true);
      const uploaded = snap.media.find((m) => m.title === 'Faulted Upload');
      expect(uploaded).toBeDefined();
      const resolved = await store.resolveMediaFilePath('demo', uploaded!.id);
      expect(resolved).not.toBeNull();
      expect(await fs.readFile(resolved!.absolutePath, 'utf8')).toBe('VIDEO_PAYLOAD_BYTES');
    } finally {
      delete process.env.CONTEXTDECK_FAULT;
      await close();
    }
  });

  it('enforces MCP media_attach path allowlist, secret denials, symlink escape rejection, string caps, and baseRevision', async () => {
    const dir = await makeTempDir();
    const outside = await makeTempDir('cdeck-outside-');
    const fakeHome = await makeTempDir('cdeck-home-');

    await fs.writeFile(path.join(outside, 'secret.txt'), 'OUTSIDE_SECRET', 'utf8');
    await fs.writeFile(path.join(dir, '.env'), 'API_KEY=123', 'utf8');
    await fs.mkdir(path.join(dir, 'docs'), { recursive: true });
    await fs.writeFile(path.join(dir, 'docs', 'allowed.txt'), 'HELLO_ALLOWED', 'utf8');
    await fs.writeFile(path.join(dir, 'docs', 'server.key'), 'PRIVATE_KEY', 'utf8');
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(dir, 'docs', 'escape.txt'));

    const store = new ContextDeckStore({
      deckDir: path.join(dir, '.contextdeck'),
      projectRoot: dir,
    });
    await seedDemoBoard(store, 'demo');
    const { app, token, close } = createApp({ store, port: 4310, env: { CONTEXTDECK_HOME: fakeHome } });

    const callMcp = async (name: string, args: Record<string, unknown>) => {
      const res = await app.request('http://127.0.0.1:4310/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      return res.json();
    };

    try {
      // Reject .contextdeck/.runtime/token
      const tokenAttempt = await callMcp('media_attach', {
        board: 'demo',
        title: 'Steal token',
        kind: 'doc',
        sourceFilePath: path.join(store.runtimeDir, 'token'),
      });
      expect(tokenAttempt.result?.isError || tokenAttempt.error).toBeTruthy();

      // Reject .env
      const envAttempt = await callMcp('media_attach', {
        board: 'demo',
        title: 'Steal env',
        kind: 'doc',
        sourceFilePath: path.join(dir, '.env'),
      });
      expect(envAttempt.result?.isError || envAttempt.error).toBeTruthy();

      // Reject *.key secret pattern
      const keyAttempt = await callMcp('media_attach', {
        board: 'demo',
        title: 'Steal key',
        kind: 'doc',
        sourceFilePath: path.join(dir, 'docs', 'server.key'),
      });
      expect(keyAttempt.result?.isError || keyAttempt.error).toBeTruthy();

      // Reject symlink escaping projectRoot
      const symAttempt = await callMcp('media_attach', {
        board: 'demo',
        title: 'Symlink escape',
        kind: 'doc',
        sourceFilePath: path.join(dir, 'docs', 'escape.txt'),
      });
      expect(symAttempt.result?.isError || symAttempt.error).toBeTruthy();

      // Allow safe regular file inside projectRoot
      const okAttempt = await callMcp('media_attach', {
        board: 'demo',
        title: 'Allowed Doc',
        kind: 'doc',
        sourceFilePath: path.join(dir, 'docs', 'allowed.txt'),
      });
      expect(okAttempt.result?.isError).toBeFalsy();
      expect(okAttempt.result?.content?.[0]?.text).toContain('Allowed Doc');

      // H14: Relative sourceFilePath resolves against projectRoot (not process.cwd())
      const relAttempt = await callMcp('media_attach', {
        board: 'demo',
        title: 'Relative Project Doc',
        kind: 'doc',
        sourceFilePath: 'docs/allowed.txt',
      });
      expect(relAttempt.result?.isError).toBeFalsy();
      expect(relAttempt.result?.content?.[0]?.text).toContain('Relative Project Doc');

      // Allow external root ONLY when configured in user-local ~/.contextdeck/config.yaml
      const outsideAllowedDir = await makeTempDir('cdeck-media-root-');
      const outsideAllowedFile = path.join(outsideAllowedDir, 'clip.txt');
      await fs.writeFile(outsideAllowedFile, 'FROM_MEDIA_ROOT', 'utf8');

      // Rejected before adding to user-local config
      const beforeRoot = await callMcp('media_attach', {
        board: 'demo',
        title: 'Outside before config',
        kind: 'doc',
        sourceFilePath: outsideAllowedFile,
      });
      expect(beforeRoot.result?.isError || beforeRoot.error).toBeTruthy();

      await fs.writeFile(
        path.join(fakeHome, 'config.yaml'),
        `mediaRoots:\n  - ${JSON.stringify(outsideAllowedDir)}\n`,
        'utf8',
      );
      const afterRoot = await callMcp('media_attach', {
        board: 'demo',
        title: 'Outside after config',
        kind: 'doc',
        sourceFilePath: outsideAllowedFile,
      });
      expect(afterRoot.result?.isError).toBeFalsy();

      // MCP board_update_brief REQUIRES baseRevision
      const noBase = await callMcp('board_update_brief', {
        board: 'demo',
        brief: '# Updated without baseRevision',
      });
      expect(noBase.result?.isError || noBase.error).toBeTruthy();

      // MCP string cap (>20 KB rejected)
      const hugeText = await callMcp('decision_record', {
        board: 'demo',
        title: 'Huge rationale',
        rationale: 'x'.repeat(25_000),
      });
      expect(hugeText.result?.isError || hugeText.error).toBeTruthy();

      // H8: MCP tools must reject unknown/storage keys (.strict()) and enforce 20 KB caps on quiz questions
      const mediaUnknownKeys = await callMcp('media_attach', {
        board: 'demo',
        title: 'Bad Media Keys',
        kind: 'doc',
        content: 'ok',
        filePath: '../brief.md',
        createdAt: '2020-01-01T00:00:00.000Z',
        version: 99,
      });
      expect(mediaUnknownKeys.result?.isError || mediaUnknownKeys.error).toBeTruthy();

      const decisionUnknownKeys = await callMcp('decision_record', {
        board: 'demo',
        title: 'Bad Decision Keys',
        createdAt: '2020-01-01T00:00:00.000Z',
        version: 2,
      });
      expect(decisionUnknownKeys.result?.isError || decisionUnknownKeys.error).toBeTruthy();

      const quizHugePrompt = await callMcp('quiz_create', {
        board: 'demo',
        title: 'Huge Quiz Prompt',
        questions: [
          {
            id: 'q1',
            prompt: 'P'.repeat(30_000),
            type: 'multiple_choice',
            options: ['A', 'B'],
            correctIndex: 0,
          },
        ],
      });
      expect(quizHugePrompt.result?.isError || quizHugePrompt.error).toBeTruthy();

      const quizUnknownKeys = await callMcp('quiz_create', {
        board: 'demo',
        title: 'Unknown Quiz Keys',
        version: 42,
        questions: [
          {
            id: 'q1',
            prompt: 'Valid?',
            type: 'multiple_choice',
            options: ['A', 'B'],
            correctIndex: 0,
            extraField: 'bad',
          },
        ],
      });
      expect(quizUnknownKeys.result?.isError || quizUnknownKeys.error).toBeTruthy();

      const chapterUnknownKeys = await callMcp('media_attach', {
        board: 'demo',
        title: 'Bad Chapter',
        kind: 'video',
        chapters: [{ timeSec: 0, title: 'Intro', secret: true }],
      });
      expect(chapterUnknownKeys.result?.isError || chapterUnknownKeys.error).toBeTruthy();
    } finally {
      await close();
    }
  });

  it('supports real HTTP cookie-jar flow: bootstrap -> cookie -> /api/session -> API + SSE + non-loopback guard (D6)', async () => {
    const dir = await makeTempDir();
    const store = new ContextDeckStore(dir);
    await seedDemoBoard(store, 'demo');

    // Non-loopback without --allow-remote must throw
    await expect(
      startServer({
        deckDir: store.deckDir,
        projectRoot: dir,
        host: '0.0.0.0',
        port: 4411,
      }),
    ).rejects.toThrow(/allow-remote/i);

    const srv = await startServer({
      deckDir: store.deckDir,
      projectRoot: dir,
      host: '127.0.0.1',
      port: 4412,
    });

    try {
      // 1. Exchange launchUrl bootstrap code -> redirect + Set-Cookie
      const authRes = await fetch(srv.launchUrl, { redirect: 'manual' });
      expect(authRes.status).toBe(302);
      expect(authRes.headers.get('location')).toBe('/');
      const setCookie = authRes.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('cdeck_sess_4412=');
      const cookie = setCookie.split(';')[0];

      // 2. Get CSRF token from /api/session
      const sessRes = await fetch(`${srv.url}/api/session`, {
        headers: { Cookie: cookie },
      });
      expect(sessRes.status).toBe(200);
      const { csrfToken } = (await sessRes.json()) as { csrfToken: string };

      // 3. Call authenticated GET /api/boards + POST mutation with CSRF
      const boardsRes = await fetch(`${srv.url}/api/boards`, {
        headers: { Cookie: cookie },
      });
      expect(boardsRes.status).toBe(200);

      const taskRes = await fetch(`${srv.url}/api/boards/demo/tasks`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: srv.url,
          'X-CSRF-Token': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: 'Cookie jar task' }),
      });
      expect(taskRes.status).toBe(201);

      // 4. Connect SSE stream with cookie and read initial connected event
      const ac = new AbortController();
      const sseRes = await fetch(`${srv.url}/api/events`, {
        headers: { Cookie: cookie },
        signal: ac.signal,
      });
      expect(sseRes.status).toBe(200);
      const reader = sseRes.body!.getReader();
      const { value } = await reader.read();
      const chunk = new TextDecoder().decode(value);
      expect(chunk).toContain('event: connected');
      ac.abort();
    } finally {
      await srv.close();
    }
  });

  it('H13: real-HTTP oversized chunked upload, mid-upload abort, and truncated multipart body never crash server or leak temps', async () => {
    const dir = await makeTempDir('cdeck-h13-');
    const store = new ContextDeckStore({
      deckDir: path.join(dir, '.contextdeck'),
      projectRoot: dir,
      maxMediaBytes: 1024,
    });
    await seedDemoBoard(store, 'demo');

    const port = 4421;
    const srv = await startServer({
      deckDir: store.deckDir,
      projectRoot: dir,
      host: '127.0.0.1',
      port,
      maxMediaBytes: 1024,
    });

    const assertServerAlive = async () => {
      const health = await fetch(`${srv.url}/api/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true, name: 'contextdeck' });
    };

    const mediaDir = path.join(store.boardPath('demo'), 'media');

    try {
      // 1. Real HTTP chunked 4 KB upload (> 1 KB limit) -> 413, server stays alive
      const boundary1 = '----h13ChunkedBoundary';
      const status1 = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/api/boards/demo/media',
            method: 'POST',
            headers: {
              'Content-Type': `multipart/form-data; boundary=${boundary1}`,
              Authorization: `Bearer ${srv.token}`,
              'Transfer-Encoding': 'chunked',
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.on('error', (err) => {
          // Server may close socket early after sending 413 while chunks are still writing
          if ((err as NodeJS.ErrnoException).code === 'EPIPE' || (err as NodeJS.ErrnoException).code === 'ECONNRESET') {
            return;
          }
          reject(err);
        });
        req.write(
          `--${boundary1}\r\n` +
            `Content-Disposition: form-data; name="title"\r\n\r\nOversized\r\n` +
            `--${boundary1}\r\n` +
            `Content-Disposition: form-data; name="kind"\r\n\r\nvideo\r\n` +
            `--${boundary1}\r\n` +
            `Content-Disposition: form-data; name="file"; filename="big.mp4"\r\n` +
            `Content-Type: video/mp4\r\n\r\n`,
        );
        setTimeout(() => {
          if (!req.destroyed) req.write('A'.repeat(2048));
        }, 15);
        setTimeout(() => {
          if (!req.destroyed) {
            req.write('B'.repeat(2048));
            req.end(`\r\n--${boundary1}--\r\n`);
          }
        }, 30);
      });
      expect(status1).toBe(413);
      await assertServerAlive();

      // 2. Client aborts mid-upload -> server stays alive, no leftover .tmp-upload-*
      const boundary2 = '----h13AbortBoundary';
      await new Promise<void>((resolve) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: '/api/boards/demo/media',
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary2}`,
            Authorization: `Bearer ${srv.token}`,
            'Transfer-Encoding': 'chunked',
          },
        });
        req.on('error', () => resolve());
        req.on('close', () => resolve());
        req.write(
          `--${boundary2}\r\n` +
            `Content-Disposition: form-data; name="file"; filename="aborted.mp4"\r\n` +
            `Content-Type: video/mp4\r\n\r\n` +
            'PARTIAL_BYTES_BEFORE_ABORT',
        );
        setTimeout(() => {
          req.destroy();
        }, 40);
      });
      // Give server cleanup a moment to settle after client socket abort
      await new Promise((r) => setTimeout(r, 120));
      await assertServerAlive();
      const filesAfterAbort = await fs.readdir(mediaDir);
      expect(filesAfterAbort.some((f) => f.startsWith('.tmp-upload-'))).toBe(false);

      // 3. Truncated multipart body without closing boundary -> 400, server stays alive
      const boundary3 = '----h13TruncatedBoundary';
      const truncatedBody =
        `--${boundary3}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="trunc.mp4"\r\n` +
        `Content-Type: video/mp4\r\n\r\n` +
        'TRUNCATED_WITHOUT_END_BOUNDARY';
      const truncRes = await fetch(`${srv.url}/api/boards/demo/media`, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary3}`,
          Authorization: `Bearer ${srv.token}`,
        },
        body: truncatedBody,
      });
      expect(truncRes.status).toBe(400);
      await assertServerAlive();
      const filesAfterTrunc = await fs.readdir(mediaDir);
      expect(filesAfterTrunc.some((f) => f.startsWith('.tmp-upload-'))).toBe(false);
    } finally {
      await srv.close();
    }
  }, 20_000);

  it('H16: parses bare IPv6 --allowed-hosts correctly and preserves explicit port in launchUrl', async () => {
    const policy = buildHostPolicy({
      host: '0.0.0.0',
      port: 4429,
      allowRemote: true,
      allowedHosts: ['2001:db8::1', '192.168.1.5:8080', '[2001:db8::2]:8443'],
    });
    expect(policy.allowedHosts.has('[2001:db8::1]:4429')).toBe(true);
    expect(policy.allowedHosts.has('2001:db8::1')).toBe(false);
    expect(policy.allowedHosts.has('192.168.1.5:8080')).toBe(true);
    expect(policy.allowedHosts.has('[2001:db8::2]:8443')).toBe(true);

    const dir = await makeTempDir('cdeck-h16-');
    const store = new ContextDeckStore(dir);
    await seedDemoBoard(store, 'demo');

    const srv = await startServer({
      deckDir: store.deckDir,
      projectRoot: dir,
      host: '0.0.0.0',
      port: 4422,
      allowRemote: true,
      allowedHosts: ['192.168.1.5:8080', '2001:db8::1'],
    });
    try {
      expect(srv.url).toBe('http://192.168.1.5:8080');
      expect(srv.launchUrl.startsWith('http://192.168.1.5:8080/auth?code=')).toBe(true);

      // Sending a request with the Host header from launchUrl must be accepted (302), not rejected (421)
      const launchParsed = new URL(srv.launchUrl);
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: 4422,
            path: `${launchParsed.pathname}${launchParsed.search}`,
            method: 'GET',
            headers: { Host: launchParsed.host },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(302);

      // Bare IPv6 allowedHost must also be accepted with Host: [2001:db8::1]:4422
      const ipv6Status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: 4422,
            path: '/api/health',
            method: 'GET',
            headers: { Host: '[2001:db8::1]:4422' },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(ipv6Status).toBe(200);
    } finally {
      await srv.close();
    }
  });
});
