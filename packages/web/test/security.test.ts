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
