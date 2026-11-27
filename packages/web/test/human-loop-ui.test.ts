import { describe, expect, it } from 'vitest';
import { computeMasteryTrend, formatRelativeTime, getQuizQuestionStaleness } from '../src/quiz-helpers';
import type { Decision, Quiz } from '../src/types';

describe('B3 Web helpers: quiz per-question staleness, mastery trend, and relative time (AC7.2, AC7.7)', () => {
  it('flags only questions referencing superseded unconfirmed decisions via relatedDecisionIds', () => {
    const decisions: Decision[] = [
      {
        id: 'dec_001',
        title: 'Use Redis',
        status: 'superseded',
        supersededBy: 'dec_003',
        tags: [],
        summary: '',
        rationale: '',
        createdAt: '2026-11-25T00:00:00Z',
        updatedAt: '2026-11-25T00:00:00Z',
      },
      {
        id: 'dec_002',
        title: 'Expose MCP',
        status: 'accepted',
        tags: [],
        summary: '',
        rationale: '',
        createdAt: '2026-11-25T00:00:00Z',
        updatedAt: '2026-11-25T00:00:00Z',
      },
      {
        id: 'dec_003',
        title: 'Use Plain Files',
        status: 'accepted',
        supersedes: 'dec_001',
        tags: [],
        summary: '',
        rationale: '',
        createdAt: '2026-11-25T00:00:00Z',
        updatedAt: '2026-11-25T00:00:00Z',
      },
    ];

    const quiz: Quiz = {
      id: 'quiz_1',
      title: 'Sync Mastery',
      topic: 'Sync',
      description: '',
      basedOnDecisions: ['dec_001', 'dec_002'],
      attempts: [],
      questions: [
        {
          id: 'q1',
          prompt: 'Redis question',
          type: 'true_false',
          correctAnswer: 'true',
          explanation: '',
          relatedDecisionIds: ['dec_001'],
        },
        {
          id: 'q2',
          prompt: 'MCP question',
          type: 'true_false',
          correctAnswer: 'true',
          explanation: '',
          relatedDecisionIds: ['dec_002'],
        },
      ],
      boardRevisionAtUpdate: 1,
      createdAt: '2026-11-25T00:00:00Z',
      updatedAt: '2026-11-25T00:00:00Z',
    };

    const stale = getQuizQuestionStaleness(quiz, decisions);
    expect(stale.q1).toBeDefined();
    expect(stale.q1.reasons[0]).toContain('dec_003');
    expect(stale.q2).toBeUndefined();

    // Confirmed against dec_003 clears q1 staleness
    const confirmedQuiz: Quiz = {
      ...quiz,
      confirmations: {
        dec_001: {
          againstDecisionId: 'dec_003',
          confirmedBy: 'alice',
          actorType: 'human',
          confirmedAt: '2026-11-26T00:00:00Z',
          note: 'Still valid',
        },
      },
    };
    expect(getQuizQuestionStaleness(confirmedQuiz, decisions)).toEqual({});
  });

  it('computes score trend per quiz across multiple attempts', () => {
    expect(computeMasteryTrend([])).toBeNull();
    const trend = computeMasteryTrend([
      { id: 'a1', takenAt: '2026-11-24T00:00:00Z', score: 1, total: 3, percentage: 33, answers: {} },
      { id: 'a2', takenAt: '2026-11-25T00:00:00Z', score: 2, total: 3, percentage: 67, answers: {} },
      { id: 'a3', takenAt: '2026-11-26T00:00:00Z', score: 3, total: 3, percentage: 100, answers: {} },
    ]);
    expect(trend).toEqual({
      latestPct: 100,
      previousPct: 67,
      delta: 33,
      scores: [33, 67, 100],
    });
  });

  it('formats relative time concisely for Catch up header', () => {
    const now = new Date('2026-11-26T12:00:00.000Z');
    expect(formatRelativeTime(null, now)).toBe('first visit');
    expect(formatRelativeTime('2026-11-26T11:59:45.000Z', now)).toBe('just now');
    expect(formatRelativeTime('2026-11-26T11:40:00.000Z', now)).toBe('20m ago');
    expect(formatRelativeTime('2026-11-26T09:00:00.000Z', now)).toBe('3h ago');
    expect(formatRelativeTime('2026-11-24T12:00:00.000Z', now)).toBe('2d ago');
  });
});
