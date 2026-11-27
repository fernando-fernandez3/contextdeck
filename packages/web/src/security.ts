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
  'srcset',
  'action',
  'formaction',
  'poster',
  'cite',
  'data',
  'background',
  'ping',
  'dynsrc',
  'lowsrc',
  'longdesc',
  'profile',
  'codebase',
  'archive',
]);

const SVG_URL_PRESENTATION_ATTRS = new Set([
  'fill',
  'stroke',
  'filter',
  'clip-path',
  'mask',
  'mask-image',
  'marker',
  'marker-start',
  'marker-mid',
  'marker-end',
  'cursor',
  'shape-outside',
  'offset-path',
]);

const MAX_CSS_DECODE_PASSES = 16;

function stripCssComments(css: string): string {
  // Replace comments (including unclosed trailing /*) with a single space so
  // adjacent tokens cannot concatenate into a new identifier/function token.
  return css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ' ');
}

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

function decodeCssToFixedPoint(cssText: string): string {
  let current = stripCssComments(cssText);
  for (let pass = 0; pass < MAX_CSS_DECODE_PASSES; pass += 1) {
    const next = stripCssComments(decodeCssEscapes(current));
    if (next === current) break;
    current = next;
  }
  return current;
}

function dropSegmentsWithBackslash(css: string): string {
  if (!css.includes('\\')) return css;

  // Fail closed on any backslash surviving bounded fixed-point escape decoding:
  // drop any rule block (stylesheet) or declaration (inline style) containing '\',
  // and if any '\' remains afterwards, drop the entire CSS text.
  if (css.includes('{') || css.includes('}')) {
    const kept: string[] = [];
    let start = 0;
    let braceDepth = 0;
    let quote: '"' | "'" | null = null;
    for (let i = 0; i < css.length; i += 1) {
      const ch = css[i];
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '{') {
        braceDepth += 1;
      } else if (ch === '}') {
        if (braceDepth > 0) braceDepth -= 1;
        if (braceDepth === 0) {
          const rule = css.slice(start, i + 1);
          if (!rule.includes('\\')) kept.push(rule);
          start = i + 1;
        }
      } else if (ch === ';' && braceDepth === 0) {
        const stmt = css.slice(start, i + 1);
        if (!stmt.includes('\\')) kept.push(stmt);
        start = i + 1;
      }
    }
    if (start < css.length) {
      const tail = css.slice(start);
      if (!tail.includes('\\') && braceDepth === 0) kept.push(tail);
    }
    const joined = kept.join(' ');
    return joined.includes('\\') ? '' : joined;
  }

  const keptDecls: string[] = [];
  let start = 0;
  let parenDepth = 0;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')' && parenDepth > 0) {
      parenDepth -= 1;
    } else if (ch === ';' && parenDepth === 0) {
      const decl = css.slice(start, i + 1);
      if (!decl.includes('\\')) keptDecls.push(decl);
      start = i + 1;
    }
  }
  if (start < css.length) {
    const tail = css.slice(start);
    if (!tail.includes('\\')) keptDecls.push(tail);
  }
  const joined = keptDecls.join(' ');
  return joined.includes('\\') ? '' : joined;
}

function stripCssAtImports(css: string): string {
  // Quote- and paren-aware scanner that removes every @import rule (even when
  // its quoted URL contains '{', '}', or ';'). Fails closed if any @import remains.
  let current = css;
  for (let pass = 0; pass < 8; pass += 1) {
    if (!/@import(?![a-z0-9_-])/i.test(current)) break;
    let out = '';
    let i = 0;
    let quote: '"' | "'" | null = null;

    while (i < current.length) {
      const ch = current[i];
      if (quote) {
        out += ch;
        if (ch === quote) quote = null;
        i += 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        out += ch;
        i += 1;
        continue;
      }
      if (ch === '@' && /^@import(?![a-z0-9_-])/i.test(current.slice(i))) {
        out += ' ';
        i += '@import'.length;
        let importQuote: '"' | "'" | null = null;
        let parenDepth = 0;
        while (i < current.length) {
          const c = current[i];
          if (importQuote) {
            if (c === importQuote) importQuote = null;
            i += 1;
            continue;
          }
          if (c === '"' || c === "'") {
            importQuote = c;
            i += 1;
            continue;
          }
          if (c === '(') {
            parenDepth += 1;
            i += 1;
            continue;
          }
          if (c === ')' && parenDepth > 0) {
            parenDepth -= 1;
            i += 1;
            continue;
          }
          if (parenDepth === 0 && c === ';') {
            i += 1;
            break;
          }
          if (parenDepth === 0 && c === '}') {
            break;
          }
          i += 1;
        }
        continue;
      }
      out += ch;
      i += 1;
    }

    if (out === current) break;
    current = out;
  }

  return /@import(?![a-z0-9_-])/i.test(current) ? '' : current;
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
  const fnRe =
    /(^|[^a-z0-9_-])(url|image-set|-webkit-image-set|src|image|cross-fade|-webkit-cross-fade)\s*\(/gi;
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
        : fnName === 'image-set' || fnName === '-webkit-image-set'
          ? isSafeImageSetInner(inner)
          : false;
    out += safe ? css.slice(fnStart, i) : 'none';
    cursor = i;
  }

  return out;
}

function sanitizeSvgStyleText(cssText: string): string {
  // R3-1 / R2-2 / H15 / D5: Strip comments and decode CSS escapes to a fixed point,
  // fail closed on any remaining backslash, strip all @import rules with a
  // quote/paren-aware scanner, and neutralize any url()/image-set()/src()/image()/cross-fade()
  // targeting anything other than a local #fragment or raster data:image/ URI
  // (including inside custom properties).
  const decoded = dropSegmentsWithBackslash(decodeCssToFixedPoint(cssText));
  if (!decoded) return '';
  const withoutImports = stripCssAtImports(decoded);
  if (!withoutImports) return '';
  let result = sanitizeCssResourceFunctions(withoutImports);
  for (let pass = 0; pass < 4; pass += 1) {
    const next = sanitizeCssResourceFunctions(result);
    if (next === result) break;
    result = next;
  }
  if (result.includes('\\') || /@import(?![a-z0-9_-])/i.test(result)) {
    return '';
  }
  return result;
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
      if (/[(\\/*@]/.test(data.attrValue)) {
        const cleanedVal = sanitizeSvgStyleText(data.attrValue);
        if (!cleanedVal.trim()) {
          data.keepAttr = false;
        } else {
          data.attrValue = cleanedVal;
        }
      }
      return;
    }

    if (attrName === 'href' || attrName === 'xlink:href') {
      const val = (data.attrValue ?? '').replace(/[\u0000-\u001f\u007f]+/g, '').trim();
      if (node.tagName.toLowerCase() === 'a') {
        if (/^[/\\]{2}/.test(val) || !SAFE_SVG_URI_REGEX.test(val)) {
          data.keepAttr = false;
        }
      } else if (!SAFE_CSS_FRAGMENT_REGEX.test(val)) {
        // R3-1: Restrict href / xlink:href to local #fragment on every element except <a>
        data.keepAttr = false;
      }
      return;
    }

    if (SVG_URI_ATTRS.has(attrName)) {
      const val = (data.attrValue ?? '').replace(/[\u0000-\u001f\u007f]+/g, '').trim();
      if (/^[/\\]{2}/.test(val) || !SAFE_SVG_URI_REGEX.test(val)) {
        data.keepAttr = false;
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
        'background',
        'src',
        'srcset',
        'poster',
        'data',
        'ping',
        'action',
        'formaction',
        'cite',
        'dynsrc',
        'lowsrc',
        'longdesc',
        'profile',
        'codebase',
        'archive',
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
