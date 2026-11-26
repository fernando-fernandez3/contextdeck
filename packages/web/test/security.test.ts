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

  it('sanitizes Mermaid rendered SVG to neutralize script tags, event handlers, and javascript: hrefs (D5)', () => {
    const evilSvg =
      '<svg xmlns="http://www.w3.org/2000/svg"><g onload="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)"><text>Node</text></a></g></svg>';
    const cleaned = sanitizeMermaidSvg(evilSvg);
    expect(cleaned).toContain('<svg');
    expect(cleaned).toContain('Node');
    expect(cleaned.toLowerCase()).not.toContain('<script');
    expect(cleaned.toLowerCase()).not.toContain('onload');
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

  it('validates http(s) URLs strictly', () => {
    expect(isSafeHttpUrl('https://example.com/a')).toBe(true);
    expect(isSafeHttpUrl('http://127.0.0.1:4310')).toBe(true);
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('data:text/html,<h1>x</h1>')).toBe(false);
    expect(isSafeHttpUrl('file:///etc/passwd')).toBe(false);
  });
});
