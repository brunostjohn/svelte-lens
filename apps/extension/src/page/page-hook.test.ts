// @vitest-environment jsdom

import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  contentMessage,
  isPageToContentMessage,
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
