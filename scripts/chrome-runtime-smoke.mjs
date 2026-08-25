const port = Number(process.argv[2] ?? 9222);
const inspectedUrl = process.argv[3] ?? 'http://127.0.0.1:5173/';

if (!Number.isSafeInteger(port) || port < 1) throw new Error('Expected a Chrome debugging port');

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => {
  if (!response.ok) throw new Error(`Chrome target discovery failed: ${response.status}`);
  return response.json();
});
const target = targets.find((candidate) => candidate.type === 'page' && candidate.url === inspectedUrl);
if (!target?.webSocketDebuggerUrl) throw new Error(`No page target found for ${inspectedUrl}`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let nextId = 0;
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const onMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      socket.removeEventListener('message', onMessage);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

const expression = String.raw`(async () => {
  const events = [];
  const receive = (event) => {
    if (event.source === window && event.data?.source === 'svelte-lens/page' && event.data?.v === 1) {
      events.push(event.data.event);
    }
  };
  const command = (command) => window.postMessage({
    source: 'svelte-lens/content',
    v: 1,
    sessionId: null,
    command
  }, '*');
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const snapshot = async (requestId) => {
    command({ kind: 'snapshot', requestId });
    await wait(120);
    return events.findLast((event) => event.type === 'snapshot' && event.payload.requestId === requestId);
  };
  const traces = () => events
    .filter((event) => event.type === 'trace')
    .flatMap((event) => event.payload.events);
  const detail = (node) => node?.detail && typeof node.detail === 'object' && !Array.isArray(node.detail)
    ? node.detail
    : null;
  const count = (node) => detail(node)?.state?.count ?? null;

  window.addEventListener('message', receive);
  try {
    command({ kind: 'connect' });
    command({ kind: 'record', enabled: true });
    const beforeSnapshot = await snapshot('chrome-before');
    const counter = beforeSnapshot?.payload.nodes.find((node) =>
      node.kind === 'component' && node.name === 'Counter' && detail(node)?.enhanced === true
    );
    if (!counter) throw new Error('Enhanced Counter was not found');

    const baseline = traces().find((trace) =>
      trace.kind === 'mount' &&
      trace.componentId === counter.id &&
      typeof trace.detail?.checkpointId === 'string'
    );
    if (!baseline) throw new Error('Counter baseline checkpoint was not captured');

    const increment = document.querySelector('button[aria-label="increment"]');
    if (!(increment instanceof HTMLButtonElement)) throw new Error('Counter button was not found');
    increment.click();
    await wait(160);
    const afterSnapshot = await snapshot('chrome-after');
    const afterCounter = afterSnapshot?.payload.nodes.find((node) => node.id === counter.id);

    command({
      kind: 'time-travel',
      requestId: 'chrome-rewind',
      action: 'apply',
      targets: [{ componentId: counter.id, checkpointId: baseline.detail.checkpointId }]
    });
    await wait(160);
    const rewoundSnapshot = await snapshot('chrome-rewound');
    const rewoundCounter = rewoundSnapshot?.payload.nodes.find((node) => node.id === counter.id);

    command({ kind: 'time-travel', requestId: 'chrome-live', action: 'live' });
    await wait(160);
    const liveSnapshot = await snapshot('chrome-live-state');
    const liveCounter = liveSnapshot?.payload.nodes.find((node) => node.id === counter.id);

    command({ kind: 'record', enabled: false });
    return {
      hook: Boolean(globalThis.__SVELTE_LENS__),
      versions: Array.from(window.__svelte?.v ?? []),
      componentCount: beforeSnapshot?.payload.nodes.filter((node) => node.kind === 'component').length ?? 0,
      enhancedCount: beforeSnapshot?.payload.nodes.filter((node) => detail(node)?.enhanced === true).length ?? 0,
      counts: {
        before: count(counter),
        after: count(afterCounter),
        rewound: count(rewoundCounter),
        live: count(liveCounter)
      },
      traceKinds: traces().slice(-12).map((trace) => trace.kind)
    };
  } finally {
    window.removeEventListener('message', receive);
  }
})()`;

try {
  const evaluation = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (evaluation.exceptionDetails) {
    throw new Error(evaluation.exceptionDetails.exception?.description ?? 'Runtime smoke failed');
  }
  const result = evaluation.result.value;
  const expected = result?.hook === true &&
    result?.counts?.before === 2 &&
    result?.counts?.after === 3 &&
    result?.counts?.rewound === 2 &&
    result?.counts?.live === 3;
  if (!expected) throw new Error(`Unexpected runtime smoke result: ${JSON.stringify(result)}`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  socket.close();
}
