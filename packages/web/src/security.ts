import DOMPurify from 'dompurify';
import { marked } from 'marked';

export const HTML_ARTIFACT_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:";

export const MERMAID_CONFIG = {
  startOnLoad: false,
  theme: 'dark' as const,
  securityLevel: 'strict' as const,
  fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
};

const SAFE_URI_REGEX = /^(?:https?:\/\/|mailto:|\/|#)/i;

export function isSafeHttpUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function sanitizeMarkdownHtml(markdown: string): string {
  const rawHtml = marked.parse(markdown || '', { async: false, breaks: true }) as string;
  return DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'style', 'form', 'input', 'textarea', 'button'],
    FORBID_ATTR: [
      'onerror',
      'onload',
      'onclick',
      'onmouseover',
      'onfocus',
      'onblur',
      'onmouseenter',
      'style',
    ],
    ALLOWED_URI_REGEXP: SAFE_URI_REGEX,
  });
}

export function sanitizeMermaidSvg(svg: string): string {
  return DOMPurify.sanitize(svg || '', {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    ADD_TAGS: ['foreignObject'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed'],
    FORBID_ATTR: [
      'onload',
      'onerror',
      'onclick',
      'onmouseover',
      'onfocus',
      'onblur',
      'onmouseenter',
    ],
    ALLOWED_URI_REGEXP: /^(?:https?:\/\/|#)/i,
  });
}

export function wrapHtmlArtifactSrcDoc(html: string): string {
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${HTML_ARTIFACT_CSP}">`;
  const source = html || '';
  const headMatch = source.match(/<head\b[^>]*>/i);
  if (headMatch && headMatch.index !== undefined) {
    const insertAt = headMatch.index + headMatch[0].length;
    return `${source.slice(0, insertAt)}\n${cspMeta}\n${source.slice(insertAt)}`;
  }
  const htmlMatch = source.match(/<html\b[^>]*>/i);
  if (htmlMatch && htmlMatch.index !== undefined) {
    const insertAt = htmlMatch.index + htmlMatch[0].length;
    return `${source.slice(0, insertAt)}\n<head>${cspMeta}</head>\n${source.slice(insertAt)}`;
  }
  return `<!doctype html><html><head>${cspMeta}</head><body>${source}</body></html>`;
}
