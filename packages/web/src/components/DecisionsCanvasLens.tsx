import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Code2,
  Eye,
  GitCommitHorizontal,
  Layers,
  Plus,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import type { BoardSnapshot, DecisionStatus, RefreshJob } from '../types';
import { api } from '../api';
import { MarkdownView, StatusBadge } from './Badge';
import { ConfirmationBadges, StaleArtifactActions } from './ArtifactActions';

const MermaidDiagramLazy = lazy(() => import('./MermaidDiagram'));
const ExcalidrawCanvasLazy = lazy(() => import('./ExcalidrawCanvas'));

interface DecisionsCanvasLensProps {
  snapshot: BoardSnapshot;
  onRefresh: () => void;
}

export function DecisionsCanvasLens({ snapshot, onRefresh }: DecisionsCanvasLensProps) {
  const [subTab, setSubTab] = useState<'canvas' | 'decisions'>('canvas');
  const [selectedDiagId, setSelectedDiagId] = useState<string | null>(
    snapshot.diagrams[0]?.id ?? null,
  );
  const [mermaidMode, setMermaidMode] = useState<'split' | 'preview'>('preview');
  const [mermaidDraft, setMermaidDraft] = useState<string>(snapshot.diagrams[0]?.content ?? '');
  const [savingDiag, setSavingDiag] = useState(false);

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

  const staleMap = useMemo(
    () =>
      new Map(
        snapshot.drift.staleArtifacts
          .filter((s) => s.artifactType === 'diagram')
          .map((s) => [s.artifactId, s]),
      ),
    [snapshot.drift.staleArtifacts],
  );

  const openJobByDiag = useMemo(() => {
    const map = new Map<string, RefreshJob>();
    for (const job of snapshot.jobs ?? []) {
      if (job.artifactType === 'diagram' && (job.status === 'queued' || job.status === 'claimed')) {
        map.set(job.artifactId, job);
      }
    }
    return map;
  }, [snapshot.jobs]);

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
        ? `flowchart TD\n  A["User"] --> B["${newDiagTitle.trim()}"]\n`
        : JSON.stringify(
            { type: 'excalidraw', version: 2, elements: [], appState: { viewBackgroundColor: '#09090b' } },
            null,
            2,
          );

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
            type="button"
            onClick={() => setSubTab('canvas')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition ${
              subTab === 'canvas' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            Diagrams ({snapshot.diagrams.length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('decisions')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition ${
              subTab === 'decisions'
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <GitCommitHorizontal className="w-3.5 h-3.5" />
            Decisions ({snapshot.decisions.length})
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowNewDiagram(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-xs font-medium text-zinc-200"
          >
            <Plus className="w-3.5 h-3.5" /> Add diagram
          </button>
          <button
            type="button"
            onClick={() => setShowNewDecision(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white"
          >
            <Plus className="w-3.5 h-3.5" /> Record decision
          </button>
        </div>
      </div>

      {subTab === 'canvas' ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-3 space-y-2 min-w-0">
            {snapshot.diagrams.length === 0 ? (
              <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-xs text-zinc-500">
                No diagrams yet.
              </div>
            ) : (
              snapshot.diagrams.map((d) => {
                const isStale = staleMap.has(d.id);
                const job = openJobByDiag.get(d.id);
                const hasConf = Object.keys(d.confirmations ?? {}).length > 0;
                const active = selectedDiagram?.id === d.id;
                return (
                  <button
                    type="button"
                    key={d.id}
                    onClick={() => setSelectedDiagId(d.id)}
                    className={`w-full text-left rounded-lg border p-3 transition ${
                      active
                        ? 'border-indigo-500 bg-zinc-900'
                        : 'border-zinc-800 bg-zinc-900 hover:border-zinc-700'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 font-medium">
                        {d.kind} · v{d.version ?? 1}
                      </span>
                      {job ? (
                        <StatusBadge status="refreshing" label="Refreshing" />
                      ) : isStale ? (
                        <StatusBadge status="stale" label="Stale" />
                      ) : hasConf ? (
                        <StatusBadge status="confirmed" label="Confirmed" />
                      ) : null}
                    </div>
                    <div className="text-xs font-medium text-zinc-100 truncate">{d.title}</div>
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

          <div className="lg:col-span-9 min-w-0 rounded-lg border border-zinc-800 bg-zinc-900 p-4 space-y-4">
            {selectedDiagram ? (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-sm font-semibold text-zinc-100">
                        {selectedDiagram.title}
                      </h3>
                      <span className="font-mono text-[11px] text-zinc-500">
                        v{selectedDiagram.version ?? 1}
                      </span>
                    </div>
                    {selectedDiagram.description && (
                      <p className="text-xs text-zinc-400 mt-0.5">{selectedDiagram.description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {selectedDiagram.kind === 'mermaid' && (
                      <>
                        <button
                          type="button"
                          onClick={() =>
                            setMermaidMode(mermaidMode === 'split' ? 'preview' : 'split')
                          }
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-zinc-700 bg-zinc-950 text-xs text-zinc-300 hover:bg-zinc-800"
                        >
                          {mermaidMode === 'split' ? (
                            <>
                              <Eye className="w-3.5 h-3.5" /> Preview
                            </>
                          ) : (
                            <>
                              <Code2 className="w-3.5 h-3.5" /> Edit
                            </>
                          )}
                        </button>
                        {mermaidMode === 'split' && (
                          <button
                            type="button"
                            disabled={savingDiag}
                            onClick={() => void handleSaveMermaid()}
                            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white"
                          >
                            <Save className="w-3.5 h-3.5" /> {savingDiag ? 'Saving...' : 'Save'}
                          </button>
                        )}
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleDeleteDiagram(selectedDiagram.id)}
                      className="p-1.5 rounded-lg text-zinc-500 hover:text-rose-400 hover:bg-zinc-800"
                      title="Delete"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {staleMap.has(selectedDiagram.id) ? (
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3.5 space-y-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge
                        status={openJobByDiag.has(selectedDiagram.id) ? 'refreshing' : 'stale'}
                        label={openJobByDiag.has(selectedDiagram.id) ? 'Refreshing' : 'Stale'}
                      />
                      <span className="text-xs text-zinc-300">
                        {staleMap.get(selectedDiagram.id)!.reasons.join(' · ')}
                      </span>
                    </div>
                    <StaleArtifactActions
                      boardSlug={snapshot.config.slug}
                      artifactType="diagram"
                      artifactId={selectedDiagram.id}
                      artifactVersion={
                        staleMap.get(selectedDiagram.id)!.artifactVersion ??
                        selectedDiagram.version ??
                        1
                      }
                      expectedAgainst={staleMap.get(selectedDiagram.id)!.expectedAgainst ?? {}}
                      activeJob={openJobByDiag.get(selectedDiagram.id) ?? null}
                      onUpdated={onRefresh}
                    />
                  </div>
                ) : (
                  <ConfirmationBadges confirmations={selectedDiagram.confirmations} />
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
                        className="w-full min-h-[280px] sm:min-h-[340px] rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs text-zinc-100 focus:outline-none focus:border-indigo-500"
                      />
                    )}
                    <Suspense
                      fallback={
                        <div className="min-h-[280px] rounded-lg border border-zinc-800 bg-zinc-950 flex items-center justify-center text-xs text-zinc-500">
                          Loading diagram...
                        </div>
                      }
                    >
                      <MermaidDiagramLazy code={mermaidDraft} />
                    </Suspense>
                  </div>
                ) : (
                  <Suspense
                    fallback={
                      <div className="h-[420px] rounded-lg border border-zinc-800 bg-zinc-950 flex items-center justify-center text-xs text-zinc-500">
                        Loading canvas...
                      </div>
                    }
                  >
                    <ExcalidrawCanvasLazy
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
                  </Suspense>
                )}
              </>
            ) : (
              <div className="py-12 text-center text-xs text-zinc-500">No diagram selected.</div>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {snapshot.decisions.length === 0 ? (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center text-xs text-zinc-500">
              No decisions recorded yet.
            </div>
          ) : (
            snapshot.decisions.map((d) => (
              <div
                key={d.id}
                className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 space-y-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 flex-wrap min-w-0">
                    <span className="font-mono text-xs px-2 py-0.5 rounded bg-zinc-950 text-zinc-300 border border-zinc-800">
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
                      <span className="font-mono text-[11px] text-zinc-400">
                        supersedes {d.supersedes}
                      </span>
                    )}
                    {d.supersededBy && (
                      <span className="font-mono text-[11px] text-zinc-400">
                        → {d.supersededBy}
                      </span>
                    )}
                    {d.status === 'proposed' && (
                      <button
                        type="button"
                        onClick={async () => {
                          await api.updateDecision(snapshot.config.slug, d.id, {
                            status: 'accepted',
                          });
                          onRefresh();
                        }}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded border border-zinc-700 bg-zinc-950 text-zinc-200 hover:bg-zinc-800 text-[11px]"
                      >
                        <CheckCircle2 className="w-3 h-3" /> Accept
                      </button>
                    )}
                  </div>
                </div>
                {d.summary && <p className="text-xs text-zinc-300">{d.summary}</p>}
                {d.rationale && (
                  <div className="pt-2 border-t border-zinc-800">
                    <MarkdownView content={d.rationale} />
                  </div>
                )}
                <div className="flex items-center gap-2 flex-wrap pt-1 text-[11px] text-zinc-500">
                  {d.sessionId && <span className="font-mono">{d.sessionId}</span>}
                  {d.tags.map((t) => (
                    <span key={t} className="px-1.5 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-zinc-400">
                      #{t}
                    </span>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {showNewDecision && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <form
            onSubmit={handleCreateDecision}
            className="w-full max-w-lg rounded-lg border border-zinc-800 bg-zinc-900 p-5 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-100">Record decision</h3>
              <button type="button" onClick={() => setShowNewDecision(false)} className="text-zinc-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Title</label>
                <input
                  required
                  value={decTitle}
                  onChange={(e) => setDecTitle(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                  <label className="block text-xs text-zinc-400 mb-1">Supersedes</label>
                  <select
                    value={decSupersedes}
                    onChange={(e) => setDecSupersedes(e.target.value)}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-2 text-xs text-zinc-100"
                  >
                    <option value="">None</option>
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
                <label className="block text-xs text-zinc-400 mb-1">Summary</label>
                <input
                  value={decSummary}
                  onChange={(e) => setDecSummary(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Rationale</label>
                <textarea
                  rows={3}
                  value={decRationale}
                  onChange={(e) => setDecRationale(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Tags</label>
                <input
                  value={decTags}
                  onChange={(e) => setDecTags(e.target.value)}
                  placeholder="storage, api"
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
                className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white"
              >
                Record
              </button>
            </div>
          </form>
        </div>
      )}

      {showNewDiagram && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <form
            onSubmit={handleCreateDiagram}
            className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-900 p-5 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-100">Add diagram</h3>
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
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Kind</label>
                <select
                  value={newDiagKind}
                  onChange={(e) => setNewDiagKind(e.target.value as 'mermaid' | 'excalidraw')}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-2 text-xs text-zinc-100"
                >
                  <option value="mermaid">Mermaid</option>
                  <option value="excalidraw">Excalidraw</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Decisions (optional)</label>
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
                className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white"
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

export default DecisionsCanvasLens;
