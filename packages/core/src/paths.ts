import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { SecurityError } from './errors.js';

const MAX_SYMLINK_HOPS = 40;

/**
 * Resolve the canonical path of `targetPath` by calling realpath on the
 * deepest existing ancestor and re-joining remaining segments, following
 * dangling symlinks (up to MAX_SYMLINK_HOPS) so they cannot bypass containment.
 */
export async function canonicalizePath(targetPath: string): Promise<string> {
  let current = path.resolve(targetPath);
  const tail: string[] = [];
  let hops = 0;

  for (;;) {
    try {
      const real = await fs.realpath(current);
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ELOOP') {
        throw new SecurityError('Access denied: symlink loop detected while resolving path.');
      }
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw err;
      }

      // Check whether `current` itself is a dangling symlink before falling back to parent
      try {
        const st = await fs.lstat(current);
        if (st.isSymbolicLink()) {
          hops += 1;
          if (hops > MAX_SYMLINK_HOPS) {
            throw new SecurityError('Access denied: too many symbolic link hops while resolving path.');
          }
          const linkTarget = await fs.readlink(current);
          const resolvedLink = path.resolve(path.dirname(current), linkTarget);
          current = tail.length > 0 ? path.join(resolvedLink, ...tail.reverse()) : resolvedLink;
          tail.length = 0;
          continue;
        }
      } catch (lstatErr) {
        if (lstatErr instanceof SecurityError) {
          throw lstatErr;
        }
        const lstatCode = (lstatErr as NodeJS.ErrnoException).code;
        if (lstatCode !== 'ENOENT' && lstatCode !== 'ENOTDIR') {
          throw lstatErr;
        }
      }

      const parent = path.dirname(current);
      if (parent === current) {
        return tail.length > 0 ? path.join(current, ...tail.reverse()) : current;
      }
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

export function canonicalizePathSync(targetPath: string): string {
  let current = path.resolve(targetPath);
  const tail: string[] = [];
  let hops = 0;

  for (;;) {
    try {
      const real = fsSync.realpathSync(current);
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ELOOP') {
        throw new SecurityError('Access denied: symlink loop detected while resolving path.');
      }
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw err;
      }

      try {
        const st = fsSync.lstatSync(current);
        if (st.isSymbolicLink()) {
          hops += 1;
          if (hops > MAX_SYMLINK_HOPS) {
            throw new SecurityError('Access denied: too many symbolic link hops while resolving path.');
          }
          const linkTarget = fsSync.readlinkSync(current);
          const resolvedLink = path.resolve(path.dirname(current), linkTarget);
          current = tail.length > 0 ? path.join(resolvedLink, ...tail.reverse()) : resolvedLink;
          tail.length = 0;
          continue;
        }
      } catch (lstatErr) {
        if (lstatErr instanceof SecurityError) {
          throw lstatErr;
        }
        const lstatCode = (lstatErr as NodeJS.ErrnoException).code;
        if (lstatCode !== 'ENOENT' && lstatCode !== 'ENOTDIR') {
          throw lstatErr;
        }
      }

      const parent = path.dirname(current);
      if (parent === current) {
        return tail.length > 0 ? path.join(current, ...tail.reverse()) : current;
      }
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

export function isPathInside(baseDir: string, candidate: string, allowEqual = false): boolean {
  const rel = path.relative(baseDir, candidate);
  if (rel === '') return allowEqual;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Assert that `targetPath` is lexically AND canonically (after realpath)
 * contained inside `baseDir`. Rejects path traversal and symlink escapes.
 */
export async function assertContainedPath(
  baseDir: string,
  targetPath: string,
  options: { allowEqual?: boolean; label?: string } = {},
): Promise<string> {
  const { allowEqual = false, label = 'path' } = options;
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);

  if (!isPathInside(resolvedBase, resolvedTarget, allowEqual)) {
    throw new SecurityError(`Access denied: ${label} escapes allowed directory.`);
  }

  const [realBase, realTarget] = await Promise.all([
    canonicalizePath(resolvedBase),
    canonicalizePath(resolvedTarget),
  ]);

  if (!isPathInside(realBase, realTarget, allowEqual)) {
    throw new SecurityError(`Access denied: ${label} resolves outside allowed directory (symlink escape).`);
  }

  return realTarget;
}

export function assertContainedPathSync(
  baseDir: string,
  targetPath: string,
  options: { allowEqual?: boolean; label?: string } = {},
): string {
  const { allowEqual = false, label = 'path' } = options;
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);

  if (!isPathInside(resolvedBase, resolvedTarget, allowEqual)) {
    throw new SecurityError(`Access denied: ${label} escapes allowed directory.`);
  }

  const realBase = canonicalizePathSync(resolvedBase);
  const realTarget = canonicalizePathSync(resolvedTarget);

  if (!isPathInside(realBase, realTarget, allowEqual)) {
    throw new SecurityError(`Access denied: ${label} resolves outside allowed directory (symlink escape).`);
  }

  return realTarget;
}
