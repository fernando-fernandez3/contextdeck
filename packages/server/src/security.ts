import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {
  PayloadTooLargeError,
  SecurityError,
  ValidationError,
  canonicalizePath,
  isPathInside,
  readUserLocalConfig,
} from '@contextdeck/core';

export const TOKEN_FILENAME = 'token';
export const DEFAULT_BOOTSTRAP_TTL_MS = 120_000; // 120 seconds (D8)
export const JSON_BODY_LIMIT_BYTES = 1024 * 1024; // 1 MB (AC2.8)

export function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Ensure a per-workspace 32-byte random bearer token exists at `<runtimeDir>/token`
 * with file mode 0600 (AC2.3, D2).
 */
export function ensureWorkspaceTokenSync(runtimeDir: string): string {
  fsSync.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  try {
    fsSync.chmodSync(runtimeDir, 0o700);
  } catch {
    // best-effort on non-POSIX filesystems
  }

  const tokenPath = path.join(runtimeDir, TOKEN_FILENAME);
  try {
    const existing = fsSync.readFileSync(tokenPath, 'utf8').trim();
    if (existing.length >= 32) {
      try {
        fsSync.chmodSync(tokenPath, 0o600);
      } catch {
        // best-effort
      }
      return existing;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  const token = crypto.randomBytes(32).toString('hex');
  const tmpPath = path.join(runtimeDir, `.tmp-token-${crypto.randomBytes(6).toString('hex')}`);
  const fd = fsSync.openSync(tmpPath, 'wx', 0o600);
  try {
    fsSync.writeSync(fd, `${token}\n`, null, 'utf8');
    fsSync.fsyncSync(fd);
  } finally {
    fsSync.closeSync(fd);
  }
  try {
    fsSync.chmodSync(tmpPath, 0o600);
  } catch {
    // best-effort
  }
  fsSync.renameSync(tmpPath, tokenPath);
  try {
    fsSync.chmodSync(tokenPath, 0o600);
  } catch {
    // best-effort
  }
  return token;
}

export async function readWorkspaceToken(runtimeDir: string): Promise<string> {
  const tokenPath = path.join(runtimeDir, TOKEN_FILENAME);
  const raw = await fs.readFile(tokenPath, 'utf8');
  const token = raw.trim();
  if (token.length < 32) {
    throw new SecurityError('Workspace bearer token is missing or invalid.');
  }
  return token;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '[::1]'
  );
}

export function formatHostForUrl(host: string): string {
  const trimmed = host.trim();
  if (trimmed.includes(':') && !trimmed.startsWith('[')) {
    return `[${trimmed}]`;
  }
  return trimmed;
}

export interface HostPolicy {
  allowedHosts: Set<string>;
  allowedOrigins: Set<string>;
}

/**
 * Build Host & Origin allowlists (AC2.2, D6).
 * Non-loopback `--host` and `--allowed-hosts` both require `allowRemote: true`.
 */
export function buildHostPolicy(options: {
  host?: string;
  port?: number;
  allowRemote?: boolean;
  allowedHosts?: string[];
}): HostPolicy {
  const host = (options.host ?? '127.0.0.1').trim();
  const port = options.port;
  const allowRemote = options.allowRemote === true;
  const extraHosts = (options.allowedHosts ?? []).map((h) => h.trim()).filter(Boolean);

  if (!isLoopbackHost(host) && !allowRemote) {
    throw new ValidationError(
      `Refusing to bind non-loopback host "${host}" without --allow-remote (traffic is plain HTTP).`,
    );
  }

  if (extraHosts.length > 0 && !allowRemote) {
    throw new ValidationError(
      '--allowed-hosts requires --allow-remote because it permits non-loopback HTTP access.',
    );
  }

  const allowedHosts = new Set<string>();
  const addHostEntry = (rawHost: string) => {
    const clean = rawHost.trim().toLowerCase();
    if (!clean) return;
    // Check if host already includes explicit port (handle IPv6 [::1]:4310)
    const hasExplicitPort = clean.startsWith('[')
      ? /\]:\d+$/.test(clean)
      : /:\d+$/.test(clean);
    if (hasExplicitPort) {
      allowedHosts.add(clean);
    } else if (port !== undefined) {
      const formatted = formatHostForUrl(clean);
      allowedHosts.add(`${formatted}:${port}`);
    } else {
      const formatted = formatHostForUrl(clean);
      allowedHosts.add(formatted);
    }
  };

  // Always allow loopback variants for the bound port (or bare loopback if port omitted in unit tests)
  if (port !== undefined) {
    allowedHosts.add(`127.0.0.1:${port}`);
    allowedHosts.add(`localhost:${port}`);
    allowedHosts.add(`[::1]:${port}`);
  } else {
    allowedHosts.add('127.0.0.1');
    allowedHosts.add('localhost');
    allowedHosts.add('[::1]');
    allowedHosts.add('127.0.0.1:4310');
    allowedHosts.add('localhost:4310');
    allowedHosts.add('[::1]:4310');
  }

  if (allowRemote) {
    if (!isLoopbackHost(host) && host !== '0.0.0.0' && host !== '::' && host !== '[::]') {
      addHostEntry(host);
    }
    for (const entry of extraHosts) {
      addHostEntry(entry);
    }
  }

  const allowedOrigins = new Set<string>();
  for (const h of allowedHosts) {
    allowedOrigins.add(`http://${h}`);
  }

  return { allowedHosts, allowedOrigins };
}

/**
 * Server-controlled media MIME allowlist by extension ONLY (AC2.7, D5).
 * HTML, SVG, XML, JS, and unknown extensions are NEVER in this map and are
 * forced to application/octet-stream + Content-Disposition: attachment.
 */
const INLINE_SAFE_MEDIA_MIME: Record<string, string> = {
  // Video
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  // Audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  // Raster images ONLY (never .svg!)
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  // Safe document/data formats
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export function sanitizeDispositionFilename(rawName: string): string {
  const base = path.basename(rawName).replace(/[^A-Za-z0-9._-]/g, '_');
  const trimmed = base.replace(/^\.+/, '').slice(0, 120);
  return trimmed || 'download.bin';
}

export function resolveMediaServePolicy(filePath: string): {
  contentType: string;
  contentDisposition: string;
  isInline: boolean;
} {
  const ext = path.extname(filePath).toLowerCase();
  const safeFilename = sanitizeDispositionFilename(filePath);
  const allowlisted = INLINE_SAFE_MEDIA_MIME[ext];
  if (allowlisted) {
    return {
      contentType: allowlisted,
      contentDisposition: `inline; filename="${safeFilename}"`,
      isInline: true,
    };
  }
  return {
    contentType: 'application/octet-stream',
    contentDisposition: `attachment; filename="${safeFilename}"`,
    isInline: false,
  };
}

const SECRET_BASENAME_PATTERNS = [
  /^\.env(\.|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_/i,
  /credentials/i,
];

const FORBIDDEN_SEGMENTS = new Set(['.contextdeck', '.git', 'node_modules']);

/**
 * Validate MCP `media_attach` `sourceFilePath` (AC2.5, E2 amended):
 * - Must resolve (realpath) to an existing regular file
 * - Must NOT be inside deckDir
 * - Must be inside projectRoot OR a user-local `~/.contextdeck/config.yaml` `mediaRoots` directory
 * - No path segment relative to the allowed root may start with `.` or match `.contextdeck`/`.git`/`node_modules`
 * - Basename must not match secret patterns (`.env*`, `*.pem`, `*.key`, `id_*`, `*credentials*`)
 * - Size must be <= maxMediaBytes
 */
export async function validateMcpMediaSourcePath(
  rawSourcePath: string,
  options: {
    projectRoot?: string;
    deckDir: string;
    maxMediaBytes: number;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
  },
): Promise<string> {
  if (!rawSourcePath || typeof rawSourcePath !== 'string') {
    throw new ValidationError('sourceFilePath must be a non-empty string.');
  }

  let realFilePath: string;
  try {
    realFilePath = await fs.realpath(path.resolve(rawSourcePath));
  } catch {
    throw new SecurityError('sourceFilePath does not exist or cannot be accessed.');
  }

  let st;
  try {
    st = await fs.stat(realFilePath);
  } catch {
    throw new SecurityError('sourceFilePath cannot be inspected.');
  }
  if (!st.isFile()) {
    throw new SecurityError('sourceFilePath must refer to a regular file.');
  }
  if (st.size > options.maxMediaBytes) {
    throw new PayloadTooLargeError(
      `File size (${st.size} bytes) exceeds media limit of ${options.maxMediaBytes} bytes.`,
    );
  }

  // Always block anything inside the workspace deckDir (e.g. .contextdeck/.runtime/token)
  const realDeckDir = await canonicalizePath(options.deckDir);
  if (isPathInside(realDeckDir, realFilePath, true)) {
    throw new SecurityError('Access denied: cannot attach files from inside .contextdeck.');
  }

  // Build allowed roots: projectRoot + user-local ~/.contextdeck/config.yaml mediaRoots ONLY
  const allowedRoots: string[] = [];
  if (options.projectRoot) {
    allowedRoots.push(await canonicalizePath(options.projectRoot));
  }
  const userCfg = readUserLocalConfig({ env: options.env, homeDir: options.homeDir });
  for (const root of userCfg.mediaRoots) {
    allowedRoots.push(await canonicalizePath(root));
  }

  const matchedRoot = allowedRoots.find((root) => isPathInside(root, realFilePath, false));
  if (!matchedRoot) {
    throw new SecurityError(
      'Access denied: sourceFilePath must be inside the project root or user-local ~/.contextdeck/config.yaml mediaRoots.',
    );
  }

  // Check every path segment relative to matched root (also check raw path segments if inside root)
  const relSegments = path.relative(matchedRoot, realFilePath).split(path.sep).filter(Boolean);
  for (const seg of relSegments) {
    if (seg.startsWith('.') || FORBIDDEN_SEGMENTS.has(seg.toLowerCase())) {
      throw new SecurityError(`Access denied: hidden or restricted path segment "${seg}" is not allowed.`);
    }
  }

  const baseName = path.basename(realFilePath);
  for (const pattern of SECRET_BASENAME_PATTERNS) {
    if (pattern.test(baseName)) {
      throw new SecurityError(`Access denied: file "${baseName}" matches a restricted secret pattern.`);
    }
  }

  return realFilePath;
}
