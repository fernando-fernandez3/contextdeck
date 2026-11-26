import { useState } from 'react';
import type { CatchUpReport } from '../types';
import { api } from '../api';
import { formatRelativeTime } from '../quiz-helpers';
import { HarnessBadge, StatusBadge } from './Badge';
import { StaleArtifactActions } from './ArtifactActions';

interface CatchUpLensProps {
  boardSlug: string;
  catchUp: CatchUpReport;
  onUpdated: () => void;
}

const COLUMN_LABEL: Record<string, string> = {
  backlog: 'Backlog',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
};

export function CatchUpLens({ boardSlug, catchUp, onUpdated }: CatchUpLensProps) {
  const [acking, setAcking] = useState(false);

  if (!catchUp.hasUnseen) {
    return (
      <div className="max-w-3xl mx-auto py-16 text-center">
        <p className="text-sm text-zinc-400">You&apos;re caught up.</p>
      </div>
    );
  }

  const handleMarkCaughtUp = async () => {
    setAcking(true);
    try {
      await api.ackCatchUp(boardSlug, catchUp.toRevision, catchUp.evaluatedAt);
      onUpdated();
    } finally {
      setAcking(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="text-xs text-zinc-400 font-mono">
        Since you last looked · {formatRelativeTime(catchUp.lastReviewedAt)} · rev{' '}
        {catchUp.fromRevision} → {catchUp.toRevision}
      </div>

      {catchUp.decisionsChanged.length > 0 && (
        <section className="rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-100">Decisions changed</h2>
            <span className="text-xs font-mono text-zinc-500">
              {catchUp.decisionsChanged.length}
            </span>
          </div>
          <div className="divide-y divide-zinc-800">
            {catchUp.decisionsChanged.map((d) => (
              <div key={d.decisionId} className="px-4 py-3 space-y-1">
                <div className="flex flex-wrap items-baseline gap-2 text-sm">
                  {d.previousTitle && (
                    <>
                      <span className="line-through text-zinc-500">{d.previousTitle}</span>
                      <span className="text-zinc-500">→</span>
                    </>
                  )}
                  <span className="font-medium text-zinc-100">{d.title}</span>
                  <span className="font-mono text-xs text-zinc-500">{d.decisionId}</span>
                </div>
                {d.rationaleLine && (
                  <p className="text-xs text-zinc-400 truncate">{d.rationaleLine}</p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {catchUp.staleArtifacts.length > 0 && (
        <section className="rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-100">Now out of date</h2>
            <span className="text-xs font-mono text-zinc-500">
              {catchUp.staleArtifacts.length}
            </span>
          </div>
          <div className="divide-y divide-zinc-800">
            {catchUp.staleArtifacts.map((art) => (
              <div
                key={`${art.artifactType}-${art.artifactId}`}
                className="px-4 py-3.5 space-y-2.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <StatusBadge status={art.activeJob ? 'refreshing' : 'stale'} label={art.activeJob ? 'Refreshing' : 'Stale'} />
                    <span className="text-xs uppercase font-mono text-zinc-400">
                      {art.artifactType}
                    </span>
                    <span className="text-sm font-medium text-zinc-100 truncate">
                      {art.title}
                    </span>
                  </div>
                </div>
                {art.reasons.length > 0 && (
                  <div className="text-xs text-zinc-400">{art.reasons[0]}</div>
                )}
                <StaleArtifactActions
                  boardSlug={boardSlug}
                  artifactType={art.artifactType}
                  artifactId={art.artifactId}
                  artifactVersion={art.artifactVersion}
                  expectedAgainst={art.expectedAgainst}
                  activeJob={art.activeJob}
                  onUpdated={onUpdated}
                />
              </div>
            ))}
          </div>
        </section>
      )}

      {catchUp.tasksMoved.length > 0 && (
        <section className="rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-100">Tasks moved</h2>
            <span className="text-xs font-mono text-zinc-500">{catchUp.tasksMoved.length}</span>
          </div>
          <div className="divide-y divide-zinc-800">
            {catchUp.tasksMoved.map((t) => (
              <div
                key={t.taskId}
                className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-sm"
              >
                <span className="text-zinc-100 min-w-0 truncate">{t.title}</span>
                <span className="text-xs font-mono text-zinc-400 shrink-0">
                  {t.fromColumn ? COLUMN_LABEL[t.fromColumn] ?? t.fromColumn : 'New'} →{' '}
                  {COLUMN_LABEL[t.toColumn] ?? t.toColumn}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {catchUp.newSessions.length > 0 && (
        <section className="rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-100">New sessions</h2>
            <span className="text-xs font-mono text-zinc-500">{catchUp.newSessions.length}</span>
          </div>
          <div className="divide-y divide-zinc-800">
            {catchUp.newSessions.map((s) => (
              <div key={s.sessionId} className="px-4 py-2.5 flex items-center gap-2.5 text-sm">
                <HarnessBadge harness={s.harness} />
                <span className="text-zinc-100 min-w-0 truncate">{s.title}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {(catchUp.otherChanges?.length ?? 0) > 0 && (
        <section className="rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-100">Other changes</h2>
            <span className="text-xs font-mono text-zinc-500">
              {catchUp.otherChanges.length + (catchUp.otherChangesTruncated ?? 0)}
            </span>
          </div>
          <div className="divide-y divide-zinc-800">
            {catchUp.otherChanges.map((item, idx) => (
              <div
                key={`${item.kind}-${item.at}-${idx}`}
                className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-sm"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[11px] font-mono text-zinc-500 shrink-0">{item.kind}</span>
                  <span className="text-zinc-100 min-w-0 truncate">{item.title}</span>
                </div>
                <span className="text-xs font-mono text-zinc-500 shrink-0">{item.actor}</span>
              </div>
            ))}
            {(catchUp.otherChangesTruncated ?? 0) > 0 && (
              <div className="px-4 py-2 text-xs font-mono text-zinc-500">
                and {catchUp.otherChangesTruncated} more
              </div>
            )}
          </div>
        </section>
      )}

      <div className="pt-2">
        <button
          type="button"
          disabled={acking}
          onClick={() => void handleMarkCaughtUp()}
          className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs font-semibold text-white transition"
        >
          {acking ? 'Saving...' : 'Mark caught up'}
        </button>
      </div>
    </div>
  );
}
