// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  HTML_ARTIFACT_CSP,
  MERMAID_CONFIG,
  isSafeHttpUrl,
  sanitizeMarkdownHtml,
  sanitizeMermaidSvg,
  wrapHtmlArtifactSrcDoc,
} from '../src/security';

describe('@contextdeck/web content security (Bug 7, AC2.7, AC2.9, D5)', () => {
  it('sanitizes markdown HTML by stripping <img onerror>, <script>, and javascript: links', () => {
    const payload = [
      '# Hello',
      '<img src="x" onerror="alert(1)">',
      '<script>window.pwned = true</script>',
      '[Click me](javascript:alert(2))',
      '[Safe Link](https://example.com/docs)',
      '<a href="javascript:alert(3)">Raw JS Link</a>',
    ].join('\n\n');

    const sanitized = sanitizeMarkdownHtml(payload);
    expect(sanitized).toContain('<h1>Hello</h1>');
    expect(sanitized).toContain('https://example.com/docs');
    expect(sanitized.toLowerCase()).not.toContain('onerror');
    expect(sanitized.toLowerCase()).not.toContain('<script');
    expect(sanitized.toLowerCase()).not.toContain('javascript:');
  });

  it('exports Mermaid config with strict securityLevel', () => {
    expect(MERMAID_CONFIG.securityLevel).toBe('strict');
    expect(MERMAID_CONFIG.startOnLoad).toBe(false);
    expect(MERMAID_CONFIG.secure).toContain('themeCSS');
  });

  it('sanitizes Mermaid rendered SVG to neutralize script tags, event handlers, and javascript: hrefs while preserving diagram geometry and foreignObject labels (D5)', () => {
    const evilSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="100%"><g transform="translate(10,10)" onload="alert(1)"><path d="M10,10L50,50" marker-end="url(#arrow)"></path><rect x="-10" y="-10" width="120" height="40"></rect><foreignObject width="120" height="40"><div xmlns="http://www.w3.org/1999/xhtml"><span>Server Node</span><img src="x" onerror="alert(4)"/></div></foreignObject><script>alert(2)</script><a href="javascript:alert(3)"><text>Node</text></a></g></svg>';
    const cleaned = sanitizeMermaidSvg(evilSvg);
    expect(cleaned).toContain('<svg');
    expect(cleaned).toContain('viewBox="0 0 200 100"');
    expect(cleaned).toContain('d="M10,10L50,50"');
    expect(cleaned).toContain('width="120"');
    expect(cleaned).toContain('Server Node');
    expect(cleaned).toContain('Node');
    expect(cleaned.toLowerCase()).not.toContain('<script');
    expect(cleaned.toLowerCase()).not.toContain('onload');
    expect(cleaned.toLowerCase()).not.toContain('onerror');
    expect(cleaned.toLowerCase()).not.toContain('javascript:');
  });

  it('H15: blocks protocol-relative //, <image>, SVG <style> @import/external url(), <form>/<input>, and non-fragment <use> hrefs', () => {
    const v1 = sanitizeMermaidSvg('<svg><a href="//evil.example/phish"><text>x</text></a></svg>');
    expect(v1).not.toContain('//evil.example');

    const v2 = sanitizeMermaidSvg(
      '<svg><image href="https://evil.example/pixel.png" width="10" height="10"/></svg>',
    );
    expect(v2.toLowerCase()).not.toContain('<image');
    expect(v2).not.toContain('evil.example');

    const v3 = sanitizeMermaidSvg(
      '<svg><style>@import url("https://evil.example/x.css"); .node { background: url(https://evil.example/bg.png); fill: #fff; }</style><rect width="10" height="10"/></svg>',
    );
    expect(v3.toLowerCase()).not.toContain('@import');
    expect(v3).not.toContain('evil.example');
    expect(v3).toContain('fill: #fff');

    const v4 = sanitizeMermaidSvg(
      '<svg><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><form action="https://evil.example"><input name="x"/><textarea></textarea><button>Go</button></form><span>Safe Label</span></div></foreignObject></svg>',
    );
    expect(v4.toLowerCase()).not.toContain('<form');
    expect(v4.toLowerCase()).not.toContain('<input');
    expect(v4.toLowerCase()).not.toContain('<textarea');
    expect(v4.toLowerCase()).not.toContain('<button');
    expect(v4).toContain('Safe Label');

    const v5 = sanitizeMermaidSvg(
      '<svg><use href="https://evil.example/sprite.svg#x"/><use href="#local-arrow"/></svg>',
    );
    expect(v5).not.toContain('evil.example');
    expect(v5).toContain('#local-arrow');
  });

  it('R2-2: blocks all 9 Neon + 3 Codex external-request and protocol-relative SVG sanitizer bypasses while keeping safe Mermaid SVG intact', () => {
    const vectors: Array<{ name: string; svg: string }> = [
      // 9 Neon vectors
      {
        name: 'Neon 1: inline style url()',
        svg: '<svg><rect width="10" height="10" style="background:url(https://evil.example/leak.png)"></rect></svg>',
      },
      {
        name: 'Neon 2: foreignObject inline style url()',
        svg: '<svg><foreignObject><div xmlns="http://www.w3.org/1999/xhtml" style="background-image:url(https://evil.example/bg.png)">Hi</div></foreignObject></svg>',
      },
      {
        name: 'Neon 3: foreignObject HTML <img>',
        svg: '<svg><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="https://evil.example/pixel.png"></div></foreignObject></svg>',
      },
      {
        name: 'Neon 4: SVG filter <feImage>',
        svg: '<svg><defs><filter id="f"><feImage href="https://evil.example/fe.png"></feImage></filter></defs><rect filter="url(#f)"></rect></svg>',
      },
      {
        name: 'Neon 5: CSS zero-padded hex escape @\\0069mport',
        svg: '<svg><style>@\\0069mport "https://evil.example/x.css";</style></svg>',
      },
      {
        name: 'Neon 6: CSS hex escape u\\72 l()',
        svg: '<svg><style>.a { background: u\\72 l(https://evil.example/x.png); }</style></svg>',
      },
      {
        name: 'Neon 7: CSS image-set()',
        svg: '<svg><style>.a { background-image: image-set("https://evil.example/x.png" 1x); }</style></svg>',
      },
      {
        name: 'Neon 8: backslash protocol-relative /\\evil',
        svg: '<svg><a href="/\\evil.example/phish"><text>click</text></a></svg>',
      },
      {
        name: 'Neon 9: double backslash \\\\evil',
        svg: '<svg><a href="\\\\evil.example/phish"><text>click</text></a></svg>',
      },
      // 3 Codex vectors
      {
        name: 'Codex 1: foreignObject div style background-image url()',
        svg: '<svg><foreignObject><div style="background-image:url(https://evil.example/pixel)">test</div></foreignObject></svg>',
      },
      {
        name: 'Codex 2: foreignObject <img> without xmlns',
        svg: '<svg><foreignObject><img src="https://evil.example/pixel"></foreignObject></svg>',
      },
      {
        name: 'Codex 3: CSS hex escape @\\69 mport with trailing space',
        svg: '<svg><style>@\\69 mport "https://evil.example/style.css";</style></svg>',
      },
      // Additional scheme/escape/function/tag hardening vectors
      {
        name: 'mixed \\/ protocol-relative href',
        svg: '<svg><a href="\\/evil.example/phish"><text>click</text></a></svg>',
      },
      {
        name: 'CSS -webkit-image-set() and src()',
        svg: '<svg><style>.a { background-image: -webkit-image-set(url("https://evil.example/a.png") 1x); } @font-face { src: src("https://evil.example/font.woff2"); }</style></svg>',
      },
      {
        name: 'CSS backslash-char escape @\\import and u\\rl()',
        svg: '<svg><style>@\\import "https://evil.example/a.css"; .a { background: u\\r\\l("https://evil.example/b.png"); }</style></svg>',
      },
      {
        name: 'forbidden media/embed tags video/audio/source/link/meta/base',
        svg: '<svg><foreignObject><video src="https://evil.example/v.mp4"><source src="https://evil.example/s.mp4"/></video><audio src="https://evil.example/a.mp3"></audio><link rel="stylesheet" href="https://evil.example/c.css"/><meta http-equiv="refresh" content="0;url=https://evil.example/"/><base href="https://evil.example/"/></foreignObject></svg>',
      },
      {
        name: 'SVG data:image/svg+xml in CSS url() blocked (non-raster)',
        svg: '<svg><style>.a { background: url("data:image/svg+xml,<svg xmlns=http://www.w3.org/2000/svg/>"); }</style></svg>',
      },
    ];

    for (const vec of vectors) {
      const cleaned = sanitizeMermaidSvg(vec.svg);
      expect(cleaned.toLowerCase(), `Vector leaked external URL: ${vec.name}`).not.toContain(
        'evil.example',
      );
      expect(cleaned, `Vector leaked protocol-relative href: ${vec.name}`).not.toMatch(
        /href\s*=\s*["']\s*[/\\]{2}/i,
      );
      expect(cleaned.toLowerCase(), `Vector leaked non-raster svg data URI: ${vec.name}`).not.toContain(
        'image/svg+xml',
      );
    }

    // Safe fragment url(#id), raster data:image/png, and Mermaid inline styles remain intact
    const safeMermaid =
      '<svg viewBox="0 0 100 50"><defs><marker id="arrow"><path d="M0,0 L10,5 L0,10 Z"/></marker></defs><style>.node rect { fill: #18181b; background: url("data:image/png;base64,iVBORw0KGgo="); }</style><g style="max-width: 200px; stroke-width: 2px;"><path d="M0,0 L50,50" marker-end="url(#arrow)" style="fill: url(#arrow);"/></g></svg>';
    const cleanedSafe = sanitizeMermaidSvg(safeMermaid);
    expect(cleanedSafe).toContain('marker-end="url(#arrow)"');
    expect(cleanedSafe).toContain('max-width: 200px');
    expect(cleanedSafe).toContain('url(#arrow)');
    expect(cleanedSafe).toContain('data:image/png;base64,iVBORw0KGgo=');
  });

  it('R3-1: blocks double-backslash CSS escapes, @import with braces, custom-property url(), legacy fetch attributes, and non-<a> external hrefs with zero surviving CSS backslashes', () => {
    const vectors: Array<{ name: string; svg: string }> = [
      {
        name: '1: double-backslash style url()',
        svg: '<svg width="100" height="100"><style>.a{background:\\\\75rl("https://evil.example/hit-style-url")}</style><foreignObject width="100" height="100"><div class="a">x</div></foreignObject></svg>',
      },
      {
        name: '2: double-backslash @import',
        svg: '<svg width="100" height="100"><style>@\\\\69mport "https://evil.example/hit-at-import";</style></svg>',
      },
      {
        name: '3: double-backslash inline style url()',
        svg: '<svg width="100" height="100"><foreignObject width="100" height="100"><div style="background:\\\\75rl(https://evil.example/hit-inline-style)">x</div></foreignObject></svg>',
      },
      {
        name: '4: double-backslash image-set()',
        svg: '<svg width="100" height="100"><style>.b{background-image:\\\\69mage-set("https://evil.example/hit-image-set" 1x)}</style><foreignObject width="100" height="100"><div class="b">x</div></foreignObject></svg>',
      },
      {
        name: '5: @import URL containing closing brace }',
        svg: '<svg width="100" height="100"><style>@import "https://evil.example/hit-brace}css"; .keep { fill: #fff; }</style></svg>',
      },
      {
        name: '6: foreignObject table/td background attributes',
        svg: '<svg width="100" height="100"><foreignObject width="100" height="100"><table background="https://evil.example/hit-table-bg"><tr><td background="https://evil.example/hit-td-bg">x</td></tr></table></foreignObject></svg>',
      },
      {
        name: '7: custom property --u with double-backslash url()',
        svg: '<svg width="100" height="100"><style>:root { --u: \\\\75rl("https://evil.example/hit-custom-prop"); } .a { background: var(--u); }</style><foreignObject width="100" height="100"><div class="a">x</div></foreignObject></svg>',
      },
      {
        name: '8: non-<a> SVG external href/xlink:href on pattern, linearGradient, textPath',
        svg: '<svg><defs><pattern id="p" href="https://evil.example/pat.svg#p"/><linearGradient id="g" xlink:href="https://evil.example/grad.svg#g"/></defs><text><textPath href="https://evil.example/path.svg#t">hi</textPath></text></svg>',
      },
      {
        name: '9: deeply nested backslashes (>20 passes) fail closed with no surviving backslash',
        svg: `<svg><style>.safe { fill: #123456; } .evil { background: ${'\\'.repeat(40)}75rl("https://evil.example/deep"); }</style></svg>`,
      },
      {
        name: '10: legacy/resource-fetching HTML attributes stripped',
        svg: '<svg><foreignObject><div srcset="https://evil.example/s" poster="https://evil.example/p" data="https://evil.example/d" ping="https://evil.example/pi" action="https://evil.example/a" formaction="https://evil.example/fa" cite="https://evil.example/c" dynsrc="https://evil.example/dy" lowsrc="https://evil.example/lo" longdesc="https://evil.example/ld" profile="https://evil.example/pr" codebase="https://evil.example/cb" archive="https://evil.example/ar">ok</div></foreignObject></svg>',
      },
    ];

    for (const vec of vectors) {
      const cleaned = sanitizeMermaidSvg(vec.svg);
      expect(cleaned.toLowerCase(), `Vector leaked external URL: ${vec.name}`).not.toContain(
        'evil.example',
      );
      expect(cleaned.toLowerCase(), `Vector leaked @import: ${vec.name}`).not.toContain('@import');
      const doc = new DOMParser().parseFromString(cleaned, 'text/html');
      for (const styleEl of Array.from(doc.querySelectorAll('style'))) {
        expect(styleEl.textContent ?? '', `Surviving backslash in <style>: ${vec.name}`).not.toContain(
          '\\',
        );
      }
      for (const styledEl of Array.from(doc.querySelectorAll('[style]'))) {
        expect(
          styledEl.getAttribute('style') ?? '',
          `Surviving backslash in style attr: ${vec.name}`,
        ).not.toContain('\\');
      }
    }

    // Safe <a> https href and safe #fragment href on <pattern>/<linearGradient>/<textPath> still work
    const safeLinks = sanitizeMermaidSvg(
      '<svg><defs><linearGradient id="g1"><stop offset="0%"/></linearGradient><linearGradient id="g2" href="#g1"/><path id="p1" d="M0,0 L10,10"/></defs><text><textPath href="#p1">ok</textPath></text><a href="https://example.com/docs"><text>Docs</text></a></svg>',
    );
    expect(safeLinks).toContain('href="#g1"');
    expect(safeLinks).toContain('href="#p1"');
    expect(safeLinks).toContain('href="https://example.com/docs"');
  });

  it('R4-2: quote-desync image-set does not smuggle url()', () => {
    const vectors: Array<{ name: string; svg: string }> = [
      {
        name: '<style> quote-desync image-set smuggling url()',
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><style>.a { --x: "image-set("#a" "; } .t { background: url(https://evil.example/desync-style.png); } .c { --y: ")"; }</style><foreignObject width="100" height="100"><div class="t">x</div></foreignObject></svg>',
      },
      {
        name: 'inline style quote-desync image-set smuggling url()',
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="100" height="100"><div style=\'--x: "image-set("#a" "; background: url(https://evil.example/desync-inline.png); --y: ")"\'>x</div></foreignObject></svg>',
      },
      {
        name: '@font-face src quote-desync image-set smuggling url()',
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><style>.a { --x: "image-set("#a" "; } @font-face { font-family: Evil; src: url(https://evil.example/font.woff2); } .c { --y: ")"; }</style></svg>',
      },
      {
        name: 'image-set wildcard tail smuggling trailing CSS rule',
        svg: '<svg><style>.a { background-image: image-set("#a" ; } .t { background: url(https://evil.example/wildcard-tail.png)); } .b { background-image: -webkit-image-set(url(#a) ; } .u { background: url(https://evil.example/webkit-tail.png)); }</style></svg>',
      },
      {
        name: 'CSS Syntax 3 unescaped newline terminates string before url()',
        svg: '<svg><style>.a { --x: "unclosed\n; } .t { background: url(https://evil.example/newline-break.png); }</style></svg>',
      },
      {
        name: 'string-only "image-set(" vector fails closed',
        svg: '<svg><style>.a { --x: "image-set("; } .keep { fill: #fff; }</style><foreignObject><div style=\'--x: "image-set("\'>ok</div></foreignObject></svg>',
      },
      {
        name: 'benign image-set and -webkit-image-set are replaced unconditionally',
        svg: '<svg><style>.a { background-image: image-set("#a" 1x); } .b { background-image: -webkit-image-set(url(#a) 1x); }</style></svg>',
      },
      {
        name: 'string-smuggled url(https://...) fails closed',
        svg: '<svg><style>.a { --x: "url(https://evil.example/in-string.png)"; }</style></svg>',
      },
    ];

    for (const vec of vectors) {
      const cleaned = sanitizeMermaidSvg(vec.svg);
      expect(cleaned.toLowerCase(), `Vector leaked external URL: ${vec.name}`).not.toContain(
        'evil.example',
      );
      expect(cleaned.toLowerCase(), `Vector leaked image-set(: ${vec.name}`).not.toContain(
        'image-set(',
      );
    }

    // Legitimate Mermaid SVG styles with quoted font-family, #fragment url(), and raster data:image/ still survive
    const legitimate = sanitizeMermaidSvg(
      '<svg viewBox="0 0 100 50"><defs><linearGradient id="linearGradient-1"><stop offset="0%"/></linearGradient><marker id="arrow"><path d="M0,0 L10,5 L0,10 Z"/></marker></defs><style>.label { font-family: "Inter", sans-serif; } .node rect { fill: url(#linearGradient-1); background: url("data:image/png;base64,iVBORw0KGgo="); }</style><path d="M0,0 L50,50" marker-end="url(#arrow)" style="stroke: #fff; fill: url(#linearGradient-1);"/></svg>',
    );
    expect(legitimate).toContain('font-family: "Inter", sans-serif');
    expect(legitimate).toContain('url(#linearGradient-1)');
    expect(legitimate).toContain('marker-end="url(#arrow)"');
    expect(legitimate).toContain('data:image/png;base64,iVBORw0KGgo=');
  });

  it('wraps HTML artifact srcDoc with strict no-network CSP meta tag', () => {
    const rawFragment = '<h1>Widget</h1><script>console.log(1)</script>';
    const wrapped1 = wrapHtmlArtifactSrcDoc(rawFragment);
    expect(wrapped1).toContain(`http-equiv="Content-Security-Policy"`);
    expect(wrapped1).toContain(HTML_ARTIFACT_CSP);
    expect(wrapped1).toContain('<h1>Widget</h1>');

    const fullDoc = '<!doctype html><html><head><title>T</title></head><body>Hi</body></html>';
    const wrapped2 = wrapHtmlArtifactSrcDoc(fullDoc);
    expect(wrapped2).toContain(HTML_ARTIFACT_CSP);
    expect(wrapped2.indexOf(HTML_ARTIFACT_CSP)).toBeLessThan(wrapped2.indexOf('<title>T</title>'));
  });

  it('H12: prevents HTML artifact CSP meta bypasses via comments, rawtext/RCDATA, or leading scripts', () => {
    const bypassInputs = [
      '<!-- <head> --><script>fetch("https://example.invalid")</script>',
      '<style><head></style><script>fetch("https://example.invalid")</script>',
      '<title><head></title><script>fetch("https://example.invalid")</script>',
      '<script>fetch("https://example.invalid")</script><html><head></head>',
      '<!doctype html><html><head><title>Doc</title></head><body><script>1</script></body></html>',
    ];

    for (const input of bypassInputs) {
      const wrapped = wrapHtmlArtifactSrcDoc(input);
      const doc = new DOMParser().parseFromString(wrapped, 'text/html');
      const cspMetas = doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]');
      expect(cspMetas).toHaveLength(1);
      const meta = cspMetas[0];
      expect(meta.getAttribute('content')).toBe(HTML_ARTIFACT_CSP);
      expect(doc.head.firstElementChild).toBe(meta);

      // Nothing may precede the CSP meta in document order (every other element in head/body comes after)
      const allElements = Array.from(doc.querySelectorAll('*')).filter(
        (el) => el !== doc.documentElement && el !== doc.head && el !== meta,
      );
      for (const el of allElements) {
        const pos = meta.compareDocumentPosition(el);
        expect(pos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
    }
  });

  it('validates http(s) URLs strictly', () => {
    expect(isSafeHttpUrl('https://example.com/a')).toBe(true);
    expect(isSafeHttpUrl('http://127.0.0.1:4310')).toBe(true);
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('data:text/html,<h1>x</h1>')).toBe(false);
    expect(isSafeHttpUrl('file:///etc/passwd')).toBe(false);
  });
});
