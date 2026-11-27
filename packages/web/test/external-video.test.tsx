// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaMasteryLens } from '../src/components/MediaMasteryLens';
import type { BoardSnapshot, MediaArtifact } from '../src/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeSnapshot(media: MediaArtifact[]): BoardSnapshot {
  return {
    config: {
      slug: 'main',
      title: 'Main',
      description: '',
      revision: 1,
      lenses: [],
      createdAt: '2026-11-27T00:00:00.000Z',
      updatedAt: '2026-11-27T00:00:00.000Z',
    },
    brief: '',
    sessions: [],
    decisions: [],
    tasks: [],
    diagrams: [],
    media,
    quizzes: [],
    jobs: [],
    events: [],
    drift: {
      boardRevision: 1,
      driftedSessions: [],
      staleArtifacts: [],
    },
  };
}

function makeVideoArtifact(overrides: Partial<MediaArtifact>): MediaArtifact {
  return {
    id: 'med_video_1',
    title: 'External Video',
    kind: 'video',
    basedOnDecisions: [],
    tags: [],
    chapters: [],
    version: 1,
    boardRevisionAtUpdate: 1,
    createdAt: '2026-11-27T00:00:00.000Z',
    updatedAt: '2026-11-27T00:00:00.000Z',
    ...overrides,
  };
}

describe('B3 Hardening Round 4 G1: External video playback & fallback (R4-1)', () => {
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

  it('R4-1: http external video shows open-in-new-tab fallback', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const httpVideo = makeVideoArtifact({
      id: 'med_http_vid',
      title: 'HTTP Legacy Video',
      externalUrl: 'http://media.example.test/legacy.mp4',
    });
    const httpsVideo = makeVideoArtifact({
      id: 'med_https_vid',
      title: 'HTTPS External Video',
      externalUrl: 'https://media.example.test/tutorial.mp4',
    });
    const localVideo = makeVideoArtifact({
      id: 'med_local_vid',
      title: 'Local Uploaded Video',
      filePath: 'media/med_local_vid.mp4',
    });

    await act(async () => {
      root!.render(
        <MediaMasteryLens
          snapshot={makeSnapshot([httpVideo, httpsVideo, localVideo])}
          onRefresh={vi.fn()}
        />,
      );
    });

    // 1. http: external video is blocked by CSP on purpose -> no <video>, inline fallback link
    expect(container.querySelector('video')).toBeNull();
    const httpFallback = container.querySelector('a[href="http://media.example.test/legacy.mp4"]');
    expect(httpFallback).not.toBeNull();
    expect(httpFallback?.textContent?.trim()).toBe('Open video in a new tab');
    expect(httpFallback?.getAttribute('target')).toBe('_blank');
    expect(httpFallback?.getAttribute('rel')).toBe('noopener noreferrer');

    // 2. Switch to https: external video -> renders <video preload="none">
    const httpsBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('HTTPS External Video'),
    ) as HTMLButtonElement;
    expect(httpsBtn).toBeTruthy();

    await act(async () => {
      httpsBtn.click();
    });

    const httpsVideoEl = container.querySelector('video') as HTMLVideoElement | null;
    expect(httpsVideoEl).not.toBeNull();
    expect(httpsVideoEl?.getAttribute('src')).toBe('https://media.example.test/tutorial.mp4');
    expect(httpsVideoEl?.getAttribute('preload')).toBe('none');

    // Firing error on the <video> switches the slot to the inline fallback link
    await act(async () => {
      httpsVideoEl!.dispatchEvent(new Event('error'));
    });

    expect(container.querySelector('video')).toBeNull();
    const httpsFallback = container.querySelector(
      'a[href="https://media.example.test/tutorial.mp4"]',
    );
    expect(httpsFallback).not.toBeNull();
    expect(httpsFallback?.textContent?.trim()).toBe('Open video in a new tab');
    expect(httpsFallback?.getAttribute('target')).toBe('_blank');
    expect(httpsFallback?.getAttribute('rel')).toBe('noopener noreferrer');

    // 3. Switch to local filePath video -> renders <video> without preload="none"
    const localBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Local Uploaded Video'),
    ) as HTMLButtonElement;
    expect(localBtn).toBeTruthy();

    await act(async () => {
      localBtn.click();
    });

    const localVideoEl = container.querySelector('video') as HTMLVideoElement | null;
    expect(localVideoEl).not.toBeNull();
    expect(localVideoEl?.getAttribute('src')).toContain('/api/boards/main/media/med_local_vid/file');
    expect(localVideoEl?.getAttribute('preload')).not.toBe('none');
  });
});
