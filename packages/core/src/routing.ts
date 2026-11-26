import path from 'node:path';
import { NotFoundError, ValidationError } from './errors.js';
import { canonicalizePathSync } from './paths.js';
import type { BoardConfig } from './schemas.js';

export interface GlobSpecificity {
  literalPrefixLen: number;
  segmentCount: number;
  exactSegmentCount: number;
}

const GLOB_META_REGEX = /[*?[]/;

/**
 * Normalize a board path glob into clean POSIX relative form.
 * Returns null if the glob is invalid or contains traversal segments.
 */
export function normalizeBoardGlob(rawGlob: string): string | null {
  const trimmed = rawGlob.trim().replace(/\\/g, '/');
  if (!trimmed || trimmed.includes('\0')) return null;

  let cleaned = trimmed.replace(/^(?:\.\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!cleaned) return '.';

  const parts = cleaned.split('/');
  for (const part of parts) {
    if (part === '..' || part === '') {
      return null;
    }
  }
  cleaned = parts.join('/');
  return cleaned;
}

function normalizeRelativePath(relPath: string): string | null {
  const posix = relPath.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!posix || posix === '.') return '';
  const parts = posix.split('/');
  for (const part of parts) {
    if (part === '..' || part === '') return null;
  }
  return parts.join('/');
}

/**
 * Match a single path segment against a glob segment supporting `*`, `?`, and `[...]`.
 * Iterative/DP matching guarantees O(n*m) worst-case runtime (zero ReDoS risk).
 */
function matchSingleSegment(pattern: string, segment: string): boolean {
  const pLen = pattern.length;
  const sLen = segment.length;
  const memo = new Map<number, boolean>();

  const matchFrom = (pi: number, si: number): boolean => {
    const key = pi * (sLen + 1) + si;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let result = false;
    if (pi === pLen && si === sLen) {
      result = true;
    } else if (pi < pLen && pattern[pi] === '*') {
      // '*' matches zero or more chars in this segment
      result = matchFrom(pi + 1, si) || (si < sLen && matchFrom(pi, si + 1));
    } else if (pi < pLen && si < sLen) {
      if (pattern[pi] === '?') {
        result = matchFrom(pi + 1, si + 1);
      } else if (pattern[pi] === '[') {
        const closeIdx = pattern.indexOf(']', pi + 1);
        if (closeIdx > pi + 1) {
          let body = pattern.slice(pi + 1, closeIdx);
          let negate = false;
          if (body.startsWith('!') || body.startsWith('^')) {
            negate = true;
            body = body.slice(1);
          }
          const ch = segment[si];
          let matchedChar = false;
          for (let i = 0; i < body.length; i += 1) {
            if (i + 2 < body.length && body[i + 1] === '-') {
              if (ch >= body[i] && ch <= body[i + 2]) {
                matchedChar = true;
                break;
              }
              i += 2;
            } else if (body[i] === ch) {
              matchedChar = true;
              break;
            }
          }
          if (negate ? !matchedChar : matchedChar) {
            result = matchFrom(closeIdx + 1, si + 1);
          }
        } else if (pattern[pi] === segment[si]) {
          result = matchFrom(pi + 1, si + 1);
        }
      } else if (pattern[pi] === segment[si]) {
        result = matchFrom(pi + 1, si + 1);
      }
    }

    memo.set(key, result);
    return result;
  };

  return matchFrom(0, 0);
}

/**
 * Match a POSIX relative directory path against a board `paths` glob (AC6.2, D15).
 * - Plain directory prefixes (no wildcards) match the exact directory or any descendant on a segment boundary.
 * - `**` matches zero or more path segments (so `packages/web/**` matches `packages/web` and `packages/web/src`).
 * - `*` matches within a single segment only.
 */
export function matchBoardPathGlob(rawGlob: string, rawRelPath: string): boolean {
  const normGlob = normalizeBoardGlob(rawGlob);
  const normRel = normalizeRelativePath(rawRelPath);
  if (normGlob === null || normRel === null) return false;

  if (normGlob === '.') {
    return normRel === '';
  }
  if (normGlob === '**') {
    return true;
  }

  // Plain literal directory prefix (no wildcards): match exact dir or any descendant
  if (!GLOB_META_REGEX.test(normGlob)) {
    return normRel === normGlob || normRel.startsWith(`${normGlob}/`);
  }

  const patSegs = normGlob.split('/');
  const pathSegs = normRel === '' ? [] : normRel.split('/');
  const memo = new Map<number, boolean>();

  const matchSegs = (pi: number, si: number): boolean => {
    const key = pi * (pathSegs.length + 1) + si;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let result = false;
    if (pi === patSegs.length && si === pathSegs.length) {
      result = true;
    } else if (pi < patSegs.length && patSegs[pi] === '**') {
      result = matchSegs(pi + 1, si) || (si < pathSegs.length && matchSegs(pi, si + 1));
    } else if (pi < patSegs.length && si < pathSegs.length) {
      if (matchSingleSegment(patSegs[pi], pathSegs[si])) {
        result = matchSegs(pi + 1, si + 1);
      }
    }

    memo.set(key, result);
    return result;
  };

  return matchSegs(0, 0);
}

/**
 * Compute deterministic D15 specificity tuple for a board path glob:
 * 1. Longest leading literal prefix (chars before first wildcard, stripping trailing `/`).
 * 2. Segment count (count of non-globstar segments, so `packages/web/*` beats `packages/web/**`).
 * 3. Exact (non-wildcard) segment count so exact segments beat wildcarded segments on ties (N1).
 */
export function computeGlobSpecificity(rawGlob: string): GlobSpecificity {
  const norm = normalizeBoardGlob(rawGlob);
  if (!norm || norm === '.' || norm === '**') {
    return { literalPrefixLen: 0, segmentCount: 0, exactSegmentCount: 0 };
  }

  const metaIdx = norm.search(GLOB_META_REGEX);
  const literalPrefix =
    metaIdx === -1 ? norm : norm.slice(0, metaIdx).replace(/\/+$/, '');
  const segments = norm.split('/').filter((seg) => seg !== '' && seg !== '**');
  const exactSegmentCount = segments.filter((seg) => !GLOB_META_REGEX.test(seg)).length;

  return {
    literalPrefixLen: literalPrefix.length,
    segmentCount: segments.length,
    exactSegmentCount,
  };
}

function compareSpecificity(a: GlobSpecificity, b: GlobSpecificity): number {
  if (a.literalPrefixLen !== b.literalPrefixLen) {
    return a.literalPrefixLen - b.literalPrefixLen;
  }
  if (a.segmentCount !== b.segmentCount) {
    return a.segmentCount - b.segmentCount;
  }
  return a.exactSegmentCount - b.exactSegmentCount;
}

/**
 * Resolve which board owns a session's `cwd` relative to `projectRoot` (AC6.2, D15).
 * Deterministic tie-breaking:
 *   1. Longest literal prefix
 *   2. Higher segment count (excluding `**`)
 *   3. Higher exact (non-wildcard) segment count (N1)
 *   4. Lexicographically smaller board slug (deterministic ASCII code-unit order)
 * Falls back to `defaultBoard` if no board matches or `cwd` is outside `projectRoot`.
 */
export function routeBoardForCwd(
  boards: BoardConfig[],
  cwd: string | undefined,
  projectRoot: string | undefined,
  defaultBoard: string,
): string {
  if (!cwd || !projectRoot || boards.length === 0) {
    return defaultBoard;
  }

  let relPosix: string;
  try {
    const realRoot = canonicalizePathSync(path.resolve(projectRoot));
    const realCwd = canonicalizePathSync(path.resolve(cwd));
    const rel = path.relative(realRoot, realCwd);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      return defaultBoard;
    }
    relPosix = rel.split(path.sep).join('/');
  } catch {
    return defaultBoard;
  }

  let winner: { slug: string; spec: GlobSpecificity } | null = null;

  for (const board of boards) {
    if (!board.paths || board.paths.length === 0) continue;

    let bestForBoard: GlobSpecificity | null = null;
    for (const pattern of board.paths) {
      if (!matchBoardPathGlob(pattern, relPosix)) continue;
      const spec = computeGlobSpecificity(pattern);
      if (!bestForBoard || compareSpecificity(spec, bestForBoard) > 0) {
        bestForBoard = spec;
      }
    }

    if (!bestForBoard) continue;

    if (!winner) {
      winner = { slug: board.slug, spec: bestForBoard };
    } else {
      const cmp = compareSpecificity(bestForBoard, winner.spec);
      if (cmp > 0 || (cmp === 0 && board.slug < winner.slug)) {
        winner = { slug: board.slug, spec: bestForBoard };
      }
    }
  }

  return winner ? winner.slug : defaultBoard;
}

/**
 * Validate `parentBoard` assignment against existing boards (D15):
 * - Rejects self-parent (`targetSlug === parentBoard`)
 * - Rejects missing parent (`NotFoundError`)
 * - Rejects any direct or indirect cycle (`ValidationError`)
 */
export function validateBoardParentHierarchy(
  boards: BoardConfig[],
  targetSlug: string,
  parentBoard: string | null | undefined,
): void {
  if (parentBoard === null || parentBoard === undefined) {
    return;
  }

  if (parentBoard === targetSlug) {
    throw new ValidationError(`Board "${targetSlug}" cannot set itself as parentBoard.`);
  }

  const bySlug = new Map(boards.map((b) => [b.slug, b]));
  if (!bySlug.has(parentBoard)) {
    throw new NotFoundError(`Parent board "${parentBoard}" does not exist.`);
  }

  const visited = new Set<string>([targetSlug]);
  let cursor: string | null | undefined = parentBoard;
  while (cursor) {
    if (visited.has(cursor)) {
      throw new ValidationError(
        `Board hierarchy cycle detected: "${targetSlug}" cannot have parentBoard "${parentBoard}".`,
      );
    }
    visited.add(cursor);
    cursor = bySlug.get(cursor)?.parentBoard ?? null;
  }
}
