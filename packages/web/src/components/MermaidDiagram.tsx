import { useEffect, useId, useState } from 'react';
import mermaid from 'mermaid';
import { MERMAID_CONFIG, sanitizeMermaidSvg } from '../security';

export default function MermaidDiagram({ code }: { code: string }) {
  const reactId = useId().replace(/:/g, '');
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [isLight, setIsLight] = useState<boolean>(() =>
    typeof document !== 'undefined' ? document.documentElement.classList.contains('light') : false,
  );

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const syncTheme = () => setIsLight(document.documentElement.classList.contains('light'));
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    mermaid.initialize({
      ...MERMAID_CONFIG,
      theme: isLight ? 'default' : 'dark',
    });
    let active = true;
    mermaid
      .render(`mmd_${reactId}_${Date.now()}`, code || 'flowchart LR\n  A[Empty Diagram]')
      .then((res) => {
        if (!active) return;
        setSvg(sanitizeMermaidSvg(res.svg));
        setError(null);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, [code, reactId, isLight]);

  if (error) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-xs font-mono text-rose-300 whitespace-pre-wrap break-words">
        Mermaid syntax error: {error}
      </div>
    );
  }

  return (
    <div
      data-mermaid-rendered={svg ? 'true' : 'false'}
      className="w-full max-w-full overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950 p-4 flex items-center justify-center min-h-[280px] sm:min-h-[340px]"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
