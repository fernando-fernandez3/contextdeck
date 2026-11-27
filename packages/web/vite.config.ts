import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const EXCALIDRAW_SELF_HOSTED_FONT_FAMILIES = [
  'Assistant',
  'Cascadia',
  'ComicShanns',
  'Excalifont',
  'Liberation',
  'Lilita',
  'Nunito',
  'Virgil',
];

function resolveExcalidrawFontsDir(): string {
  const req = createRequire(import.meta.url);
  const entryPath = req.resolve('@excalidraw/excalidraw');
  const fontsDir = path.join(path.dirname(entryPath), 'fonts');
  if (!fs.existsSync(fontsDir)) {
    throw new Error(`Could not locate @excalidraw/excalidraw fonts directory at ${fontsDir}`);
  }
  return fontsDir;
}

const EXCALIDRAW_ESM_FALLBACK_RE = /`https:\/\/esm\.sh\/(?:[^`]|`[^`]*`)*\/dist\/prod\/`/g;
const EXCALIDRAW_LOCAL_FALLBACK_EXPR =
  '(typeof globalThis !== "undefined" && globalThis.location && globalThis.location.origin && globalThis.location.origin !== "null" ? `${globalThis.location.origin}/excalidraw-assets/` : "http://127.0.0.1/excalidraw-assets/")';

function excalidrawSelfHostedFontsPlugin(): Plugin {
  const fontsDir = resolveExcalidrawFontsDir();
  return {
    name: 'contextdeck-excalidraw-self-hosted-fonts',
    transform(code, id) {
      if (!id.includes('@excalidraw') || !code.includes('https://esm.sh/')) {
        return null;
      }
      const replaced = code.replace(EXCALIDRAW_ESM_FALLBACK_RE, EXCALIDRAW_LOCAL_FALLBACK_EXPR);
      if (replaced === code) return null;
      return { code: replaced, map: null };
    },
    configureServer(server) {
      server.middlewares.use('/excalidraw-assets/fonts', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '');
        const candidate = path.resolve(fontsDir, rel);
        if (
          (candidate === fontsDir || candidate.startsWith(`${fontsDir}${path.sep}`)) &&
          fs.existsSync(candidate) &&
          fs.statSync(candidate).isFile()
        ) {
          res.setHeader(
            'Content-Type',
            candidate.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream',
          );
          fs.createReadStream(candidate).pipe(res);
          return;
        }
        next();
      });
    },
    writeBundle(options) {
      const outDir = options.dir ?? path.resolve(process.cwd(), 'dist');
      const targetRoot = path.join(outDir, 'excalidraw-assets', 'fonts');
      fs.mkdirSync(targetRoot, { recursive: true });
      for (const family of EXCALIDRAW_SELF_HOSTED_FONT_FAMILIES) {
        const src = path.join(fontsDir, family);
        if (fs.existsSync(src)) {
          fs.cpSync(src, path.join(targetRoot, family), { recursive: true });
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), excalidrawSelfHostedFontsPlugin()],
  define: {
    'process.env.IS_PREACT': JSON.stringify('false'),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4310',
      '/mcp': 'http://127.0.0.1:4310',
    },
  },
});
