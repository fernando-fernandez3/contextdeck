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

const SAFE_URI_REGEX = /^(?:https?:\/\/|mailto:|\/(?!\/)|#)/i;
const SAFE_SVG_URI_REGEX = /^(?:https?:\/\/|\/(?!\/)|#|[^a-z/\s]|(?![a-z][a-z0-9+.\-]*:)[a-z])/i;

function sanitizeSvgStyleText(cssText: string): string {
  // Strip CSS comments that could obfuscate @import or url(), strip @import rules,
  // and replace any external/non-fragment url(...) with none (H15, D5).
  return cssText
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@(?:\\69|\\49|i)(?:\\6d|\\4d|m)(?:\\70|\\50|p)(?:\\6f|\\4f|o)(?:\\72|\\52|r)(?:\\74|\\54|t)\b[^;]*(?:;|$)/gi, '')
    .replace(/@import\b[^;]*(?:;|$)/gi, '')
    .replace(/url\(\s*(?:(['"])\s*(?!#)[\s\S]*?\1|(?!\s*['"]?\s*#)[^)]*)\)/gi, 'none');
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
    const val = (data.attrValue ?? '').trim();
    if (
      (attrName === 'href' ||
        attrName === 'xlink:href' ||
        attrName === 'src' ||
        attrName === 'action' ||
        attrName === 'formaction') &&
      val.startsWith('//')
    ) {
      data.keepAttr = false;
      return;
    }
    if (node.tagName.toLowerCase() === 'use' && (attrName === 'href' || attrName === 'xlink:href')) {
      if (!/^#[A-Za-z0-9_.:-]+$/.test(val)) {
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
