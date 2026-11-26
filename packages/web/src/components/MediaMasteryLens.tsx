import { useRef, useState } from 'react';
import {
  CheckCircle2,
  FileText,
  Film,
  HelpCircle,
  Plus,
  Trash2,
  Upload,
  X,
  XCircle,
} from 'lucide-react';
import type { BoardSnapshot, MediaArtifact, Quiz, RefreshJob } from '../types';
import { api } from '../api';
import { isSafeHttpUrl, wrapHtmlArtifactSrcDoc } from '../security';
import { computeMasteryTrend, getQuizQuestionStaleness } from '../quiz-helpers';
import { MarkdownView, StatusBadge } from './Badge';
import { ConfirmationBadges, StaleArtifactActions } from './ArtifactActions';

interface MediaMasteryLensProps {
  snapshot: BoardSnapshot;
  onRefresh: () => void;
}

type SelectedItem =
  | { kind: 'media'; id: string }
  | { kind: 'quiz'; id: string }
  | null;

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function MasteryTrendBadge({ quiz }: { quiz: Quiz }) {
  const trend = computeMasteryTrend(quiz.attempts);
  if (!trend) return null;

  const recentScores = trend.scores.slice(-8);
  const deltaLabel =
    trend.delta !== null
      ? trend.delta > 0
        ? `+${trend.delta}%`
        : `${trend.delta}%`
      : null;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 flex items-center gap-3">
      <div className="text-right">
        <div className="text-[10px] uppercase tracking-wider text-zinc-400">Mastery</div>
        <div className="flex items-baseline justify-end gap-1.5">
          <span className="text-base font-semibold font-mono text-zinc-100">
            {trend.latestPct}%
          </span>
          {deltaLabel && (
            <span
              className={`text-[11px] font-mono ${
                trend.delta! > 0
                  ? 'text-emerald-300'
                  : trend.delta! < 0
                    ? 'text-amber-300'
                    : 'text-zinc-400'
              }`}
            >
              {deltaLabel}
            </span>
          )}
        </div>
        <div className="text-[10px] text-zinc-500">
          {quiz.attempts.length} attempt{quiz.attempts.length === 1 ? '' : 's'}
        </div>
      </div>

      {recentScores.length > 1 && (
        <svg
          width="64"
          height="28"
          viewBox="0 0 64 28"
          className="shrink-0"
          aria-label="Mastery score trend"
        >
          {recentScores.map((score, i) => {
            const barW = Math.max(4, Math.floor(56 / recentScores.length) - 2);
            const x = i * (barW + 2) + 2;
            const h = Math.max(3, Math.round((score / 100) * 24));
            const y = 26 - h;
            return (
              <rect
                key={i}
                x={x}
                y={y}
                width={barW}
                height={h}
                rx={1.5}
                fill={i === recentScores.length - 1 ? '#6366f1' : '#3f3f46'}
              />
            );
          })}
        </svg>
      )}
    </div>
  );
}

function QuizRunner({
  slug,
  quiz,
  snapshot,
  staleReasons,
  activeJob,
  onSubmitted,
}: {
  slug: string;
  quiz: Quiz;
  snapshot: BoardSnapshot;
  staleReasons?: string[];
  activeJob?: RefreshJob | null;
  onSubmitted: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, number | string | boolean>>({});
  const [confidence, setConfidence] = useState<number>(3);
  const [submittedResult, setSubmittedResult] = useState<{
    score: number;
    total: number;
    percentage: number;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const questionStaleness = getQuizQuestionStaleness(quiz, snapshot.decisions);

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const res = await api.submitQuizAttempt(slug, quiz.id, answers, confidence);
      setSubmittedResult({
        score: res.attempt.score,
        total: res.attempt.total,
        percentage: res.attempt.percentage,
      });
      onSubmitted();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-800 pb-4">
        <div className="space-y-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-zinc-400">
            <span className="uppercase">quiz</span>
            <span>v{quiz.version ?? 1}</span>
            <span>{quiz.id}</span>
          </div>
          <h3 className="text-base font-semibold text-zinc-100 break-words">{quiz.title}</h3>
          {quiz.description && <p className="text-xs text-zinc-400">{quiz.description}</p>}
        </div>

        <MasteryTrendBadge quiz={quiz} />
      </div>

      <ConfirmationBadges confirmations={quiz.confirmations} />

      {staleReasons && staleReasons.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3.5 space-y-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge
              status={activeJob ? 'refreshing' : 'stale'}
              label={activeJob ? 'Refreshing' : 'Stale'}
            />
            <span className="text-xs text-zinc-300">{staleReasons.join(' · ')}</span>
          </div>
          <StaleArtifactActions
            boardSlug={slug}
            artifactType="quiz"
            artifactId={quiz.id}
            activeJob={activeJob}
            onUpdated={onSubmitted}
          />
        </div>
      )}

      <div className="space-y-3">
        {quiz.questions.map((q, idx) => {
          const chosen = answers[q.id];
          const showReveal = submittedResult !== null;
          const qStale = questionStaleness[q.id];
          const isCorrect =
            q.type === 'multiple_choice'
              ? Number(chosen) === q.correctIndex
              : q.type === 'true_false'
                ? String(chosen).toLowerCase() === String(q.correctAnswer).toLowerCase()
                : typeof chosen === 'string' &&
                  q.correctAnswer &&
                  chosen.toLowerCase().includes(q.correctAnswer.toLowerCase());

          return (
            <div
              key={q.id}
              data-question-id={q.id}
              className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 space-y-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1.5 min-w-0">
                  <div className="text-sm font-medium text-zinc-100">
                    <span className="text-indigo-400 font-mono mr-2">Q{idx + 1}.</span>
                    {q.prompt}
                  </div>
                  {qStale && (
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status="stale" label="Stale" />
                      <span className="text-xs text-zinc-400">{qStale.reasons.join(' · ')}</span>
                    </div>
                  )}
                </div>
                {showReveal &&
                  (isCorrect ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  ) : (
                    <XCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  ))}
              </div>

              {q.type === 'multiple_choice' && q.options && (
                <div className="space-y-2">
                  {q.options.map((opt, optIdx) => {
                    const selected = chosen === optIdx;
                    let cls = 'border-zinc-800 bg-zinc-900 hover:border-zinc-700 text-zinc-200';
                    if (showReveal && optIdx === q.correctIndex) {
                      cls = 'border-emerald-500/60 bg-zinc-900 text-emerald-200';
                    } else if (showReveal && selected && optIdx !== q.correctIndex) {
                      cls = 'border-rose-500/60 bg-zinc-900 text-rose-200';
                    } else if (selected) {
                      cls = 'border-indigo-500 bg-zinc-900 text-indigo-200';
                    }
                    return (
                      <button
                        key={optIdx}
                        type="button"
                        onClick={() => {
                          setSubmittedResult(null);
                          setAnswers((prev) => ({ ...prev, [q.id]: optIdx }));
                        }}
                        className={`w-full text-left rounded-lg border px-3 py-2 text-xs transition ${cls}`}
                      >
                        <span className="font-mono text-zinc-500 mr-2">
                          {String.fromCharCode(65 + optIdx)}.
                        </span>
                        {opt}
                      </button>
                    );
                  })}
                </div>
              )}

              {q.type === 'true_false' && (
                <div className="flex gap-2">
                  {[true, false].map((val) => {
                    const selected = chosen === val;
                    return (
                      <button
                        key={String(val)}
                        type="button"
                        onClick={() => {
                          setSubmittedResult(null);
                          setAnswers((prev) => ({ ...prev, [q.id]: val }));
                        }}
                        className={`px-3 py-1.5 rounded-lg border text-xs transition ${
                          selected
                            ? 'border-indigo-500 bg-zinc-900 text-indigo-200'
                            : 'border-zinc-800 bg-zinc-900 hover:border-zinc-700 text-zinc-300'
                        }`}
                      >
                        {val ? 'True' : 'False'}
                      </button>
                    );
                  })}
                </div>
              )}

              {q.type === 'short_answer' && (
                <input
                  value={String(chosen ?? '')}
                  onChange={(e) => {
                    setSubmittedResult(null);
                    setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }));
                  }}
                  placeholder="Type your answer..."
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-100"
                />
              )}

              {showReveal && q.explanation && (
                <div className="rounded-lg bg-zinc-900 border border-zinc-800 px-3 py-2 text-xs text-zinc-300">
                  <strong className="text-zinc-100">Explanation: </strong>
                  {q.explanation}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-zinc-800">
        <div className="flex items-center gap-2.5 text-xs text-zinc-300">
          <span>Confidence</span>
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setConfidence(n)}
                className={`w-7 h-7 rounded-md font-mono text-xs border transition ${
                  confidence === n
                    ? 'bg-indigo-600 border-indigo-500 text-white'
                    : 'bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          disabled={submitting}
          onClick={handleSubmit}
          className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs font-medium text-white transition"
        >
          {submitting ? 'Checking...' : 'Submit answers'}
        </button>
      </div>

      {submittedResult && (
        <div className="rounded-lg border border-zinc-700 bg-zinc-950 px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="font-semibold text-zinc-100">
            Score: {submittedResult.score} / {submittedResult.total} ({submittedResult.percentage}%)
          </div>
          <span className="font-mono text-zinc-400">{quiz.id}</span>
        </div>
      )}
    </div>
  );
}

export function MediaMasteryLens({ snapshot, onRefresh }: MediaMasteryLensProps) {
  const [selected, setSelected] = useState<SelectedItem>(() => {
    if (snapshot.media[0]) return { kind: 'media', id: snapshot.media[0].id };
    if (snapshot.quizzes[0]) return { kind: 'quiz', id: snapshot.quizzes[0].id };
    return null;
  });
  const [showUpload, setShowUpload] = useState(false);
  const [showAddDoc, setShowAddDoc] = useState(false);

  const [upTitle, setUpTitle] = useState('');
  const [upKind, setUpKind] = useState<'video' | 'audio'>('video');
  const [upTranscript, setUpTranscript] = useState('');
  const [upDecisions, setUpDecisions] = useState('');
  const [upFile, setUpFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const [docTitle, setDocTitle] = useState('');
  const [docContent, setDocContent] = useState('');
  const [docDecisions, setDocDecisions] = useState('');

  const videoRef = useRef<HTMLVideoElement | null>(null);

  const staleMediaMap = new Map(
    snapshot.drift.staleArtifacts
      .filter((s) => s.artifactType === 'media')
      .map((s) => [s.artifactId, s]),
  );
  const staleQuizMap = new Map(
    snapshot.drift.staleArtifacts
      .filter((s) => s.artifactType === 'quiz')
      .map((s) => [s.artifactId, s]),
  );
  const activeJobMap = new Map<string, RefreshJob>();
  for (const job of snapshot.jobs ?? []) {
    if (job.status === 'queued' || job.status === 'claimed') {
      activeJobMap.set(`${job.artifactType}:${job.artifactId}`, job);
    }
  }

  const activeMedia: MediaArtifact | null =
    selected?.kind === 'media'
      ? snapshot.media.find((m) => m.id === selected.id) ?? null
      : null;
  const activeQuiz: Quiz | null =
    selected?.kind === 'quiz'
      ? snapshot.quizzes.find((q) => q.id === selected.id) ?? null
      : null;

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!upFile) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', upFile);
      form.append('title', upTitle.trim() || upFile.name);
      form.append('kind', upKind);
      if (upTranscript.trim()) form.append('transcript', upTranscript.trim());
      if (upDecisions.trim()) form.append('basedOnDecisions', upDecisions.trim());
      const created = await api.uploadMediaFile(snapshot.config.slug, form);
      setUpTitle('');
      setUpTranscript('');
      setUpDecisions('');
      setUpFile(null);
      setShowUpload(false);
      setSelected({ kind: 'media', id: created.id });
      onRefresh();
    } finally {
      setUploading(false);
    }
  };

  const handleAddDoc = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!docTitle.trim()) return;
    const created = await api.addMediaJson(snapshot.config.slug, {
      title: docTitle.trim(),
      kind: 'doc',
      content: docContent,
      basedOnDecisions: docDecisions
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    });
    setDocTitle('');
    setDocContent('');
    setDocDecisions('');
    setShowAddDoc(false);
    setSelected({ kind: 'media', id: created.id });
    onRefresh();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-zinc-100">Media &amp; Mastery</h2>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowAddDoc(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-xs font-medium text-zinc-200 transition"
          >
            <Plus className="w-3.5 h-3.5" /> Add doc
          </button>
          <button
            type="button"
            onClick={() => setShowUpload(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white transition"
          >
            <Upload className="w-3.5 h-3.5" /> Upload media
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-4 space-y-4 min-w-0">
          <div className="space-y-2">
            <div className="text-[11px] uppercase tracking-wider text-zinc-400 font-semibold px-1 flex items-center gap-1.5">
              <HelpCircle className="w-3.5 h-3.5 text-zinc-400" /> Quizzes ({snapshot.quizzes.length})
            </div>
            {snapshot.quizzes.map((q) => {
              const trend = computeMasteryTrend(q.attempts);
              const isStale = staleQuizMap.has(q.id);
              const activeJob = activeJobMap.get(`quiz:${q.id}`);
              const isSelected = selected?.kind === 'quiz' && selected.id === q.id;
              return (
                <button
                  key={q.id}
                  type="button"
                  onClick={() => setSelected({ kind: 'quiz', id: q.id })}
                  className={`w-full text-left rounded-lg border p-3 transition ${
                    isSelected
                      ? 'border-indigo-500 bg-zinc-900'
                      : 'border-zinc-800 bg-zinc-900 hover:border-zinc-700'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-[10px] font-mono uppercase text-zinc-400">
                      quiz · {q.questions.length} Qs · v{q.version ?? 1}
                    </span>
                    {trend && (
                      <span className="text-[11px] font-mono text-zinc-200">
                        {trend.latestPct}%
                        {trend.delta !== null && (
                          <span className="text-zinc-400 ml-1">
                            ({trend.delta > 0 ? `+${trend.delta}` : trend.delta}%)
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                  <div className="text-xs font-semibold text-zinc-100 break-words">{q.title}</div>
                  {isStale && (
                    <div className="mt-1.5">
                      <StatusBadge
                        status={activeJob ? 'refreshing' : 'stale'}
                        label={activeJob ? 'Refreshing' : 'Stale'}
                      />
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          <div className="space-y-2">
            <div className="text-[11px] uppercase tracking-wider text-zinc-400 font-semibold px-1">
              Artifacts ({snapshot.media.length})
            </div>
            {snapshot.media.map((m) => {
              const isStale = staleMediaMap.has(m.id);
              const activeJob = activeJobMap.get(`media:${m.id}`);
              const isSelected = selected?.kind === 'media' && selected.id === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setSelected({ kind: 'media', id: m.id })}
                  className={`w-full text-left rounded-lg border p-3 transition ${
                    isSelected
                      ? 'border-indigo-500 bg-zinc-900'
                      : 'border-zinc-800 bg-zinc-900 hover:border-zinc-700'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase text-zinc-400">
                      {m.kind === 'video' ? (
                        <Film className="w-3 h-3 text-zinc-400" />
                      ) : (
                        <FileText className="w-3 h-3 text-zinc-400" />
                      )}
                      {m.kind} · v{m.version ?? 1}
                    </span>
                    {isStale && (
                      <StatusBadge
                        status={activeJob ? 'refreshing' : 'stale'}
                        label={activeJob ? 'Refreshing' : 'Stale'}
                      />
                    )}
                  </div>
                  <div className="text-xs font-semibold text-zinc-100 break-words">{m.title}</div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="lg:col-span-8 rounded-lg border border-zinc-800 bg-zinc-900 p-4 sm:p-5 min-h-[420px] min-w-0">
          {activeQuiz ? (
            <QuizRunner
              key={activeQuiz.id}
              slug={snapshot.config.slug}
              quiz={activeQuiz}
              snapshot={snapshot}
              staleReasons={staleQuizMap.get(activeQuiz.id)?.reasons}
              activeJob={activeJobMap.get(`quiz:${activeQuiz.id}`)}
              onSubmitted={onRefresh}
            />
          ) : activeMedia ? (
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-zinc-400">
                    <span className="uppercase">{activeMedia.kind}</span>
                    <span>v{activeMedia.version ?? 1}</span>
                    <span>{activeMedia.id}</span>
                  </div>
                  <h3 className="text-base font-semibold text-zinc-100 mt-0.5 break-words">
                    {activeMedia.title}
                  </h3>
                  {activeMedia.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {activeMedia.tags.map((t) => (
                        <span
                          key={t}
                          className="text-[10px] px-1.5 py-0.5 rounded border border-zinc-800 bg-zinc-950 text-zinc-400"
                        >
                          #{t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    await api.deleteMedia(snapshot.config.slug, activeMedia.id);
                    setSelected(null);
                    onRefresh();
                  }}
                  className="p-1.5 rounded-lg text-zinc-500 hover:text-rose-400 hover:bg-zinc-800 shrink-0"
                  title="Delete artifact"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              <ConfirmationBadges confirmations={activeMedia.confirmations} />

              {staleMediaMap.has(activeMedia.id) && (
                <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3.5 space-y-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge
                      status={activeJobMap.has(`media:${activeMedia.id}`) ? 'refreshing' : 'stale'}
                      label={activeJobMap.has(`media:${activeMedia.id}`) ? 'Refreshing' : 'Stale'}
                    />
                    <span className="text-xs text-zinc-300">
                      {staleMediaMap.get(activeMedia.id)!.reasons.join(' · ')}
                    </span>
                  </div>
                  <StaleArtifactActions
                    boardSlug={snapshot.config.slug}
                    artifactType="media"
                    artifactId={activeMedia.id}
                    activeJob={activeJobMap.get(`media:${activeMedia.id}`)}
                    onUpdated={onRefresh}
                  />
                </div>
              )}

              {activeMedia.kind === 'video' && (
                <div className="space-y-3">
                  {activeMedia.filePath || isSafeHttpUrl(activeMedia.externalUrl) ? (
                    <video
                      ref={videoRef}
                      controls
                      className="w-full rounded-lg border border-zinc-800 bg-black max-h-[400px]"
                      src={
                        activeMedia.filePath
                          ? `/api/boards/${encodeURIComponent(snapshot.config.slug)}/media/${encodeURIComponent(activeMedia.id)}/file`
                          : activeMedia.externalUrl
                      }
                    />
                  ) : (
                    <div className="rounded-lg border border-dashed border-zinc-700 bg-zinc-950 p-5 text-center text-xs text-zinc-400">
                      No video file attached.
                    </div>
                  )}

                  {activeMedia.chapters.length > 0 && (
                    <div className="space-y-1.5">
                      <div className="text-[11px] uppercase tracking-wider text-zinc-400">
                        Chapters
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {activeMedia.chapters.map((ch, idx) => (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => {
                              if (videoRef.current) {
                                videoRef.current.currentTime = ch.timeSec;
                                void videoRef.current.play();
                              }
                            }}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-zinc-800 bg-zinc-950 hover:border-indigo-500 text-xs text-zinc-200"
                          >
                            <span className="font-mono text-indigo-400">
                              {formatTime(ch.timeSec)}
                            </span>
                            {ch.title}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {activeMedia.transcript && (
                    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 space-y-1.5">
                      <div className="text-[11px] uppercase tracking-wider text-zinc-400">
                        Transcript
                      </div>
                      <p className="text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap">
                        {activeMedia.transcript}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {activeMedia.kind === 'audio' && activeMedia.filePath && (
                <audio
                  controls
                  className="w-full"
                  src={`/api/boards/${encodeURIComponent(snapshot.config.slug)}/media/${encodeURIComponent(activeMedia.id)}/file`}
                />
              )}

              {activeMedia.kind === 'doc' && (
                <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 overflow-x-auto">
                  <MarkdownView content={activeMedia.content || ''} />
                </div>
              )}

              {(activeMedia.kind === 'json' || activeMedia.kind === 'custom') && (
                <pre className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-xs font-mono text-zinc-200 overflow-auto">
                  {activeMedia.content || JSON.stringify(activeMedia.metadata, null, 2)}
                </pre>
              )}

              {activeMedia.kind === 'html' && activeMedia.content && (
                <iframe
                  sandbox="allow-scripts"
                  title={activeMedia.title}
                  srcDoc={wrapHtmlArtifactSrcDoc(activeMedia.content)}
                  className="w-full h-[420px] rounded-lg border border-zinc-800 bg-white"
                />
              )}

              {activeMedia.kind === 'link' && isSafeHttpUrl(activeMedia.externalUrl) && (
                <a
                  href={activeMedia.externalUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex text-sm text-indigo-400 underline break-all"
                >
                  {activeMedia.externalUrl}
                </a>
              )}
            </div>
          ) : (
            <div className="py-16 text-center text-xs text-zinc-500">
              Select an item to view.
            </div>
          )}
        </div>
      </div>

      {showUpload && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <form
            onSubmit={handleUpload}
            className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-900 p-5 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-100">Upload media</h3>
              <button
                type="button"
                onClick={() => setShowUpload(false)}
                className="text-zinc-400 hover:text-zinc-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Media file</label>
                <input
                  required
                  type="file"
                  accept="video/*,audio/*"
                  onChange={(e) => setUpFile(e.target.files?.[0] ?? null)}
                  className="w-full text-xs text-zinc-300 file:mr-3 file:rounded-md file:border-0 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-xs file:text-zinc-200"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div className="sm:col-span-2">
                  <label className="block text-xs text-zinc-400 mb-1">Title</label>
                  <input
                    value={upTitle}
                    onChange={(e) => setUpTitle(e.target.value)}
                    placeholder="Explainer title"
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100"
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Type</label>
                  <select
                    value={upKind}
                    onChange={(e) => setUpKind(e.target.value as 'video' | 'audio')}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-zinc-100"
                  >
                    <option value="video">video</option>
                    <option value="audio">audio</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Transcript (optional)</label>
                <textarea
                  rows={3}
                  value={upTranscript}
                  onChange={(e) => setUpTranscript(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">
                  Based on Decision IDs (optional)
                </label>
                <input
                  value={upDecisions}
                  onChange={(e) => setUpDecisions(e.target.value)}
                  placeholder="dec_003"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowUpload(false)}
                className="px-3 py-1.5 text-xs text-zinc-400"
              >
                Cancel
              </button>
              <button
                disabled={uploading || !upFile}
                type="submit"
                className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs font-medium text-white"
              >
                {uploading ? 'Uploading...' : 'Upload'}
              </button>
            </div>
          </form>
        </div>
      )}

      {showAddDoc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <form
            onSubmit={handleAddDoc}
            className="w-full max-w-lg rounded-lg border border-zinc-800 bg-zinc-900 p-5 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-100">Add doc</h3>
              <button
                type="button"
                onClick={() => setShowAddDoc(false)}
                className="text-zinc-400 hover:text-zinc-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Title</label>
                <input
                  required
                  value={docTitle}
                  onChange={(e) => setDocTitle(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Content (Markdown)</label>
                <textarea
                  rows={8}
                  value={docContent}
                  onChange={(e) => setDocContent(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 p-3 font-mono text-xs text-zinc-100"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">
                  Based on Decision IDs (optional)
                </label>
                <input
                  value={docDecisions}
                  onChange={(e) => setDocDecisions(e.target.value)}
                  placeholder="dec_002, dec_003"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowAddDoc(false)}
                className="px-3 py-1.5 text-xs text-zinc-400"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white"
              >
                Save doc
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
