import type { BoardConfig } from './types';

export interface BoardTreeOption {
  board: BoardConfig;
  depth: number;
  label: string;
}

/**
 * Flatten boards into deterministic hierarchical tree order for the board switcher (AC6.3).
 * Safe against missing parent slugs and cycles in hand-edited board.yaml files.
 */
export function buildBoardTreeOptions(boards: BoardConfig[]): BoardTreeOption[] {
  const bySlug = new Map(boards.map((b) => [b.slug, b]));
  const childrenByParent = new Map<string, BoardConfig[]>();
  const roots: BoardConfig[] = [];

  const sorted = [...boards].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

  for (const board of sorted) {
    const parent = board.parentBoard;
    if (parent && parent !== board.slug && bySlug.has(parent)) {
      const list = childrenByParent.get(parent) ?? [];
      list.push(board);
      childrenByParent.set(parent, list);
    } else {
      roots.push(board);
    }
  }

  const result: BoardTreeOption[] = [];
  const visited = new Set<string>();

  const visit = (board: BoardConfig, depth: number) => {
    if (visited.has(board.slug)) return;
    visited.add(board.slug);
    const prefix = depth === 0 ? '' : `${'\u00A0\u00A0'.repeat(depth - 1)}└─ `;
    result.push({
      board,
      depth,
      label: `${prefix}${board.title} (${board.slug})`,
    });
    const children = childrenByParent.get(board.slug) ?? [];
    for (const child of children) {
      visit(child, depth + 1);
    }
  };

  for (const root of roots) {
    visit(root, 0);
  }

  // Fallback for disconnected cycle components so every board remains selectable
  for (const board of sorted) {
    if (!visited.has(board.slug)) {
      visit(board, 0);
    }
  }

  return result;
}
