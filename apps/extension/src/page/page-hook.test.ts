// @vitest-environment jsdom

import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  contentMessage,
  isPageToContentMessage,
  pageMessage,
  type PageEvent
} from '../shared/protocol';

const received: PageEvent[] = [];
const receive = (event: MessageEvent<unknown>): void => {
  if (isPageToContentMessage(event.data)) received.push(event.data.event);
};

window.addEventListener('message', receive);

afterAll(() => {
  window.removeEventListener('message', receive);
  const sentinel = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for('svelte-lens.page-hook.v1')
  ] as { destroy?: () => void } | undefined;
  sentinel?.destroy?.();
});

describe('MAIN-world page hook', () => {
  it('handshakes, exposes enhanced state, applies a checkpoint, and returns live', async () => {
    await import('./page-hook');
    dispatch(contentMessage(null, { kind: 'connect' }));
    await settle();
    expect(received.some((event) => event.type === 'snapshot')).toBe(false);
    const hook = globalThis.__SVELTE_LENS__;
    expect(hook).toBeDefined();

    const proxyWrites: string[] = [];
    const proxyDeletes: string[] = [];
    const proxyTarget = new Proxy({ keep: 1, remove: 2 } as Record<string, number>, {
      set(target, key, value) {
        proxyWrites.push(String(key));
        return Reflect.set(target, key, value);
      },
      deleteProperty(target, key) {
        proxyDeletes.push(String(key));
        return Reflect.deleteProperty(target, key);
      }
    });
    hook?.replaceStateInPlace(proxyTarget, { keep: 3, added: 4 });
    expect(proxyTarget).toEqual({ keep: 3, added: 4 });
    expect(proxyWrites).toEqual(['keep', 'added']);
    expect(proxyDeletes).toEqual(['remove']);
    const proxyArray = new Proxy([1, 2, 3], {});
    hook?.replaceStateInPlace(proxyArray, [4]);
    expect(proxyArray).toEqual([4]);
    expect(hook?.canReplaceStateInPlace(proxyTarget)).toBe(true);
    expect(hook?.canReplaceStateInPlace(proxyArray)).toBe(true);
    expect(hook?.canReplaceStateInPlace(new Date())).toBe(false);
    expect(hook?.canReplaceStateInPlace(new Map())).toBe(false);
    expect(hook?.canReplaceStateInPlace(Object.create(null))).toBe(false);
    expect(() => hook?.replaceStateInPlace(new Date(), new Date())).toThrow('plain objects or arrays');
    const unsafeReplacement = JSON.parse('{"__proto__":{"polluted":true}}') as object;
    expect(() => hook?.replaceStateInPlace(proxyTarget, unsafeReplacement)).toThrow('not safe');
    expect(proxyTarget).toEqual({ keep: 3, added: 4 });

    const idleId = hook?.beginComponent({
      name: 'IdleUnmount',
      file: 'src/IdleUnmount.svelte',
      props: () => ({}),
      state: {},
      derived: {}
    });
    hook?.endComponent(idleId ?? null);
    const queryAll = vi.spyOn(document, 'querySelectorAll');
    hook?.unregisterComponent(idleId ?? null);
    await Promise.resolve();
    expect(queryAll).not.toHaveBeenCalled();
    queryAll.mockRestore();

    dispatch(contentMessage(null, { kind: 'record', enabled: true }));

    const failedInitId = hook?.beginComponent({
      name: 'FailedInit',
      file: 'src/FailedInit.svelte',
      props: () => ({}),
      state: {},
      derived: {}
    });
    hook?.abortComponent(failedInitId ?? null, new Error('init failed'));
    const recoveredInitId = hook?.beginComponent({
      name: 'RecoveredInit',
      file: 'src/RecoveredInit.svelte',
      props: () => ({}),
      state: {},
      derived: {}
    });
    hook?.endComponent(recoveredInitId ?? null);
    dispatch(contentMessage(null, { kind: 'snapshot', requestId: 'init-abort' }));
    await settle();
    const initAbortSnapshot = received.findLast(
      (event): event is Extract<PageEvent, { type: 'snapshot' }> =>
        event.type === 'snapshot' && event.payload.requestId === 'init-abort'
    );
    expect(initAbortSnapshot?.payload.nodes.some((node) => node.id === failedInitId)).toBe(false);
    expect(initAbortSnapshot?.payload.nodes.find((node) => node.id === recoveredInitId)?.parentId).toBeNull();
    expect(received
      .filter((event): event is Extract<PageEvent, { type: 'trace' }> => event.type === 'trace')
      .flatMap((event) => event.payload.events)
      .find((event) => event.kind === 'component-error' && event.componentId === failedInitId)?.detail)
      .toMatchObject({ phase: 'initialization', error: { message: 'init failed' } });
    hook?.unregisterComponent(recoveredInitId ?? null);

    let count = 1;
    let accessorReads = 0;
    const accessorState = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => {
        accessorReads++;
        return 'should not run';
      }
    });
    const id = hook?.beginComponent({
      name: 'Counter',
      file: 'src/Counter.svelte',
      props: () => ({ label: 'Clicks' }),
      state: {
        count: {
          get: () => count,
          set: (value) => {
            count = Number(value);
          }
        }
      },
      derived: {
        doubled: { get: () => count * 2 },
        accessorState: { get: () => accessorState }
      }
    });
    expect(id).toMatch(/^cmp:/);

    const button = document.createElement('button');
    button.textContent = 'increment';
    button.__svelte_meta = {
      parent: null,
      loc: { file: 'src/Counter.svelte', line: 4, column: 1 }
    };
    document.body.append(button);
    hook?.updateComponent(id ?? null, 'init');
    hook?.endComponent(id ?? null);

    const statelessId = hook?.beginComponent({
      name: 'StaticLabel',
      file: 'src/StaticLabel.svelte',
      props: () => ({}),
      state: {},
      derived: {}
    });
    hook?.updateComponent(statelessId ?? null, 'init');
    hook?.endComponent(statelessId ?? null);
    await settle();

    const mount = received
      .filter((event): event is Extract<PageEvent, { type: 'trace' }> => event.type === 'trace')
      .flatMap((event) => event.payload.events)
      .find((event) => event.kind === 'mount' && event.componentId === id);
    const checkpointId = isRecord(mount?.detail) && typeof mount.detail.checkpointId === 'string'
      ? mount.detail.checkpointId
      : null;
    expect(checkpointId).toMatch(/^cp:/);

    dispatch(contentMessage(null, {
      kind: 'set-value',
      requestId: 'set-1',
      componentId: id ?? '',
      path: ['state', 'count'],
      value: 5
    }));
    expect(count).toBe(5);

    dispatch(contentMessage(null, {
      kind: 'time-travel',
      requestId: 'travel-1',
      action: 'apply',
      targets: [{ componentId: id ?? '', checkpointId: checkpointId ?? '' }]
    }));
    expect(count).toBe(1);

    dispatch(contentMessage(null, {
      kind: 'time-travel',
      requestId: 'live-1',
      action: 'live'
    }));
    expect(count).toBe(5);

    dispatch(contentMessage(null, { kind: 'snapshot', requestId: 'snapshot-1' }));
    await settle();
    const snapshot = received.findLast(
      (event): event is Extract<PageEvent, { type: 'snapshot' }> =>
        event.type === 'snapshot' && event.payload.requestId === 'snapshot-1'
    );
    expect(snapshot).toBeDefined();
    const component = snapshot?.payload.nodes.find((node) => node.id === id);
    expect(component?.source).toEqual({ file: 'src/Counter.svelte', line: 4, column: 1 });
    expect(component?.detail).toMatchObject({
      enhanced: true,
      domCount: 1,
      props: { label: 'Clicks' },
      state: { count: 5 },
      writableState: { count: true },
      derived: {
        doubled: 10,
        accessorState: { secret: { $type: 'accessor', get: true, set: false } }
      }
    });
    expect(accessorReads).toBe(0);
    expect(mount?.at).toBeGreaterThan(1_000_000_000_000);
    const stateless = snapshot?.payload.nodes.find((node) => node.id === statelessId);
    expect(stateless?.detail).toMatchObject({ checkpoints: [], writableState: {} });

    const effectId = hook?.beginComponent({
      name: 'EffectProbe',
      file: 'src/EffectProbe.svelte',
      props: () => ({}),
      state: {},
      derived: {}
    });
    hook?.endComponent(effectId ?? null);
    window.__svelte = { v: new Set(['5']) };
    let activeEffect: Record<string, unknown> | null = null;
    const untrackCall = vi.fn();
    const untrack = <Value>(read: () => Value): Value => {
      untrackCall();
      return read();
    };
    const enableTracing = vi.fn();
    hook?.installRuntime(() => ({ activeEffect, untrack, enableTracing }));
    expect(enableTracing).toHaveBeenCalledTimes(1);
    const countSignal = {
      f: 0,
      v: 1,
      wv: 1,
      label: 'count',
      deps: null,
      created: new Error('created at')
    };
    const conditionalSignal = { f: 0, v: 'left', wv: 1, label: 'branch.left', deps: null };
    const replacementSignal = { f: 0, v: 'right', wv: 2, label: 'branch.right', deps: null };
    const reaction = {
      f: 1 << 20,
      fn: () => undefined,
      deps: null as Array<Record<string, unknown>> | null,
      parent: null,
      wv: 0
    };
    const cleanup = vi.fn();
    const wrapped = hook?.registerEffect({
      siteId: 'site:effect-probe',
      componentId: effectId ?? null,
      kind: 'effect',
      source: { file: 'src/EffectProbe.svelte', line: 8, column: 2 }
    }, () => cleanup) as (() => (() => void)) | undefined;
    expect(wrapped).toBeTypeOf('function');

    activeEffect = reaction;
    const wrappedCleanup = wrapped?.();
    activeEffect = null;
    reaction.deps = [countSignal, conditionalSignal];
    reaction.wv = 1;
    await settle();

    countSignal.v = 2;
    countSignal.wv = 2;
    activeEffect = reaction;
    wrappedCleanup?.();
    const secondCleanup = wrapped?.();
    activeEffect = null;
    reaction.deps = [countSignal, replacementSignal];
    reaction.wv = 2;
    await settle();

    const effectRuns = received
      .filter((event): event is Extract<PageEvent, { type: 'trace' }> => event.type === 'trace')
      .flatMap((event) => event.payload.events)
      .filter((event) => event.kind === 'effect-run' && event.componentId === effectId);
    expect(effectRuns).toHaveLength(2);
    expect(effectRuns[0]?.detail).toMatchObject({
      phase: 'initial',
      runCount: 1,
      rerunCount: 0,
      reason: 'initial',
      dependencies: [
        { label: 'count', value: 1 },
        { label: 'branch.left', value: 'left' }
      ]
    });
    expect(effectRuns[1]?.detail).toMatchObject({
      phase: 'rerun',
      runCount: 2,
      rerunCount: 1,
      reason: 'dependencies',
      cleanupCount: 1,
      triggers: [{ label: 'count', before: 1, current: 2, invalidated: true }]
    });
    const secondDetail = isRecord(effectRuns[1]?.detail) ? effectRuns[1].detail : {};
    expect(secondDetail.addedDependencyIds).toEqual(expect.any(Array));
    expect(secondDetail.removedDependencyIds).toEqual(expect.any(Array));
    expect((secondDetail.addedDependencyIds as unknown[]).length).toBe(1);
    expect((secondDetail.removedDependencyIds as unknown[]).length).toBe(1);
    expect(untrackCall).toHaveBeenCalled();

    dispatch(contentMessage(null, { kind: 'snapshot', requestId: 'effects-snapshot' }));
    await settle();
    const effectSnapshot = received.findLast(
      (event): event is Extract<PageEvent, { type: 'snapshot' }> =>
        event.type === 'snapshot' && event.payload.requestId === 'effects-snapshot'
    );
    expect(effectSnapshot?.payload.nodes.find((node) => node.id === effectId)?.detail).toMatchObject({
      effects: [{
        siteId: 'site:effect-probe',
        runCount: 2,
        rerunCount: 1,
        capturedRunCount: 2,
        cleanupCount: 1,
        dependencyCount: 2,
        adapter: 'exact'
      }]
    });
    secondCleanup?.();

    dispatch(contentMessage(null, { kind: 'record', enabled: false }));
    countSignal.v = 3;
    countSignal.wv = 3;
    activeEffect = reaction;
    wrapped?.();
    activeEffect = null;
    reaction.wv = 3;
    await settle();
    dispatch(contentMessage(null, { kind: 'record', enabled: true }));
    dispatch(contentMessage(null, { kind: 'snapshot', requestId: 'effect-pause-gap' }));
    await settle();
    const gapSnapshot = received.findLast(
      (event): event is Extract<PageEvent, { type: 'snapshot' }> =>
        event.type === 'snapshot' && event.payload.requestId === 'effect-pause-gap'
    );
    expect(gapSnapshot?.payload.nodes.find((node) => node.id === effectId)?.detail).toMatchObject({
      effects: [{
        runCount: 3,
        rerunCount: 2,
        capturedRunCount: 2,
        captureGap: false,
        outcome: 'ok',
        triggers: [],
        addedDependencyIds: [],
        removedDependencyIds: [],
        lastSyncDurationMs: null,
        lastRunId: null
      }]
    });

    countSignal.v = 4;
    countSignal.wv = 4;
    activeEffect = reaction;
    wrapped?.();
    activeEffect = null;
    reaction.wv = 4;
    await settle();
    const gapRun = received
      .filter((event): event is Extract<PageEvent, { type: 'trace' }> => event.type === 'trace')
      .flatMap((event) => event.payload.events)
      .findLast((event) => event.kind === 'effect-run' && event.componentId === effectId);
    expect(gapRun?.detail).toMatchObject({
      runCount: 4,
      rerunCount: 3,
      capturedRunCount: 3,
      reason: 'dependencies',
      triggers: [{ label: 'count', before: 3, current: 4, previewChanged: true }]
    });

    const terminalErrorId = hook?.beginComponent({
      name: 'TerminalErrorProbe',
      file: 'src/TerminalErrorProbe.svelte',
      props: () => ({}),
      state: {},
      derived: {}
    });
    hook?.endComponent(terminalErrorId ?? null);
    const terminalReaction = {
      f: 1 << 20,
      fn: () => undefined,
      deps: [] as Array<Record<string, unknown>>,
      parent: null,
      wv: 1
    };
    const terminalWrapped = hook?.registerEffect({
      siteId: 'site:terminal-error-probe',
      componentId: terminalErrorId ?? null,
      kind: 'effect',
      source: { file: 'src/TerminalErrorProbe.svelte', line: 4, column: 2 }
    }, () => {
      throw new Error('terminal effect failed');
    }) as (() => void) | undefined;
    activeEffect = terminalReaction;
    expect(() => terminalWrapped?.()).toThrow('terminal effect failed');
    activeEffect = null;
    terminalReaction.f |= 1 << 14;
    terminalReaction.fn = null as unknown as () => undefined;
    dispatch(contentMessage(null, { kind: 'snapshot', requestId: 'terminal-error-snapshot' }));
    // Simulate an error boundary synchronously unmounting the component before
    // the effect receipt's normal microtask gets a chance to run.
    hook?.unregisterComponent(terminalErrorId ?? null);
    await settle();
    const terminalSnapshot = received.findLast(
      (event): event is Extract<PageEvent, { type: 'snapshot' }> =>
        event.type === 'snapshot' && event.payload.requestId === 'terminal-error-snapshot'
    );
    expect(terminalSnapshot?.payload.nodes.find((node) => node.id === terminalErrorId)?.detail)
      .toMatchObject({
        effects: [{
          status: 'disposed',
          outcome: 'error',
          errorCount: 1,
          lastError: { message: 'terminal effect failed' }
        }]
      });
    expect(effectRunTracesFor(terminalErrorId ?? '').at(-1)?.detail).toMatchObject({
      outcome: 'error',
      error: { message: 'terminal effect failed' }
    });
    const terminalTimeline = received
      .filter((event): event is Extract<PageEvent, { type: 'trace' }> => event.type === 'trace')
      .flatMap((event) => event.payload.events)
      .filter((event) => event.componentId === terminalErrorId);
    expect(terminalTimeline.findIndex((event) => event.kind === 'effect-run'))
      .toBeLessThan(terminalTimeline.findIndex((event) => event.kind === 'unmount'));

    const directEffectId = hook?.beginComponent({
      name: 'DirectDependencyProbe',
      file: 'src/DirectDependencyProbe.svelte',
      props: () => ({}),
      state: {},
      derived: {}
    });
    hook?.endComponent(directEffectId ?? null);
    const directLeaf = { f: 0, v: 2, wv: 1, label: 'leaf', deps: null };
    const directDerived = { f: 2, v: 4, wv: 1, label: 'doubled', deps: [directLeaf] };
    const directReaction = {
      f: 1 << 20,
      fn: () => undefined,
      deps: [directDerived, directLeaf],
      parent: null,
      wv: 1
    };
    const directWrapped = hook?.registerEffect({
      siteId: 'site:direct-dependency-probe',
      componentId: directEffectId ?? null,
      kind: 'effect',
      source: { file: 'src/DirectDependencyProbe.svelte', line: 4, column: 2 }
    }, () => undefined) as (() => void) | undefined;
    activeEffect = directReaction;
    directWrapped?.();
    activeEffect = null;
    await settle();
    const directRun = effectRunTracesFor(directEffectId ?? '').at(-1);
    expect(directRun?.detail).toMatchObject({
      directDependencyCount: 2,
      dependencyTruncated: false,
      dependencies: [
        { label: 'doubled', direct: true, depth: 0, parentId: null },
        { label: 'leaf', direct: true, depth: 0, parentId: null }
      ]
    });
    const directDependencies = isRecord(directRun?.detail) && Array.isArray(directRun.detail.dependencies)
      ? directRun.detail.dependencies
      : [];
    expect(directDependencies.filter(
      (dependency) => isRecord(dependency) && dependency.label === 'leaf'
    )).toHaveLength(1);

    const boundedDepsId = hook?.beginComponent({
      name: 'BoundedDependenciesProbe',
      file: 'src/BoundedDependenciesProbe.svelte',
      props: () => ({}),
      state: {},
      derived: {}
    });
    hook?.endComponent(boundedDepsId ?? null);
    let dependencyIndexReads = 0;
    const manySignals = Array.from({ length: 5_000 }, (_, index) => ({
      f: 0,
      v: index,
      wv: 1,
      label: `bounded-${index}`,
      deps: null
    }));
    const boundedDeps = new Proxy(manySignals, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) dependencyIndexReads++;
        return Reflect.get(target, key, receiver);
      }
    });
    const boundedReaction = {
      f: 1 << 20,
      fn: () => undefined,
      deps: boundedDeps,
      parent: null,
      wv: 1
    };
    const boundedWrapped = hook?.registerEffect({
      siteId: 'site:bounded-dependencies-probe',
      componentId: boundedDepsId ?? null,
      kind: 'effect',
      source: { file: 'src/BoundedDependenciesProbe.svelte', line: 4, column: 2 }
    }, () => undefined) as (() => void) | undefined;
    activeEffect = boundedReaction;
    boundedWrapped?.();
    activeEffect = null;
    await settle();
    expect(dependencyIndexReads).toBeLessThanOrEqual(200);
    expect(effectRunTracesFor(boundedDepsId ?? '').at(-1)?.detail).toMatchObject({
      directDependencyCount: 5_000,
      dependencyTruncated: true,
      dependencies: expect.any(Array)
    });
    const boundedDetail = effectRunTracesFor(boundedDepsId ?? '').at(-1)?.detail;
    expect(isRecord(boundedDetail) && Array.isArray(boundedDetail.dependencies)
      ? boundedDetail.dependencies.length
      : -1).toBe(60);

    const overlapEffectId = hook?.beginComponent({
      name: 'OverlapProbe',
      file: 'src/OverlapProbe.svelte',
      props: () => ({}),
      state: {},
      derived: {}
    });
    hook?.endComponent(overlapEffectId ?? null);
    const overlapSignal = { f: 0, v: 1, wv: 1, label: 'overlap', deps: null };
    const overlapReaction = {
      f: 1 << 20,
      fn: () => undefined,
      deps: [overlapSignal],
      parent: null,
      wv: 1
    };
    const overlapWrapped = hook?.registerEffect({
      siteId: 'site:overlap-probe',
      componentId: overlapEffectId ?? null,
      kind: 'effect',
      source: { file: 'src/OverlapProbe.svelte', line: 4, column: 2 }
    }, () => undefined) as (() => void) | undefined;
    activeEffect = overlapReaction;
    overlapWrapped?.();
    activeEffect = null;
    await settle();

    overlapSignal.v = 2;
    overlapSignal.wv = 2;
    activeEffect = overlapReaction;
    overlapWrapped?.();
    activeEffect = null;
    overlapReaction.wv = 2;
    overlapSignal.v = 3;
    overlapSignal.wv = 3;
    activeEffect = overlapReaction;
    overlapWrapped?.();
    activeEffect = null;
    overlapReaction.wv = 3;
    await settle();
    const overlapGapRuns = effectRunTracesFor(overlapEffectId ?? '');
    expect(overlapGapRuns.map((trace) => isRecord(trace.detail) ? trace.detail.reason : null))
      .toEqual(['initial', 'capture-gap', 'capture-gap']);
    const overlappedTrigger = isRecord(overlapGapRuns[1]?.detail) &&
      Array.isArray(overlapGapRuns[1].detail.triggers)
      ? overlapGapRuns[1].detail.triggers[0]
      : null;
    expect(isRecord(overlappedTrigger) && 'before' in overlappedTrigger).toBe(false);

    overlapSignal.v = 4;
    overlapSignal.wv = 4;
    activeEffect = overlapReaction;
    overlapWrapped?.();
    activeEffect = null;
    overlapReaction.wv = 4;
    await settle();
    expect(effectRunTracesFor(overlapEffectId ?? '').at(-1)?.detail).toMatchObject({
      runCount: 4,
      reason: 'dependencies',
      captureGap: false,
      triggers: [{ label: 'overlap', before: 3, current: 4, previewChanged: true }]
    });

    const cleanupEffectId = hook?.beginComponent({
      name: 'CleanupTriggerProbe',
      file: 'src/CleanupTriggerProbe.svelte',
      props: () => ({}),
      state: {},
      derived: {}
    });
    hook?.endComponent(cleanupEffectId ?? null);
    const externalSignal = { f: 0, v: 0, wv: 1, label: 'external', deps: null };
    const cleanupSignal = { f: 0, v: 0, wv: 1, label: 'cleanup-write', deps: null };
    const cleanupReaction = {
      f: 1 << 20,
      fn: () => undefined,
      deps: [externalSignal, cleanupSignal],
      parent: null,
      wv: 1
    };
    const cleanupWrapped = hook?.registerEffect({
      siteId: 'site:cleanup-trigger-probe',
      componentId: cleanupEffectId ?? null,
      kind: 'effect',
      source: { file: 'src/CleanupTriggerProbe.svelte', line: 4, column: 2 }
    }, () => () => {
      cleanupSignal.v = 1;
      cleanupSignal.wv = 2;
    }) as (() => (() => void)) | undefined;
    activeEffect = cleanupReaction;
    const cleanupWriter = cleanupWrapped?.();
    activeEffect = null;
    await settle();
    externalSignal.v = 1;
    externalSignal.wv = 2;
    activeEffect = cleanupReaction;
    cleanupWriter?.();
    cleanupWrapped?.();
    activeEffect = null;
    cleanupReaction.wv = 2;
    await settle();
    expect(effectRunTracesFor(cleanupEffectId ?? '').at(-1)?.detail).toMatchObject({
      runCount: 2,
      reason: 'dependencies',
      triggers: [{ label: 'external', before: 0, current: 1 }]
    });

    const nestedCleanupId = hook?.beginComponent({
      name: 'NestedCleanupProbe',
      file: 'src/NestedCleanupProbe.svelte',
      props: () => ({}),
      state: {},
      derived: {}
    });
    hook?.endComponent(nestedCleanupId ?? null);
    const outerTrigger = { f: 0, v: 0, wv: 1, label: 'outer-trigger', deps: null };
    const nestedCleanupWrite = { f: 0, v: 0, wv: 1, label: 'nested-cleanup-write', deps: null };
    const outerReaction = {
      f: 1 << 20,
      fn: () => undefined,
      deps: [outerTrigger, nestedCleanupWrite],
      parent: null,
      wv: 1
    };
    const childReaction = {
      f: 1 << 20,
      fn: () => undefined,
      deps: [] as Array<Record<string, unknown>>,
      parent: outerReaction,
      wv: 1
    };
    const outerWrapped = hook?.registerEffect({
      siteId: 'site:nested-cleanup-outer',
      componentId: nestedCleanupId ?? null,
      kind: 'effect',
      source: { file: 'src/NestedCleanupProbe.svelte', line: 4, column: 2 }
    }, () => undefined) as (() => void) | undefined;
    const childWrapped = hook?.registerEffect({
      siteId: 'site:nested-cleanup-child',
      componentId: nestedCleanupId ?? null,
      kind: 'effect',
      source: { file: 'src/NestedCleanupProbe.svelte', line: 6, column: 4 }
    }, () => () => {
      nestedCleanupWrite.v = 1;
      nestedCleanupWrite.wv = 2;
    }) as (() => (() => void)) | undefined;
    activeEffect = outerReaction;
    outerWrapped?.();
    activeEffect = childReaction;
    const nestedWriter = childWrapped?.();
    activeEffect = null;
    await settle();
    outerTrigger.v = 1;
    outerTrigger.wv = 2;
    activeEffect = outerReaction;
    nestedWriter?.();
    outerWrapped?.();
    activeEffect = null;
    outerReaction.wv = 2;
    await settle();
    const nestedOuterRun = effectRunTracesFor(nestedCleanupId ?? '')
      .filter((trace) => isRecord(trace.detail) && trace.detail.siteId === 'site:nested-cleanup-outer')
      .at(-1);
    expect(nestedOuterRun?.detail).toMatchObject({
      runCount: 2,
      reason: 'dependencies',
      triggers: [{ label: 'outer-trigger', before: 0, current: 1 }]
    });
    const nestedOuterTriggers = isRecord(nestedOuterRun?.detail) && Array.isArray(nestedOuterRun.detail.triggers)
      ? nestedOuterRun.detail.triggers
      : [];
    expect(nestedOuterTriggers.some(
      (trigger) => isRecord(trigger) && trigger.label === 'nested-cleanup-write'
    )).toBe(false);

    const selfWriteEffectId = hook?.beginComponent({
      name: 'SelfWriteProbe',
      file: 'src/SelfWriteProbe.svelte',
      props: () => ({}),
      state: {},
      derived: {}
    });
    hook?.endComponent(selfWriteEffectId ?? null);
    const selfWriteSignal = { f: 0, v: 0, wv: 1, label: 'self-write', deps: null };
    const selfWriteReaction = {
      f: 1 << 20,
      fn: () => undefined,
      deps: [selfWriteSignal],
      parent: null,
      wv: 1
    };
    const selfWriteWrapped = hook?.registerEffect({
      siteId: 'site:self-write-probe',
      componentId: selfWriteEffectId ?? null,
      kind: 'effect',
      source: { file: 'src/SelfWriteProbe.svelte', line: 4, column: 2 }
    }, () => {
      if (selfWriteSignal.v === 1) {
        selfWriteSignal.v = 2;
        selfWriteSignal.wv = 3;
      }
    }) as (() => void) | undefined;
    activeEffect = selfWriteReaction;
    selfWriteWrapped?.();
    activeEffect = null;
    await settle();
    selfWriteSignal.v = 1;
    selfWriteSignal.wv = 2;
    activeEffect = selfWriteReaction;
    selfWriteWrapped?.();
    activeEffect = null;
    selfWriteReaction.wv = 3;
    await settle();
    expect(effectRunTracesFor(selfWriteEffectId ?? '').at(-1)?.detail).toMatchObject({
      runCount: 2,
      reason: 'dependencies',
      triggers: [{
        label: 'self-write',
        before: 0,
        current: 1,
        afterCallback: 2,
        previewChanged: true
      }]
    });

    const stackBudgetEffectId = hook?.beginComponent({
      name: 'StackBudgetProbe',
      file: 'src/StackBudgetProbe.svelte',
      props: () => ({}),
      state: {},
      derived: {}
    });
    hook?.endComponent(stackBudgetEffectId ?? null);
    const sharedPreview = { value: 'shared' };
    const stackSignals = Array.from({ length: 60 }, (_, index) => ({
      f: 0,
      v: index < 2 ? sharedPreview : index,
      wv: 1,
      label: `stack-${index}`,
      deps: null,
      created: new Error(`created-${index}-${'x'.repeat(3_000)}`)
    }));
    const stackBudgetReaction = {
      f: 1 << 20,
      fn: () => undefined,
      deps: stackSignals,
      parent: null,
      wv: 1
    };
    const stackBudgetWrapped = hook?.registerEffect({
      siteId: 'site:stack-budget-probe',
      componentId: stackBudgetEffectId ?? null,
      kind: 'effect',
      source: { file: 'src/StackBudgetProbe.svelte', line: 4, column: 2 }
    }, () => undefined) as (() => void) | undefined;
    activeEffect = stackBudgetReaction;
    stackBudgetWrapped?.();
    activeEffect = null;
    await settle();
    const stackBudgetRun = effectRunTracesFor(stackBudgetEffectId ?? '').at(-1);
    const stackDependencies = isRecord(stackBudgetRun?.detail) && Array.isArray(stackBudgetRun.detail.dependencies)
      ? stackBudgetRun.detail.dependencies
      : [];
    expect(stackDependencies).toHaveLength(60);
    expect(stackDependencies[0]).toMatchObject({ value: { value: 'shared' } });
    expect(stackDependencies[1]).toMatchObject({ value: { value: 'shared' } });
    expect(stackDependencies[59]).toMatchObject({ value: 59 });
    expect(stackDependencies.filter(
      (dependency) => isRecord(dependency) && typeof dependency.createdAt === 'string'
    ).length).toBeLessThanOrEqual(10);
    for (const [index, signal] of stackSignals.entries()) {
      signal.v = `${index}:${'changed'.repeat(800)}` as never;
      signal.wv = 2;
      Object.assign(signal, {
        updated: new Map(Array.from({ length: 3 }, (_, stackIndex) => [
          stackIndex,
          { error: new Error(`updated-${index}-${stackIndex}-${'y'.repeat(3_000)}`) }
        ]))
      });
    }
    activeEffect = stackBudgetReaction;
    stackBudgetWrapped?.();
    activeEffect = null;
    stackBudgetReaction.wv = 2;
    await settle();
    const compactStackRun = effectRunTracesFor(stackBudgetEffectId ?? '').at(-1);
    expect(compactStackRun?.detail).toMatchObject({
      runCount: 2,
      reason: 'dependencies',
      dependencyTruncated: true,
      triggerDetailOmitted: true,
      dependencies: [],
      triggers: []
    });
    expect(JSON.stringify(compactStackRun?.detail).length).toBeLessThanOrEqual(100_000);

    const versionEffectId = hook?.beginComponent({
      name: 'VersionGuardProbe',
      file: 'src/VersionGuardProbe.svelte',
      props: () => ({}),
      state: {},
      derived: {}
    });
    hook?.endComponent(versionEffectId ?? null);
    const versionSignal = { f: 0, v: 1, wv: 1, label: 'versioned', deps: null };
    const versionReaction = {
      f: 1 << 20,
      fn: () => undefined,
      deps: [versionSignal],
      parent: null,
      wv: 1
    };
    const versionWrapped = hook?.registerEffect({
      siteId: 'site:version-guard-probe',
      componentId: versionEffectId ?? null,
      kind: 'effect',
      source: { file: 'src/VersionGuardProbe.svelte', line: 4, column: 2 }
    }, () => undefined) as (() => void) | undefined;
    window.__svelte = { v: new Set(['5.38.0']) };
    activeEffect = versionReaction;
    versionWrapped?.();
    activeEffect = null;
    await settle();
    expect(effectRunTracesFor(versionEffectId ?? '').at(-1)?.detail).toMatchObject({
      adapter: 'unavailable',
      dependencies: []
    });
    window.__svelte = { v: new Set(['5.39.0']) };
    versionSignal.v = 2;
    versionSignal.wv = 2;
    activeEffect = versionReaction;
    versionWrapped?.();
    activeEffect = null;
    versionReaction.wv = 2;
    await settle();
    expect(effectRunTracesFor(versionEffectId ?? '').at(-1)?.detail).toMatchObject({
      adapter: 'svelte-5-dev-internals',
      dependencies: [{ label: 'versioned', value: 2 }]
    });
    window.__svelte = { v: new Set(['5']) };

    const largeEffectId = hook?.beginComponent({
      name: 'LargePreviewProbe',
      file: 'src/LargePreviewProbe.svelte',
      props: () => ({}),
      state: {},
      derived: {}
    });
    hook?.endComponent(largeEffectId ?? null);
    const largeSignal = {
      f: 0,
      v: Array.from({ length: 5_000 }, (_, index) => `${index}:${'x'.repeat(2_000)}`),
      wv: 1,
      label: 'large-preview',
      deps: null
    };
    const largeReaction = {
      f: 1 << 20,
      fn: () => undefined,
      deps: [largeSignal],
      parent: null,
      wv: 1
    };
    const largeWrapped = hook?.registerEffect({
      siteId: 'site:large-preview-probe',
      componentId: largeEffectId ?? null,
      kind: 'effect',
      source: { file: 'src/LargePreviewProbe.svelte', line: 4, column: 2 }
    }, () => undefined) as (() => void) | undefined;
    activeEffect = largeReaction;
    largeWrapped?.();
    activeEffect = null;
    await settle();
    const largeRun = effectRunTracesFor(largeEffectId ?? '').at(-1);
    expect(largeRun).toBeDefined();
    expect(JSON.stringify(largeRun?.detail).length).toBeLessThanOrEqual(100_000);
    expect(isPageToContentMessage(pageMessage('test-session', {
      type: 'trace',
      payload: { events: largeRun ? [largeRun] : [] }
    }))).toBe(true);

    const capacityEffectId = hook?.beginComponent({
      name: 'EffectCapacityProbe',
      file: 'src/EffectCapacityProbe.svelte',
      props: () => ({}),
      state: {},
      derived: {}
    });
    hook?.endComponent(capacityEffectId ?? null);
    let firstCapacityWrapped: (() => void) | undefined;
    for (let index = 0; index < 201; index++) {
      const registered = hook?.registerEffect({
        siteId: `site:capacity-${index}`,
        componentId: capacityEffectId ?? null,
        kind: 'effect',
        source: { file: 'src/EffectCapacityProbe.svelte', line: index + 1, column: 2 }
      }, index === 0
        ? () => { throw new Error('capacity effect failed'); }
        : () => undefined);
      if (index === 0) firstCapacityWrapped = registered as () => void;
    }
    const capacityReaction = {
      f: 1 << 20,
      fn: () => undefined,
      deps: [] as Array<Record<string, unknown>>,
      parent: null,
      wv: 1
    };
    activeEffect = capacityReaction;
    expect(() => firstCapacityWrapped?.()).toThrow('capacity effect failed');
    activeEffect = null;
    await settle();
    dispatch(contentMessage(null, { kind: 'snapshot', requestId: 'effect-capacity-snapshot' }));
    await settle();
    const capacitySnapshot = received.findLast(
      (event): event is Extract<PageEvent, { type: 'snapshot' }> =>
        event.type === 'snapshot' && event.payload.requestId === 'effect-capacity-snapshot'
    );
    const capacityDetail = capacitySnapshot?.payload.nodes.find(
      (node) => node.id === capacityEffectId
    )?.detail;
    expect(capacityDetail).toMatchObject({ effectTotal: 201 });
    expect(isRecord(capacityDetail) && typeof capacityDetail.effectsOmitted === 'number'
      ? capacityDetail.effectsOmitted
      : 0).toBeGreaterThanOrEqual(1);
    const capacityEffects = isRecord(capacityDetail) && Array.isArray(capacityDetail.effects)
      ? capacityDetail.effects
      : [];
    expect(capacityEffects[0]).toMatchObject({
      source: { file: 'src/EffectCapacityProbe.svelte', line: 1, column: 2 },
      lastError: { message: 'capacity effect failed' }
    });
    expect(received
      .filter((event): event is Extract<PageEvent, { type: 'trace' }> => event.type === 'trace')
      .flatMap((event) => event.payload.events)
      .some((event) => event.kind === 'effect-capacity' && event.componentId === capacityEffectId))
      .toBe(true);
    hook?.unregisterComponent(capacityEffectId ?? null);

    const cyclicEntry = {
      file: 'src/Cycle.svelte',
      type: 'if' as const,
      line: 2,
      column: 0,
      parent: null as unknown
    };
    cyclicEntry.parent = cyclicEntry;
    const cyclicElement = document.createElement('p');
    cyclicElement.__svelte_meta = {
      parent: cyclicEntry as never,
      loc: { file: 'src/Cycle.svelte', line: 3, column: 1 }
    };
    document.body.append(cyclicElement);
    dispatch(contentMessage(null, { kind: 'snapshot', requestId: 'cycle-safe' }));
    await settle();
    const cycleSnapshot = received.findLast(
      (event): event is Extract<PageEvent, { type: 'snapshot' }> =>
        event.type === 'snapshot' && event.payload.requestId === 'cycle-safe'
    );
    expect(cycleSnapshot?.payload.nodes.some((node) => node.name === '{#if}')).toBe(true);

    let ephemeral = 10;
    const ephemeralId = hook?.beginComponent({
      name: 'Ephemeral',
      file: 'src/Ephemeral.svelte',
      props: () => ({}),
      state: {
        ephemeral: {
          get: () => ephemeral,
          set: (value) => {
            ephemeral = Number(value);
          }
        }
      },
      derived: {}
    });
    hook?.updateComponent(ephemeralId ?? null, 'init');
    hook?.endComponent(ephemeralId ?? null);
    await settle();
    const ephemeralCheckpoint = checkpointFor(ephemeralId ?? '');
    expect(ephemeralCheckpoint).toMatch(/^cp:/);
    ephemeral = 20;
    hook?.updateComponent(ephemeralId ?? null, 'update');
    dispatch(contentMessage(null, {
      kind: 'time-travel',
      requestId: 'ephemeral-travel',
      action: 'apply',
      targets: [{ componentId: ephemeralId ?? '', checkpointId: ephemeralCheckpoint ?? '' }]
    }));
    expect(ephemeral).toBe(10);
    hook?.unregisterComponent(ephemeralId ?? null);
    dispatch(contentMessage(null, {
      kind: 'time-travel',
      requestId: 'ephemeral-live',
      action: 'live'
    }));
    await settle();
    const missingResult = received.findLast(
      (event): event is Extract<PageEvent, { type: 'time-travel-result' }> =>
        event.type === 'time-travel-result' && event.payload.requestId === 'ephemeral-live'
    );
    expect(missingResult?.payload).toMatchObject({ ok: false, live: true, applied: 1 });
    expect(missingResult?.payload.failures?.[0]?.componentId).toBe(ephemeralId);

    let first = 1;
    let second = 1;
    const rollbackId = hook?.beginComponent({
      name: 'Rollback',
      file: 'src/Rollback.svelte',
      props: () => ({}),
      state: {
        first: {
          get: () => first,
          set: (value) => {
            first = Number(value);
          }
        },
        second: {
          get: () => second,
          set: (value) => {
            if (value === 1) throw new Error('setter rejected historical value');
            second = Number(value);
          }
        }
      },
      derived: {}
    });
    hook?.updateComponent(rollbackId ?? null, 'init');
    hook?.endComponent(rollbackId ?? null);
    await settle();
    const rollbackCheckpoint = checkpointFor(rollbackId ?? '');
    first = 2;
    second = 2;
    hook?.updateComponent(rollbackId ?? null, 'update');
    dispatch(contentMessage(null, {
      kind: 'time-travel',
      requestId: 'rollback-travel',
      action: 'apply',
      targets: [{ componentId: rollbackId ?? '', checkpointId: rollbackCheckpoint ?? '' }]
    }));
    expect(first).toBe(2);
    expect(second).toBe(2);
    await settle();
    const rollbackResult = received.findLast(
      (event): event is Extract<PageEvent, { type: 'time-travel-result' }> =>
        event.type === 'time-travel-result' && event.payload.requestId === 'rollback-travel'
    );
    expect(rollbackResult?.payload).toMatchObject({ ok: false, applied: 0 });

    const recursiveDescriptor = {
      name: 'Foo',
      file: 'src/Foo.svelte',
      props: () => ({}),
      state: {},
      derived: {}
    };
    const recursiveRootId = hook?.beginComponent(recursiveDescriptor);
    const recursiveRootElement = document.createElement('div');
    recursiveRootElement.__svelte_meta = {
      parent: null,
      loc: { file: 'src/Foo.svelte', line: 1, column: 0 }
    };
    document.body.append(recursiveRootElement);
    const nestedFooId = hook?.beginComponent(recursiveDescriptor);
    const recursiveEntry = {
      file: 'src/Foo.svelte',
      type: 'component' as const,
      line: 8,
      column: 2,
      parent: null,
      componentTag: 'Foo'
    };
    const nestedElement = document.createElement('span');
    nestedElement.__svelte_meta = {
      parent: recursiveEntry,
      loc: { file: 'src/Foo.svelte', line: 2, column: 0 }
    };
    document.body.append(nestedElement);
    hook?.endComponent(nestedFooId ?? null);
    hook?.endComponent(recursiveRootId ?? null);
    dispatch(contentMessage(null, { kind: 'snapshot', requestId: 'recursive-ownership' }));
    await settle();
    const recursiveSnapshot = received.findLast(
      (event): event is Extract<PageEvent, { type: 'snapshot' }> =>
        event.type === 'snapshot' && event.payload.requestId === 'recursive-ownership'
    );
    expect(recursiveSnapshot?.payload.nodes.find((node) => node.id === recursiveRootId)?.detail)
      .toMatchObject({ enhanced: true, domCount: 1 });
    expect(recursiveSnapshot?.payload.nodes.find((node) => node.id === nestedFooId)?.detail)
      .toMatchObject({ enhanced: true, domCount: 1 });
    hook?.unregisterComponent(nestedFooId ?? null);
    const replacementFooId = hook?.beginComponent(recursiveDescriptor);
    hook?.endComponent(replacementFooId ?? null);
    dispatch(contentMessage(null, { kind: 'snapshot', requestId: 'hmr-replacement' }));
    await settle();
    const hmrSnapshot = received.findLast(
      (event): event is Extract<PageEvent, { type: 'snapshot' }> =>
        event.type === 'snapshot' && event.payload.requestId === 'hmr-replacement'
    );
    expect(hmrSnapshot?.payload.nodes.find((node) => node.id === replacementFooId)).toMatchObject({
      parentId: recursiveRootId,
      detail: { enhanced: true, domCount: 1 }
    });

    const delayedParentId = hook?.beginComponent({
      name: 'Parent',
      file: 'src/Parent.svelte',
      props: () => ({}),
      state: {},
      derived: {}
    });
    const delayedParentElement = document.createElement('div');
    delayedParentElement.__svelte_meta = {
      parent: null,
      loc: { file: 'src/Parent.svelte', line: 1, column: 0 }
    };
    document.body.append(delayedParentElement);
    hook?.endComponent(delayedParentId ?? null);
    await settle();

    const delayedIfEntry = {
      file: 'src/Parent.svelte',
      type: 'if' as const,
      line: 4,
      column: 0,
      parent: null
    };
    const delayedCallEntry = {
      file: 'src/Parent.svelte',
      type: 'component' as const,
      line: 5,
      column: 0,
      parent: delayedIfEntry,
      componentTag: 'Child'
    };
    const delayedChildId = hook?.beginComponent({
      name: 'Child',
      file: 'src/Child.svelte',
      props: () => ({}),
      state: {},
      derived: {}
    });
    const delayedChildElement = document.createElement('span');
    delayedChildElement.__svelte_meta = {
      parent: delayedCallEntry,
      loc: { file: 'src/Child.svelte', line: 1, column: 0 }
    };
    delayedParentElement.append(delayedChildElement);
    hook?.endComponent(delayedChildId ?? null);
    dispatch(contentMessage(null, { kind: 'snapshot', requestId: 'delayed-child' }));
    await settle();
    const delayedSnapshot = received.findLast(
      (event): event is Extract<PageEvent, { type: 'snapshot' }> =>
        event.type === 'snapshot' && event.payload.requestId === 'delayed-child'
    );
    expect(delayedSnapshot?.payload.nodes.find((node) => node.id === delayedChildId)).toMatchObject({
      parentId: delayedParentId,
      detail: { enhanced: true, domCount: 1 }
    });
    expect(delayedSnapshot?.payload.nodes.filter(
      (node) => node.kind === 'component' && node.name === 'Child'
    )).toHaveLength(1);

    const transparentParentId = hook?.beginComponent({
      name: 'TransparentParent',
      file: 'src/TransparentParent.svelte',
      props: () => ({}),
      state: {},
      derived: {}
    });
    hook?.endComponent(transparentParentId ?? null);
    await settle();

    const transparentIfEntry = {
      file: 'src/TransparentParent.svelte',
      type: 'if' as const,
      line: 3,
      column: 0,
      parent: null
    };
    const transparentCallEntry = {
      file: 'src/TransparentParent.svelte',
      type: 'component' as const,
      line: 4,
      column: 0,
      parent: transparentIfEntry,
      componentTag: 'TransparentChild'
    };
    const transparentChildId = hook?.beginComponent({
      name: 'TransparentChild',
      file: 'src/TransparentChild.svelte',
      props: () => ({}),
      state: {},
      derived: {}
    });
    const transparentChildElement = document.createElement('i');
    transparentChildElement.__svelte_meta = {
      parent: transparentCallEntry,
      loc: { file: 'src/TransparentChild.svelte', line: 1, column: 0 }
    };
    document.body.append(transparentChildElement);
    hook?.endComponent(transparentChildId ?? null);
    dispatch(contentMessage(null, { kind: 'snapshot', requestId: 'transparent-late-child' }));
    await settle();
    const transparentSnapshot = received.findLast(
      (event): event is Extract<PageEvent, { type: 'snapshot' }> =>
        event.type === 'snapshot' && event.payload.requestId === 'transparent-late-child'
    );
    expect(transparentSnapshot?.payload.nodes.find((node) => node.id === transparentChildId))
      .toMatchObject({
        parentId: transparentParentId,
        detail: { enhanced: true, domCount: 1 }
      });
    expect(transparentSnapshot?.payload.nodes.filter(
      (node) => node.kind === 'component' && node.name === 'TransparentChild'
    )).toHaveLength(1);

    let pauseRestore = 10;
    const pauseRestoreId = hook?.beginComponent({
      name: 'PauseRestore',
      file: 'src/PauseRestore.svelte',
      props: () => ({}),
      state: {
        pauseRestore: {
          get: () => pauseRestore,
          set: (value) => {
            pauseRestore = Number(value);
          }
        }
      },
      derived: {}
    });
    hook?.updateComponent(pauseRestoreId ?? null, 'init');
    hook?.endComponent(pauseRestoreId ?? null);
    await settle();
    const pauseCheckpoint = checkpointFor(pauseRestoreId ?? '');
    expect(pauseCheckpoint).toMatch(/^cp:/);
    pauseRestore = 20;
    hook?.updateComponent(pauseRestoreId ?? null, 'update');
    dispatch(contentMessage(null, {
      kind: 'time-travel',
      requestId: 'pause-travel',
      action: 'apply',
      targets: [{ componentId: pauseRestoreId ?? '', checkpointId: pauseCheckpoint ?? '' }]
    }));
    expect(pauseRestore).toBe(10);
    dispatch(contentMessage(null, { kind: 'record', enabled: false }));
    expect(pauseRestore).toBe(20);

    // A repeated pause command must also recover state if an old checkpoint was
    // applied while capture was already disabled.
    dispatch(contentMessage(null, {
      kind: 'time-travel',
      requestId: 'paused-travel',
      action: 'apply',
      targets: [{ componentId: pauseRestoreId ?? '', checkpointId: pauseCheckpoint ?? '' }]
    }));
    expect(pauseRestore).toBe(10);
    dispatch(contentMessage(null, { kind: 'record', enabled: false }));
    expect(pauseRestore).toBe(20);

    dispatch(contentMessage(null, { kind: 'record', enabled: true }));
    pauseRestore = 30;
    hook?.updateComponent(pauseRestoreId ?? null, 'update');
    dispatch(contentMessage(null, {
      kind: 'time-travel',
      requestId: 'destroy-travel',
      action: 'apply',
      targets: [{ componentId: pauseRestoreId ?? '', checkpointId: pauseCheckpoint ?? '' }]
    }));
    expect(pauseRestore).toBe(10);
    const sentinel = (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for('svelte-lens.page-hook.v1')
    ] as { destroy?: () => void } | undefined;
    sentinel?.destroy?.();
    expect(pauseRestore).toBe(30);
  });
});

function dispatch(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { source: window, data }));
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 70));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function checkpointFor(componentId: string): string | null {
  const records = received
    .filter((event): event is Extract<PageEvent, { type: 'trace' }> => event.type === 'trace')
    .flatMap((event) => event.payload.events)
    .filter((event) => event.componentId === componentId);
  for (const record of records) {
    if (isRecord(record.detail) && typeof record.detail.checkpointId === 'string') {
      return record.detail.checkpointId;
    }
  }
  return null;
}

function effectRunTracesFor(componentId: string) {
  return received
    .filter((event): event is Extract<PageEvent, { type: 'trace' }> => event.type === 'trace')
    .flatMap((event) => event.payload.events)
    .filter((event) => event.kind === 'effect-run' && event.componentId === componentId);
}
