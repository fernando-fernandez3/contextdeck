import { describe, expect, it } from 'vitest';
import { buildBoardTreeOptions } from '../src/board-tree';
import type { BoardConfig } from '../src/types';

function mkBoard(slug: string, title: string, parentBoard?: string | null): BoardConfig {
  return {
    id: `brd_${slug}`,
    slug,
    title,
    description: '',
    revision: 1,
    lenses: [],
    parentBoard: parentBoard ?? null,
    createdAt: '2026-11-26T00:00:00.000Z',
    updatedAt: '2026-11-26T00:00:00.000Z',
  };
}

describe('AC6.3 UI board switcher tree hierarchy', () => {
  it('orders boards hierarchically with parent -> child indentation', () => {
    const boards = [
      mkBoard('auth-ui', 'Auth UI', 'web'),
      mkBoard('api', 'API Service', 'platform'),
      mkBoard('platform', 'Platform'),
      mkBoard('web', 'Web App', 'platform'),
      mkBoard('standalone', 'Standalone'),
    ];

    const opts = buildBoardTreeOptions(boards);
    expect(opts.map((o) => ({ slug: o.board.slug, depth: o.depth }))).toEqual([
      { slug: 'platform', depth: 0 },
      { slug: 'api', depth: 1 },
      { slug: 'web', depth: 1 },
      { slug: 'auth-ui', depth: 2 },
      { slug: 'standalone', depth: 0 },
    ]);
    expect(opts[0].label).toBe('Platform (platform)');
    expect(opts[1].label).toContain('API Service (api)');
    expect(opts[3].label).toContain('Auth UI (auth-ui)');
  });

  it('handles broken parent links and cycles without hanging', () => {
    const boards = [
      mkBoard('orphan', 'Orphan', 'missing-parent'),
      mkBoard('a', 'Board A', 'b'),
      mkBoard('b', 'Board B', 'a'),
    ];

    const opts = buildBoardTreeOptions(boards);
    expect(opts.map((o) => o.board.slug).sort()).toEqual(['a', 'b', 'orphan']);
  });

  it('N1: orders sibling slugs by deterministic ASCII code-unit comparison', () => {
    const boards = [mkBoard('a_1', 'Underscore'), mkBoard('a-1', 'Hyphen')];
    const opts = buildBoardTreeOptions(boards);
    expect(opts.map((o) => o.board.slug)).toEqual(['a-1', 'a_1']);
  });
});
