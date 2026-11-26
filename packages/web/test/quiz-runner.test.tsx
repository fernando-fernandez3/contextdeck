// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaMasteryLens } from '../src/components/MediaMasteryLens';
import { ApiError, api } from '../src/api';
import type { BoardSnapshot, Quiz } from '../src/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeSnapshot(quiz: Quiz): BoardSnapshot {
  return {
    config: {
      slug: 'main',
      title: 'Main',
      description: '',
      revision: 1,
      lenses: [],
      createdAt: '2026-11-26T00:00:00.000Z',
      updatedAt: '2026-11-26T00:00:00.000Z',
    },
    brief: '',
    sessions: [],
    decisions: [],
    tasks: [],
    diagrams: [],
    media: [],
    quizzes: [quiz],
    jobs: [],
    events: [],
    drift: {
      boardRevision: 1,
      driftedSessions: [],
      staleArtifacts: [],
    },
  };
}

describe('B3 Hardening Round 2 G2: QuizRunner version change & 409 handling (R2-5)', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
  });

  it('R2-5: clears selected answers and results when quiz version changes, and handles 409 by reloading with a short notice', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const quizV1: Quiz = {
      id: 'quiz_ver_test',
      title: 'Version Test Quiz',
      topic: 'Sync',
      description: '',
      basedOnDecisions: [],
      attempts: [],
      version: 1,
      questions: [
        {
          id: 'q1',
          prompt: 'Which letter is first?',
          type: 'multiple_choice',
          options: ['A', 'B'],
          correctIndex: 0,
          explanation: 'A is first',
          relatedDecisionIds: [],
        },
      ],
      boardRevisionAtUpdate: 1,
      createdAt: '2026-11-26T00:00:00.000Z',
      updatedAt: '2026-11-26T00:00:00.000Z',
    };

    const onRefresh = vi.fn();

    await act(async () => {
      root!.render(<MediaMasteryLens snapshot={makeSnapshot(quizV1)} onRefresh={onRefresh} />);
    });

    const getOptionButtons = () =>
      Array.from(container!.querySelectorAll('[data-question-id="q1"] button'));

    // Select option A on v1
    await act(async () => {
      (getOptionButtons()[0] as HTMLButtonElement).click();
    });
    expect(getOptionButtons()[0].className).toContain('border-indigo-500');

    // Quiz reloads at v2 with swapped options -> answers MUST be cleared
    const quizV2: Quiz = {
      ...quizV1,
      version: 2,
      questions: [
        {
          ...quizV1.questions[0],
          options: ['B', 'A'],
          correctIndex: 1,
        },
      ],
    };

    await act(async () => {
      root!.render(<MediaMasteryLens snapshot={makeSnapshot(quizV2)} onRefresh={onRefresh} />);
    });

    for (const btn of getOptionButtons()) {
      expect(btn.className).not.toContain('border-indigo-500');
    }

    // Select an option on v2 and simulate a 409 Conflict from backend on submit
    const submitSpy = vi
      .spyOn(api, 'submitQuizAttempt')
      .mockRejectedValueOnce(new ApiError('Quiz is now at version 3', 409, 'CONFLICT'));

    await act(async () => {
      (getOptionButtons()[1] as HTMLButtonElement).click();
    });
    expect(getOptionButtons()[1].className).toContain('border-indigo-500');

    const submitBtn = Array.from(container!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Submit answers'),
    ) as HTMLButtonElement;

    await act(async () => {
      submitBtn.click();
    });

    expect(submitSpy).toHaveBeenCalledWith('main', 'quiz_ver_test', { q1: 1 }, 3, 2);
    expect(onRefresh).toHaveBeenCalled();
    for (const btn of getOptionButtons()) {
      expect(btn.className).not.toContain('border-indigo-500');
    }
    const statusEl = container!.querySelector('[role="status"]');
    expect(statusEl?.textContent).toMatch(/changed|updated|newer version/i);
  });
});
