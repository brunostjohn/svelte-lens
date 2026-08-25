import { describe, expect, it } from 'vitest';

import type { SnapshotNode } from '../shared/protocol';
import { buildComponentTree } from './component-tree';

const node = (id: string, parentId?: string | null, name = id): SnapshotNode => ({
  id,
  parentId,
  kind: 'component',
  name
});

describe('buildComponentTree', () => {
  it('preserves stable input order and parentage', () => {
    const tree = buildComponentTree([
      node('root'),
      node('first', 'root'),
      node('second', 'root')
    ]);

    expect(tree.children.map((item) => item.id)).toEqual(['root']);
    expect(tree.children[0]?.children.map((item) => item.id)).toEqual(['first', 'second']);
  });

  it('keeps matches and their ancestors while filtering', () => {
    const tree = buildComponentTree([
      node('root'),
      node('settings', 'root', 'Settings'),
      { ...node('account', 'settings', 'Account'), source: { file: 'src/account.svelte', line: 1, column: 0 } },
      node('billing', 'root', 'Billing')
    ], 'account.svelte');

    expect(tree.children.map((item) => item.id)).toEqual(['root']);
    expect(tree.children[0]?.children.map((item) => item.id)).toEqual(['settings']);
    expect(tree.children[0]?.children[0]?.children.map((item) => item.id)).toEqual(['account']);
  });

  it('promotes cycles, self parents, and over-deep paths instead of recursing forever', () => {
    const cycle = [node('a', 'b'), node('b', 'a'), node('self', 'self')];
    const chain = Array.from({ length: 70 }, (_, index) =>
      node(`deep-${index}`, index === 0 ? null : `deep-${index - 1}`));

    const tree = buildComponentTree([...cycle, ...chain]);
    const topLevel = new Set(tree.children.map((item) => item.id));

    expect([...topLevel]).toEqual(expect.arrayContaining(['a', 'b', 'self', 'deep-0', 'deep-65']));
  });

  it('ignores duplicate ids rather than rendering ambiguous tree items', () => {
    const tree = buildComponentTree([node('same', null, 'First'), node('same', null, 'Second')]);
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]?.snapshot?.name).toBe('First');
  });
});
