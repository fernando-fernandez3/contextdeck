import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Edit3,
  RefreshCw,
  Save,
  Sparkles,
  X,
} from 'lucide-react';
import type { BoardSnapshot } from '../types';
import { api } from '../api';
import { HarnessBadge, MarkdownView, StatusBadge } from './Badge';

interface BriefLensProps {
  snapshot: BoardSnapshot;
  onRefresh: () => void;
  onNavigateLens: (lensId: string) => void;
}

export function BriefLens({ snapshot, onRefresh, onNavigateLens }: BriefLensProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(snapshot.brief);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.updateBrief(snapshot.config.slug, draft);
      setEditing(false);
      onRefresh();
    } finally {
      setSaving(false);
    }
  };

  const handleMarkAligned = async (
    type: 'diagram' | 'media' | 'quiz' | 'task',
    id: string,
  ) => {
    await api.refreshArtifact(snapshot.config.slug, type, id);
    onRefresh();
  };

  const handleSyncSession = async (sessionId: string) => {
    await api.syncSession(snapshot.config.slug, sessionId);
    onRefresh();
  };

  const activeDecisions = snapshot.decisions.filter((d) => d.status === 'accepted');
  const openTasks = snapshot.tasks.filter((t) => t.column !== 'done');
  const recentEvents = [...snapshot.events].reverse().slice(0, 12);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      {/* Left 8 cols: Living Brief + Active Decisions */}
      <div className="lg:col-span-8 space-y-6">
        {/* KPI strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <button
            onClick={() => onNavigateLens('sessions')}
            className="text-left rounded-xl border border-zinc-800/90 bg-zinc-900/60 hover:border-zinc-700 p-3.5 transition"
          >
            <div className="text-[11px] uppercase tracking-wider text-zinc-400">Sessions</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-bold text-zinc-100">{snapshot.sessions.length}</span>
              {snapshot.drift.driftedSessions.length > 0 && (
                <span className="text-xs text-amber-400">
                  {snapshot.drift.driftedSessions.length} behind
                </span>
              )}
            </div>
          </button>

          <button
            onClick={() => onNavigateLens('decisions')}
            className="text-left rounded-xl border border-zinc-800/90 bg-zinc-900/60 hover:border-zinc-700 p-3.5 transition"
          >
            <div className="text-[11px] uppercase tracking-wider text-zinc-400">Active Decisions</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-bold text-zinc-100">{activeDecisions.length}</span>
              <span className="text-xs text-zinc-500">/ {snapshot.decisions.length} total</span>
            </div>
          </button>

          <button
            onClick={() => onNavigateLens('tasks')}
            className="text-left rounded-xl border border-zinc-800/90 bg-zinc-900/60 hover:border-zinc-700 p-3.5 transition"
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
            onClick={() => onNavigateLens('media')}
            className="text-left rounded-xl border border-zinc-800/90 bg-zinc-900/60 hover:border-zinc-700 p-3.5 transition"
          >
            <div className="text-[11px] uppercase tracking-wider text-zinc-400">Stale Artifacts</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span
                className={`text-2xl font-bold ${
                  snapshot.drift.staleArtifacts.length > 0 ? 'text-amber-400' : 'text-emerald-400'
                }`}
              >
                {snapshot.drift.staleArtifacts.length}
              </span>
              <span className="text-xs text-zinc-500">
                {snapshot.drift.staleArtifacts.length > 0 ? 'need review' : 'all fresh'}
              </span>
            </div>
          </button>
        </div>

        {/* Living Brief card */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800 bg-zinc-900/80">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-indigo-400" />
              <h2 className="text-sm font-semibold text-zinc-100">Living Mental Model (brief.md)</h2>
            </div>
            {editing ? (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setDraft(snapshot.brief);
                    setEditing(false);
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
                >
                  <X className="w-3.5 h-3.5" /> Cancel
                </button>
                <button
                  disabled={saving}
                  onClick={handleSave}
                  className="inline-flex items-center gap-1 px-3 py-1 rounded-md bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white"
                >
                  <Save className="w-3.5 h-3.5" /> {saving ? 'Saving...' : 'Save'}
                </button>
              </div>
            ) : (
              <button
                onClick={() => {
                  setDraft(snapshot.brief);
                  setEditing(true);
                }}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-zinc-300 hover:text-white hover:bg-zinc-800 transition"
              >
                <Edit3 className="w-3.5 h-3.5" /> Edit Brief
              </button>
            )}
          </div>
          <div className="p-5">
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

        {/* Active Decisions Quick Glance */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800 bg-zinc-900/80">
            <h2 className="text-sm font-semibold text-zinc-100">Governing Decisions</h2>
            <button
              onClick={() => onNavigateLens('decisions')}
              className="text-xs text-indigo-400 hover:text-indigo-300"
            >
              Open Decision Ledger →
            </button>
          </div>
          <div className="divide-y divide-zinc-800/80">
            {snapshot.decisions.length === 0 ? (
              <div className="p-5 text-xs text-zinc-500">No decisions recorded yet.</div>
            ) : (
              snapshot.decisions.map((d) => (
                <div key={d.id} className="px-5 py-3 flex items-start justify-between gap-4">
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-xs text-indigo-300">{d.id}</span>
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
                    <span className="text-[11px] font-mono text-rose-300 shrink-0">
                      → {d.supersededBy}
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      {/* Right 4 cols: Staleness Alerts, Drifted Sessions, Timeline */}
      <div className="lg:col-span-4 space-y-6">
        {/* Stale Artifacts */}
        <section className="rounded-xl border border-amber-500/30 bg-amber-950/15 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-amber-500/20">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400" />
              <h3 className="text-sm font-semibold text-amber-200">
                Stale Artifacts ({snapshot.drift.staleArtifacts.length})
              </h3>
            </div>
          </div>
          <div className="p-4 space-y-3">
            {snapshot.drift.staleArtifacts.length === 0 ? (
              <div className="flex items-center gap-2 text-xs text-emerald-300">
                <CheckCircle2 className="w-4 h-4" />
                Every diagram, video, quiz, and task aligns with active decisions.
              </div>
            ) : (
              snapshot.drift.staleArtifacts.map((stale) => (
                <div
                  key={`${stale.artifactType}-${stale.artifactId}`}
                  className="rounded-lg border border-amber-500/25 bg-zinc-950/70 p-3 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-semibold">
                      {stale.artifactType}
                    </span>
                    <button
                      onClick={() => handleMarkAligned(stale.artifactType, stale.artifactId)}
                      className="inline-flex items-center gap-1 text-[11px] text-emerald-300 hover:text-emerald-200"
                      title="Re-link to the latest superseding decision"
                    >
                      <RefreshCw className="w-3 h-3" /> Mark Aligned
                    </button>
                  </div>
                  <div className="text-xs font-semibold text-zinc-100">{stale.title}</div>
                  <ul className="space-y-1">
                    {stale.reasons.map((r, i) => (
                      <li key={i} className="text-[11px] text-amber-200/80 leading-snug">
                        • {r}
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </div>
        </section>

        {/* Drifted Sessions */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
            <h3 className="text-sm font-semibold text-zinc-100">
              Sessions Behind rev {snapshot.config.revision}
            </h3>
            <span className="text-xs text-zinc-400">{snapshot.drift.driftedSessions.length}</span>
          </div>
          <div className="p-4 space-y-2.5">
            {snapshot.drift.driftedSessions.length === 0 ? (
              <p className="text-xs text-emerald-400">All active agent sessions are up to date.</p>
            ) : (
              snapshot.drift.driftedSessions.map((ds) => (
                <div
                  key={ds.sessionId}
                  className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3 space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <HarnessBadge harness={ds.harness} />
                    <span className="text-[11px] font-mono text-amber-300">
                      behind by {ds.behindBy}
                    </span>
                  </div>
                  <div className="text-xs font-medium text-zinc-100">{ds.title}</div>
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-[11px] text-zinc-500">
                      synced at rev {ds.lastSyncedRevision}
                    </span>
                    <button
                      onClick={() => handleSyncSession(ds.sessionId)}
                      className="text-[11px] text-indigo-400 hover:text-indigo-300 font-medium"
                    >
                      Mark Synced
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        {/* Recent Event Timeline */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800">
            <Clock className="w-4 h-4 text-zinc-400" />
            <h3 className="text-sm font-semibold text-zinc-100">Recent Pulse (events.jsonl)</h3>
          </div>
          <div className="p-4 space-y-3 max-h-80 overflow-y-auto">
            {recentEvents.map((ev) => (
              <div key={ev.id} className="flex gap-2.5 text-xs">
                <span className="font-mono text-[10px] text-indigo-300 bg-indigo-500/10 border border-indigo-500/20 rounded px-1.5 py-0.5 h-fit shrink-0">
                  r{ev.revision}
                </span>
                <div className="min-w-0">
                  <div className="text-zinc-200 leading-snug">{ev.summary}</div>
                  <div className="text-[10px] text-zinc-500 mt-0.5">
                    {ev.actor.harness || ev.actor.label || ev.actor.type} •{' '}
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
