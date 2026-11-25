import { useRef, useState } from 'react';
import {
  AlertTriangle,
  Award,
  BookOpen,
  CheckCircle2,
  FileText,
  Film,
  HelpCircle,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  X,
  XCircle,
} from 'lucide-react';
import type { BoardSnapshot, MediaArtifact, Quiz } from '../types';
import { api } from '../api';
import { MarkdownView } from './Badge';

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

function QuizRunner({
  slug,
  quiz,
  onSubmitted,
}: {
  slug: string;
  quiz: Quiz;
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

  const latestAttempt = quiz.attempts[quiz.attempts.length - 1];

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
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-zinc-800 pb-4">
        <div>
          <div className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-pink-300 font-semibold">
            <HelpCircle className="w-3.5 h-3.5" /> Knowledge Check Quiz
          </div>
          <h3 className="text-base font-semibold text-zinc-100 mt-1">{quiz.title}</h3>
          {quiz.description && <p className="text-xs text-zinc-400 mt-0.5">{quiz.description}</p>}
        </div>

        {latestAttempt && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/25 px-3.5 py-2 text-right">
            <div className="text-[10px] uppercase tracking-wider text-emerald-300 flex items-center gap-1 justify-end">
              <Award className="w-3.5 h-3.5" /> Latest Mastery
            </div>
            <div className="text-lg font-bold text-emerald-200">{latestAttempt.percentage}%</div>
            <div className="text-[10px] text-zinc-400">
              {quiz.attempts.length} attempt(s) logged
            </div>
          </div>
        )}
      </div>

      <div className="space-y-4">
        {quiz.questions.map((q, idx) => {
          const chosen = answers[q.id];
          const showReveal = submittedResult !== null;
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
              className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-4 space-y-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="text-sm font-medium text-zinc-100">
                  <span className="text-indigo-400 font-mono mr-2">Q{idx + 1}.</span>
                  {q.prompt}
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
                    let cls =
                      'border-zinc-800 bg-zinc-900/60 hover:border-zinc-700 text-zinc-200';
                    if (showReveal && optIdx === q.correctIndex) {
                      cls = 'border-emerald-500/60 bg-emerald-500/15 text-emerald-100';
                    } else if (showReveal && selected && optIdx !== q.correctIndex) {
                      cls = 'border-rose-500/60 bg-rose-500/15 text-rose-100';
                    } else if (selected) {
                      cls = 'border-indigo-500 bg-indigo-500/15 text-indigo-100';
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
                  <strong className="text-indigo-300">Explanation: </strong>
                  {q.explanation}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 pt-2 border-t border-zinc-800">
        <div className="flex items-center gap-3 text-xs text-zinc-300">
          <span>Mental-model confidence:</span>
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setConfidence(n)}
                className={`w-7 h-7 rounded-md font-mono text-xs border transition ${
                  confidence === n
                    ? 'bg-indigo-600 border-indigo-400 text-white'
                    : 'bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <button
          disabled={submitting}
          onClick={handleSubmit}
          className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white"
        >
          {submitting ? 'Checking...' : 'Check Answers & Log Mastery'}
        </button>
      </div>

      {submittedResult && (
        <div className="rounded-xl border border-indigo-500/40 bg-indigo-950/30 p-4 flex items-center justify-between">
          <div className="text-sm font-semibold text-indigo-100">
            Score: {submittedResult.score} / {submittedResult.total} ({submittedResult.percentage}%)
          </div>
          <span className="text-xs text-indigo-300">Saved to .contextdeck/quizzes/{quiz.id}.quiz.json</span>
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

  // Upload form
  const [upTitle, setUpTitle] = useState('');
  const [upKind, setUpKind] = useState<'video' | 'audio'>('video');
  const [upTranscript, setUpTranscript] = useState('');
  const [upDecisions, setUpDecisions] = useState('');
  const [upFile, setUpFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  // Add Doc form
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
        <div>
          <h2 className="text-base font-semibold text-zinc-100">
            Learning Media, Videos, Quizzes & Reference Docs
          </h2>
          <p className="text-xs text-zinc-400">
            Watch Kokoro TTS explainer videos, take knowledge-check quizzes, and catch stale learning material when decisions evolve.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowAddDoc(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-xs font-medium text-zinc-200"
          >
            <Plus className="w-3.5 h-3.5" /> Add Note / Doc
          </button>
          <button
            onClick={() => setShowUpload(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white"
          >
            <Upload className="w-3.5 h-3.5" /> Upload Video / Audio
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Left Library List */}
        <div className="lg:col-span-4 space-y-4">
          <div className="space-y-2">
            <div className="text-[11px] uppercase tracking-wider text-zinc-400 font-semibold px-1 flex items-center gap-1.5">
              <HelpCircle className="w-3.5 h-3.5 text-pink-400" /> Interactive Quizzes ({snapshot.quizzes.length})
            </div>
            {snapshot.quizzes.map((q) => {
              const latest = q.attempts[q.attempts.length - 1];
              const isStale = staleQuizMap.has(q.id);
              const isSelected = selected?.kind === 'quiz' && selected.id === q.id;
              return (
                <button
                  key={q.id}
                  onClick={() => setSelected({ kind: 'quiz', id: q.id })}
                  className={`w-full text-left rounded-xl border p-3 transition ${
                    isSelected
                      ? 'border-indigo-500/60 bg-indigo-500/10'
                      : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-pink-500/15 text-pink-300 font-semibold">
                      quiz • {q.questions.length} Qs
                    </span>
                    {latest && (
                      <span className="text-[11px] font-mono text-emerald-300">
                        {latest.percentage}%
                      </span>
                    )}
                  </div>
                  <div className="text-xs font-semibold text-zinc-100">{q.title}</div>
                  {isStale && (
                    <div className="mt-1 inline-flex items-center gap-1 text-[10px] text-amber-300">
                      <AlertTriangle className="w-3 h-3" /> Decision changed
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          <div className="space-y-2">
            <div className="text-[11px] uppercase tracking-wider text-zinc-400 font-semibold px-1 flex items-center gap-1.5">
              <BookOpen className="w-3.5 h-3.5 text-sky-400" /> Videos, Audio & Docs ({snapshot.media.length})
            </div>
            {snapshot.media.map((m) => {
              const isStale = staleMediaMap.has(m.id);
              const isSelected = selected?.kind === 'media' && selected.id === m.id;
              return (
                <button
                  key={m.id}
                  onClick={() => setSelected({ kind: 'media', id: m.id })}
                  className={`w-full text-left rounded-xl border p-3 transition ${
                    isSelected
                      ? 'border-indigo-500/60 bg-indigo-500/10'
                      : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 font-semibold">
                      {m.kind === 'video' ? (
                        <Film className="w-3 h-3 text-sky-400" />
                      ) : (
                        <FileText className="w-3 h-3 text-indigo-400" />
                      )}
                      {m.kind}
                    </span>
                    {isStale && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-amber-300">
                        <AlertTriangle className="w-3 h-3" /> Stale
                      </span>
                    )}
                  </div>
                  <div className="text-xs font-semibold text-zinc-100">{m.title}</div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Right Detail / Player / Runner */}
        <div className="lg:col-span-8 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 min-h-[520px]">
          {activeQuiz ? (
            <QuizRunner
              key={activeQuiz.id}
              slug={snapshot.config.slug}
              quiz={activeQuiz}
              onSubmitted={onRefresh}
            />
          ) : activeMedia ? (
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-sky-400 font-semibold">
                    {activeMedia.kind} artifact
                  </div>
                  <h3 className="text-base font-semibold text-zinc-100 mt-0.5">
                    {activeMedia.title}
                  </h3>
                  {activeMedia.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {activeMedia.tags.map((t) => (
                        <span
                          key={t}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400"
                        >
                          #{t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  onClick={async () => {
                    await api.deleteMedia(snapshot.config.slug, activeMedia.id);
                    setSelected(null);
                    onRefresh();
                  }}
                  className="p-1.5 rounded-lg text-zinc-500 hover:text-rose-400 hover:bg-zinc-800"
                  title="Delete artifact"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              {staleMediaMap.has(activeMedia.id) && (
                <div className="rounded-lg border border-amber-500/35 bg-amber-950/25 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                  <div className="space-y-0.5">
                    <div className="text-xs font-semibold text-amber-200 flex items-center gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                      Reference artifact predates a newer decision
                    </div>
                    <div className="text-[11px] text-amber-200/80">
                      {staleMediaMap.get(activeMedia.id)!.reasons.join(' • ')}
                    </div>
                  </div>
                  <button
                    onClick={async () => {
                      await api.refreshArtifact(snapshot.config.slug, 'media', activeMedia.id);
                      onRefresh();
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600/20 border border-emerald-500/40 text-emerald-200 hover:bg-emerald-600/30 text-xs font-medium"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> Mark Aligned
                  </button>
                </div>
              )}

              {/* Video / Audio Player */}
              {activeMedia.kind === 'video' && (
                <div className="space-y-3">
                  {activeMedia.filePath || activeMedia.externalUrl ? (
                    <video
                      ref={videoRef}
                      controls
                      className="w-full rounded-xl border border-zinc-800 bg-black max-h-[400px]"
                      src={
                        activeMedia.filePath
                          ? `/api/boards/${encodeURIComponent(snapshot.config.slug)}/media/${encodeURIComponent(activeMedia.id)}/file`
                          : activeMedia.externalUrl
                      }
                    />
                  ) : (
                    <div className="rounded-xl border border-dashed border-zinc-700 bg-zinc-950 p-6 text-center space-y-2">
                      <Film className="w-8 h-8 text-zinc-600 mx-auto" />
                      <div className="text-xs text-zinc-300 font-medium">
                        No video binary attached yet
                      </div>
                      <p className="text-[11px] text-zinc-500 max-w-md mx-auto">
                        Attach a rendered <code className="text-indigo-300">.mp4</code> /{' '}
                        <code className="text-indigo-300">.webm</code> from your{' '}
                        <code className="text-indigo-300">idea-to-video</code> skill via the Upload
                        button or{' '}
                        <code className="text-indigo-300">
                          cdeck media add &quot;Title&quot; --type video --file video.mp4
                        </code>
                        .
                      </p>
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
                            onClick={() => {
                              if (videoRef.current) {
                                videoRef.current.currentTime = ch.timeSec;
                                void videoRef.current.play();
                              }
                            }}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-zinc-800 bg-zinc-950 hover:border-indigo-500/50 text-xs text-zinc-200"
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
                        Narration / Kokoro TTS Transcript
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
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-5">
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
                  srcDoc={activeMedia.content}
                  className="w-full h-[420px] rounded-lg border border-zinc-800 bg-white"
                />
              )}

              {activeMedia.kind === 'link' && activeMedia.externalUrl && (
                <a
                  href={activeMedia.externalUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex text-sm text-indigo-400 underline"
                >
                  {activeMedia.externalUrl}
                </a>
              )}
            </div>
          ) : (
            <div className="py-16 text-center text-xs text-zinc-500">
              Select a quiz, video explainer, or reference doc from the left list.
            </div>
          )}
        </div>
      </div>

      {/* Upload Video / Audio Modal */}
      {showUpload && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <form
            onSubmit={handleUpload}
            className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-5 space-y-4 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-100">Upload Video / Audio Artifact</h3>
              <button type="button" onClick={() => setShowUpload(false)} className="text-zinc-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Media File (.mp4, .webm, .mp3, .wav)</label>
                <input
                  required
                  type="file"
                  accept="video/*,audio/*"
                  onChange={(e) => setUpFile(e.target.files?.[0] ?? null)}
                  className="w-full text-xs text-zinc-300 file:mr-3 file:rounded-md file:border-0 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-xs file:text-zinc-200"
                />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
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
                <label className="block text-xs text-zinc-400 mb-1">Based on Decision IDs (optional)</label>
                <input
                  value={upDecisions}
                  onChange={(e) => setUpDecisions(e.target.value)}
                  placeholder="dec_003"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowUpload(false)} className="px-3 py-1.5 text-xs text-zinc-400">
                Cancel
              </button>
              <button
                disabled={uploading || !upFile}
                type="submit"
                className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs font-semibold text-white"
              >
                {uploading ? 'Uploading...' : 'Upload'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Add Doc Modal */}
      {showAddDoc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <form
            onSubmit={handleAddDoc}
            className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-900 p-5 space-y-4 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-100">Add Markdown Reference Doc</h3>
              <button type="button" onClick={() => setShowAddDoc(false)} className="text-zinc-400 hover:text-white">
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
                <label className="block text-xs text-zinc-400 mb-1">Based on Decision IDs (optional)</label>
                <input
                  value={docDecisions}
                  onChange={(e) => setDocDecisions(e.target.value)}
                  placeholder="dec_002, dec_003"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowAddDoc(false)} className="px-3 py-1.5 text-xs text-zinc-400">
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white"
              >
                Save Doc
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
