import {
  contentMessage,
  isPageToContentMessage,
  type PageEvent,
  type SnapshotNode,
  type TraceRecord
} from '../../../apps/extension/src/shared/protocol';

const events: PageEvent[] = [];
const status = document.querySelector<HTMLOutputElement>('#smoke-status');

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== window || !isPageToContentMessage(event.data)) return;
  events.push(event.data.event);
  if (
    event.data.event.type === 'hello' ||
    (event.data.event.type === 'snapshot' && event.data.event.payload.requestId === 'browser-smoke')
  ) {
    renderStatus();
  }
});

await import('../../../apps/extension/src/page/page-hook');
dispatch({ kind: 'connect' });
dispatch({ kind: 'record', enabled: true });
await import('./main');

setTimeout(() => {
  dispatch({ kind: 'snapshot', requestId: 'browser-smoke' });
}, 100);

document.querySelector('#smoke-refresh')?.addEventListener('click', () => {
  dispatch({ kind: 'snapshot', requestId: 'browser-smoke' });
});

function dispatch(command: Parameters<typeof contentMessage>[1]) {
  window.postMessage(contentMessage(null, command), '*');
}

function renderStatus() {
  if (!status) return;
  const hello = events.findLast(
    (event): event is Extract<PageEvent, { type: 'hello' }> => event.type === 'hello'
  );
  const requestedSnapshot = events.findLast(
    (event): event is Extract<PageEvent, { type: 'snapshot' }> =>
      event.type === 'snapshot' && event.payload.requestId === 'browser-smoke'
  );
  const snapshot = requestedSnapshot ?? events.findLast(
    (event): event is Extract<PageEvent, { type: 'snapshot' }> => event.type === 'snapshot'
  );
  const traces = events
    .filter((event): event is Extract<PageEvent, { type: 'trace' }> => event.type === 'trace')
    .flatMap((event) => event.payload.events);
  const components = snapshot?.payload.nodes.filter((node) => node.kind === 'component') ?? [];
  const enhanced = components.filter((node) => detail(node)?.enhanced === true);
  const counter = enhanced.find((node) => node.name === 'Counter');
  const byId = new Map(snapshot?.payload.nodes.map((node) => [node.id, node]) ?? []);

  status.textContent = JSON.stringify({
    mode: hello?.payload.mode ?? null,
    stateCapture: hello?.payload.capabilities.state ?? false,
    componentNames: components.map((node) => node.name),
    enhanced: enhanced.length,
    fallbackComponents: components.length - enhanced.length,
    componentParents: enhanced.map((node) => ({
      name: node.name,
      parent: node.parentId ? byId.get(node.parentId)?.name ?? node.parentId : null
    })),
    counterState: detail(counter)?.state ?? null,
    traceKinds: traces.slice(-20).map((trace: TraceRecord) => trace.kind),
    snapshotRequest: snapshot?.payload.requestId ?? null
  });
  document.documentElement.dataset.smokeReady = requestedSnapshot
    ? 'true'
    : 'false';
}

function detail(node: SnapshotNode | undefined): Record<string, unknown> | null {
  const value = node?.detail;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const style = document.createElement('style');
style.textContent = `
  #smoke-status {
    position: fixed;
    right: 10px;
    bottom: 10px;
    z-index: 10;
    max-width: min(680px, calc(100vw - 20px));
    padding: 8px 10px;
    overflow: hidden;
    border: 1px solid #394052;
    border-radius: 6px;
    color: #aeb8ca;
    background: rgba(9, 11, 16, .94);
    font: 10px/1.4 ui-monospace, monospace;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  #smoke-refresh {
    position: fixed;
    right: 10px;
    bottom: 50px;
    z-index: 10;
    border: 1px solid #394052;
    border-radius: 6px;
    padding: 6px 9px;
    color: #aeb8ca;
    background: rgba(9, 11, 16, .94);
    font: 10px/1 ui-monospace, monospace;
    cursor: pointer;
  }
`;
document.head.append(style);
