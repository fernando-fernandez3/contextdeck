import DOMPurify from 'dompurify';
import { marked } from 'marked';

export const HTML_ARTIFACT_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:";

export const MERMAID_CONFIG = {
  startOnLoad: false,
  theme: 'dark' as const,
  securityLevel: 'strict' as const,
  fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
  // R4-2: Prevent untrusted %%{init: ...}%% directives from injecting raw themeCSS
  // into document.body during mermaid.render() before sanitizeMermaidSvg runs.
  secure: [
    'secure',
    'securityLevel',
    'startOnLoad',
    'maxTextSize',
    'suppressErrorRendering',
    'maxEdges',
    'themeCSS',
    'fontFamily',
    'altFontFamily',
  ],
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

function isCssNewline(ch: string): boolean {
  return ch === '\n' || ch === '\r' || ch === '\f';
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
        if (ch === quote || isCssNewline(ch)) quote = null;
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
      if (ch === quote || isCssNewline(ch)) quote = null;
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
        if (ch === quote || isCssNewline(ch)) quote = null;
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
            if (c === importQuote || isCssNewline(c)) importQuote = null;
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

const RESOURCE_FN_STICKY_RE =
  /(url|image-set|-webkit-image-set|src|image|cross-fade|-webkit-cross-fade)\s*\(/iy;
const FAIL_CLOSED_RESOURCE_FN_RE =
  /(?<![a-z0-9_-])(url|src|image|image-set|-webkit-image-set|cross-fade|-webkit-cross-fade)\s*\(/gi;

function sanitizeCssResourceFunctions(css: string): string {
  // R4-2: Track CSS string quotes (terminating on matching quote or unescaped newline per
  // CSS Syntax Level 3 §4.3.5) so resource function names inside strings never desync the
  // scanner. Replace image-set/-webkit-image-set/image/cross-fade unconditionally with none.
  let out = '';
  let i = 0;
  let quote: '"' | "'" | null = null;

  while (i < css.length) {
    const ch = css[i];
    if (quote) {
      out += ch;
      if (ch === quote || isCssNewline(ch)) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }

    const atTokenBoundary = i === 0 || !/[a-z0-9_-]/i.test(css[i - 1]);
    if (atTokenBoundary) {
      RESOURCE_FN_STICKY_RE.lastIndex = i;
      const match = RESOURCE_FN_STICKY_RE.exec(css);
      if (match) {
        const fnName = match[1].toLowerCase();
        const argStart = RESOURCE_FN_STICKY_RE.lastIndex;

        let depth = 1;
        let innerQuote: '"' | "'" | null = null;
        let j = argStart;
        for (; j < css.length && depth > 0; j += 1) {
          const c = css[j];
          if (innerQuote) {
            if (c === innerQuote || isCssNewline(c)) innerQuote = null;
            continue;
          }
          if (c === '"' || c === "'") {
            innerQuote = c;
          } else if (c === '(') {
            depth += 1;
          } else if (c === ')') {
            depth -= 1;
          }
        }

        if (depth !== 0) {
          // Unclosed resource function -> neutralize remainder
          out += 'none';
          break;
        }

        const inner = css.slice(argStart, j - 1);
        const safe = (fnName === 'url' || fnName === 'src') && isSafeCssResourceTarget(inner);
        out += safe ? css.slice(i, j) : 'none';
        i = j;
        continue;
      }
    }

    out += ch;
    i += 1;
  }

  return out;
}

function hasUnsafeCssResourceToken(css: string): boolean {
  // R4-2 fail-closed check: scan the entire CSS text (both outside and inside strings)
  // for any remaining resource-fetching function whose target is not strictly a local
  // #fragment or raster data:image/ URI. Any image/image-set/cross-fade fails closed.
  FAIL_CLOSED_RESOURCE_FN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FAIL_CLOSED_RESOURCE_FN_RE.exec(css)) !== null) {
    const fnName = match[1].toLowerCase();
    if (fnName !== 'url' && fnName !== 'src') {
      return true;
    }
    const argStart = match.index + match[0].length;
    const closeIdx = css.indexOf(')', argStart);
    if (closeIdx === -1) {
      return true;
    }
    const inner = css.slice(argStart, closeIdx);
    if (!isSafeCssResourceTarget(inner)) {
      return true;
    }
  }
  return false;
}

function sanitizeSvgStyleText(cssText: string): string {
  // R4-2 / R3-1 / R2-2 / H15 / D5: Strip comments and decode CSS escapes to a fixed point,
  // fail closed on any remaining backslash, strip all @import rules with a quote/paren-aware
  // scanner, neutralize resource functions with quote tracking (replacing image-set/image/
  // cross-fade unconditionally), and fail closed by dropping the entire style if any unsafe
  // resource function token remains anywhere (outside or inside strings).
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
  if (
    result.includes('\\') ||
    /@import(?![a-z0-9_-])/i.test(result) ||
    hasUnsafeCssResourceToken(result)
  ) {
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

export function isSafeHttpsUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
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
