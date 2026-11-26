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
