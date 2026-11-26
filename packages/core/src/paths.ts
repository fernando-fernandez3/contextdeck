import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { SecurityError } from './errors.js';

/**
 * Resolve the canonical path of `targetPath` by calling realpath on the
 * deepest existing ancestor and re-joining remaining segments.
 */
export async function canonicalizePath(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath);
  const tail: string[] = [];
  let current = resolved;

  for (;;) {
    try {
      const real = await fs.realpath(current);
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw err;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return resolved;
      }
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

export function canonicalizePathSync(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  const tail: string[] = [];
  let current = resolved;

  for (;;) {
    try {
      const real = fsSync.realpathSync(current);
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw err;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return resolved;
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
