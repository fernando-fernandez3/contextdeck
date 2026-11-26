import { useEffect, useMemo, useRef, useState } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { Save } from 'lucide-react';
import type { Diagram } from '../types';

const DARK_DEFAULT_BACKGROUNDS = new Set(['#09090b', '#0f172a', '#18181b', '#121212']);

function resolveCanvasBackground(savedBg: unknown, isLight: boolean): string {
  if (typeof savedBg === 'string' && savedBg.trim()) {
    const normalized = savedBg.trim().toLowerCase();
    if (isLight && DARK_DEFAULT_BACKGROUNDS.has(normalized)) {
      return '#ffffff';
    }
    if (!isLight && normalized === '#ffffff') {
      return '#09090b';
    }
    return savedBg;
  }
  return isLight ? '#ffffff' : '#09090b';
}

export default function ExcalidrawCanvas({
  diagram,
  onSave,
}: {
  diagram: Diagram;
  onSave: (content: string) => Promise<void>;
}) {
  const latestRef = useRef<{ elements: readonly unknown[]; appState?: Record<string, unknown> } | null>(null);
  const apiRef = useRef<{ updateScene: (scene: Record<string, unknown>) => void } | null>(null);
  const [saving, setSaving] = useState(false);
  const [isLight, setIsLight] = useState<boolean>(() =>
    typeof document !== 'undefined' ? document.documentElement.classList.contains('light') : false,
  );

  // R2-8: Follow html.light class changes via MutationObserver (matching MermaidDiagram.tsx)
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const syncTheme = () => setIsLight(document.documentElement.classList.contains('light'));
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const initialData = useMemo(() => {
    const theme = isLight ? ('light' as const) : ('dark' as const);
    try {
      const parsed = JSON.parse(diagram.content || '{}');
      const savedBg = parsed.appState?.viewBackgroundColor;
      return {
        elements: Array.isArray(parsed.elements) ? parsed.elements : [],
        appState: {
          ...(parsed.appState ?? {}),
          theme,
          viewBackgroundColor: resolveCanvasBackground(savedBg, isLight),
        },
      };
    } catch {
      return {
        elements: [],
        appState: { theme, viewBackgroundColor: isLight ? '#ffffff' : '#09090b' },
      };
    }
  }, [diagram.id, diagram.updatedAt]);

  useEffect(() => {
    if (!apiRef.current) return;
    const currentBg = latestRef.current?.appState?.viewBackgroundColor ?? initialData.appState.viewBackgroundColor;
    apiRef.current.updateScene({
      appState: {
        theme: isLight ? 'light' : 'dark',
        viewBackgroundColor: resolveCanvasBackground(currentBg, isLight),
      },
    });
  }, [isLight, initialData.appState.viewBackgroundColor]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = {
        type: 'excalidraw',
        version: 2,
        source: 'contextdeck',
        elements: latestRef.current?.elements ?? initialData.elements,
        appState: {
          viewBackgroundColor:
            latestRef.current?.appState?.viewBackgroundColor ??
            (isLight ? '#ffffff' : '#09090b'),
        },
      };
      await onSave(JSON.stringify(payload, null, 2));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2.5">
      <div className="flex justify-end">
        <button
          type="button"
          disabled={saving}
          onClick={() => void handleSave()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white"
        >
          <Save className="w-3.5 h-3.5" /> {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
      <div className="h-[420px] sm:h-[480px] w-full rounded-lg overflow-hidden border border-zinc-800">
        <Excalidraw
          key={diagram.id}
          excalidrawAPI={(api) => {
            apiRef.current = api as unknown as { updateScene: (scene: Record<string, unknown>) => void };
          }}
          initialData={initialData as never}
          theme={isLight ? 'light' : 'dark'}
          onChange={(elements, appState) => {
            latestRef.current = {
              elements,
              appState: { viewBackgroundColor: appState.viewBackgroundColor },
            };
          }}
        />
      </div>
    </div>
  );
}
