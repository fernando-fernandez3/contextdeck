import type { Decision, Quiz, QuizAttempt } from './types';

function resolveLatestDecision(
  decisionId: string,
  decisionMap: Map<string, Decision>,
): Decision | undefined {
  let current = decisionMap.get(decisionId);
  const visited = new Set<string>();
  while (current?.supersededBy && !visited.has(current.id)) {
    visited.add(current.id);
    const next = decisionMap.get(current.supersededBy);
    if (!next) break;
    current = next;
  }
  return current;
}

export interface QuestionStaleInfo {
  staleDecisionIds: string[];
  reasons: string[];
}

/**
 * AC7.7 / Neon 18: Evaluate per-question staleness using `question.relatedDecisionIds`
 * and respecting active `quiz.confirmations`.
 */
export function getQuizQuestionStaleness(
  quiz: Pick<Quiz, 'questions' | 'confirmations'>,
  decisions: Decision[],
): Record<string, QuestionStaleInfo> {
  const decisionMap = new Map(decisions.map((d) => [d.id, d]));
  const confirmations = quiz.confirmations ?? {};
  const result: Record<string, QuestionStaleInfo> = {};

  for (const q of quiz.questions) {
    const staleDecisionIds: string[] = [];
    const reasons: string[] = [];
    const seen = new Set<string>();
    for (const decId of q.relatedDecisionIds ?? []) {
      if (seen.has(decId)) continue;
      seen.add(decId);
      const dec = decisionMap.get(decId);
      if (!dec) continue;
      if (dec.status === 'superseded') {
        const latest = resolveLatestDecision(dec.id, decisionMap);
        const conf = confirmations[dec.id];
        if (conf && latest && latest.id !== dec.id && conf.againstDecisionId === latest.id) {
          continue;
        }
        staleDecisionIds.push(dec.id);
        reasons.push(
          latest && latest.id !== dec.id
            ? `${dec.id} superseded by ${latest.id} ("${latest.title}")`
            : `${dec.id} superseded`,
        );
      } else if (dec.status === 'deprecated') {
        const conf = confirmations[dec.id];
        if (conf && conf.againstDecisionId === dec.id) continue;
        staleDecisionIds.push(dec.id);
        reasons.push(`${dec.id} deprecated`);
      }
    }
    if (staleDecisionIds.length > 0) {
      result[q.id] = { staleDecisionIds, reasons };
    }
  }

  return result;
}

export interface MasteryTrend {
  latestPct: number;
  previousPct: number | null;
  delta: number | null;
  scores: number[];
}

export function computeMasteryTrend(attempts: QuizAttempt[]): MasteryTrend | null {
  if (!attempts || attempts.length === 0) return null;
  const scores = attempts.map((a) => a.percentage);
  const latestPct = scores[scores.length - 1];
  const previousPct = scores.length >= 2 ? scores[scores.length - 2] : null;
  const delta = previousPct !== null ? latestPct - previousPct : null;
  return { latestPct, previousPct, delta, scores };
}

export function formatRelativeTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return 'first visit';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return 'first visit';
  const diffSec = Math.max(0, Math.floor((now.getTime() - ts) / 1000));
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}
