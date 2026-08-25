<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    HelloPayload,
    JsonValue,
    PageCommand,
    PageEvent,
    SnapshotNode,
    TraceRecord
  } from '../shared/protocol';
  import {
    connectPanel,
    type ConnectionStatus,
    type PanelConnection
  } from './transport';

  type Detail = Record<string, JsonValue>;
  type TreeRow = SnapshotNode & { depth: number; hasChildren: boolean };

  const requestId = () => crypto.randomUUID();

  let connection: PanelConnection | null = null;
  let status = $state<ConnectionStatus>('connecting');
  let sessionId = $state<string | null>(null);
  let hello = $state<HelloPayload | null>(null);
  let nodes = $state<SnapshotNode[]>([]);
  let traces = $state<TraceRecord[]>([]);
  let selectedId = $state<string | null>(null);
  let selectedTraceId = $state<string | null>(null);
  let query = $state('');
  let pickerActive = $state(false);
  let recording = $state(true);
  let gap = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let expanded = $state<Record<string, boolean>>({});
  let editingStateKey = $state<string | null>(null);
  let editingStateValue = $state('');

  const selected = $derived(nodes.find((node) => node.id === selectedId) ?? null);
  const selectedTrace = $derived(traces.find((trace) => trace.id === selectedTraceId) ?? null);
  const selectedDetail = $derived(asDetail(selected?.detail));
  const selectedTraceDetail = $derived(asDetail(selectedTrace?.detail));
  const selectedInvocation = $derived(asDetail(selectedDetail?.invocation));
  const treeNodes = $derived(nodes.filter((node) => node.kind !== 'element' && node.kind !== 'text'));
  const rows = $derived(buildRows(treeNodes, expanded, query));
  const components = $derived(nodes.filter((node) => node.kind === 'component'));
  const timelineMode = $derived(readTimelineMode(nodes));

  onMount(() => {
    connection = connectPanel({
      onStatus(next) {
        status = next;
      },
      onSession(nextSessionId) {
        sessionId = nextSessionId;
        nodes = [];
        traces = [];
        selectedId = null;
        selectedTraceId = null;
        editingStateKey = null;
        hello = null;
        gap = null;
        queueMicrotask(activatePage);
      },
      onPageConnected() {
        queueMicrotask(activatePage);
      },
      onGap(fromSeq, toSeq) {
        gap = `Capture compacted messages ${fromSeq}–${toSeq}`;
      },
      onEvent(event) {
        consume(event);
      }
    });

    const syncCapture = () => {
      if (document.hidden && timelineMode === 'travel') goLive();
      send({ kind: 'record', enabled: recording && !document.hidden });
    };
    document.addEventListener('visibilitychange', syncCapture);
    activatePage();
    return () => {
      document.removeEventListener('visibilitychange', syncCapture);
      if (timelineMode === 'travel') goLive();
      send({ kind: 'record', enabled: false });
      connection?.close();
    };
  });

  function consume(event: PageEvent) {
    if (event.type === 'hello') {
      hello = event.payload;
      return;
    }

    if (event.type === 'snapshot') {
      nodes = event.payload.nodes;
      const nextExpanded = { ...expanded };
      for (const node of nodes) {
        if (!(node.id in nextExpanded)) nextExpanded[node.id] = true;
      }
      expanded = nextExpanded;
      if (selectedId && !nodes.some((node) => node.id === selectedId)) selectedId = null;
      return;
    }

    if (event.type === 'trace') {
      const byId = new Map(traces.map((trace) => [trace.id, trace]));
      for (const trace of event.payload.events) byId.set(trace.id, trace);
      traces = [...byId.values()].sort((a, b) => a.at - b.at).slice(-500);
      return;
    }

    if (event.type === 'picker') {
      pickerActive = event.payload.phase !== 'cancelled' && event.payload.phase !== 'selected';
      if (event.payload.phase === 'selected' && event.payload.componentId) {
        selectNode(event.payload.componentId, true);
      }
      return;
    }

    if (event.type === 'command-result') {
      notice = event.payload.ok ? null : event.payload.error ?? 'Command failed';
      return;
    }

    if (event.type === 'time-travel-result') {
      notice = event.payload.ok
        ? event.payload.live
          ? 'Back live'
          : `Restored ${event.payload.applied} component${event.payload.applied === 1 ? '' : 's'}`
        : event.payload.failures?.map((failure) => failure.reason).join(', ') ?? 'Restore failed';
      refresh();
    }
  }

  function send(command: PageCommand) {
    connection?.command(command);
  }

  function activatePage() {
    send({ kind: 'connect' });
    refresh();
    send({ kind: 'record', enabled: recording && !document.hidden });
  }

  function refresh() {
    send({ kind: 'snapshot', requestId: requestId() });
  }

  function togglePicker() {
    pickerActive = !pickerActive;
    send({ kind: 'picker', action: pickerActive ? 'start' : 'stop' });
  }

  function toggleRecording() {
    recording = !recording;
    if (!recording && timelineMode === 'travel') goLive();
    send({ kind: 'record', enabled: recording && !document.hidden });
  }

  function selectNode(id: string, reveal = false) {
    selectedId = id;
    selectedTraceId = null;
    editingStateKey = null;
    send({ kind: 'highlight', componentId: id, reveal });
  }

  function hoverNode(id: string | null) {
    send({ kind: 'highlight', componentId: id ?? selectedId });
  }

  function toggleExpanded(id: string) {
    expanded = { ...expanded, [id]: expanded[id] === false };
  }

  function selectTrace(trace: TraceRecord) {
    selectedTraceId = trace.id;
    if (trace.componentId) {
      selectedId = trace.componentId;
      send({ kind: 'highlight', componentId: trace.componentId });
    }
  }

  function rewind(trace: TraceRecord) {
    const detail = asDetail(trace.detail);
    const checkpointId = typeof detail?.checkpointId === 'string' ? detail.checkpointId : null;
    const cursor = typeof detail?.cursor === 'number' ? detail.cursor : undefined;
    if (!checkpointId && cursor === undefined) {
      notice = 'This receipt no longer has a restorable checkpoint';
      return;
    }
    send({
      kind: 'time-travel',
      requestId: requestId(),
      action: 'apply',
      cursor,
      targets: checkpointId && trace.componentId
        ? [{ componentId: trace.componentId, checkpointId }]
        : undefined
    });
  }

  function goLive() {
    send({ kind: 'time-travel', requestId: requestId(), action: 'live' });
  }

  function openSource() {
    if (!selected?.source) return;
    const source = selected.source;
    const open = (url: string) => {
      chrome.devtools.panels.openResource(
        url,
        Math.max(0, source.line - 1),
        Math.max(0, source.column),
        () => {
        if (chrome.runtime.lastError) {
          notice = chrome.runtime.lastError.message ?? 'Source is not loaded in DevTools';
        }
        }
      );
    };
    if (/^(?:https?|file|webpack):/i.test(source.file)) {
      open(source.file);
      return;
    }
    chrome.devtools.inspectedWindow.eval('location.origin', (origin, exception) => {
      if (!exception && typeof origin === 'string' && /^https?:\/\//i.test(origin)) {
        open(new URL(source.file.replace(/^\.?\//, '/'), origin).href);
      } else {
        open(source.file);
      }
    });
  }

  function startStateEdit(key: string, value: JsonValue) {
    editingStateKey = key;
    editingStateValue = JSON.stringify(value, null, 2) ?? 'null';
  }

  function cancelStateEdit() {
    editingStateKey = null;
    editingStateValue = '';
  }

  function applyStateEdit() {
    if (!selectedId || !editingStateKey) return;
    let value: JsonValue;
    try {
      value = JSON.parse(editingStateValue) as JsonValue;
    } catch {
      notice = 'State edits must be valid JSON';
      return;
    }
    send({
      kind: 'set-value',
      requestId: requestId(),
      componentId: selectedId,
      path: ['state', editingStateKey],
      value
    });
    cancelStateEdit();
    refresh();
  }

  function asDetail(value: JsonValue | undefined): Detail | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Detail) : null;
  }

  function buildRows(
    values: SnapshotNode[],
    open: Record<string, boolean>,
    search: string
  ): TreeRow[] {
    const byParent = new Map<string | null, SnapshotNode[]>();
    const ids = new Set(values.map((value) => value.id));
    for (const value of values) {
      const parentId = value.parentId && ids.has(value.parentId) ? value.parentId : null;
      const list = byParent.get(parentId) ?? [];
      list.push(value);
      byParent.set(parentId, list);
    }

    const needle = search.trim().toLowerCase();
    const visible = new Set<string>();
    if (needle) {
      const parentOf = new Map(values.map((value) => [value.id, value.parentId ?? null]));
      for (const value of values) {
        const source = value.source?.file ?? '';
        if (`${value.name} ${source}`.toLowerCase().includes(needle)) {
          let id: string | null = value.id;
          const ancestors = new Set<string>();
          while (id && !ancestors.has(id)) {
            ancestors.add(id);
            visible.add(id);
            id = parentOf.get(id) ?? null;
          }
        }
      }
    }

    const result: TreeRow[] = [];
    const roots = byParent.get(null) ?? [];
    const stack = roots.map((value) => ({ value, depth: 0 })).reverse();
    const visited = new Set<string>();
    while (stack.length > 0) {
      const item = stack.pop();
      if (!item || visited.has(item.value.id)) continue;
      visited.add(item.value.id);
      if (needle && !visible.has(item.value.id)) continue;

      const children = byParent.get(item.value.id) ?? [];
      result.push({ ...item.value, depth: Math.min(item.depth, 64), hasChildren: children.length > 0 });
      if (open[item.value.id] !== false) {
        for (let index = children.length - 1; index >= 0; index--) {
          const child = children[index];
          if (child) stack.push({ value: child, depth: item.depth + 1 });
        }
      }
    }
    return result;
  }

  function shortFile(file: string | undefined) {
    if (!file) return 'source unavailable';
    const parts = file.split('/');
    return parts.slice(-2).join('/');
  }

  function componentName(id: string | undefined) {
    if (!id) return 'Page';
    return nodes.find((node) => node.id === id)?.name ?? id;
  }

  function isRuneTrace(trace: TraceRecord) {
    return trace.kind !== 'dom';
  }

  function canRewind(trace: TraceRecord | null) {
    const detail = asDetail(trace?.detail);
    return detail?.restorable === true && (
      typeof detail.checkpointId === 'string' || typeof detail.cursor === 'number'
    );
  }

  function interactionLabel(trace: TraceRecord | null) {
    if (!trace) return null;
    const own = asDetail(trace.detail);
    if (typeof own?.interaction === 'string') {
      return typeof own.target === 'string' ? `${own.interaction} · ${own.target}` : own.interaction;
    }
    if (!trace.causeId) return null;
    const cause = traces.find((candidate) => candidate.id === trace.causeId);
    const detail = asDetail(cause?.detail);
    if (cause?.kind !== 'interaction' || typeof detail?.interaction !== 'string') return null;
    return typeof detail.target === 'string'
      ? `${detail.interaction} · ${detail.target}`
      : detail.interaction;
  }

  function traceSummary(trace: TraceRecord, detail: Detail | null) {
    if (trace.kind === 'mount') return 'component mounted';
    if (trace.kind === 'unmount') return 'component unmounted';
    if (trace.kind === 'interaction') return 'user interaction';
    if (trace.kind === 'state-set') return 'state edited';
    if (trace.kind === 'time-travel') return 'timeline moved';
    if (Array.isArray(detail?.changes)) {
      return `${detail.changes.length} value change${detail.changes.length === 1 ? '' : 's'}`;
    }
    if (trace.kind === 'dom') {
      const mutationCount = ['added', 'removed', 'attributes', 'text'].reduce((total, key) => {
        const value = detail?.[key];
        return total + (typeof value === 'number' ? value : 0);
      }, 0);
      return `${mutationCount} DOM mutation${mutationCount === 1 ? '' : 's'}`;
    }
    return 'reactive update';
  }

  function readTimelineMode(values: SnapshotNode[]): 'live' | 'travel' {
    for (const value of values) {
      const timeline = asDetail(asDetail(value.detail)?.timeline);
      if (timeline?.mode === 'travel') return 'travel';
    }
    return 'live';
  }

  function detailText(value: JsonValue | undefined) {
    if (value === undefined) return '—';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function isEditablePreview(value: JsonValue): boolean {
    if (value === null || typeof value !== 'object') return true;
    if (Array.isArray(value)) return value.every(isEditablePreview);
    if ('$type' in value) return false;
    return Object.values(value).every(isEditablePreview);
  }
</script>

<svelte:head><title>Svelte Lens</title></svelte:head>

<div class="shell">
  <header class="toolbar">
    <div class="brand" title="Svelte Lens">
      <span class="brand-mark"><span></span></span>
      <strong>Svelte Lens</strong>
      <span class="version">Svelte {hello?.svelteVersion ?? '5'}</span>
    </div>

    <div class="toolbar-actions">
      <button class:active={pickerActive} class="tool-button" onclick={togglePicker} title="Pick a Svelte component on the page">
        <span class="crosshair">⌖</span> Pick
      </button>
      <button class="icon-button" onclick={refresh} title="Refresh tree">↻</button>
      <button class:paused={!recording} class="record-button" onclick={toggleRecording} title="Toggle trace capture">
        <span></span>{recording ? 'Recording' : 'Paused'}
      </button>
      <span class:online={status === 'connected'} class="connection-dot" title={status}></span>
    </div>
  </header>

  <div class="banner-slot">
    {#if gap || notice}
      <div class="notice">
        <span>{gap ?? notice}</span>
        <button onclick={() => { gap = null; notice = null; }}>×</button>
      </div>
    {/if}
  </div>

  {#if hello && hello.mode !== 'dev'}
    <div class="unsupported">
      <strong>Svelte development metadata was not found.</strong>
      <span>Run the inspected app in development mode, then reload the page.</span>
    </div>
  {:else}
    <main class="workspace">
      <section class="pane tree-pane">
        <div class="pane-header">
          <div>
            <span class="pane-title">Components</span>
            <span class="count">{components.length}</span>
          </div>
        </div>
        <label class="search">
          <span>⌕</span>
          <input bind:value={query} placeholder="Filter components" />
          {#if query}<button onclick={() => (query = '')}>×</button>{/if}
        </label>
        <div class="tree" role="tree" aria-label="Svelte component tree">
          {#if rows.length === 0}
            <div class="empty compact">
              {status === 'connected' ? 'No Svelte dev nodes yet.' : 'Waiting for the inspected page…'}
            </div>
          {/if}
          {#each rows as row (row.id)}
            <button
              class:selected={selectedId === row.id}
              class:subtle={row.kind !== 'component'}
              class="tree-row"
              style:--depth={row.depth}
              onclick={(event) => {
                if ((event.target as HTMLElement).closest('.disclosure')) toggleExpanded(row.id);
                else selectNode(row.id, true);
              }}
              onmouseenter={() => hoverNode(row.id)}
              onmouseleave={() => hoverNode(null)}
              role="treeitem"
              aria-selected={selectedId === row.id}
            >
              <span
                class:empty={!row.hasChildren}
                class="disclosure"
              >{row.hasChildren ? (expanded[row.id] === false ? '›' : '⌄') : '·'}</span>
              <span class:component={row.kind === 'component'} class="node-icon"></span>
              <span class="node-label">{row.name}</span>
              {#if asDetail(row.detail)?.enhanced === true}<span class="enhanced" title="Vite instrumentation active">●</span>{/if}
              {#if typeof asDetail(row.detail)?.updateCount === 'number'}
                <span class="update-count">{asDetail(row.detail)?.updateCount}</span>
              {/if}
            </button>
          {/each}
        </div>
      </section>

      <section class="pane trace-pane">
        <div class="pane-header trace-header">
          <div>
            <span class="pane-title">Update receipts</span>
            <span class="count">{traces.length}</span>
          </div>
          <div class="trace-legend">
            <span><i class="rune"></i>rune</span>
            <span><i class="dom"></i>DOM</span>
          </div>
        </div>

        <div class="trace-list">
          {#if traces.length === 0}
            <div class="empty">
              <span class="empty-orbit"><i></i></span>
              <strong>No updates captured yet</strong>
              <p>Interact with the inspected Svelte app. Every reactive update will leave a receipt here.</p>
            </div>
          {/if}
          {#each traces as trace, index (trace.id)}
            {@const detail = asDetail(trace.detail)}
            {@const interaction = interactionLabel(trace)}
            <button
              class:selected={selectedTraceId === trace.id}
              class="trace-row"
              onclick={() => selectTrace(trace)}
            >
              <span class="trace-rail">
                <i class:rune={isRuneTrace(trace)} class:dom={!isRuneTrace(trace)}></i>
                {#if index < traces.length - 1}<b></b>{/if}
              </span>
              <span class="trace-copy">
                <span class="trace-primary">
                  <strong>{componentName(trace.componentId)}</strong>
                  <span class="trace-kind">{typeof detail?.phase === 'string' ? detail.phase : trace.kind}</span>
                  <time>+{Math.max(0, trace.at - (traces[0]?.at ?? trace.at)).toFixed(1)}ms</time>
                </span>
                <span class="trace-secondary">
                  {#if interaction}<em>{interaction}</em>{/if}
                  <span>{traceSummary(trace, detail)}</span>
                </span>
              </span>
              {#if canRewind(trace)}<span class="rewind-glyph" title="Restorable checkpoint">↶</span>{/if}
            </button>
          {/each}
        </div>

        <div class="time-travel">
          <div class="time-copy">
            <span class:travel={timelineMode === 'travel'} class="live-pulse"></span>
            <div>
              <strong>{timelineMode === 'travel' ? 'Rewound' : 'Live'}</strong>
              <span>{timelineMode === 'travel' ? 'local state checkpoint' : recording ? 'capturing updates' : 'capture paused'}</span>
            </div>
          </div>
          <div class="time-actions">
            <button disabled={!canRewind(selectedTrace)} onclick={() => selectedTrace && rewind(selectedTrace)}>↶ Rewind here</button>
            <button disabled={timelineMode === 'live'} onclick={goLive}>Go live</button>
          </div>
        </div>
      </section>

      <aside class="pane inspector-pane">
        <div class="inspector-top">
          <span class="pane-title">Inspector</span>
          {#if selected}<span class="selected-kind">{selected.kind}</span>{/if}
        </div>

        {#if selected}
          <div class="identity">
            <div class="identity-icon">S</div>
            <div>
              <h2>{selected.name}</h2>
              <button title={selected.source?.file} onclick={openSource}>{shortFile(selected.source?.file)}{selected.source ? `:${selected.source.line}` : ''}</button>
            </div>
          </div>

          <div class="metrics">
            <div><strong>{typeof selectedDetail?.updateCount === 'number' ? selectedDetail.updateCount : 0}</strong><span>updates</span></div>
            <div><strong>{typeof selectedDetail?.domCount === 'number' ? selectedDetail.domCount : 0}</strong><span>DOM nodes</span></div>
            <div><strong>{selectedDetail?.enhanced === true ? 'on' : 'base'}</strong><span>capture</span></div>
          </div>

          {#if selectedTrace}
            <section class="inspector-section receipt">
              <div class="section-title"><span>Selected receipt</span><time>{new Date(selectedTrace.at).toLocaleTimeString()}</time></div>
              <div class="cause-line"><i></i><span>{interactionLabel(selectedTrace) ?? selectedTrace.kind}</span></div>
              {#if Array.isArray(selectedTraceDetail?.changes)}
                <pre>{detailText(selectedTraceDetail.changes)}</pre>
              {/if}
            </section>
          {/if}

          {#each ['props', 'state', 'derived'] as section}
            {@const value = selectedDetail?.[section]}
            <section class="inspector-section">
              <div class="section-title">
                <span>{section}</span>
                <span class="section-count">{value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).length : 0}</span>
              </div>
              {#if value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0}
                <div class="value-table">
                  {#each Object.entries(value) as [key, entry]}
                    {@const writable = section === 'state' && asDetail(selectedDetail?.writableState)?.[key] === true && isEditablePreview(entry)}
                    <div class:value-editing={editingStateKey === key && section === 'state'} class="value-row">
                      <code>{key}</code>
                      {#if editingStateKey === key && section === 'state'}
                        <div class="value-editor">
                          <textarea
                            aria-label={`Edit state ${key} as JSON`}
                            bind:value={editingStateValue}
                            onkeydown={(event) => {
                              if (event.key === 'Escape') cancelStateEdit();
                              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) applyStateEdit();
                            }}
                          ></textarea>
                          <div>
                            <button onclick={cancelStateEdit}>Cancel</button>
                            <button class="save" onclick={applyStateEdit}>Apply</button>
                          </div>
                        </div>
                      {:else}
                        <pre>{detailText(entry)}</pre>
                        {#if writable}
                          <button class="edit-value" title={`Edit ${key}`} onclick={() => startStateEdit(key, entry)}>Edit</button>
                        {/if}
                      {/if}
                    </div>
                  {/each}
                </div>
              {:else}
                <div class="section-empty">
                  {selectedDetail?.enhanced === true ? `No ${section} captured` : 'Add svelte-lens-vite for live values'}
                </div>
              {/if}
            </section>
          {/each}

          <section class="inspector-section source-section">
            <div class="section-title"><span>Source</span></div>
            <dl>
              <div><dt>file</dt><dd>{selected.source?.file ?? 'unavailable'}</dd></div>
              <div><dt>location</dt><dd>{selected.source ? `${selected.source.line}:${selected.source.column}` : '—'}</dd></div>
              {#if typeof selectedInvocation?.file === 'string'}
                <div><dt>called from</dt><dd>{selectedInvocation.file}:{selectedInvocation.line ?? '?'}</dd></div>
              {/if}
            </dl>
          </section>
        {:else}
          <div class="empty inspector-empty">
            <span class="cursor-card">⌖</span>
            <strong>Select a component</strong>
            <p>Choose one in the tree or use Pick to inspect it on the page.</p>
          </div>
        {/if}
      </aside>
    </main>
  {/if}

  <footer class="statusbar">
    <span><i class:online={status === 'connected'}></i>{status}</span>
    <span>{sessionId ? `session ${sessionId.slice(0, 8)}` : 'no page session'}</span>
    <span class="spacer"></span>
    <span class:available={hello?.capabilities.state}>{hello?.capabilities.state ? 'enhanced state capture' : 'metadata capture'}</span>
  </footer>
</div>
