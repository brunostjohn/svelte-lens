import type { SnapshotNode } from '../shared/protocol';

export const COMPONENT_TREE_ROOT_ID = 'svelte-lens:component-tree-root';
const MAX_TREE_DEPTH = 64;

export interface ComponentTreeNode {
  id: string;
  snapshot: SnapshotNode | null;
  children: ComponentTreeNode[];
}

/**
 * Turns the page adapter's untrusted flat records into a finite, acyclic tree.
 * Invalid parents, cycles, and pathologically deep chains are promoted to roots
 * so neither the tree widget nor the panel can recurse forever.
 */
export function buildComponentTree(
  values: readonly SnapshotNode[],
  search = ''
): ComponentTreeNode {
  const nodes = new Map<string, ComponentTreeNode>();
  const source = new Map<string, SnapshotNode>();

  for (const value of values) {
    if (nodes.has(value.id) || value.id === COMPONENT_TREE_ROOT_ID) continue;
    nodes.set(value.id, { id: value.id, snapshot: value, children: [] });
    source.set(value.id, value);
  }

  const parentOf = new Map<string, string | null>();
  for (const value of source.values()) {
    const candidate = value.parentId;
    if (!candidate || candidate === value.id || !nodes.has(candidate)) {
      parentOf.set(value.id, null);
      continue;
    }

    let cursor: string | null = candidate;
    const seen = new Set([value.id]);
    let depth = 0;
    let valid = true;
    while (cursor) {
      if (seen.has(cursor) || depth >= MAX_TREE_DEPTH) {
        valid = false;
        break;
      }
      seen.add(cursor);
      const parent: string | null | undefined = source.get(cursor)?.parentId;
      cursor = parent && nodes.has(parent) ? parent : null;
      depth += 1;
    }
    parentOf.set(value.id, valid ? candidate : null);
  }

  const roots: ComponentTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = parentOf.get(node.id);
    if (parent) nodes.get(parent)?.children.push(node);
    else roots.push(node);
  }

  const needle = search.trim().toLocaleLowerCase();
  if (!needle) {
    return { id: COMPONENT_TREE_ROOT_ID, snapshot: null, children: roots };
  }

  const visible = new Set<string>();
  for (const value of source.values()) {
    const haystack = `${value.name} ${value.source?.file ?? ''}`.toLocaleLowerCase();
    if (!haystack.includes(needle)) continue;
    let cursor: string | null = value.id;
    while (cursor && !visible.has(cursor)) {
      visible.add(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
  }

  const filter = (items: readonly ComponentTreeNode[]): ComponentTreeNode[] =>
    items.flatMap((item) => visible.has(item.id)
      ? [{ ...item, children: filter(item.children) }]
      : []);

  return {
    id: COMPONENT_TREE_ROOT_ID,
    snapshot: null,
    children: filter(roots)
  };
}
