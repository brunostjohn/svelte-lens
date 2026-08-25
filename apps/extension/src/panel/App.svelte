<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    HelloPayload,
    JsonValue,
    PageCommand,
    PageEvent,
    SnapshotNode,
    SourceLocation,
    TraceRecord
  } from '../shared/protocol';
  import {
    connectPanel,
    type ConnectionStatus,
    type PanelConnection
  } from './transport';

  type Detail = Record<string, JsonValue>;
  type TreeRow = SnapshotNode & { depth: number; hasChildren: boolean };
  type CenterView = 'updates' | 'effects';
  type EffectStatus = 'active' | 'error' | 'disposed';

  type EffectSummary = {
    id: string;
    siteId: string;
    componentId: string;
    kind: 'effect' | 'pre';
    label?: string;
    source?: SourceLocation;
    parentEffectId?: string | null;
    status: EffectStatus;
    runCount: number;
    rerunCount: number;
    capturedRunCount: number;
    cleanupCount: number;
    errorCount: number;
    lastSyncDurationMs?: number;
    maxSyncDurationMs?: number;
    totalSyncDurationMs?: number;
    averageSyncDurationMs?: number;
    triggers: Detail[];
    dependencies: Detail[];
    dependencyCount: number;
    directDependencyCount: number;
    dependencyTruncated: boolean;
    triggerDetailOmitted: boolean;
    addedDependencyIds: string[];
    removedDependencyIds: string[];
    phase?: string;
    outcome?: string;
    adapter?: string;
    captureGap?: boolean;
    cleanupRegistered?: boolean;
    error?: JsonValue;
    at?: number;
  };

  const requestId = () => crypto.randomUUID();

  let connection: PanelConnection | null = null;
  let status = $state<ConnectionStatus>('connecting');
  let sessionId = $state<string | null>(null);
  let hello = $state<HelloPayload | null>(null);
  let nodes = $state<SnapshotNode[]>([]);
  let hasSnapshot = $state(false);
  let traces = $state<TraceRecord[]>([]);
  let selectedId = $state<string | null>(null);
  let selectedTraceId = $state<string | null>(null);
  let selectedEffectId = $state<string | null>(null);
  let centerView = $state<CenterView>('updates');
  let showAllEffects = $state(false);
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
  const effects = $derived(collectEffects(nodes, traces, hasSnapshot));
  const effectsByComponent = $derived.by(() => {
    const grouped = new Map<string, EffectSummary[]>();
    for (const effect of effects) {
      const componentEffects = grouped.get(effect.componentId) ?? [];
      componentEffects.push(effect);
      grouped.set(effect.componentId, componentEffects);
    }
    return grouped;
  });
  const effectTotalsByComponent = $derived.by(() => {
    const totals = new Map<string, number>();
    for (const component of components) {
      const detail = asDetail(component.detail);
      const visible = effectsByComponent.get(component.id)?.length ?? 0;
      const reported = countValue(
        detail?.effectTotal,
        asDetails(detail?.effects).length + countValue(detail?.effectsOmitted)
      );
      totals.set(component.id, Math.max(visible, reported));
    }
    return totals;
  });
  const selectedEffect = $derived(effects.find((effect) => effect.id === selectedEffectId) ?? null);
  const visibleEffects = $derived(
    showAllEffects || !selectedId
      ? effects
      : effectsByComponent.get(selectedId) ?? []
  );
  const totalEffectCount = $derived.by(() => {
    const mounted = new Set(components.map((component) => component.id));
    const mountedTotal = components.reduce((total, component) => total + effectCount(component.id), 0);
    return mountedTotal + effects.filter((effect) => !mounted.has(effect.componentId)).length;
  });
  const visibleOmittedEffectCount = $derived(
    showAllEffects || !selectedId
      ? components.reduce((total, component) => total + omittedEffectCount(component.id), 0)
      : omittedEffectCount(selectedId)
  );
  const effectRunTraces = $derived(traces.filter((trace) => trace.kind === 'effect-run'));

  onMount(() => {
    connection = connectPanel({
      onStatus(next) {
        status = next;
      },
      onSession(nextSessionId) {
        sessionId = nextSessionId;
        nodes = [];
        hasSnapshot = false;
        traces = [];
        selectedId = null;
        selectedTraceId = null;
        selectedEffectId = null;
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
      hasSnapshot = true;
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
    selectedEffectId = null;
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
    const detail = asDetail(trace.detail);
    selectedEffectId = (trace.kind === 'effect-run' || trace.kind === 'effect-cleanup') && typeof detail?.effectId === 'string'
      ? detail.effectId
      : null;
    if (trace.componentId) {
      selectedId = trace.componentId;
      send({ kind: 'highlight', componentId: trace.componentId });
    }
  }

  function selectEffect(effect: EffectSummary) {
    selectedEffectId = effect.id;
    selectedId = effect.componentId;
    editingStateKey = null;
    const latest = effectRunTraces.findLast((trace) => asDetail(trace.detail)?.effectId === effect.id);
    selectedTraceId = latest?.id ?? null;
    send({ kind: 'highlight', componentId: effect.componentId });
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
    openSourceAt(selected.source);
  }

  function openEffectSource() {
    const source = selectedEffect?.source ?? readSource(selectedTraceDetail?.source);
    if (source) openSourceAt(source);
  }

  function openTraceSource(trace: TraceRecord) {
    const source = readSource(asDetail(trace.detail)?.source) ??
      (trace.componentId ? nodes.find((node) => node.id === trace.componentId)?.source : undefined);
    if (source) openSourceAt(source);
  }

  function openSourceAt(source: SourceLocation) {
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

  function asDetails(value: JsonValue | undefined): Detail[] {
    if (!Array.isArray(value)) return [];
    return value.map((entry) => asDetail(entry)).filter((entry): entry is Detail => entry !== null);
  }

  function asStrings(value: JsonValue | undefined): string[] {
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : [];
  }

  function readSource(value: JsonValue | undefined): SourceLocation | undefined {
    const detail = asDetail(value);
    if (
      !detail ||
      typeof detail.file !== 'string' ||
      typeof detail.line !== 'number' ||
      typeof detail.column !== 'number'
    ) return undefined;
    return { file: detail.file, line: detail.line, column: detail.column };
  }

  function countValue(value: JsonValue | undefined, fallback = 0): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : fallback;
  }

  function durationValue(value: JsonValue | undefined): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  }

  function parseEffect(raw: Detail, ownerId: string | undefined, at?: number): EffectSummary | null {
    const id = typeof raw.effectId === 'string'
      ? raw.effectId
      : typeof raw.id === 'string'
        ? raw.id
        : null;
    if (!id) return null;

    const componentId = typeof raw.componentId === 'string' ? raw.componentId : ownerId;
    if (!componentId) return null;
    const rawKind = typeof raw.kind === 'string' ? raw.kind : 'effect';
    const kind = rawKind === 'pre' || rawKind === 'effect.pre' || rawKind === '$effect.pre'
      ? 'pre'
      : 'effect';
    const outcome = typeof raw.outcome === 'string' ? raw.outcome : undefined;
    const rawStatus = typeof raw.status === 'string' ? raw.status : undefined;
    const status: EffectStatus = outcome === 'error' || rawStatus === 'error'
      ? 'error'
      : rawStatus === 'disposed'
        ? 'disposed'
        : 'active';
    const runCount = countValue(raw.runCount, typeof raw.phase === 'string' ? 1 : 0);

    return {
      id,
      siteId: typeof raw.siteId === 'string' ? raw.siteId : id,
      componentId,
      kind,
      label: typeof raw.label === 'string' ? raw.label : undefined,
      source: readSource(raw.source),
      parentEffectId: typeof raw.parentEffectId === 'string'
        ? raw.parentEffectId
        : raw.parentEffectId === null
          ? null
          : undefined,
      status,
      runCount,
      rerunCount: countValue(raw.rerunCount, Math.max(0, runCount - 1)),
      capturedRunCount: countValue(raw.capturedRunCount, runCount),
      cleanupCount: countValue(raw.cleanupCount),
      errorCount: countValue(raw.errorCount, outcome === 'error' ? 1 : 0),
      lastSyncDurationMs: durationValue(raw.lastSyncDurationMs) ?? durationValue(raw.syncDurationMs),
      maxSyncDurationMs: durationValue(raw.maxSyncDurationMs),
      totalSyncDurationMs: durationValue(raw.totalSyncDurationMs),
      averageSyncDurationMs: durationValue(raw.averageSyncDurationMs),
      triggers: asDetails(raw.triggers),
      dependencies: asDetails(raw.dependencies),
      dependencyCount: countValue(raw.dependencyCount, asDetails(raw.dependencies).length),
      directDependencyCount: countValue(raw.directDependencyCount),
      dependencyTruncated: raw.dependencyTruncated === true,
      triggerDetailOmitted: raw.triggerDetailOmitted === true,
      addedDependencyIds: asStrings(raw.addedDependencyIds),
      removedDependencyIds: asStrings(raw.removedDependencyIds),
      phase: typeof raw.phase === 'string' ? raw.phase : undefined,
      outcome,
      adapter: typeof raw.adapter === 'string' ? raw.adapter : undefined,
      captureGap: typeof raw.captureGap === 'boolean' ? raw.captureGap : undefined,
      cleanupRegistered: typeof raw.cleanupRegistered === 'boolean' ? raw.cleanupRegistered : undefined,
      error: (raw.error ?? raw.lastError) === null ? undefined : raw.error ?? raw.lastError,
      at: at ?? durationValue(raw.lastRunAt) ?? durationValue(raw.at)
    };
  }

  function mergeEffect(previous: EffectSummary | undefined, next: EffectSummary): EffectSummary {
    if (!previous) return next;
    const nextIsNewer = next.runCount > previous.runCount || (
      next.runCount === previous.runCount && (next.at ?? 0) >= (previous.at ?? 0)
    );
    return {
      ...previous,
      ...next,
      siteId: next.siteId || previous.siteId,
      label: next.label ?? previous.label,
      source: next.source ?? previous.source,
      parentEffectId: next.parentEffectId !== undefined ? next.parentEffectId : previous.parentEffectId,
      status: nextIsNewer ? next.status : previous.status,
      runCount: Math.max(previous.runCount, next.runCount),
      rerunCount: Math.max(previous.rerunCount, next.rerunCount),
      capturedRunCount: Math.max(previous.capturedRunCount, next.capturedRunCount),
      cleanupCount: Math.max(previous.cleanupCount, next.cleanupCount),
      errorCount: Math.max(previous.errorCount, next.errorCount),
      lastSyncDurationMs: nextIsNewer ? next.lastSyncDurationMs : previous.lastSyncDurationMs,
      maxSyncDurationMs: Math.max(previous.maxSyncDurationMs ?? 0, next.maxSyncDurationMs ?? 0) || undefined,
      totalSyncDurationMs: next.totalSyncDurationMs ?? previous.totalSyncDurationMs,
      averageSyncDurationMs: next.averageSyncDurationMs ?? previous.averageSyncDurationMs,
      triggers: nextIsNewer ? next.triggers : previous.triggers,
      dependencies: nextIsNewer ? next.dependencies : previous.dependencies,
      dependencyCount: nextIsNewer ? next.dependencyCount : previous.dependencyCount,
      directDependencyCount: nextIsNewer ? next.directDependencyCount : previous.directDependencyCount,
      dependencyTruncated: nextIsNewer ? next.dependencyTruncated : previous.dependencyTruncated,
      triggerDetailOmitted: nextIsNewer ? next.triggerDetailOmitted : previous.triggerDetailOmitted,
      addedDependencyIds: nextIsNewer ? next.addedDependencyIds : previous.addedDependencyIds,
      removedDependencyIds: nextIsNewer ? next.removedDependencyIds : previous.removedDependencyIds,
      phase: nextIsNewer ? next.phase : previous.phase,
      outcome: nextIsNewer ? next.outcome : previous.outcome,
      adapter: nextIsNewer ? next.adapter : previous.adapter,
      captureGap: nextIsNewer ? next.captureGap : previous.captureGap,
      cleanupRegistered: nextIsNewer ? next.cleanupRegistered : previous.cleanupRegistered,
      error: nextIsNewer ? next.error : previous.error,
      at: nextIsNewer ? next.at ?? previous.at : previous.at
    };
  }

  function mergeCleanupEffect(
    previous: EffectSummary | undefined,
    next: EffectSummary,
    originatingRun: number
  ): EffectSummary {
    const runCount = Math.max(previous?.runCount ?? 0, originatingRun);
    if (!previous) {
      return {
        ...next,
        runCount,
        rerunCount: Math.max(0, runCount - 1),
        capturedRunCount: 0,
        lastSyncDurationMs: undefined,
        maxSyncDurationMs: undefined,
        totalSyncDurationMs: undefined,
        averageSyncDurationMs: undefined,
        triggers: [],
        dependencies: [],
        dependencyCount: 0,
        directDependencyCount: 0,
        dependencyTruncated: false,
        triggerDetailOmitted: next.triggerDetailOmitted,
        addedDependencyIds: [],
        removedDependencyIds: [],
        phase: undefined,
        adapter: undefined,
        captureGap: undefined
      };
    }
    return {
      ...previous,
      siteId: next.siteId || previous.siteId,
      label: next.label ?? previous.label,
      source: next.source ?? previous.source,
      status: next.status === 'error' ? 'error' : previous.status,
      runCount,
      rerunCount: Math.max(previous.rerunCount, Math.max(0, runCount - 1)),
      cleanupCount: Math.max(previous.cleanupCount, next.cleanupCount),
      errorCount: Math.max(previous.errorCount, next.errorCount),
      error: next.error ?? previous.error,
      at: Math.max(previous.at ?? 0, next.at ?? 0) || undefined
    };
  }

  function collectEffects(
    values: SnapshotNode[],
    receipts: TraceRecord[],
    snapshotAuthoritative: boolean
  ): EffectSummary[] {
    const byId = new Map<string, EffectSummary>();
    for (const node of values) {
      const detail = asDetail(node.detail);
      for (const raw of asDetails(detail?.effects)) {
        const effect = parseEffect(raw, node.id);
        if (effect) byId.set(effect.id, mergeEffect(byId.get(effect.id), effect));
      }
    }
    for (const trace of receipts) {
      if (trace.kind !== 'effect-run' && trace.kind !== 'effect-cleanup') continue;
      const raw = asDetail(trace.detail);
      if (!raw) continue;
      const effect = parseEffect(raw, trace.componentId, trace.at);
      if (!effect) continue;
      byId.set(
        effect.id,
        trace.kind === 'effect-cleanup'
          ? mergeCleanupEffect(byId.get(effect.id), effect, countValue(raw.originatingRun))
          : mergeEffect(byId.get(effect.id), effect)
      );
    }
    const unmounted = new Set(
      receipts.flatMap((trace) => trace.kind === 'unmount' && trace.componentId ? [trace.componentId] : [])
    );
    const mounted = new Set(
      values.flatMap((node) => node.kind === 'component' ? [node.id] : [])
    );
    const completeSnapshot = snapshotAuthoritative &&
      !values.some((node) => node.id === 'svelte-lens:snapshot-truncated');
    for (const effect of byId.values()) {
      if (unmounted.has(effect.componentId) || (completeSnapshot && !mounted.has(effect.componentId))) {
        effect.status = 'disposed';
      }
    }
    const componentOrder = new Map(values.map((node, index) => [node.id, index]));
    return [...byId.values()].sort((left, right) => {
      const owner = (componentOrder.get(left.componentId) ?? Number.MAX_SAFE_INTEGER) -
        (componentOrder.get(right.componentId) ?? Number.MAX_SAFE_INTEGER);
      if (owner !== 0) return owner;
      const line = (left.source?.line ?? Number.MAX_SAFE_INTEGER) -
        (right.source?.line ?? Number.MAX_SAFE_INTEGER);
      return line !== 0 ? line : left.id.localeCompare(right.id);
    });
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

  function effectsForComponent(componentId: string) {
    return effectsByComponent.get(componentId) ?? [];
  }

  function effectCount(componentId: string) {
    return effectTotalsByComponent.get(componentId) ?? effectsForComponent(componentId).length;
  }

  function omittedEffectCount(componentId: string) {
    return Math.max(0, effectCount(componentId) - effectsForComponent(componentId).length);
  }

  function effectErrorCount(componentId: string) {
    let count = 0;
    for (const effect of effectsForComponent(componentId)) {
      if (effect.status === 'error') count++;
    }
    return count;
  }

  function effectKindLabel(effect: EffectSummary) {
    return effect.kind === 'pre' ? '$effect.pre' : '$effect';
  }

  function effectName(effect: EffectSummary) {
    if (effect.label) return effect.label;
    return `${effectKindLabel(effect)} @ ${shortFile(effect.source?.file)}${effect.source ? `:${effect.source.line}` : ''}`;
  }

  function parentEffectName(effect: EffectSummary) {
    if (!effect.parentEffectId) return null;
    const parent = effects.find((candidate) => candidate.id === effect.parentEffectId);
    return parent ? effectName(parent) : effect.parentEffectId;
  }

  function formatDuration(value: number | undefined) {
    if (value === undefined) return '—';
    if (value < 0.01) return '<0.01 ms';
    if (value < 10) return `${value.toFixed(2)} ms`;
    return `${value.toFixed(1)} ms`;
  }

  function dependencyId(value: Detail) {
    return typeof value.id === 'string' ? value.id : null;
  }

  function dependencyLabel(value: Detail) {
    if (typeof value.label === 'string') return value.label;
    if (typeof value.name === 'string') return value.name;
    return dependencyId(value) ?? 'unlabelled dependency';
  }

  function dependencyKind(value: Detail) {
    return typeof value.kind === 'string' ? value.kind : 'reactive';
  }

  function dependencyPreview(value: Detail, phase: 'before' | 'after' | 'current') {
    if (phase === 'before') return value.before ?? value.previous;
    if (phase === 'after') return value.after ?? value.current ?? value.value;
    return value.current ?? value.after ?? value.value;
  }

  function dependencyState(value: Detail) {
    if (value.previewChanged === true) return 'changed';
    if (value.invalidated === true || value.dirty === true) return 'invalidated';
    return 'tracked';
  }

  function adapterLabel(effect: EffectSummary) {
    if (effect.adapter === 'unavailable') return 'unavailable';
    if (effect.adapter === 'exact' || effect.adapter === 'svelte-5-dev-internals') return 'exact Svelte 5';
    return 'unreported';
  }

  function effectCaptureLabel() {
    if (!recording) return 'Detailed capture paused';
    if (effects.length === 0 || effects.every((effect) => effect.adapter === 'unavailable')) {
      return 'Effect capture active';
    }
    if (effects.some((effect) => effect.adapter === 'unavailable')) return 'Dependency capture partial';
    return 'Dependency capture active';
  }

  function effectIdForTrace(trace: TraceRecord | null) {
    const detail = asDetail(trace?.detail);
    return typeof detail?.effectId === 'string' ? detail.effectId : null;
  }

  function selectedRunFor(effect: EffectSummary | null) {
    if (!effect || selectedTrace?.kind !== 'effect-run' || effectIdForTrace(selectedTrace) !== effect.id) {
      return null;
    }
    return selectedTraceDetail;
  }

  function selectedCleanupFor(effect: EffectSummary | null) {
    if (!effect || selectedTrace?.kind !== 'effect-cleanup' || effectIdForTrace(selectedTrace) !== effect.id) {
      return null;
    }
    return selectedTraceDetail;
  }

  function runTriggers(effect: EffectSummary, run: Detail | null) {
    return run ? asDetails(run.triggers) : effect.triggers;
  }

  function runDependencies(effect: EffectSummary, run: Detail | null) {
    return run ? asDetails(run.dependencies) : effect.dependencies;
  }

  function runDependencyCount(effect: EffectSummary, run: Detail | null) {
    return countValue(run?.dependencyCount, run ? asDetails(run.dependencies).length : effect.dependencyCount);
  }

  function runDirectDependencyCount(effect: EffectSummary, run: Detail | null) {
    return countValue(run?.directDependencyCount, effect.directDependencyCount);
  }

  function runDependencyTruncated(effect: EffectSummary, run: Detail | null) {
    return typeof run?.dependencyTruncated === 'boolean'
      ? run.dependencyTruncated
      : effect.dependencyTruncated;
  }

  function dependencyRoute(dependency: Detail, dependencies: Detail[]) {
    if (dependency.direct === true) return 'direct';
    if (typeof dependency.parentId !== 'string') return 'expanded';
    const parent = dependencies.find((candidate) => candidate.id === dependency.parentId);
    return `via ${parent ? dependencyLabel(parent) : dependency.parentId}`;
  }

  function runStrings(effect: EffectSummary, run: Detail | null, field: 'addedDependencyIds' | 'removedDependencyIds') {
    return run ? asStrings(run[field]) : effect[field];
  }

  function runPhase(effect: EffectSummary, run: Detail | null) {
    return typeof run?.phase === 'string' ? run.phase : effect.phase;
  }

  function runOutcome(effect: EffectSummary, run: Detail | null) {
    return typeof run?.outcome === 'string' ? run.outcome : effect.outcome ?? effect.status;
  }

  function runDuration(effect: EffectSummary, run: Detail | null) {
    return durationValue(run?.syncDurationMs) ?? effect.lastSyncDurationMs;
  }

  function runCleanupRegistered(effect: EffectSummary, run: Detail | null) {
    return typeof run?.cleanupRegistered === 'boolean'
      ? run.cleanupRegistered
      : effect.cleanupRegistered;
  }

  function runError(effect: EffectSummary, run: Detail | null) {
    if (run && run.outcome !== 'error') return undefined;
    const error = run?.error ?? effect.error;
    return error === null ? undefined : error;
  }

  function missingTriggerEvidence(effect: EffectSummary, run: Detail | null) {
    if (run?.triggerDetailOmitted === true || (!run && effect.triggerDetailOmitted)) {
      return 'Trigger details were omitted because this capture reached a bounded payload limit.';
    }
    if (run?.reason === 'capture-gap') {
      return 'This run crossed a capture gap, so its triggering dependency values are unavailable.';
    }
    if (run?.reason === 'runtime-unavailable') {
      return 'The effect reran, but this Svelte runtime did not expose exact dependency evidence.';
    }
    if (run?.reason === 'runtime-scheduled') {
      return 'Svelte scheduled this rerun, but no tracked dependency was reported as invalidated.';
    }
    return 'The effect reran, but dependency evidence was not captured. This can happen across a pause, reconnect, or unsupported runtime adapter.';
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
    if (trace.kind === 'component-error') return 'component initialization threw an error';
    if (trace.kind === 'effect-capacity') {
      return 'effect capture reached a bounded capacity limit';
    }
    if (trace.kind === 'effect-cleanup') {
      return detail?.outcome === 'error' ? 'effect cleanup threw an error' : 'effect cleanup completed';
    }
    if (trace.kind === 'effect-run') {
      if (detail?.outcome === 'error') return 'effect threw an error';
      if (detail?.phase === 'initial') return 'initial effect run';
      const triggers = asDetails(detail?.triggers);
      if (triggers.length > 0) {
        return `${triggers.length} tracked dependenc${triggers.length === 1 ? 'y' : 'ies'} invalidated`;
      }
      return 'effect reran; dependency evidence unavailable';
    }
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
              {#if effectCount(row.id) > 0}
                <span
                  class:error={effectErrorCount(row.id) > 0}
                  class="effect-count"
                  title={`${effectCount(row.id)} instrumented effect${effectCount(row.id) === 1 ? '' : 's'}${effectErrorCount(row.id) ? ` · ${effectErrorCount(row.id)} errored` : ''}`}
                >fx {effectCount(row.id)}</span>
              {/if}
              {#if typeof asDetail(row.detail)?.updateCount === 'number'}
                <span class="update-count">{asDetail(row.detail)?.updateCount}</span>
              {/if}
            </button>
          {/each}
        </div>
      </section>

      <section class="pane trace-pane">
        <div class="pane-header trace-header">
          <div class="center-tabs" role="tablist" aria-label="Svelte activity views">
            <button
              class:active={centerView === 'updates'}
              role="tab"
              aria-selected={centerView === 'updates'}
              onclick={() => (centerView = 'updates')}
            >Updates <span>{traces.length}</span></button>
            <button
              class:active={centerView === 'effects'}
              role="tab"
              aria-selected={centerView === 'effects'}
              onclick={() => (centerView = 'effects')}
            >Effects <span>{totalEffectCount}</span></button>
          </div>
          {#if centerView === 'updates'}
            <div class="trace-legend">
              <span><i class="effect"></i>effect</span>
              <span><i class="rune"></i>rune</span>
              <span><i class="dom"></i>DOM</span>
            </div>
          {:else}
            <button
              class:active={showAllEffects}
              class="scope-toggle"
              disabled={!selectedId}
              onclick={() => (showAllEffects = !showAllEffects)}
              title={selectedId ? 'Toggle between the selected component and the whole page' : 'All page effects are shown'}
            >{showAllEffects || !selectedId ? 'All components' : 'Selected component'}</button>
          {/if}
        </div>

        {#if centerView === 'updates'}
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
                <i
                  class:effect={trace.kind === 'effect-run' || trace.kind === 'effect-cleanup'}
                  class:rune={isRuneTrace(trace) && trace.kind !== 'effect-run' && trace.kind !== 'effect-cleanup'}
                  class:dom={!isRuneTrace(trace)}
                ></i>
                {#if index < traces.length - 1}<b></b>{/if}
              </span>
              <span class="trace-copy">
                <span class="trace-primary">
                  <strong>{componentName(trace.componentId)}</strong>
                  <span class="trace-kind">{typeof detail?.phase === 'string' ? detail.phase : trace.kind}</span>
                  <time>+{Math.max(0, trace.at - (traces[0]?.at ?? trace.at)).toFixed(1)}ms</time>
                </span>
                <span class="trace-secondary">
                  {#if interaction}<em title="Nearby interaction; temporal correlation, not proven causation">near {interaction}</em>{/if}
                  <span>{traceSummary(trace, detail)}</span>
                  {#if (trace.kind === 'effect-run' || trace.kind === 'effect-cleanup') && typeof detail?.syncDurationMs === 'number'}
                    <span class="trace-duration">{formatDuration(detail.syncDurationMs)}</span>
                  {/if}
                </span>
              </span>
              {#if canRewind(trace)}<span class="rewind-glyph" title="Restorable checkpoint">↶</span>{/if}
            </button>
          {/each}
          </div>
        {:else}
          <div class="effect-list" aria-label="Instrumented Svelte effects">
            {#if visibleEffects.length === 0}
              <div class="empty">
                <span class="empty-effect">ƒx</span>
                <strong>{effects.length === 0 ? 'No effects captured yet' : 'No effects in this component'}</strong>
                <p>{effects.length === 0 ? 'Use svelte-lens-vite in development to capture user-authored $effect runs and, when available, exact dependency evidence.' : 'Choose All components to inspect effects elsewhere on the page.'}</p>
              </div>
            {/if}
            {#if visibleOmittedEffectCount > 0}
              <div class="capture-gap">{visibleOmittedEffectCount} additional effect{visibleOmittedEffectCount === 1 ? '' : 's'} omitted by bounded capture or payload limits.</div>
            {/if}
            {#each visibleEffects as effect (effect.id)}
              <button
                class:selected={selectedEffectId === effect.id}
                class:error={effect.status === 'error'}
                class:disposed={effect.status === 'disposed'}
                class="effect-row"
                onclick={() => selectEffect(effect)}
              >
                <span class="effect-status" title={effect.status}></span>
                <span class="effect-copy">
                  <span class="effect-primary">
                    <strong>{effectName(effect)}</strong>
                    <span class="effect-kind">{effectKindLabel(effect)}</span>
                    <time>{formatDuration(effect.lastSyncDurationMs)}</time>
                  </span>
                  <span class="effect-secondary">
                    <span>{componentName(effect.componentId)}</span>
                    <span>{effect.rerunCount} rerun{effect.rerunCount === 1 ? '' : 's'}</span>
                    <span>{effect.dependencyCount} dep{effect.dependencyCount === 1 ? '' : 's'}{effect.dependencyCount > effect.dependencies.length ? ' · details omitted' : ''}</span>
                    {#if effect.triggers[0]}<code>{dependencyLabel(effect.triggers[0])}</code>{/if}
                  </span>
                </span>
                <span class="effect-runs"><strong>{effect.runCount}</strong><small>runs</small></span>
              </button>
            {/each}
          </div>
        {/if}

        {#if centerView === 'updates'}
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
        {:else}
          <div class="effect-footer">
            <span class:paused={!recording}></span>
            <div>
              <strong>{effectCaptureLabel()}</strong>
              <small>{effects.reduce((total, effect) => total + effect.rerunCount, 0)} observed reruns · {effectRunTraces.length} retained run receipts</small>
            </div>
          </div>
        {/if}
      </section>

      <aside class="pane inspector-pane">
        <div class="inspector-top">
          <span class="pane-title">Inspector</span>
          {#if selectedEffect}
            <span class:error={selectedEffect.status === 'error'} class="selected-kind">{effectKindLabel(selectedEffect)}</span>
          {:else if selected}
            <span class="selected-kind">{selected.kind}</span>
          {/if}
        </div>

        {#if selectedEffect}
          {@const selectedRun = selectedRunFor(selectedEffect)}
          {@const selectedCleanup = selectedCleanupFor(selectedEffect)}
          {@const selectedReceipt = selectedCleanup ?? selectedRun}
          {@const triggers = runTriggers(selectedEffect, selectedRun)}
          {@const dependencies = runDependencies(selectedEffect, selectedRun)}
          {@const dependencyCount = runDependencyCount(selectedEffect, selectedRun)}
          {@const directDependencyCount = runDirectDependencyCount(selectedEffect, selectedRun)}
          {@const dependencyTruncated = runDependencyTruncated(selectedEffect, selectedRun)}
          {@const addedIds = runStrings(selectedEffect, selectedRun, 'addedDependencyIds')}
          {@const removedIds = runStrings(selectedEffect, selectedRun, 'removedDependencyIds')}
          {@const phase = runPhase(selectedEffect, selectedRun)}
          {@const outcome = runOutcome(selectedEffect, selectedRun)}
          {@const receiptOutcome = runOutcome(selectedEffect, selectedReceipt)}
          {@const effectError = runError(selectedEffect, selectedReceipt)}
          {@const cleanupRegistered = runCleanupRegistered(selectedEffect, selectedRun)}

          <div class="identity effect-identity">
            <div class:error={selectedEffect.status === 'error'} class="identity-icon">ƒx</div>
            <div>
              <h2>{effectName(selectedEffect)}</h2>
              <button title={selectedEffect.source?.file} onclick={openEffectSource}>{shortFile(selectedEffect.source?.file)}{selectedEffect.source ? `:${selectedEffect.source.line}` : ''}</button>
              {#if parentEffectName(selectedEffect)}
                <small class="effect-parent">Nested under {parentEffectName(selectedEffect)}</small>
              {/if}
            </div>
          </div>

          <div class="metrics effect-metrics">
            <div><strong>{selectedEffect.runCount}</strong><span>runs</span></div>
            <div><strong>{selectedEffect.rerunCount}</strong><span>reruns</span></div>
            <div><strong>{formatDuration(runDuration(selectedEffect, selectedReceipt))}</strong><span>sync time</span></div>
          </div>

          {#if selectedEffect.captureGap === true || selectedEffect.capturedRunCount < selectedEffect.runCount}
            <div class="capture-gap">Detailed evidence exists for {selectedEffect.capturedRunCount} of {selectedEffect.runCount} runs. Missing detail can come from paused capture or overlapping synchronous flushes.</div>
          {/if}

          <section class:error={receiptOutcome === 'error'} class="inspector-section receipt effect-receipt">
            <div class="section-title">
              <span>{selectedCleanup ? 'Selected cleanup' : selectedRun ? 'Selected run' : 'Latest run'}</span>
              {#if selectedTrace && selectedReceipt}<time>{new Date(selectedTrace.at).toLocaleTimeString()}</time>{/if}
            </div>
            <div class="run-summary">
              {#if selectedCleanup}
                <span class="run-phase">cleanup #{countValue(selectedCleanup.cleanupCount)}</span>
                <strong>{receiptOutcome ?? 'ok'}</strong>
                <span>after run {countValue(selectedCleanup.originatingRun)} · {formatDuration(runDuration(selectedEffect, selectedCleanup))}</span>
              {:else}
                <span class="run-phase">{phase === 'initial' ? 'initial' : 'rerun'}</span>
                <strong>{outcome ?? selectedEffect.status}</strong>
                <span>{formatDuration(runDuration(selectedEffect, selectedRun))} synchronous · {cleanupRegistered === true ? 'cleanup registered' : cleanupRegistered === false ? 'no cleanup' : 'cleanup unknown'}</span>
              {/if}
            </div>
            {#if selectedTrace && selectedReceipt && interactionLabel(selectedTrace)}
              <div class="correlation-line"><i></i><span>Nearby interaction: {interactionLabel(selectedTrace)}</span><small>time correlation only</small></div>
            {/if}
          </section>

          {#if !selectedCleanup}
          <section class="inspector-section why-section">
            <div class="section-title">
              <span>Why this run?</span>
              <span class="section-count">{triggers.length}</span>
            </div>
            {#if phase === 'initial'}
              <div class="section-empty reason-empty">Initial execution — no dependency triggered it.</div>
            {:else if triggers.length === 0}
              <div class="section-empty reason-empty">{missingTriggerEvidence(selectedEffect, selectedRun)}</div>
            {:else}
              <div class="dependency-table changes-table">
                {#each triggers as trigger}
                  <div class="dependency-row changed">
                    <div class="dependency-heading">
                      <code>{dependencyLabel(trigger)}</code>
                      <span>{dependencyKind(trigger)}</span>
                      <em>{dependencyState(trigger)}</em>
                    </div>
                    <div class="dependency-diff">
                      <pre>{detailText(dependencyPreview(trigger, 'before'))}</pre>
                      <b>→</b>
                      <pre>{detailText(dependencyPreview(trigger, 'after'))}</pre>
                    </div>
                    {#if trigger.afterCallback !== undefined}
                      <div class="after-callback">
                        <span>After callback</span>
                        <pre>{detailText(trigger.afterCallback)}</pre>
                      </div>
                    {/if}
                    {#if asStrings(trigger.updatedAt).length > 0}
                      <details class="stack-details">
                        <summary>Update stack{asStrings(trigger.updatedAt).length === 1 ? '' : 's'}</summary>
                        {#each asStrings(trigger.updatedAt) as stack}<pre>{stack}</pre>{/each}
                      </details>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </section>

          <section class="inspector-section dependencies-section">
            <div class="section-title">
              <span>Reactive graph this run</span>
              <span class="section-count">{directDependencyCount} direct · {dependencyCount} nodes</span>
            </div>
            {#if dependencyTruncated}
              <div class="capture-gap">Dependency graph reached the bounded capture limit; later nodes are omitted.</div>
            {/if}
            {#if dependencies.length > 0}
              <div class="dependency-table">
                {#each dependencies as dependency}
                  {@const id = dependencyId(dependency)}
                  <div class:added={id !== null && addedIds.includes(id)} class="dependency-row">
                    <div class="dependency-heading">
                      <code>{dependencyLabel(dependency)}</code>
                      <span>{dependencyKind(dependency)}</span>
                      <em>{dependencyRoute(dependency, dependencies)}</em>
                      {#if id !== null && addedIds.includes(id)}<em>new</em>{/if}
                    </div>
                    <pre>{detailText(dependencyPreview(dependency, 'current'))}</pre>
                    {#if typeof dependency.createdAt === 'string' || asStrings(dependency.updatedAt).length > 0}
                      <details class="stack-details">
                        <summary>Source stack{asStrings(dependency.updatedAt).length === 1 ? '' : 's'}</summary>
                        {#if typeof dependency.createdAt === 'string'}<pre>{dependency.createdAt}</pre>{/if}
                        {#each asStrings(dependency.updatedAt) as stack}<pre>{stack}</pre>{/each}
                      </details>
                    {/if}
                  </div>
                {/each}
              </div>
            {:else}
              <div class="section-empty">No synchronous reactive reads were reported for this run.</div>
            {/if}
            {#if removedIds.length > 0}
              <div class="dependency-delta"><span>Stopped tracking</span>{#each removedIds as id}<code>{id}</code>{/each}</div>
            {/if}
          </section>
          {/if}

          <section class="inspector-section lifecycle-section">
            <div class="section-title"><span>Lifecycle</span></div>
            <dl>
              <div><dt>status</dt><dd>{selectedEffect.status}</dd></div>
              <div><dt>captured</dt><dd>{selectedEffect.capturedRunCount} / {selectedEffect.runCount} runs</dd></div>
              <div><dt>cleanups</dt><dd>{selectedEffect.cleanupCount}</dd></div>
              <div><dt>errors</dt><dd>{selectedEffect.errorCount}</dd></div>
              <div><dt>max sync</dt><dd>{formatDuration(selectedEffect.maxSyncDurationMs)}</dd></div>
              <div><dt>total sync</dt><dd>{formatDuration(selectedEffect.totalSyncDurationMs)}</dd></div>
              <div><dt>average sync</dt><dd>{formatDuration(selectedEffect.averageSyncDurationMs)}</dd></div>
              <div><dt>dependency adapter</dt><dd>{adapterLabel(selectedEffect)}</dd></div>
            </dl>
            {#if effectError !== undefined}
              <pre class="effect-error">{detailText(effectError)}</pre>
            {/if}
          </section>

          <section class="inspector-section source-section">
            <div class="section-title"><span>Effect source</span></div>
            <dl>
              <div><dt>file</dt><dd>{selectedEffect.source?.file ?? 'unavailable'}</dd></div>
              <div><dt>location</dt><dd>{selectedEffect.source ? `${selectedEffect.source.line}:${selectedEffect.source.column}` : '—'}</dd></div>
              <div><dt>site</dt><dd>{selectedEffect.siteId}</dd></div>
            </dl>
          </section>
        {:else if selected}
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
              <div class="cause-line">
                <i></i>
                <span>{interactionLabel(selectedTrace) ? `Nearby interaction: ${interactionLabel(selectedTrace)}` : selectedTrace.kind}</span>
                {#if interactionLabel(selectedTrace)}<small>time correlation only</small>{/if}
                <button onclick={() => openTraceSource(selectedTrace)}>Open source</button>
              </div>
              {#if Array.isArray(selectedTraceDetail?.changes)}
                <pre>{detailText(selectedTraceDetail.changes)}</pre>
              {/if}
            </section>
          {/if}

          <section class="inspector-section component-effects">
            <div class="section-title">
              <span>Effects</span>
              <span class="section-count">{effectCount(selected.id)}</span>
            </div>
            {#if omittedEffectCount(selected.id) > 0}
              <div class="capture-gap">{omittedEffectCount(selected.id)} additional effect{omittedEffectCount(selected.id) === 1 ? '' : 's'} omitted by bounded capture or payload limits.</div>
            {/if}
            {#if effectsForComponent(selected.id).length > 0}
              <div class="component-effect-list">
                {#each effectsForComponent(selected.id) as effect (effect.id)}
                  <button class:error={effect.status === 'error'} onclick={() => { centerView = 'effects'; selectEffect(effect); }}>
                    <span class="effect-status"></span>
                    <span><strong>{effectName(effect)}</strong><small>{effect.rerunCount} reruns · {formatDuration(effect.lastSyncDurationMs)}</small></span>
                    <b>{effect.dependencyCount}</b>
                  </button>
                {/each}
              </div>
            {:else}
              <div class="section-empty">{selectedDetail?.enhanced === true ? 'No user effects captured in this component' : 'Add svelte-lens-vite for effect instrumentation'}</div>
            {/if}
          </section>

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
        {:else if selectedTrace}
          <div class="identity">
            <div class="identity-icon">!</div>
            <div>
              <h2>{traceSummary(selectedTrace, selectedTraceDetail)}</h2>
              <span>{selectedTrace.kind}</span>
            </div>
          </div>
          <section class="inspector-section receipt">
            <div class="section-title"><span>Selected receipt</span><time>{new Date(selectedTrace.at).toLocaleTimeString()}</time></div>
            {#if selectedTraceDetail?.error !== undefined}
              <pre class="effect-error">{detailText(selectedTraceDetail.error)}</pre>
            {:else}
              <pre>{detailText(selectedTrace.detail)}</pre>
            {/if}
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
    <span class:available={hello?.capabilities.effects}>{hello?.capabilities.effects ? 'effect instrumentation' : 'effects unavailable'}</span>
    <span class:available={hello?.capabilities.state}>{hello?.capabilities.state ? 'enhanced state capture' : 'metadata capture'}</span>
  </footer>
</div>
