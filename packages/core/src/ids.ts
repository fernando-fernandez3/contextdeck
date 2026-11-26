import crypto from 'node:crypto';
import { ValidationError } from './errors.js';

/** Board slugs must be lowercase (D6) to prevent case-insensitive FS collisions and path traversal. */
export const BOARD_SLUG_REGEX = /^[a-z0-9][a-z0-9_-]{0,80}$/;

/** Entity IDs and global workspace names (AC2.6 / D6). */
export const ENTITY_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;

export const WORKSPACE_NAME_REGEX = ENTITY_ID_REGEX;

export function validateBoardSlug(slug: string, label = 'board slug'): string {
  if (typeof slug !== 'string' || !BOARD_SLUG_REGEX.test(slug)) {
    throw new ValidationError(
      `Invalid ${label} "${String(slug)}". Must match ${BOARD_SLUG_REGEX.source}.`,
    );
  }
  return slug;
}

export function validateEntityId(id: string, label = 'id'): string {
  if (typeof id !== 'string' || !ENTITY_ID_REGEX.test(id)) {
    throw new ValidationError(
      `Invalid ${label} "${String(id)}". Must match ${ENTITY_ID_REGEX.source}.`,
    );
  }
  return id;
}

export function validateWorkspaceName(name: string): string {
  if (typeof name !== 'string' || !WORKSPACE_NAME_REGEX.test(name)) {
    throw new ValidationError(
      `Invalid workspace name "${String(name)}". Must match ${WORKSPACE_NAME_REGEX.source}.`,
    );
  }
  return name;
}

export function validateHttpUrl(url: string, label = 'externalUrl'): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError(`Invalid ${label}: must be a valid http(s) URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError(`Invalid ${label}: only http: and https: protocols are allowed.`);
  }
  return url;
}

export function slugify(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || 'item';
}

export function shortId(prefix: string): string {
  const rand = crypto.randomBytes(4).toString('hex');
  return `${prefix}_${rand}`;
}

export function nextSequentialId(prefix: string, existingIds: string[]): string {
  const regex = new RegExp(`^${prefix}_(\\d+)$`);
  let max = 0;
  for (const id of existingIds) {
    const match = id.match(regex);
    if (match) {
      const n = Number.parseInt(match[1], 10);
      if (n > max) max = n;
    }
  }
  return `${prefix}_${String(max + 1).padStart(3, '0')}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
