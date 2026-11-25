import { useState } from 'react';
import { AlertTriangle, Plus, Trash2, X } from 'lucide-react';
import type { BoardSnapshot, Task, TaskColumn, TaskPriority } from '../types';
import { api } from '../api';
import { HarnessBadge, PriorityBadge } from './Badge';

interface TasksLensProps {
  snapshot: BoardSnapshot;
  onRefresh: () => void;
}

const COLUMNS: Array<{ id: TaskColumn; label: string; accent: string }> = [
  { id: 'backlog', label: 'Backlog', accent: 'border-t-zinc-500' },
  { id: 'in_progress', label: 'In Progress', accent: 'border-t-sky-500' },
  { id: 'in_review', label: 'In Review', accent: 'border-t-amber-500' },
  { id: 'done', label: 'Done', accent: 'border-t-emerald-500' },
];

export function TasksLens({ snapshot, onRefresh }: TasksLensProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [title, setTitle] = useState('');
  const [column, setColumn] = useState<TaskColumn>('backlog');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [assignee, setAssignee] = useState('human');
  const [description, setDescription] = useState('');
  const [decisionsRaw, setDecisionsRaw] = useState('');

  const staleTaskIds = new Set(
    snapshot.drift.staleArtifacts
      .filter((s) => s.artifactType === 'task')
      .map((s) => s.artifactId),
  );

  const handleMove = async (task: Task, targetColumn: TaskColumn) => {
    if (task.column === targetColumn) return;
    await api.updateTask(snapshot.config.slug, task.id, { column: targetColumn });
    onRefresh();
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    await api.createTask(snapshot.config.slug, {
      title: title.trim(),
      column,
      priority,
      assignee: assignee.trim() || 'unassigned',
      description: description.trim(),
      linkedDecisionIds: decisionsRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    });
    setTitle('');
    setDescription('');
    setDecisionsRaw('');
    setShowNew(false);
    onRefresh();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-zinc-100">Shared Kanban Work Board</h2>
          <p className="text-xs text-zinc-400">
            Drag cards across columns or let connected agents update task status via MCP / CLI.
          </p>
        </div>
        <button
          onClick={() => setShowNew(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white"
        >
          <Plus className="w-3.5 h-3.5" /> New Task
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {COLUMNS.map((col) => {
          const cards = snapshot.tasks.filter((t) => t.column === col.id);
          return (
            <div
              key={col.id}
              onDragOver={(e) => e.preventDefault()}
              onDrop={async () => {
                if (!draggingId) return;
                const task = snapshot.tasks.find((t) => t.id === draggingId);
                setDraggingId(null);
                if (task) await handleMove(task, col.id);
              }}
              className={`rounded-xl border border-zinc-800 border-t-2 ${col.accent} bg-zinc-900/50 p-3 min-h-[420px] flex flex-col gap-3`}
            >
              <div className="flex items-center justify-between px-1">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
                  {col.label}
                </h3>
                <span className="text-[11px] font-mono text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded">
                  {cards.length}
                </span>
              </div>

              <div className="space-y-2.5 flex-1">
                {cards.map((task) => {
                  const isStale = staleTaskIds.has(task.id);
                  return (
                    <div
                      key={task.id}
                      draggable
                      onDragStart={() => setDraggingId(task.id)}
                      onDragEnd={() => setDraggingId(null)}
                      className="rounded-lg border border-zinc-800 bg-zinc-950/90 hover:border-zinc-700 p-3 space-y-2 cursor-grab active:cursor-grabbing transition"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-[10px] text-zinc-500">{task.id}</span>
                          <PriorityBadge priority={task.priority} />
                        </div>
                        <button
                          onClick={async () => {
                            await api.deleteTask(snapshot.config.slug, task.id);
                            onRefresh();
                          }}
                          className="text-zinc-600 hover:text-rose-400"
                          title="Delete task"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>

                      <div className="text-xs font-semibold text-zinc-100 leading-snug">
                        {task.title}
                      </div>

                      {task.description && (
                        <p className="text-[11px] text-zinc-400 line-clamp-3">{task.description}</p>
                      )}

                      {isStale && (
                        <div className="flex items-center gap-1 text-[10px] text-amber-300 bg-amber-500/10 border border-amber-500/25 rounded px-2 py-1">
                          <AlertTriangle className="w-3 h-3 shrink-0" />
                          Linked decision superseded
                        </div>
                      )}

                      <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-zinc-800/80">
                        <HarnessBadge harness={task.assignee} />
                        <select
                          aria-label="Move column"
                          value={task.column}
                          onChange={(e) => handleMove(task, e.target.value as TaskColumn)}
                          className="rounded bg-zinc-900 border border-zinc-800 text-[10px] text-zinc-300 px-1.5 py-0.5"
                        >
                          {COLUMNS.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.label}
                            </option>
                          ))}
                        </select>
                      </div>

                      {(task.linkedDecisionIds.length > 0 || task.linkedSessionIds.length > 0) && (
                        <div className="flex flex-wrap gap-1 pt-0.5">
                          {task.linkedDecisionIds.map((d) => (
                            <span
                              key={d}
                              className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-300"
                            >
                              {d}
                            </span>
                          ))}
                          {task.linkedSessionIds.map((s) => (
                            <span
                              key={s}
                              className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400"
                            >
                              {s}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {showNew && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <form
            onSubmit={handleCreate}
            className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-5 space-y-4 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-100">Create Task</h3>
              <button type="button" onClick={() => setShowNew(false)} className="text-zinc-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Title</label>
                <input
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100"
                />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Column</label>
                  <select
                    value={column}
                    onChange={(e) => setColumn(e.target.value as TaskColumn)}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-zinc-100"
                  >
                    {COLUMNS.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Priority</label>
                  <select
                    value={priority}
                    onChange={(e) => setPriority(e.target.value as TaskPriority)}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-zinc-100"
                  >
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="urgent">urgent</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Assignee</label>
                  <input
                    value={assignee}
                    onChange={(e) => setAssignee(e.target.value)}
                    placeholder="claude-code"
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-zinc-100"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Description</label>
                <textarea
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Linked Decisions (optional)</label>
                <input
                  value={decisionsRaw}
                  onChange={(e) => setDecisionsRaw(e.target.value)}
                  placeholder="dec_002, dec_003"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowNew(false)} className="px-3 py-1.5 text-xs text-zinc-400">
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white"
              >
                Create Task
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
