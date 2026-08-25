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
  const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const records = (value) => Array.isArray(value) ? value.filter((item) => record(item)) : [];
  const strings = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
  const count = (node) => detail(node)?.state?.count ?? null;
  const deepValue = (node) => detail(node)?.state?.effectProbe?.nested?.value ?? null;
  const deepDomValue = () => {
    const match = /deep\s+(\d+)/.exec(document.querySelector('.effect-state')?.textContent ?? '');
    return match ? Number(match[1]) : null;
  };
  const click = async (label) => {
    const button = document.querySelector('button[aria-label="' + label + '"]');
    if (!(button instanceof HTMLButtonElement)) throw new Error(label + ' button was not found');
    button.click();
    await wait(160);
  };

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

    await click('effect-pulse');
    await click('effect-pulse');
    await click('effect-branch');
    await click('effect-deep');

    const effectsSnapshot = await snapshot('chrome-effects');
    const effectsCounter = effectsSnapshot?.payload.nodes.find((node) => node.id === counter.id);
    const effectSummaries = records(detail(effectsCounter)?.effects);
    const primaryEffect = effectSummaries.find((effect) => effect.kind === 'effect');
    const preEffect = effectSummaries.find((effect) => effect.kind === 'pre');
    if (!primaryEffect) throw new Error('Counter effect summary was not captured');
    if (!preEffect) throw new Error('Counter pre-effect summary was not captured');

    const primaryRuns = traces().filter((trace) =>
      trace.kind === 'effect-run' &&
      trace.componentId === counter.id &&
      record(trace.detail)?.effectId === primaryEffect.id
    );
    const runDetails = primaryRuns.map((trace) => record(trace.detail)).filter(Boolean);
    const triggerChanges = runDetails.flatMap((run) => records(run.triggers));
    const pulseChange = triggerChanges.findLast((trigger) =>
      typeof trigger.label === 'string' &&
      trigger.label.toLowerCase().includes('effectpulse') &&
      Object.prototype.hasOwnProperty.call(trigger, 'before') &&
      trigger.before !== trigger.current
    );
    const deepChange = triggerChanges.find((trigger) =>
      typeof trigger.label === 'string' &&
      /effectprobe|nested\.value/i.test(trigger.label) &&
      Object.prototype.hasOwnProperty.call(trigger, 'before') &&
      trigger.before !== trigger.current
    );
    const dynamicRun = runDetails.find((run) =>
      strings(run.addedDependencyIds).length > 0 && strings(run.removedDependencyIds).length > 0
    );
    const cleanupTrace = traces().find((trace) =>
      trace.kind === 'effect-cleanup' &&
      trace.componentId === counter.id &&
      record(trace.detail)?.effectId === primaryEffect.id
    );

    await click('increment');
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
    const rewoundDeepDom = deepDomValue();

    command({ kind: 'time-travel', requestId: 'chrome-live', action: 'live' });
    await wait(160);
    const liveSnapshot = await snapshot('chrome-live-state');
    const liveCounter = liveSnapshot?.payload.nodes.find((node) => node.id === counter.id);
    const liveDeepDom = deepDomValue();
    await click('effect-deep');
    const postLiveDeepSnapshot = await snapshot('chrome-post-live-deep');
    const postLiveDeepCounter = postLiveDeepSnapshot?.payload.nodes.find((node) => node.id === counter.id);
    const postLiveDeepDom = deepDomValue();

    const latestHello = events.findLast((event) => event.type === 'hello');
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
      deepState: {
        rewound: deepValue(rewoundCounter),
        live: deepValue(liveCounter),
        postLiveMutation: deepValue(postLiveDeepCounter),
        domRewound: rewoundDeepDom,
        domLive: liveDeepDom,
        domPostLiveMutation: postLiveDeepDom
      },
      effects: {
        capability: latestHello?.payload.capabilities.effects === true,
        summaryCount: effectSummaries.length,
        primary: {
          runCount: primaryEffect.runCount,
          rerunCount: primaryEffect.rerunCount,
          capturedRunCount: primaryEffect.capturedRunCount,
          cleanupCount: primaryEffect.cleanupCount,
          dependencyCount: primaryEffect.dependencyCount,
          adapter: primaryEffect.adapter
        },
        preRunCount: preEffect.runCount,
        rerunReceipt: runDetails.some((run) => run.phase === 'rerun'),
        captureGapReceipt: runDetails.some((run) => run.reason === 'capture-gap'),
        changedDependency: pulseChange ? {
          label: pulseChange.label,
          before: pulseChange.before,
          current: pulseChange.current
        } : null,
        deepDependency: deepChange ? {
          label: deepChange.label,
          before: deepChange.before,
          current: deepChange.current
        } : null,
        dynamicDependencies: dynamicRun ? {
          added: strings(dynamicRun.addedDependencyIds).length,
          removed: strings(dynamicRun.removedDependencyIds).length
        } : null,
        cleanupReceipt: Boolean(cleanupTrace)
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
    result?.counts?.live === 3 &&
    result?.deepState?.rewound === 0 &&
    result?.deepState?.live === 1 &&
    result?.deepState?.postLiveMutation === 2 &&
    result?.deepState?.domRewound === 0 &&
    result?.deepState?.domLive === 1 &&
    result?.deepState?.domPostLiveMutation === 2 &&
    result?.effects?.capability === true &&
    result?.effects?.summaryCount >= 2 &&
    result?.effects?.primary?.runCount === result?.effects?.primary?.rerunCount + 1 &&
    result?.effects?.primary?.capturedRunCount >= 4 &&
    result?.effects?.primary?.cleanupCount >= 4 &&
    result?.effects?.primary?.dependencyCount > 0 &&
    result?.effects?.primary?.adapter === 'exact' &&
    result?.effects?.preRunCount >= 1 &&
    result?.effects?.rerunReceipt === true &&
    typeof result?.effects?.changedDependency?.label === 'string' &&
    result?.effects?.changedDependency?.before === 1 &&
    result?.effects?.changedDependency?.current === 2 &&
    typeof result?.effects?.deepDependency?.label === 'string' &&
    result?.effects?.deepDependency?.before === 0 &&
    result?.effects?.deepDependency?.current === 1 &&
    result?.effects?.dynamicDependencies?.added > 0 &&
    result?.effects?.dynamicDependencies?.removed > 0 &&
    result?.effects?.cleanupReceipt === true;
  if (!expected) throw new Error(`Unexpected runtime smoke result: ${JSON.stringify(result)}`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  socket.close();
}
