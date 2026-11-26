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

const SAFE_URI_REGEX = /^(?:https?:\/\/(?![/\\])|mailto:|\/(?![/\\])|#)/i;
const SAFE_SVG_URI_REGEX =
  /^(?:https?:\/\/(?![/\\])|\/(?![/\\])|#|(?![/\\]|(?=[a-z][a-z0-9+.\-]*:))[a-z0-9._~-])/i;
const SAFE_CSS_FRAGMENT_REGEX = /^#[A-Za-z0-9_.:-]+$/;
const SAFE_RASTER_DATA_IMAGE_REGEX =
  /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)(?:;charset=[a-z0-9-]+)?(?:;base64)?,[a-z0-9+/=%._-]+$/i;

const SVG_URI_ATTRS = new Set([
  'href',
  'xlink:href',
  'src',
  'action',
  'formaction',
  'poster',
  'cite',
  'data',
  'background',
  'ping',
]);

const SVG_URL_PRESENTATION_ATTRS = new Set([
  'fill',
  'stroke',
  'filter',
  'clip-path',
  'mask',
  'marker-start',
  'marker-mid',
  'marker-end',
]);

function decodeCssEscapes(css: string): string {
  // CSS Syntax Level 3 §4.3.7: decode 1-6 hex digit escapes (with optional single
  // trailing whitespace), backslash-newline continuations, and backslash-char escapes.
  return css.replace(
    /\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\r\n\f])?|(?:\r\n|[\r\n\f])|([^\r\n\f]))/g,
    (_match, hex: string | undefined, literal: string | undefined) => {
      if (hex !== undefined) {
        const cp = Number.parseInt(hex, 16);
        if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
          return '\uFFFD';
        }
        return String.fromCodePoint(cp);
      }
      if (literal !== undefined) {
        return literal;
      }
      return '';
    },
  );
}

function unwrapCssString(raw: string): string {
  const trimmed = raw.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function isSafeCssResourceTarget(rawTarget: string): boolean {
  const target = unwrapCssString(rawTarget);
  if (!target) return false;
  return SAFE_CSS_FRAGMENT_REGEX.test(target) || SAFE_RASTER_DATA_IMAGE_REGEX.test(target);
}

function splitTopLevelCommas(input: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')' && depth > 0) {
      depth -= 1;
    } else if (ch === ',' && depth === 0) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  return parts;
}

function isSafeImageSetInner(inner: string): boolean {
  const candidates = splitTopLevelCommas(inner)
    .map((s) => s.trim())
    .filter(Boolean);
  if (candidates.length === 0) return false;
  for (const cand of candidates) {
    const urlMatch = cand.match(/^url\(\s*([\s\S]*?)\s*\)(?:\s+.*)?$/i);
    if (urlMatch) {
      if (!isSafeCssResourceTarget(urlMatch[1])) return false;
      continue;
    }
    const strMatch = cand.match(/^("(?:[^"]*)"|'(?:[^']*)')(?:\s+.*)?$/);
    if (strMatch) {
      if (!isSafeCssResourceTarget(strMatch[1])) return false;
      continue;
    }
    return false;
  }
  return true;
}

function sanitizeCssResourceFunctions(css: string): string {
  const fnRe = /(^|[^a-z0-9_-])(url|image-set|-webkit-image-set|src)\s*\(/gi;
  let out = '';
  let cursor = 0;

  while (cursor < css.length) {
    fnRe.lastIndex = cursor;
    const match = fnRe.exec(css);
    if (!match) {
      out += css.slice(cursor);
      break;
    }

    const prefix = match[1];
    const fnName = match[2].toLowerCase();
    const fnStart = match.index + prefix.length;
    const argStart = fnRe.lastIndex;

    // Scan to matching closing paren while respecting quoted strings and nested parens
    let depth = 1;
    let quote: '"' | "'" | null = null;
    let i = argStart;
    for (; i < css.length && depth > 0; i += 1) {
      const ch = css[i];
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '(') {
        depth += 1;
      } else if (ch === ')') {
        depth -= 1;
      }
    }

    out += css.slice(cursor, fnStart);
    if (depth !== 0) {
      // Unclosed resource function -> neutralize to end of declaration/input
      out += 'none';
      cursor = css.length;
      break;
    }

    const inner = css.slice(argStart, i - 1);
    const safe =
      fnName === 'url' || fnName === 'src'
        ? isSafeCssResourceTarget(inner)
        : isSafeImageSetInner(inner);
    out += safe ? css.slice(fnStart, i) : 'none';
    cursor = i;
  }

  return out;
}

function sanitizeSvgStyleText(cssText: string): string {
  // R2-2 / H15 / D5: Strip comments, decode CSS escapes, strip comments again,
  // remove @import rules, and neutralize any url()/image-set()/-webkit-image-set()/src()
  // targeting anything other than a local #fragment or raster data:image/ URI.
  const normalized = decodeCssEscapes(cssText.replace(/\/\*[\s\S]*?\*\//g, ''))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@import\b[^;{}]*(?:;|$)/gi, '');
  return sanitizeCssResourceFunctions(normalized);
}

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
  const attrHook = (
    node: Element,
    data: { attrName: string; attrValue: string; keepAttr: boolean },
  ) => {
    const attrName = data.attrName.toLowerCase();
    if (attrName === 'style') {
      const sanitizedStyle = sanitizeSvgStyleText(data.attrValue ?? '');
      if (!sanitizedStyle.trim()) {
        data.keepAttr = false;
      } else {
        data.attrValue = sanitizedStyle;
      }
      return;
    }

    if (SVG_URL_PRESENTATION_ATTRS.has(attrName) && data.attrValue) {
      if (/url\s*\(|image-set|src\s*\(|\\|\/\*/i.test(data.attrValue)) {
        data.attrValue = sanitizeSvgStyleText(data.attrValue);
      }
      return;
    }

    if (SVG_URI_ATTRS.has(attrName)) {
      const val = (data.attrValue ?? '').replace(/[\u0000-\u001f\u007f]+/g, '').trim();
      if (/^[/\\]{2}/.test(val) || !SAFE_SVG_URI_REGEX.test(val)) {
        data.keepAttr = false;
        return;
      }
      if (node.tagName.toLowerCase() === 'use' && (attrName === 'href' || attrName === 'xlink:href')) {
        if (!SAFE_CSS_FRAGMENT_REGEX.test(val)) {
          data.keepAttr = false;
        }
      }
    }
  };

  const elemHook = (node: Node) => {
    if (node.nodeType === 1) {
      const el = node as Element;
      if (el.tagName.toLowerCase() === 'style' && el.textContent) {
        el.textContent = sanitizeSvgStyleText(el.textContent);
      }
    }
  };

  DOMPurify.addHook('uponSanitizeAttribute', attrHook);
  DOMPurify.addHook('afterSanitizeElements', elemHook);
  try {
    return DOMPurify.sanitize(svg || '', {
      USE_PROFILES: { svg: true, svgFilters: true, html: true },
      ADD_TAGS: ['foreignObject', 'use'],
      HTML_INTEGRATION_POINTS: { foreignobject: true },
      FORBID_TAGS: [
        'script',
        'iframe',
        'object',
        'embed',
        'form',
        'input',
        'textarea',
        'button',
        'image',
        'img',
        'feimage',
        'video',
        'audio',
        'source',
        'link',
        'meta',
        'base',
      ],
      FORBID_ATTR: [
        'onload',
        'onerror',
        'onclick',
        'onmouseover',
        'onfocus',
        'onblur',
        'onmouseenter',
      ],
      ALLOWED_URI_REGEXP: SAFE_SVG_URI_REGEX,
    });
  } finally {
    DOMPurify.removeHook('uponSanitizeAttribute');
    DOMPurify.removeHook('afterSanitizeElements');
  }
}

export function wrapHtmlArtifactSrcDoc(html: string): string {
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${HTML_ARTIFACT_CSP}">`;
  const source = (html || '').replace(/^\uFEFF?\s*(?:<!doctype\b[^>]*>\s*)*/i, '');
  return `<!doctype html>${cspMeta}${source}`;
}
