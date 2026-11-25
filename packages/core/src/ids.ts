import crypto from 'node:crypto';

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
