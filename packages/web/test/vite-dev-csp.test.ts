// @vitest-environment node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createServer } from 'vite';
import { WEB_UI_CSP } from '../../server/src/app';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, '..');

describe('B3 Hardening Round 4 G2: Vite dev server HTML CSP parity (R4-2)', () => {
  it('R4-2: Vite dev server sends the shared WEB_UI_CSP header on HTML responses', async () => {
    const server = await createServer({
      root: WEB_ROOT,
      configFile: path.join(WEB_ROOT, 'vite.config.ts'),
      logLevel: 'silent',
      server: {
        host: '127.0.0.1',
        port: 0,
        strictPort: false,
      },
    });
    try {
      await server.listen();
      const addr = server.httpServer?.address();
      if (!addr || typeof addr === 'string') {
        throw new Error('Failed to bind Vite dev server on ephemeral port');
      }
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      for (const reqPath of ['/', '/decisions']) {
        const res = await fetch(`${baseUrl}${reqPath}`, {
          headers: { Accept: 'text/html' },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type') ?? '').toContain('text/html');
        expect(res.headers.get('content-security-policy')).toBe(WEB_UI_CSP);
      }
    } finally {
      await server.close();
    }
  });
});
