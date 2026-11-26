import { useMemo } from 'react';
import { sanitizeMarkdownHtml } from '../security';

export function HarnessBadge({ harness }: { harness: string }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-md border border-zinc-700 bg-zinc-900 text-zinc-200">
      {harness}
    </span>
  );
}

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-zinc-900 text-emerald-300 border-zinc-700',
  idle: 'bg-zinc-900 text-zinc-400 border-zinc-800',
  paused: 'bg-zinc-900 text-amber-300 border-zinc-700',
  completed: 'bg-zinc-900 text-zinc-300 border-zinc-700',
  archived: 'bg-zinc-950 text-zinc-500 border-zinc-800',
  accepted: 'bg-zinc-900 text-emerald-300 border-zinc-700',
  proposed: 'bg-zinc-900 text-indigo-300 border-zinc-700',
  superseded: 'bg-zinc-900 text-zinc-400 border-zinc-800 line-through',
  deprecated: 'bg-zinc-900 text-zinc-500 border-zinc-800 line-through',
  stale: 'bg-zinc-900 text-amber-300 border-zinc-700',
  confirmed: 'bg-zinc-900 text-emerald-300 border-zinc-700',
  refreshing: 'bg-zinc-900 text-indigo-300 border-zinc-700',
  queued: 'bg-zinc-900 text-indigo-300 border-zinc-700',
  claimed: 'bg-zinc-900 text-indigo-300 border-zinc-700',
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const key = status.toLowerCase();
  const cls = STATUS_STYLES[key] ?? 'bg-zinc-900 text-zinc-300 border-zinc-700';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-md border ${cls}`}>
      {label ?? status}
    </span>
  );
}

const PRIORITY_STYLES: Record<string, string> = {
  urgent: 'bg-zinc-900 text-rose-300 border-zinc-700',
  high: 'bg-zinc-900 text-amber-300 border-zinc-700',
  medium: 'bg-zinc-900 text-zinc-300 border-zinc-700',
  low: 'bg-zinc-950 text-zinc-400 border-zinc-800',
};

export function PriorityBadge({ priority }: { priority: string }) {
  const cls = PRIORITY_STYLES[priority] ?? PRIORITY_STYLES.medium;
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] uppercase tracking-wider font-semibold rounded border ${cls}`}>
      {priority}
    </span>
  );
}

export function MarkdownView({ content, className = '' }: { content: string; className?: string }) {
  const html = useMemo(() => {
    return sanitizeMarkdownHtml(content || '');
  }, [content]);

  return (
    <div
      className={`md-prose text-sm ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
