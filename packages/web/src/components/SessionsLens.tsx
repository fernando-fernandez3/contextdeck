import { useMemo, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Plus, RefreshCw, Trash2, X } from 'lucide-react';
import type { BoardSnapshot, Session, SessionStatus } from '../types';
import { api } from '../api';
import { HarnessBadge, StatusBadge } from './Badge';

interface SessionsLensProps {
  snapshot: BoardSnapshot;
  onRefresh: () => void;
}

interface SessionNodeData extends Record<string, unknown> {
  session: Session;
  behindBy: number;
  selected: boolean;
}

function SessionNodeCard({ data }: NodeProps<Node<SessionNodeData>>) {
  const { session, behindBy, selected } = data;
  const lag =
    session.status === 'archived' || session.status === 'completed' || session.status === 'idle'
      ? 0
      : behindBy;

  return (
    <div
      className={`w-64 sm:w-72 rounded-lg border p-3.5 transition cursor-pointer ${
        selected
          ? 'border-indigo-500 bg-zinc-900'
          : 'border-zinc-800 bg-zinc-900 hover:border-zinc-700'
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-indigo-400 !w-2.5 !h-2.5" />
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <HarnessBadge harness={session.harness} />
        <StatusBadge status={session.status} />
      </div>
      <div className="text-sm font-semibold text-zinc-100 leading-snug mb-1">{session.title}</div>
      {session.summary && (
        <p className="text-[11px] text-zinc-400 line-clamp-2 leading-relaxed">{session.summary}</p>
      )}
      <div className="mt-2.5 pt-2 border-t border-zinc-800 flex items-center justify-between text-[11px]">
        <span className="font-mono text-zinc-500 truncate">{session.id}</span>
        {lag > 0 ? (
          <span className="text-amber-300 font-medium shrink-0">-{lag}</span>
        ) : (
          <span className="text-zinc-400 shrink-0">r{session.lastSyncedRevision}</span>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-indigo-400 !w-2.5 !h-2.5" />
    </div>
  );
}

const nodeTypes = { sessionNode: SessionNodeCard };

function computeHierarchyLayout(
  sessions: Session[],
  driftBySessionId: Map<string, number>,
  selectedId: string | null,
) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const depthMap = new Map<string, number>();

  const getDepth = (s: Session, seen = new Set<string>()): number => {
    if (depthMap.has(s.id)) return depthMap.get(s.id)!;
    if (!s.parentSessionId || !byId.has(s.parentSessionId) || seen.has(s.id)) {
      depthMap.set(s.id, 0);
      return 0;
    }
    seen.add(s.id);
    const d = getDepth(byId.get(s.parentSessionId)!, seen) + 1;
    depthMap.set(s.id, d);
    return d;
  };

  for (const s of sessions) getDepth(s);

  const byLevel = new Map<number, Session[]>();
  for (const s of sessions) {
    const d = depthMap.get(s.id) ?? 0;
    const arr = byLevel.get(d) ?? [];
    arr.push(s);
    byLevel.set(d, arr);
  }

  const nodes: Node<SessionNodeData>[] = [];
  for (const [level, group] of byLevel.entries()) {
    const spacingX = 330;
    const totalWidth = (group.length - 1) * spacingX;
    group.forEach((s, idx) => {
      nodes.push({
        id: s.id,
        type: 'sessionNode',
        position: { x: idx * spacingX - totalWidth / 2 + 320, y: level * 200 + 30 },
        data: {
          session: s,
          behindBy: driftBySessionId.get(s.id) ?? 0,
          selected: s.id === selectedId,
        },
      });
    });
  }

  const edges: Edge[] = [];
  for (const s of sessions) {
    if (s.parentSessionId && byId.has(s.parentSessionId)) {
      edges.push({
        id: `parent-${s.parentSessionId}-${s.id}`,
        source: s.parentSessionId,
        target: s.id,
        animated: s.status === 'active',
        style: { stroke: '#6366f1', strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#6366f1' },
      });
    }
    for (const rel of s.relatedSessionIds) {
      if (byId.has(rel)) {
        edges.push({
          id: `rel-${s.id}-${rel}`,
          source: s.id,
          target: rel,
          label: 'linked',
          style: { stroke: '#52525b', strokeDasharray: '5 4', strokeWidth: 1.5 },
          labelStyle: { fill: '#a1a1aa', fontSize: 10 },
          labelBgStyle: { fill: '#18181b' },
        });
      }
    }
  }

  return { nodes, edges };
}

export function SessionsLens({ snapshot, onRefresh }: SessionsLensProps) {
  const [selectedId, setSelectedId] = useState<string | null>(snapshot.sessions[0]?.id ?? null);
  const [showCreate, setShowCreate] = useState(false);

  const [newTitle, setNewTitle] = useState('');
  const [newHarness, setNewHarness] = useState('cursor');
  const [newParent, setNewParent] = useState('');
  const [newSummary, setNewSummary] = useState('');
  const [newRef, setNewRef] = useState('');

  const selectedSession = snapshot.sessions.find((s) => s.id === selectedId) ?? null;

  const driftBySessionId = useMemo(
    () => new Map(snapshot.drift.driftedSessions.map((d) => [d.sessionId, d.behindBy])),
    [snapshot.drift.driftedSessions],
  );

  const { nodes, edges } = useMemo(
    () => computeHierarchyLayout(snapshot.sessions, driftBySessionId, selectedId),
    [snapshot.sessions, driftBySessionId, selectedId],
  );

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    const created = await api.registerSession(snapshot.config.slug, {
      title: newTitle.trim(),
      harness: newHarness,
      parentSessionId: newParent || null,
      summary: newSummary.trim(),
      externalRef: newRef.trim() || undefined,
    });
    setNewTitle('');
    setNewSummary('');
    setNewRef('');
    setShowCreate(false);
    setSelectedId(created.id);
    onRefresh();
  };

  const handleUpdateField = async (patch: Partial<Session>) => {
    if (!selectedSession) return;
    await api.updateSession(snapshot.config.slug, selectedSession.id, patch);
    onRefresh();
  };

  const handleSync = async () => {
    if (!selectedSession) return;
    await api.syncSession(snapshot.config.slug, selectedSession.id, snapshot.config.revision);
    onRefresh();
  };

  const handleDelete = async () => {
    if (!selectedSession) return;
    await api.deleteSession(snapshot.config.slug, selectedSession.id);
    setSelectedId(null);
    onRefresh();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-zinc-100">
          Sessions ({snapshot.sessions.length})
        </h2>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white transition"
        >
          <Plus className="w-3.5 h-3.5" /> Register session
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-8 h-[360px] sm:h-[560px] rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            onNodeClick={(_, node) => setSelectedId(node.id)}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="var(--cd-border)" gap={20} />
            <Controls className="cd-flow-controls" />
          </ReactFlow>
        </div>

        <div className="lg:col-span-4 rounded-lg border border-zinc-800 bg-zinc-900 p-4 space-y-4 lg:h-[560px] overflow-y-auto">
          {selectedSession ? (
            <>
              <div className="flex items-start justify-between gap-2">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <HarnessBadge harness={selectedSession.harness} />
                    <StatusBadge status={selectedSession.status} />
                  </div>
                  <h3 className="text-sm font-semibold text-zinc-100">{selectedSession.title}</h3>
                  <div className="font-mono text-[11px] text-zinc-500">{selectedSession.id}</div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleDelete()}
                  className="p-1.5 text-zinc-500 hover:text-rose-400 rounded-md hover:bg-zinc-800 shrink-0"
                  title="Delete"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 flex items-center justify-between gap-2">
                <div className="text-xs">
                  <div className="text-zinc-400">Revision</div>
                  <div className="font-mono text-zinc-200 mt-0.5">
                    rev {selectedSession.lastSyncedRevision} / {snapshot.config.revision}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleSync()}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-xs text-zinc-100"
                >
                  <RefreshCw className="w-3 h-3" /> Sync
                </button>
              </div>

              <div className="space-y-1.5">
                <label className="block text-[11px] uppercase tracking-wider text-zinc-400">
                  Status
                </label>
                <select
                  value={selectedSession.status}
                  onChange={(e) => void handleUpdateField({ status: e.target.value as SessionStatus })}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100"
                >
                  <option value="active">active</option>
                  <option value="idle">idle</option>
                  <option value="paused">paused</option>
                  <option value="completed">completed</option>
                  <option value="archived">archived</option>
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="block text-[11px] uppercase tracking-wider text-zinc-400">
                  Parent
                </label>
                <select
                  value={selectedSession.parentSessionId ?? ''}
                  onChange={(e) => void handleUpdateField({ parentSessionId: e.target.value || null })}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100"
                >
                  <option value="">None</option>
                  {snapshot.sessions
                    .filter((s) => s.id !== selectedSession.id)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        [{s.harness}] {s.title}
                      </option>
                    ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="block text-[11px] uppercase tracking-wider text-zinc-400">
                  Summary
                </label>
                <textarea
                  defaultValue={selectedSession.summary}
                  key={selectedSession.id + selectedSession.updatedAt}
                  onBlur={(e) => {
                    if (e.target.value !== selectedSession.summary) {
                      void handleUpdateField({ summary: e.target.value });
                    }
                  }}
                  rows={4}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500"
                />
              </div>

              {selectedSession.externalRef && (
                <div className="text-xs">
                  <span className="text-zinc-500">Ref: </span>
                  <span className="font-mono text-zinc-300 break-all">
                    {selectedSession.externalRef}
                  </span>
                </div>
              )}

              {selectedSession.focusFiles.length > 0 && (
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-zinc-400 mb-1.5">
                    Focus files
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedSession.focusFiles.map((f) => (
                      <span
                        key={f}
                        className="font-mono text-[10px] px-2 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-zinc-300 break-all"
                      >
                        {f}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="text-xs text-zinc-500">No session selected.</div>
          )}
        </div>
      </div>

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <form
            onSubmit={handleCreate}
            className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-900 p-5 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-100">Register session</h3>
              <button type="button" onClick={() => setShowCreate(false)} className="text-zinc-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Title</label>
                <input
                  required
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Harness</label>
                  <select
                    value={newHarness}
                    onChange={(e) => setNewHarness(e.target.value)}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-2 text-xs text-zinc-100"
                  >
                    <option value="cursor">cursor</option>
                    <option value="claude-code">claude-code</option>
                    <option value="codex">codex</option>
                    <option value="grok">grok</option>
                    <option value="windsurf">windsurf</option>
                    <option value="antigravity">antigravity</option>
                    <option value="chatgpt">chatgpt</option>
                    <option value="skill">skill</option>
                    <option value="custom">custom</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Parent</label>
                  <select
                    value={newParent}
                    onChange={(e) => setNewParent(e.target.value)}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-2 text-xs text-zinc-100"
                  >
                    <option value="">None</option>
                    {snapshot.sessions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Summary</label>
                <textarea
                  rows={3}
                  value={newSummary}
                  onChange={(e) => setNewSummary(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">External ref (optional)</label>
                <input
                  value={newRef}
                  onChange={(e) => setNewRef(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-zinc-200"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white"
              >
                Register
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

export default SessionsLens;
