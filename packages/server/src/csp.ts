// R3-1 / R4-1 / R5-1 defense-in-depth CSP for SPA HTML responses (shared between
// @contextdeck/server and the @contextdeck/web Vite dev server): blocks all remote
// subresource fetches (img/font/connect/script/style) while permitting inline styles
// (Mermaid/Excalidraw), inline scripts needed by inherited-CSP srcdoc HTML artifacts,
// and https: media-src for explicit external video/audio artifacts. Only <video>/<audio>
// use media-src; media/resource tags and attributes are forbidden inside Mermaid's own
// locked DOMPurify pass (before temporary DOM mount) as well as in Markdown sanitization
// and post-render SVG sanitization, so allowing https: media-src does not reopen R3-1.
export const WEB_UI_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');
