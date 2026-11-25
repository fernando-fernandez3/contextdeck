import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ClipboardCopy,
  Compass,
  GitBranch,
  Kanban,
  Layers,
  Network,
  PlayCircle,
  Plus,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import type { BoardConfig, BoardSnapshot } from './types';
import { api } from './api';
import { BriefLens } from './components/BriefLens';
import { SessionsLens } from './components/SessionsLens';
import { DecisionsCanvasLens } from './components/DecisionsCanvasLens';
import { TasksLens } from './components/TasksLens';
import { MediaMasteryLens } from './components/MediaMasteryLens';
import { ContextPackModal } from './components/ContextPackModal';

const LENS_TABS = [
  { id: 'brief', label: 'Brief', icon: Compass },
  { id: 'sessions', label: 'Sessions', icon: GitBranch },
  { id: 'decisions', label: 'Architecture & Decisions', icon: Network },
  { id: 'tasks', label: 'Tasks', icon: Kanban },
  { id: 'media', label: 'Media & Mastery', icon: PlayCircle },
] as const;

export function App() {
  const [boards, setBoards] = useState<BoardConfig[]>([]);
  const [activeSlug, setActiveSlug] = useState<string>('');
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [activeLens, setActiveLens] = useState<string>('brief');
  const [sseConnected, setSseConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [packModal, setPackModal] = useState<'export' | 'import' | null>(null);

  // Create Board modal
  const [showNewBoard, setShowNewBoard] = useState(false);
  const [newBoardTitle, setNewBoardTitle] = useState('');
  const [newBoardDesc, setNewBoardDesc] = useState('');

  const loadBoardsAndSnapshot = useCallback(async (preferredSlug?: string) => {
    try {
      const list = await api.listBoards();
      setBoards(list.boards);
      const slug = preferredSlug || activeSlug || list.defaultBoard || list.boards[0]?.slug;
      if (slug) {
        setActiveSlug(slug);
        const snap = await api.getBoard(slug);
        setSnapshot(snap);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [activeSlug]);

  useEffect(() => {
    void loadBoardsAndSnapshot();
  }, []);

  // Subscribe to SSE live push for external agent / file changes
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.addEventListener('connected', () => setSseConnected(true));
    es.addEventListener('board.changed', () => {
      void loadBoardsAndSnapshot(activeSlug);
    });
    es.addEventListener('board.created', () => {
      void loadBoardsAndSnapshot(activeSlug);
    });
    es.onerror = () => setSseConnected(false);
    return () => {
      es.close();
    };
  }, [activeSlug, loadBoardsAndSnapshot]);

  const handleSelectBoard = async (slug: string) => {
    setActiveSlug(slug);
    const snap = await api.getBoard(slug);
    setSnapshot(snap);
  };

  const handleCreateBoard = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBoardTitle.trim()) return;
    const created = await api.createBoard({
      title: newBoardTitle.trim(),
      description: newBoardDesc.trim(),
    });
    setNewBoardTitle('');
    setNewBoardDesc('');
    setShowNewBoard(false);
    await loadBoardsAndSnapshot(created.slug);
  };

  const handleSeedDemo = async () => {
    const snap = await api.seedDemo();
    await loadBoardsAndSnapshot(snap.config.slug);
  };

  const totalDriftAlerts =
    (snapshot?.drift.staleArtifacts.length ?? 0) + (snapshot?.drift.driftedSessions.length ?? 0);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      {/* Top Studio Header */}
      <header className="sticky top-0 z-30 border-b border-zinc-800/90 bg-zinc-950/90 backdrop-blur-md">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center gap-2 shrink-0">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-md shadow-indigo-500/20">
                <Layers className="w-4 h-4 text-white" />
              </div>
              <span className="font-bold text-sm tracking-tight text-zinc-100">ContextDeck</span>
            </div>

            <span className="text-zinc-700">/</span>

            <select
              aria-label="Select Board"
              value={activeSlug}
              onChange={(e) => void handleSelectBoard(e.target.value)}
              className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs font-medium text-zinc-100 max-w-[220px] truncate"
            >
              {boards.map((b) => (
                <option key={b.slug} value={b.slug}>
                  {b.title} ({b.slug})
                </option>
              ))}
            </select>

            <button
              onClick={() => setShowNewBoard(true)}
              className="p-1.5 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
              title="New Topic Board"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>

            {!boards.some((b) => b.slug === 'realtime-sync-v2') && (
              <button
                onClick={handleSeedDemo}
                className="hidden md:inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-indigo-500/30 bg-indigo-500/10 hover:bg-indigo-500/20 text-[11px] font-medium text-indigo-300"
              >
                <Sparkles className="w-3 h-3" /> Load Demo Board
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {snapshot && (
              <div
                className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-zinc-800 bg-zinc-900 text-[11px] font-mono text-zinc-300"
                title={sseConnected ? 'Live SSE sync active' : 'Reconnecting SSE...'}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    sseConnected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'
                  }`}
                />
                rev {snapshot.config.revision}
              </div>
            )}

            {totalDriftAlerts > 0 && (
              <button
                onClick={() => setActiveLens('brief')}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-amber-500/35 bg-amber-500/10 text-[11px] font-medium text-amber-300 hover:bg-amber-500/20"
              >
                <AlertTriangle className="w-3 h-3" />
                {totalDriftAlerts} drift
              </button>
            )}

            {snapshot && (
              <>
                <button
                  onClick={() => setPackModal('export')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-xs font-medium text-zinc-200 transition"
                >
                  <ClipboardCopy className="w-3.5 h-3.5" />
                  <span className="hidden md:inline">Copy Context Pack</span>
                </button>
                <button
                  onClick={() => setPackModal('import')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white transition"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span className="hidden md:inline">Paste Update</span>
                </button>
              </>
            )}
          </div>
        </div>

        {/* Lens Tab Navigation */}
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 flex items-center gap-1 overflow-x-auto border-t border-zinc-900">
          {LENS_TABS.map((tab) => {
            const Icon = tab.icon;
            const active = activeLens === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveLens(tab.id)}
                className={`inline-flex items-center gap-2 px-3.5 py-2.5 text-xs font-medium border-b-2 transition whitespace-nowrap ${
                  active
                    ? 'border-indigo-400 text-zinc-100'
                    : 'border-transparent text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </header>

      {/* Main Workspace */}
      <main className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-6">
        {loading ? (
          <div className="py-24 text-center text-xs text-zinc-500">Loading ContextDeck...</div>
        ) : error ? (
          <div className="rounded-xl border border-rose-500/30 bg-rose-950/20 p-5 text-xs text-rose-200">
            Error loading workspace: {error}
          </div>
        ) : snapshot ? (
          <>
            {activeLens === 'brief' && (
              <BriefLens
                snapshot={snapshot}
                onRefresh={() => void loadBoardsAndSnapshot(activeSlug)}
                onNavigateLens={setActiveLens}
              />
            )}
            {activeLens === 'sessions' && (
              <SessionsLens
                snapshot={snapshot}
                onRefresh={() => void loadBoardsAndSnapshot(activeSlug)}
              />
            )}
            {activeLens === 'decisions' && (
              <DecisionsCanvasLens
                snapshot={snapshot}
                onRefresh={() => void loadBoardsAndSnapshot(activeSlug)}
              />
            )}
            {activeLens === 'tasks' && (
              <TasksLens
                snapshot={snapshot}
                onRefresh={() => void loadBoardsAndSnapshot(activeSlug)}
              />
            )}
            {activeLens === 'media' && (
              <MediaMasteryLens
                snapshot={snapshot}
                onRefresh={() => void loadBoardsAndSnapshot(activeSlug)}
              />
            )}
          </>
        ) : null}
      </main>

      {packModal && snapshot && (
        <ContextPackModal
          boardSlug={snapshot.config.slug}
          initialMode={packModal}
          onClose={() => setPackModal(null)}
          onApplied={() => void loadBoardsAndSnapshot(activeSlug)}
        />
      )}

      {showNewBoard && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <form
            onSubmit={handleCreateBoard}
            className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-5 space-y-4 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-100">Create Topic / Project Board</h3>
              <button type="button" onClick={() => setShowNewBoard(false)} className="text-zinc-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Board Title</label>
                <input
                  required
                  value={newBoardTitle}
                  onChange={(e) => setNewBoardTitle(e.target.value)}
                  placeholder="e.g. OAuth Migration or Distributed Raft Study"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Description (optional)</label>
                <textarea
                  rows={3}
                  value={newBoardDesc}
                  onChange={(e) => setNewBoardDesc(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowNewBoard(false)} className="px-3 py-1.5 text-xs text-zinc-400">
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white"
              >
                Create Board
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
