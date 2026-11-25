import { Suspense, lazy, useEffect, useId, useMemo, useRef, useState } from 'react';
import mermaid from 'mermaid';
import {
  AlertTriangle,
  CheckCircle2,
  Code2,
  Eye,
  GitCommitHorizontal,
  Layers,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import type { BoardSnapshot, DecisionStatus, Diagram } from '../types';
import { api } from '../api';
import { MarkdownView, StatusBadge } from './Badge';

const ExcalidrawLazy = lazy(async () => {
  const mod = await import('@excalidraw/excalidraw');
  return { default: mod.Excalidraw };
});

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'loose',
  fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
});

function MermaidPreview({ code }: { code: string }) {
  const reactId = useId().replace(/:/g, '');
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    mermaid
      .render(`mmd_${reactId}_${Date.now()}`, code || 'flowchart LR\n  A[Empty Diagram]')
      .then((res) => {
        if (!active) return;
        setSvg(res.svg);
        setError(null);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, [code, reactId]);

  if (error) {
    return (
      <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-xs font-mono text-rose-200 whitespace-pre-wrap">
        Mermaid syntax error: {error}
      </div>
    );
  }

  return (
    <div
      className="w-full overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-4 flex items-center justify-center min-h-[340px]"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function ExcalidrawEditor({
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
          viewBackgroundColor: '#0f172a',
          ...(parsed.appState ?? {}),
        },
      };
    } catch {
      return {
        elements: [],
        appState: { theme: 'dark' as const, viewBackgroundColor: '#0f172a' },
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
          viewBackgroundColor:
            latestRef.current?.appState?.viewBackgroundColor ?? '#0f172a',
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
          disabled={saving}
          onClick={handleSave}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white"
        >
          <Save className="w-3.5 h-3.5" /> {saving ? 'Saving Canvas...' : 'Save Excalidraw to Git'}
        </button>
      </div>
      <div className="h-[480px] w-full rounded-xl overflow-hidden border border-zinc-800">
        <Suspense
          fallback={
            <div className="h-full flex items-center justify-center text-xs text-zinc-400">
              Loading Excalidraw canvas...
            </div>
          }
        >
          <ExcalidrawLazy
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
        </Suspense>
      </div>
    </div>
  );
}

interface DecisionsCanvasLensProps {
  snapshot: BoardSnapshot;
  onRefresh: () => void;
}

export function DecisionsCanvasLens({ snapshot, onRefresh }: DecisionsCanvasLensProps) {
  const [subTab, setSubTab] = useState<'canvas' | 'decisions'>('canvas');
  const [selectedDiagId, setSelectedDiagId] = useState<string | null>(
    snapshot.diagrams[0]?.id ?? null,
  );
  const [mermaidMode, setMermaidMode] = useState<'split' | 'preview'>('split');
  const [mermaidDraft, setMermaidDraft] = useState<string>(
    snapshot.diagrams[0]?.content ?? '',
  );
  const [savingDiag, setSavingDiag] = useState(false);

  // Modals
  const [showNewDecision, setShowNewDecision] = useState(false);
  const [decTitle, setDecTitle] = useState('');
  const [decSummary, setDecSummary] = useState('');
  const [decRationale, setDecRationale] = useState('');
  const [decStatus, setDecStatus] = useState<DecisionStatus>('accepted');
  const [decSupersedes, setDecSupersedes] = useState('');
  const [decTags, setDecTags] = useState('');

  const [showNewDiagram, setShowNewDiagram] = useState(false);
  const [newDiagTitle, setNewDiagTitle] = useState('');
  const [newDiagKind, setNewDiagKind] = useState<'mermaid' | 'excalidraw'>('mermaid');
  const [newDiagDecisions, setNewDiagDecisions] = useState('');

  const selectedDiagram =
    snapshot.diagrams.find((d) => d.id === selectedDiagId) ?? snapshot.diagrams[0] ?? null;

  useEffect(() => {
    if (selectedDiagram) {
      setMermaidDraft(selectedDiagram.content);
    }
  }, [selectedDiagram?.id, selectedDiagram?.updatedAt]);

  const staleMap = new Map(
    snapshot.drift.staleArtifacts
      .filter((s) => s.artifactType === 'diagram')
      .map((s) => [s.artifactId, s]),
  );

  const handleSaveMermaid = async () => {
    if (!selectedDiagram) return;
    setSavingDiag(true);
    try {
      await api.upsertDiagram(snapshot.config.slug, {
        id: selectedDiagram.id,
        title: selectedDiagram.title,
        kind: 'mermaid',
        content: mermaidDraft,
        description: selectedDiagram.description,
        basedOnDecisions: selectedDiagram.basedOnDecisions,
      });
      onRefresh();
    } finally {
      setSavingDiag(false);
    }
  };

  const handleCreateDecision = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!decTitle.trim()) return;
    await api.recordDecision(snapshot.config.slug, {
      title: decTitle.trim(),
      summary: decSummary.trim(),
      rationale: decRationale.trim(),
      status: decStatus,
      supersedes: decSupersedes || null,
      tags: decTags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    });
    setDecTitle('');
    setDecSummary('');
    setDecRationale('');
    setDecSupersedes('');
    setDecTags('');
    setShowNewDecision(false);
    onRefresh();
  };

  const handleCreateDiagram = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDiagTitle.trim()) return;
    const defaultContent =
      newDiagKind === 'mermaid'
        ? `flowchart TD\n  A["User / Harness"] --> B["${newDiagTitle.trim()}"]\n  B --> C["Shared Context"]\n`
        : JSON.stringify({ type: 'excalidraw', version: 2, elements: [], appState: { viewBackgroundColor: '#0f172a' } }, null, 2);

    const created = await api.upsertDiagram(snapshot.config.slug, {
      title: newDiagTitle.trim(),
      kind: newDiagKind,
      content: defaultContent,
      basedOnDecisions: newDiagDecisions
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    });
    setNewDiagTitle('');
    setNewDiagDecisions('');
    setShowNewDiagram(false);
    setSelectedDiagId(created.id);
    setSubTab('canvas');
    onRefresh();
  };

  const handleDeleteDiagram = async (id: string) => {
    await api.deleteDiagram(snapshot.config.slug, id);
    setSelectedDiagId(null);
    onRefresh();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-900 p-1">
          <button
            onClick={() => setSubTab('canvas')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition ${
              subTab === 'canvas' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            Visual Diagrams & Canvas ({snapshot.diagrams.length})
          </button>
          <button
            onClick={() => setSubTab('decisions')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition ${
              subTab === 'decisions' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <GitCommitHorizontal className="w-3.5 h-3.5" />
            Decision Ledger ({snapshot.decisions.length})
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowNewDiagram(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-xs font-medium text-zinc-200"
          >
            <Plus className="w-3.5 h-3.5" /> New Diagram
          </button>
          <button
            onClick={() => setShowNewDecision(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white"
          >
            <Plus className="w-3.5 h-3.5" /> Record Decision
          </button>
        </div>
      </div>

      {subTab === 'canvas' ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* Diagram selector sidebar */}
          <div className="lg:col-span-3 space-y-2">
            {snapshot.diagrams.length === 0 ? (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-xs text-zinc-500">
                No diagrams yet. Create a Mermaid diagram or Excalidraw whiteboard!
              </div>
            ) : (
              snapshot.diagrams.map((d) => {
                const isStale = staleMap.has(d.id);
                const active = selectedDiagram?.id === d.id;
                return (
                  <button
                    key={d.id}
                    onClick={() => setSelectedDiagId(d.id)}
                    className={`w-full text-left rounded-xl border p-3 transition ${
                      active
                        ? 'border-indigo-500/60 bg-indigo-500/10'
                        : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 font-semibold">
                        {d.kind}
                      </span>
                      {isStale && (
                        <span className="inline-flex items-center gap-1 text-[10px] text-amber-300">
                          <AlertTriangle className="w-3 h-3" /> Stale
                        </span>
                      )}
                    </div>
                    <div className="text-xs font-semibold text-zinc-100">{d.title}</div>
                    {d.basedOnDecisions.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {d.basedOnDecisions.map((id) => (
                          <span key={id} className="font-mono text-[10px] text-zinc-400">
                            {id}
                          </span>
                        ))}
                      </div>
                    )}
                  </button>
                );
              })
            )}
          </div>

          {/* Active diagram workspace */}
          <div className="lg:col-span-9 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 space-y-4">
            {selectedDiagram ? (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-100">{selectedDiagram.title}</h3>
                    {selectedDiagram.description && (
                      <p className="text-xs text-zinc-400 mt-0.5">{selectedDiagram.description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {selectedDiagram.kind === 'mermaid' && (
                      <>
                        <button
                          onClick={() =>
                            setMermaidMode(mermaidMode === 'split' ? 'preview' : 'split')
                          }
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-zinc-700 text-xs text-zinc-300 hover:bg-zinc-800"
                        >
                          {mermaidMode === 'split' ? (
                            <>
                              <Eye className="w-3.5 h-3.5" /> Preview Only
                            </>
                          ) : (
                            <>
                              <Code2 className="w-3.5 h-3.5" /> Split Editor
                            </>
                          )}
                        </button>
                        <button
                          disabled={savingDiag}
                          onClick={handleSaveMermaid}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white"
                        >
                          <Save className="w-3.5 h-3.5" /> {savingDiag ? 'Saving...' : 'Save'}
                        </button>
                      </>
                    )}
                    <button
                      onClick={() => handleDeleteDiagram(selectedDiagram.id)}
                      className="p-1.5 rounded-lg text-zinc-500 hover:text-rose-400 hover:bg-zinc-800"
                      title="Delete diagram"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {staleMap.has(selectedDiagram.id) && (
                  <div className="rounded-lg border border-amber-500/35 bg-amber-950/25 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                    <div className="space-y-0.5">
                      <div className="text-xs font-semibold text-amber-200 flex items-center gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                        This diagram may be outdated
                      </div>
                      <div className="text-[11px] text-amber-200/80">
                        {staleMap.get(selectedDiagram.id)!.reasons.join(' • ')}
                      </div>
                    </div>
                    <button
                      onClick={async () => {
                        await api.refreshArtifact(
                          snapshot.config.slug,
                          'diagram',
                          selectedDiagram.id,
                        );
                        onRefresh();
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600/20 border border-emerald-500/40 text-emerald-200 hover:bg-emerald-600/30 text-xs font-medium"
                    >
                      <RefreshCw className="w-3.5 h-3.5" /> Mark Aligned with Latest Decisions
                    </button>
                  </div>
                )}

                {selectedDiagram.kind === 'mermaid' ? (
                  <div
                    className={`grid gap-4 ${
                      mermaidMode === 'split' ? 'grid-cols-1 xl:grid-cols-2' : 'grid-cols-1'
                    }`}
                  >
                    {mermaidMode === 'split' && (
                      <textarea
                        value={mermaidDraft}
                        onChange={(e) => setMermaidDraft(e.target.value)}
                        className="w-full min-h-[340px] rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs text-zinc-100 focus:outline-none focus:border-indigo-500"
                      />
                    )}
                    <MermaidPreview code={mermaidDraft} />
                  </div>
                ) : (
                  <ExcalidrawEditor
                    diagram={selectedDiagram}
                    onSave={async (content) => {
                      await api.upsertDiagram(snapshot.config.slug, {
                        id: selectedDiagram.id,
                        title: selectedDiagram.title,
                        kind: 'excalidraw',
                        content,
                        description: selectedDiagram.description,
                        basedOnDecisions: selectedDiagram.basedOnDecisions,
                      });
                      onRefresh();
                    }}
                  />
                )}
              </>
            ) : (
              <div className="py-12 text-center text-xs text-zinc-500">
                Select or create a Mermaid or Excalidraw diagram to begin.
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Decision Ledger View */
        <div className="space-y-3">
          {snapshot.decisions.length === 0 ? (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-8 text-center text-xs text-zinc-500">
              No decisions recorded yet.
            </div>
          ) : (
            snapshot.decisions.map((d) => (
              <div
                key={d.id}
                className={`rounded-xl border p-4 space-y-2 ${
                  d.status === 'superseded'
                    ? 'border-zinc-800/70 bg-zinc-900/30 opacity-80'
                    : 'border-zinc-800 bg-zinc-900/60'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-xs px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">
                      {d.id}
                    </span>
                    <h3
                      className={`text-sm font-semibold ${
                        d.status === 'superseded' ? 'line-through text-zinc-500' : 'text-zinc-100'
                      }`}
                    >
                      {d.title}
                    </h3>
                    <StatusBadge status={d.status} />
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    {d.supersedes && (
                      <span className="font-mono text-[11px] text-emerald-300">
                        supersedes {d.supersedes}
                      </span>
                    )}
                    {d.supersededBy && (
                      <span className="font-mono text-[11px] text-rose-300">
                        superseded by {d.supersededBy}
                      </span>
                    )}
                    {d.status === 'proposed' && (
                      <button
                        onClick={async () => {
                          await api.updateDecision(snapshot.config.slug, d.id, {
                            status: 'accepted',
                          });
                          onRefresh();
                        }}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30 text-[11px]"
                      >
                        <CheckCircle2 className="w-3 h-3" /> Accept
                      </button>
                    )}
                  </div>
                </div>
                {d.summary && <p className="text-xs text-zinc-300">{d.summary}</p>}
                {d.rationale && (
                  <div className="pt-2 border-t border-zinc-800/80">
                    <MarkdownView content={d.rationale} />
                  </div>
                )}
                <div className="flex items-center gap-2 flex-wrap pt-1 text-[11px] text-zinc-500">
                  {d.sessionId && <span className="font-mono">session: {d.sessionId}</span>}
                  {d.tags.map((t) => (
                    <span key={t} className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                      #{t}
                    </span>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* New Decision Modal */}
      {showNewDecision && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <form
            onSubmit={handleCreateDecision}
            className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-900 p-5 space-y-4 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-100">Record Architectural Decision</h3>
              <button type="button" onClick={() => setShowNewDecision(false)} className="text-zinc-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Decision Title</label>
                <input
                  required
                  value={decTitle}
                  onChange={(e) => setDecTitle(e.target.value)}
                  placeholder="e.g. Use SQLite WAL for local query caching"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Status</label>
                  <select
                    value={decStatus}
                    onChange={(e) => setDecStatus(e.target.value as DecisionStatus)}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-2 text-xs text-zinc-100"
                  >
                    <option value="accepted">accepted</option>
                    <option value="proposed">proposed</option>
                    <option value="deprecated">deprecated</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">
                    Supersedes (auto-flags stale artifacts!)
                  </label>
                  <select
                    value={decSupersedes}
                    onChange={(e) => setDecSupersedes(e.target.value)}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-2 text-xs text-zinc-100"
                  >
                    <option value="">None (New decision)</option>
                    {snapshot.decisions
                      .filter((d) => d.status !== 'superseded')
                      .map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.id} — {d.title}
                        </option>
                      ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">One-line Summary</label>
                <input
                  value={decSummary}
                  onChange={(e) => setDecSummary(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Rationale (Markdown)</label>
                <textarea
                  rows={3}
                  value={decRationale}
                  onChange={(e) => setDecRationale(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Tags (comma-separated)</label>
                <input
                  value={decTags}
                  onChange={(e) => setDecTags(e.target.value)}
                  placeholder="storage, api, ux"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowNewDecision(false)}
                className="px-3 py-1.5 text-xs text-zinc-400"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white"
              >
                Record Decision
              </button>
            </div>
          </form>
        </div>
      )}

      {/* New Diagram Modal */}
      {showNewDiagram && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <form
            onSubmit={handleCreateDiagram}
            className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-5 space-y-4 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-100">Create Visual Diagram</h3>
              <button type="button" onClick={() => setShowNewDiagram(false)} className="text-zinc-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Title</label>
                <input
                  required
                  value={newDiagTitle}
                  onChange={(e) => setNewDiagTitle(e.target.value)}
                  placeholder="e.g. Request Lifecycle Sequence"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Diagram Engine</label>
                <select
                  value={newDiagKind}
                  onChange={(e) => setNewDiagKind(e.target.value as 'mermaid' | 'excalidraw')}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-2 text-xs text-zinc-100"
                >
                  <option value="mermaid">Mermaid (Diagrams as Code)</option>
                  <option value="excalidraw">Excalidraw (Freeform Whiteboard)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">
                  Based on Decision IDs (comma-separated, optional)
                </label>
                <input
                  value={newDiagDecisions}
                  onChange={(e) => setNewDiagDecisions(e.target.value)}
                  placeholder="dec_002, dec_003"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowNewDiagram(false)}
                className="px-3 py-1.5 text-xs text-zinc-400"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white"
              >
                Create
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
