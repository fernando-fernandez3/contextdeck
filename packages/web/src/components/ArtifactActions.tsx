import { useState } from 'react';
import type { ArtifactConfirmation, RefreshJob, RefreshJobArtifactType } from '../types';
import { api } from '../api';
import { StatusBadge } from './Badge';

export function ConfirmationBadges({
  confirmations,
}: {
  confirmations?: Record<string, ArtifactConfirmation>;
}) {
  const entries = Object.entries(confirmations ?? {});
  if (entries.length === 0) return null;

  return (
    <div className="space-y-1">
      {entries.map(([staleDecId, conf]) => (
        <div key={staleDecId} className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
          <StatusBadge status="confirmed" label="Confirmed" />
          <span>
            confirmed by{' '}
            <span className="text-zinc-200">
              {conf.actorType === 'agent' ? `agent (${conf.confirmedBy})` : conf.confirmedBy}
            </span>{' '}
            against <span className="font-mono text-zinc-200">{conf.againstDecisionId}</span>
            {conf.note ? ` — ${conf.note}` : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

interface StaleArtifactActionsProps {
  boardSlug: string;
  artifactType: RefreshJobArtifactType;
  artifactId: string;
  activeJob?: Pick<RefreshJob, 'id' | 'status' | 'claimedBy'> | null;
  onUpdated: () => void;
}

/**
 * AC7.3 + D17: Stale artifact actions are strictly two:
 *   1. "Queue refresh" (1-tap creates refresh job)
 *   2. "Still accurate" (human confirmation with optional note)
 */
export function StaleArtifactActions({
  boardSlug,
  artifactType,
  artifactId,
  activeJob,
  onUpdated,
}: StaleArtifactActionsProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'queue' | 'confirm' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleQueueRefresh = async () => {
    setBusy('queue');
    setError(null);
    try {
      await api.createRefreshJob(boardSlug, artifactType, artifactId);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('confirm');
    setError(null);
    try {
      await api.confirmArtifact(boardSlug, artifactType, artifactId, note.trim() || undefined);
      setNote('');
      setConfirmOpen(false);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const isQueuedOrClaimed = activeJob && (activeJob.status === 'queued' || activeJob.status === 'claimed');

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {isQueuedOrClaimed ? (
          <StatusBadge status="refreshing" label="Refreshing" />
        ) : (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void handleQueueRefresh()}
            className="px-2.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs font-medium text-white transition"
          >
            {busy === 'queue' ? 'Queueing...' : 'Queue refresh'}
          </button>
        )}

        <button
          type="button"
          disabled={busy !== null}
          onClick={() => setConfirmOpen((v) => !v)}
          className="px-2.5 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 disabled:opacity-50 text-xs font-medium text-zinc-200 transition"
        >
          Still accurate
        </button>
      </div>

      {confirmOpen && (
        <form onSubmit={handleConfirm} className="flex flex-wrap items-center gap-2 pt-1">
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note"
            className="flex-1 min-w-[160px] rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-indigo-500"
          />
          <button
            type="submit"
            disabled={busy !== null}
            className="px-2.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs font-medium text-white"
          >
            {busy === 'confirm' ? 'Saving...' : 'Confirm'}
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirmOpen(false);
              setNote('');
            }}
            className="px-2 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-zinc-200"
          >
            Cancel
          </button>
        </form>
      )}

      {error && <div className="text-xs text-rose-300">{error}</div>}
    </div>
  );
}
