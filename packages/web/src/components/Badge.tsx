import { useMemo } from 'react';
import { marked } from 'marked';

const HARNESS_STYLES: Record<string, string> = {
  cursor: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  'claude-code': 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  codex: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  grok: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  windsurf: 'bg-teal-500/15 text-teal-300 border-teal-500/30',
  antigravity: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
  chatgpt: 'bg-green-500/15 text-green-300 border-green-500/30',
  skill: 'bg-pink-500/15 text-pink-300 border-pink-500/30',
  human: 'bg-zinc-700/50 text-zinc-200 border-zinc-600/50',
};

export function HarnessBadge({ harness }: { harness: string }) {
  const key = harness.toLowerCase();
  const cls = HARNESS_STYLES[key] ?? 'bg-zinc-800 text-zinc-300 border-zinc-700';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-full border ${cls}`}>
      {harness}
    </span>
  );
}

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  paused: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  completed: 'bg-zinc-800 text-zinc-300 border-zinc-700',
  archived: 'bg-zinc-900 text-zinc-500 border-zinc-800',
  accepted: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  proposed: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  superseded: 'bg-rose-500/15 text-rose-300 border-rose-500/30 line-through',
  deprecated: 'bg-zinc-800 text-zinc-400 border-zinc-700 line-through',
};

export function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_STYLES[status] ?? 'bg-zinc-800 text-zinc-300 border-zinc-700';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-full border ${cls}`}>
      {status}
    </span>
  );
}

const PRIORITY_STYLES: Record<string, string> = {
  urgent: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
  high: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  medium: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
  low: 'bg-zinc-800 text-zinc-400 border-zinc-700',
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
    return marked.parse(content || '', { async: false, breaks: true }) as string;
  }, [content]);

  return (
    <div
      className={`md-prose text-sm ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
