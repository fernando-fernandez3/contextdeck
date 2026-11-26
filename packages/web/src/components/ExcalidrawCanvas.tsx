import { useMemo, useRef, useState } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { Save } from 'lucide-react';
import type { Diagram } from '../types';

export default function ExcalidrawCanvas({
  diagram,
  onSave,
}: {
  diagram: Diagram;
  onSave: (content: string) => Promise<void>;
}) {
  const latestRef = useRef<{ elements: readonly unknown[]; appState?: Record<string, unknown> } | null>(null);
  const [saving, setSaving] = useState(false);

  const initialData = useMemo(() => {
    try {
      const parsed = JSON.parse(diagram.content || '{}');
      return {
        elements: Array.isArray(parsed.elements) ? parsed.elements : [],
        appState: {
          theme: 'dark' as const,
          viewBackgroundColor: '#09090b',
          ...(parsed.appState ?? {}),
        },
      };
    } catch {
      return {
        elements: [],
        appState: { theme: 'dark' as const, viewBackgroundColor: '#09090b' },
      };
    }
  }, [diagram.id, diagram.updatedAt]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = {
        type: 'excalidraw',
        version: 2,
        source: 'contextdeck',
        elements: latestRef.current?.elements ?? initialData.elements,
        appState: {
          viewBackgroundColor: latestRef.current?.appState?.viewBackgroundColor ?? '#09090b',
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
          initialData={initialData as never}
          theme="dark"
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
