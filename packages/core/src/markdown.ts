import yaml from 'js-yaml';

export interface ParsedFrontmatter<T = Record<string, unknown>> {
  data: T;
  body: string;
}

export function parseFrontmatter<T = Record<string, unknown>>(raw: string): ParsedFrontmatter<T> {
  const normalized = raw.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { data: {} as T, body: normalized };
  }
  const endIndex = normalized.indexOf('\n---\n', 4);
  if (endIndex === -1) {
    if (normalized.endsWith('\n---')) {
      const yamlChunk = normalized.slice(4, normalized.length - 4);
      const parsed = (yaml.load(yamlChunk) ?? {}) as T;
      return { data: parsed, body: '' };
    }
    return { data: {} as T, body: normalized };
  }
  const yamlChunk = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 5).replace(/^\n/, '');
  const parsed = (yaml.load(yamlChunk) ?? {}) as T;
  return { data: parsed, body };
}

export function stringifyFrontmatter(data: Record<string, unknown>, body: string): string {
  const cleaned = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
  const yamlBlock = yaml.dump(cleaned, {
    lineWidth: 100,
    noRefs: true,
    sortKeys: false,
  });
  const trimmedBody = body.trimEnd();
  return `---\n${yamlBlock}---\n${trimmedBody ? `\n${trimmedBody}\n` : ''}`;
}
