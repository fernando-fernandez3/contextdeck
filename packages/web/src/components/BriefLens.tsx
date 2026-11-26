import { useMemo, useState } from 'react';
import { Clock, Edit3, Save, X } from 'lucide-react';
import type { BoardSnapshot, RefreshJob } from '../types';
import { ApiError, api } from '../api';
import { HarnessBadge, MarkdownView, StatusBadge } from './Badge';
import { StaleArtifactActions } from './ArtifactActions';

interface BriefLensProps {
  snapshot: BoardSnapshot;
  onRefresh: () => void;
  onNavigateLens: (lensId: string) => void;
}

export function BriefLens({ snapshot, onRefresh, onNavigateLens }: BriefLensProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(snapshot.brief);
  const [editBaseRevision, setEditBaseRevision] = useState<number>(snapshot.config.revision);
  const [conflictMsg, setConflictMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const openJobsByArtifact = useMemo(() => {
    const map = new Map<string, RefreshJob>();
    for (const job of snapshot.jobs ?? []) {
      if (job.status === 'queued' || job.status === 'claimed') {
        map.set(`${job.artifactType}:${job.artifactId}`, job);
      }
    }
    return map;
  }, [snapshot.jobs]);

  const handleSave = async () => {
    setSaving(true);
    setConflictMsg(null);
    try {
      await api.updateBrief(snapshot.config.slug, draft, editBaseRevision);
      setEditing(false);
      onRefresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConflictMsg(
          `Brief updated concurrently (latest rev ${String(err.data?.currentRevision ?? 'newer')}).`,
        );
      } else {
        setConflictMsg(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleSyncSession = async (sessionId: string) => {
    await api.syncSession(snapshot.config.slug, sessionId, snapshot.config.revision);
    onRefresh();
  };

  const activeDecisions = snapshot.decisions.filter((d) => d.status === 'accepted');
  const openTasks = snapshot.tasks.filter((t) => t.column !== 'done');
  const staleRefreshables = snapshot.drift.staleArtifacts.filter((s) => s.artifactType !== 'task');
  const recentEvents = [...snapshot.events].reverse().slice(0, 12);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      <div className="lg:col-span-8 min-w-0 space-y-6">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <button
            type="button"
            onClick={() => onNavigateLens('sessions')}
            className="text-left rounded-lg border border-zinc-800 bg-zinc-900 hover:border-zinc-700 p-3.5 transition"
          >
            <div className="text-[11px] uppercase tracking-wider text-zinc-400">Sessions</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-bold text-zinc-100">{snapshot.sessions.length}</span>
              {snapshot.drift.driftedSessions.length > 0 && (
                <span className="text-xs text-amber-300">
                  {snapshot.drift.driftedSessions.length} behind
                </span>
              )}
            </div>
          </button>

          <button
            type="button"
            onClick={() => onNavigateLens('decisions')}
            className="text-left rounded-lg border border-zinc-800 bg-zinc-900 hover:border-zinc-700 p-3.5 transition"
          >
            <div className="text-[11px] uppercase tracking-wider text-zinc-400">Decisions</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-bold text-zinc-100">{activeDecisions.length}</span>
              <span className="text-xs text-zinc-500">/ {snapshot.decisions.length}</span>
            </div>
          </button>

          <button
            type="button"
            onClick={() => onNavigateLens('tasks')}
            className="text-left rounded-lg border border-zinc-800 bg-zinc-900 hover:border-zinc-700 p-3.5 transition"
          >
            <div className="text-[11px] uppercase tracking-wider text-zinc-400">Open Tasks</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-bold text-zinc-100">{openTasks.length}</span>
              <span className="text-xs text-zinc-500">
                {snapshot.tasks.length - openTasks.length} done
              </span>
            </div>
          </button>

          <button
            type="button"
            onClick={() => onNavigateLens('media')}
            className="text-left rounded-lg border border-zinc-800 bg-zinc-900 hover:border-zinc-700 p-3.5 transition"
          >
            <div className="text-[11px] uppercase tracking-wider text-zinc-400">Stale</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-bold text-zinc-100">{staleRefreshables.length}</span>
              <span className="text-xs text-zinc-500">
                {staleRefreshables.length > 0 ? 'out of date' : 'current'}
              </span>
            </div>
          </button>
        </div>

        <section className="rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden">
          <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-b border-zinc-800">
            <h2 className="text-sm font-semibold text-zinc-100">Brief</h2>
            {editing ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setDraft(snapshot.brief);
                    setEditing(false);
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
                >
                  <X className="w-3.5 h-3.5" /> Cancel
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleSave()}
                  className="inline-flex items-center gap-1 px-3 py-1 rounded-md bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white"
                >
                  <Save className="w-3.5 h-3.5" /> {saving ? 'Saving...' : 'Save'}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setDraft(snapshot.brief);
                  setEditBaseRevision(snapshot.config.revision);
                  setConflictMsg(null);
                  setEditing(true);
                }}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-zinc-300 hover:text-white hover:bg-zinc-800 transition"
              >
                <Edit3 className="w-3.5 h-3.5" /> Edit
              </button>
            )}
          </div>
          <div className="p-4 sm:p-5">
            {conflictMsg && (
              <div className="mb-3 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 flex items-center justify-between gap-2 text-xs text-amber-300">
                <span>{conflictMsg}</span>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(snapshot.brief);
                    setEditBaseRevision(snapshot.config.revision);
                    setConflictMsg(null);
                    onRefresh();
                  }}
                  className="shrink-0 px-2 py-1 rounded border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-[11px] text-zinc-200"
                >
                  Reload
                </button>
              </div>
            )}
            {editing ? (
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="w-full h-96 rounded-lg border border-zinc-700 bg-zinc-950 p-3 font-mono text-xs text-zinc-100 focus:outline-none focus:border-indigo-500"
              />
            ) : (
              <MarkdownView content={snapshot.brief} />
            )}
          </div>
        </section>

        <section className="rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden">
          <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-b border-zinc-800">
            <h2 className="text-sm font-semibold text-zinc-100">Decisions</h2>
            <button
              type="button"
              onClick={() => onNavigateLens('decisions')}
              className="text-xs text-indigo-400 hover:text-indigo-300"
            >
              View all →
            </button>
          </div>
          <div className="divide-y divide-zinc-800">
            {snapshot.decisions.length === 0 ? (
              <div className="p-5 text-xs text-zinc-500">No decisions recorded yet.</div>
            ) : (
              snapshot.decisions.map((d) => (
                <div key={d.id} className="px-4 sm:px-5 py-3 flex items-start justify-between gap-4">
                  <div className="space-y-0.5 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-xs text-zinc-400">{d.id}</span>
                      <span
                        className={`text-sm font-medium ${
                          d.status === 'superseded' ? 'line-through text-zinc-500' : 'text-zinc-100'
                        }`}
                      >
                        {d.title}
                      </span>
                      <StatusBadge status={d.status} />
                    </div>
                    {d.summary && <p className="text-xs text-zinc-400">{d.summary}</p>}
                  </div>
                  {d.supersededBy && (
                    <span className="text-[11px] font-mono text-zinc-400 shrink-0">
                      → {d.supersededBy}
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      <div className="lg:col-span-4 min-w-0 space-y-6">
        <section className="rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
            <h3 className="text-sm font-semibold text-zinc-100">Out of date</h3>
            <span className="text-xs font-mono text-zinc-400">{staleRefreshables.length}</span>
          </div>
          <div className="p-4 space-y-3">
            {staleRefreshables.length === 0 ? (
              <div className="text-xs text-zinc-400">All artifacts match current decisions.</div>
            ) : (
              staleRefreshables.map((stale) => {
                const job = openJobsByArtifact.get(`${stale.artifactType}:${stale.artifactId}`) ?? null;
                return (
                  <div
                    key={`${stale.artifactType}-${stale.artifactId}`}
                    className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 space-y-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] uppercase font-mono text-zinc-400">
                        {stale.artifactType}
                      </span>
                      <StatusBadge
                        status={job ? 'refreshing' : 'stale'}
                        label={job ? 'Refreshing' : 'Stale'}
                      />
                    </div>
                    <div className="text-xs font-medium text-zinc-100">{stale.title}</div>
                    <div className="text-[11px] text-zinc-400 leading-snug">
                      {stale.reasons[0]}
                    </div>
                    {stale.artifactType !== 'task' && (
                      <StaleArtifactActions
                        boardSlug={snapshot.config.slug}
                        artifactType={stale.artifactType}
                        artifactId={stale.artifactId}
                        activeJob={job}
                        onUpdated={onRefresh}
                      />
                    )}
                  </div>
                );
              })
            )}
          </div>
        </section>

        <section className="rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
            <h3 className="text-sm font-semibold text-zinc-100">
              Behind rev {snapshot.config.revision}
            </h3>
            <span className="text-xs font-mono text-zinc-400">
              {snapshot.drift.driftedSessions.length}
            </span>
          </div>
          <div className="p-4 space-y-2.5">
            {snapshot.drift.driftedSessions.length === 0 ? (
              <p className="text-xs text-zinc-400">All active sessions synced.</p>
            ) : (
              snapshot.drift.driftedSessions.map((ds) => (
                <div
                  key={ds.sessionId}
                  className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <HarnessBadge harness={ds.harness} />
                    <span className="text-[11px] font-mono text-amber-300">
                      -{ds.behindBy}
                    </span>
                  </div>
                  <div className="text-xs font-medium text-zinc-100">{ds.title}</div>
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-[11px] font-mono text-zinc-500">
                      rev {ds.lastSyncedRevision}
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleSyncSession(ds.sessionId)}
                      className="text-[11px] text-indigo-400 hover:text-indigo-300 font-medium"
                    >
                      Mark synced
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800">
            <Clock className="w-4 h-4 text-zinc-400" />
            <h3 className="text-sm font-semibold text-zinc-100">Activity</h3>
          </div>
          <div className="p-4 space-y-3 max-h-80 overflow-y-auto">
            {recentEvents.map((ev) => (
              <div key={ev.id} className="flex gap-2.5 text-xs">
                <span className="font-mono text-[10px] text-zinc-400 bg-zinc-950 border border-zinc-800 rounded px-1.5 py-0.5 h-fit shrink-0">
                  r{ev.revision}
                </span>
                <div className="min-w-0">
                  <div className="text-zinc-200 leading-snug break-words">{ev.summary}</div>
                  <div className="text-[10px] text-zinc-500 mt-0.5">
                    {ev.actor.harness || ev.actor.label || ev.actor.type} ·{' '}
                    {new Date(ev.timestamp).toLocaleTimeString()}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
