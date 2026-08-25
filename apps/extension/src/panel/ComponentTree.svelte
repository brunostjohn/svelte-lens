<script lang="ts">
  import { normalizeProps, useMachine } from '@zag-js/svelte';
  import * as tree from '@zag-js/tree-view';

  import type { JsonValue, SnapshotNode } from '../shared/protocol';
  import { buildComponentTree, type ComponentTreeNode } from './component-tree';

  interface Props {
    nodes: SnapshotNode[];
    selectedId: string | null;
    query: string;
    effectCount: (id: string) => number;
    effectErrorCount: (id: string) => number;
    onSelect: (id: string) => void;
    onHover: (id: string | null) => void;
  }

  let {
    nodes,
    selectedId,
    query,
    effectCount,
    effectErrorCount,
    onSelect,
    onHover
  }: Props = $props();

  let collapsedValue = $state<string[]>([]);

  const root = $derived(buildComponentTree(nodes));
  const filteredRoot = $derived(query.trim() ? buildComponentTree(nodes, query) : root);
  const collectionOptions = (rootNode: ComponentTreeNode) => ({
    rootNode,
    nodeToValue: (node: ComponentTreeNode) => node.id,
    nodeToString: (node: ComponentTreeNode) => node.snapshot?.name ?? '',
    nodeToChildren: (node: ComponentTreeNode) => node.children
  });
  const fullCollection = $derived(tree.collection(collectionOptions(root)));
  const collection = $derived(
    query.trim() ? tree.collection(collectionOptions(filteredRoot)) : fullCollection
  );
  const allBranches = $derived(fullCollection.getBranchValues());
  const expandedValue = $derived(allBranches.filter((id) => !collapsedValue.includes(id)));
  const machineExpandedValue = $derived(query.trim() ? collection.getBranchValues() : expandedValue);

  const service = useMachine(tree.machine, () => ({
    id: 'svelte-lens-component-tree',
    collection,
    expandedValue: machineExpandedValue,
    selectedValue: selectedId ? [selectedId] : [],
    selectionMode: 'single' as const,
    expandOnClick: true,
    translations: { treeLabel: 'Svelte component tree' },
    onExpandedChange(details: tree.ExpandedChangeDetails<ComponentTreeNode>) {
      if (!query.trim()) {
        const expanded = new Set(details.expandedValue);
        collapsedValue = allBranches.filter((id) => !expanded.has(id));
      }
    },
    onSelectionChange(details: tree.SelectionChangeDetails<ComponentTreeNode>) {
      const id = details.selectedValue.at(-1);
      if (id) onSelect(id);
    }
  }));

  const api = $derived(tree.connect(service, normalizeProps));
  const visibleNodes = $derived(api.getVisibleNodes());

  function detail(value: JsonValue | undefined): Record<string, JsonValue> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, JsonValue>
      : null;
  }
</script>

<div class="tree" {...api.getRootProps()}>
  <div {...api.getTreeProps()}>
    {#each visibleNodes as item (item.node.id)}
      {@const node = item.node.snapshot}
      {@const nodeProps = { node: item.node, indexPath: item.indexPath }}
      {@const state = api.getNodeState(nodeProps)}
      {#if node}
        {#if state.isBranch}
          <div {...api.getBranchProps(nodeProps)} class="tree-branch">
            <button
              {...api.getBranchControlProps(nodeProps)}
              class:selected={state.selected}
              class:subtle={node.kind !== 'component'}
              class="tree-row"
              onmouseenter={() => onHover(node.id)}
              onmouseleave={() => onHover(null)}
            >
              <span {...api.getBranchIndicatorProps(nodeProps)} class="disclosure">
                <span class="disclosure-glyph">›</span>
              </span>
              <span class:component={node.kind === 'component'} class="node-icon"></span>
              <span {...api.getBranchTextProps(nodeProps)} class="node-label" title={node.name}>{node.name}</span>
              {#if detail(node.detail)?.enhanced === true}<span class="enhanced" title="Vite instrumentation active">●</span>{/if}
              {#if effectCount(node.id) > 0}
                <span
                  class:error={effectErrorCount(node.id) > 0}
                  class="effect-count"
                  title={`${effectCount(node.id)} instrumented effect${effectCount(node.id) === 1 ? '' : 's'}${effectErrorCount(node.id) ? ` · ${effectErrorCount(node.id)} errored` : ''}`}
                >fx {effectCount(node.id)}</span>
              {/if}
              {#if typeof detail(node.detail)?.updateCount === 'number'}
                <span class="update-count">{detail(node.detail)?.updateCount}</span>
              {/if}
            </button>
          </div>
        {:else}
          <button
            {...api.getItemProps(nodeProps)}
            class:selected={state.selected}
            class:subtle={node.kind !== 'component'}
            class="tree-row"
            onmouseenter={() => onHover(node.id)}
            onmouseleave={() => onHover(null)}
          >
            <span class="disclosure disclosure-placeholder" aria-hidden="true">·</span>
            <span class:component={node.kind === 'component'} class="node-icon"></span>
            <span {...api.getItemTextProps(nodeProps)} class="node-label" title={node.name}>{node.name}</span>
            {#if detail(node.detail)?.enhanced === true}<span class="enhanced" title="Vite instrumentation active">●</span>{/if}
            {#if effectCount(node.id) > 0}
              <span
                class:error={effectErrorCount(node.id) > 0}
                class="effect-count"
                title={`${effectCount(node.id)} instrumented effect${effectCount(node.id) === 1 ? '' : 's'}${effectErrorCount(node.id) ? ` · ${effectErrorCount(node.id)} errored` : ''}`}
              >fx {effectCount(node.id)}</span>
            {/if}
            {#if typeof detail(node.detail)?.updateCount === 'number'}
              <span class="update-count">{detail(node.detail)?.updateCount}</span>
            {/if}
          </button>
        {/if}
      {/if}
    {/each}
  </div>
</div>
