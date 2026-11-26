import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  ClipboardCopy,
  Compass,
  GitBranch,
  Kanban,
  Layers,
  Moon,
  MoreVertical,
  Network,
  PlayCircle,
  Plus,
  Sun,
  Upload,
  X,
} from 'lucide-react';
import type { BoardConfig, BoardSnapshot, CatchUpReport } from './types';
import { AuthExpiredError, api, setAuthExpiredHandler } from './api';
import { buildBoardTreeOptions } from './board-tree';
import { CatchUpLens } from './components/CatchUpLens';
import { BriefLens } from './components/BriefLens';

// Lazy-load heavier lenses so Mermaid, Excalidraw, and React Flow stay out of the initial bundle (AC8.1)
const SessionsLens = lazy(() =>
  import('./components/SessionsLens').then((m) => ({ default: m.SessionsLens })),
);
const DecisionsCanvasLens = lazy(() =>
  import('./components/DecisionsCanvasLens').then((m) => ({ default: m.DecisionsCanvasLens })),
);
const TasksLens = lazy(() =>
  import('./components/TasksLens').then((m) => ({ default: m.TasksLens })),
);
const MediaMasteryLens = lazy(() =>
  import('./components/MediaMasteryLens').then((m) => ({ default: m.MediaMasteryLens })),
);
const ContextPackModal = lazy(() =>
  import('./components/ContextPackModal').then((m) => ({ default: m.ContextPackModal })),
);

const LENS_TABS = [
  { id: 'catchup', label: 'Catch up', icon: Bell },
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
  const [catchUp, setCatchUp] = useState<CatchUpReport | null>(null);
  const [activeLens, setActiveLens] = useState<string>('catchup');
  const [sseConnected, setSseConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authExpired, setAuthExpired] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [packModal, setPackModal] = useState<'export' | 'import' | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  // Create Board modal
  const [showNewBoard, setShowNewBoard] = useState(false);
  const [newBoardTitle, setNewBoardTitle] = useState('');
  const [newBoardDesc, setNewBoardDesc] = useState('');
  const [newBoardParent, setNewBoardParent] = useState('');

  // Track which board slug we already auto-chose the landing lens for so SSE refreshes don't fight user clicks
  const autoLandedSlugRef = useRef<string | null>(null);

  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light');
  }, [theme]);

  useEffect(() => {
    setAuthExpiredHandler(() => {
      setAuthenticated(false);
      setAuthExpired(true);
      setSseConnected(false);
    });
    return () => setAuthExpiredHandler(null);
  }, []);

  const loadBoardsAndSnapshot = useCallback(
    async (preferredSlug?: string) => {
      try {
        await api.initSession();
        setAuthenticated(true);
        setAuthExpired(false);
        const list = await api.listBoards();
        setBoards(list.boards);
        const slug = preferredSlug || activeSlug || list.defaultBoard || list.boards[0]?.slug;
        if (slug) {
          setActiveSlug(slug);
          const [snap, cu] = await Promise.all([api.getBoard(slug), api.getCatchUp(slug)]);
          setSnapshot(snap);
          setCatchUp(cu);
          if (autoLandedSlugRef.current !== slug) {
            autoLandedSlugRef.current = slug;
            setActiveLens(cu.hasUnseen ? 'catchup' : 'brief');
          }
        } else {
          setSnapshot(null);
          setCatchUp(null);
        }
        setError(null);
      } catch (err) {
        if (err instanceof AuthExpiredError) {
          setAuthExpired(true);
          setAuthenticated(false);
          setError(null);
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setLoading(false);
      }
    },
    [activeSlug],
  );

  useEffect(() => {
    void loadBoardsAndSnapshot();
  }, []);

  // Subscribe to SSE live push for external agent / file changes
  useEffect(() => {
    if (!authenticated || authExpired) return;
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
  }, [activeSlug, authenticated, authExpired, loadBoardsAndSnapshot]);

  const handleSelectBoard = async (slug: string) => {
    setActiveSlug(slug);
    autoLandedSlugRef.current = null;
    const [snap, cu] = await Promise.all([api.getBoard(slug), api.getCatchUp(slug)]);
    setSnapshot(snap);
    setCatchUp(cu);
    autoLandedSlugRef.current = slug;
    setActiveLens(cu.hasUnseen ? 'catchup' : 'brief');
  };

  const handleCreateBoard = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBoardTitle.trim()) return;
    const created = await api.createBoard({
      title: newBoardTitle.trim(),
      description: newBoardDesc.trim(),
      ...(newBoardParent ? { parentBoard: newBoardParent } : {}),
    });
    setNewBoardTitle('');
    setNewBoardDesc('');
    setNewBoardParent('');
    setShowNewBoard(false);
    autoLandedSlugRef.current = null;
    await loadBoardsAndSnapshot(created.slug);
  };

  const handleSeedDemo = async () => {
    const snap = await api.seedDemo();
    autoLandedSlugRef.current = null;
    await loadBoardsAndSnapshot(snap.config.slug);
  };

  const unseenCount = catchUp?.unseenCount ?? 0;
  const hasDemoBoard = boards.some((b) => b.slug === 'realtime-sync-v2');

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col min-w-0 overflow-x-clip">
      <header className="sticky top-0 z-30 border-b border-zinc-800 bg-zinc-950">
        <div className="max-w-[1440px] mx-auto px-3 sm:px-6 h-14 flex items-center justify-between gap-2 sm:gap-4 min-w-0">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
            <div className="flex items-center gap-2 shrink-0">
              <div className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center">
                <Layers className="w-4 h-4 text-white" />
              </div>
              <span className="font-semibold text-sm tracking-tight text-zinc-100">
                ContextDeck
              </span>
            </div>

            <span className="text-zinc-700 hidden sm:inline">/</span>

            <select
              aria-label="Select Board"
              value={activeSlug}
              onChange={(e) => void handleSelectBoard(e.target.value)}
              className="rounded-lg border border-zinc-800 bg-zinc-900 px-2 sm:px-2.5 py-1 text-xs font-medium text-zinc-100 min-w-0 max-w-[140px] sm:max-w-[240px] truncate"
            >
              {buildBoardTreeOptions(boards).map(({ board, label }) => (
                <option key={board.slug} value={board.slug}>
                  {label}
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={() => setShowNewBoard(true)}
              className="hidden md:inline-flex p-1.5 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 shrink-0"
              title="New board"
              aria-label="New board"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>

            {!hasDemoBoard && (
              <button
                type="button"
                onClick={() => void handleSeedDemo()}
                className="hidden lg:inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-[11px] font-medium text-zinc-200 shrink-0"
              >
                Load demo
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            {snapshot && (
              <div
                className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-zinc-800 bg-zinc-900 text-[11px] font-mono text-zinc-300"
                title={sseConnected ? 'Live sync connected' : 'Reconnecting'}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    sseConnected ? 'bg-emerald-400' : 'bg-amber-400'
                  }`}
                />
                rev {snapshot.config.revision}
              </div>
            )}

            {unseenCount > 0 && (
              <button
                type="button"
                onClick={() => setActiveLens('catchup')}
                aria-label={`${unseenCount} unseen updates`}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-[11px] font-medium text-amber-300"
              >
                <Bell className="w-3 h-3" />
                <span>{unseenCount}</span>
              </button>
            )}

            {snapshot && (
              <div className="hidden md:flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPackModal('export')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-xs font-medium text-zinc-200 transition"
                >
                  <ClipboardCopy className="w-3.5 h-3.5" />
                  Copy Context Pack
                </button>
                <button
                  type="button"
                  onClick={() => setPackModal('import')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white transition"
                >
                  <Upload className="w-3.5 h-3.5" />
                  Paste Update
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              className="hidden md:inline-flex p-1.5 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
              title="Toggle theme"
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
            </button>

            {/* Phone / tablet overflow menu */}
            <div className="relative md:hidden">
              <button
                type="button"
                onClick={() => setOverflowOpen((v) => !v)}
                aria-label="More actions"
                aria-expanded={overflowOpen}
                className="p-1.5 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-300"
              >
                <MoreVertical className="w-4 h-4" />
              </button>
              {overflowOpen && (
                <div className="absolute right-0 top-full mt-1.5 w-48 rounded-lg border border-zinc-800 bg-zinc-900 py-1 z-40">
                  {snapshot && (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setOverflowOpen(false);
                          setPackModal('export');
                        }}
                        className="w-full text-left px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-800 flex items-center gap-2"
                      >
                        <ClipboardCopy className="w-3.5 h-3.5 text-zinc-400" />
                        Copy Context Pack
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setOverflowOpen(false);
                          setPackModal('import');
                        }}
                        className="w-full text-left px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-800 flex items-center gap-2"
                      >
                        <Upload className="w-3.5 h-3.5 text-zinc-400" />
                        Paste Update
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setOverflowOpen(false);
                      setShowNewBoard(true);
                    }}
                    className="w-full text-left px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-800 flex items-center gap-2"
                  >
                    <Plus className="w-3.5 h-3.5 text-zinc-400" />
                    New board
                  </button>
                  {!hasDemoBoard && (
                    <button
                      type="button"
                      onClick={() => {
                        setOverflowOpen(false);
                        void handleSeedDemo();
                      }}
                      className="w-full text-left px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-800 flex items-center gap-2"
                    >
                      Load demo
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setOverflowOpen(false);
                      setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
                    }}
                    className="w-full text-left px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-800 flex items-center gap-2"
                  >
                    {theme === 'dark' ? (
                      <Sun className="w-3.5 h-3.5 text-zinc-400" />
                    ) : (
                      <Moon className="w-3.5 h-3.5 text-zinc-400" />
                    )}
                    {theme === 'dark' ? 'Light theme' : 'Dark theme'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Lens Tab Navigation */}
        <nav
          aria-label="Lenses"
          className="max-w-[1440px] mx-auto px-3 sm:px-6 flex items-center gap-1 overflow-x-auto border-t border-zinc-900"
        >
          {LENS_TABS.map((tab) => {
            const Icon = tab.icon;
            const active = activeLens === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                data-lens={tab.id}
                onClick={() => setActiveLens(tab.id)}
                className={`inline-flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 transition whitespace-nowrap shrink-0 ${
                  active
                    ? 'border-indigo-500 text-zinc-100'
                    : 'border-transparent text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{tab.label}</span>
                {tab.id === 'catchup' && unseenCount > 0 && (
                  <span className="ml-0.5 px-1.5 py-0.25 rounded-full bg-zinc-800 text-[10px] font-mono text-amber-300">
                    {unseenCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </header>

      <main className="flex-1 max-w-[1440px] w-full mx-auto px-3 sm:px-6 py-5 sm:py-6 min-w-0">
        {loading ? (
          <div className="py-24 text-center text-xs text-zinc-500">Loading...</div>
        ) : authExpired ? (
          <div className="max-w-lg mx-auto my-12 rounded-lg border border-zinc-800 bg-zinc-900 p-6 space-y-4">
            <div className="flex items-center gap-2 text-amber-300 text-sm font-semibold">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              Session expired
            </div>
            <p className="text-xs text-zinc-300 leading-relaxed">
              Open the launch URL printed by{' '}
              <code className="px-1.5 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-zinc-100">
                cdeck serve
              </code>{' '}
              or run{' '}
              <code className="px-1.5 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-zinc-100">
                cdeck open
              </code>{' '}
              to sign in again.
            </p>
            <button
              type="button"
              onClick={() => void loadBoardsAndSnapshot(activeSlug)}
              className="px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-100"
            >
              Retry
            </button>
          </div>
        ) : error ? (
          <div className="rounded-lg border border-rose-500/40 bg-zinc-900 p-4 text-xs text-rose-300">
            {error}
          </div>
        ) : snapshot ? (
          <Suspense
            fallback={<div className="py-16 text-center text-xs text-zinc-500">Loading view...</div>}
          >
            {activeLens === 'catchup' && catchUp && (
              <CatchUpLens
                boardSlug={snapshot.config.slug}
                catchUp={catchUp}
                onUpdated={() => void loadBoardsAndSnapshot(activeSlug)}
              />
            )}
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
          </Suspense>
        ) : null}
      </main>

      {packModal && snapshot && (
        <Suspense fallback={null}>
          <ContextPackModal
            boardSlug={snapshot.config.slug}
            initialMode={packModal}
            onClose={() => setPackModal(null)}
            onApplied={() => void loadBoardsAndSnapshot(activeSlug)}
          />
        </Suspense>
      )}

      {showNewBoard && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <form
            onSubmit={handleCreateBoard}
            className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-900 p-5 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-100">New board</h3>
              <button
                type="button"
                onClick={() => setShowNewBoard(false)}
                className="text-zinc-400 hover:text-zinc-100"
              >
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
                  placeholder="OAuth Migration"
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
              {boards.length > 0 && (
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">
                    Parent Board (optional)
                  </label>
                  <select
                    value={newBoardParent}
                    onChange={(e) => setNewBoardParent(e.target.value)}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100"
                  >
                    <option value="">None (top-level board)</option>
                    {buildBoardTreeOptions(boards).map(({ board, label }) => (
                      <option key={board.slug} value={board.slug}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowNewBoard(false)}
                className="px-3 py-1.5 text-xs text-zinc-400"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white"
              >
                Create board
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
