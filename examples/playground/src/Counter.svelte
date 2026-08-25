<script lang="ts">
  import { untrack } from 'svelte';

  let { label, start = 0, accent }: { label: string; start?: number; accent: string } = $props();
  let count = $state(untrack(() => start));
  let step = $state(1);
  let history = $state<number[]>([untrack(() => start)]);
  let doubled = $derived(count * 2);
  let effectBranch = $state<'count' | 'history'>('count');
  let effectPulse = $state(0);
  let effectProbe = $state({ nested: { value: 0 } });

  $effect(() => {
    const pulse = effectPulse;
    const branch = effectBranch;
    const branchValue = branch === 'count'
      ? `count:${count}:doubled:${doubled}`
      : `history:${history.length}:${history.at(-1) ?? 'empty'}:deep:${effectProbe.nested.value}`;

    document.documentElement.dataset.svelteLensEffect = `${label}:${pulse}:${branchValue}`;

    return () => {
      // Cleanup reads are deliberately observable but must not join the next run's dependency set.
      document.documentElement.dataset.svelteLensEffectCleanup = `${label}:${count}`;
    };
  });

  $effect.pre(() => {
    document.documentElement.dataset.svelteLensPreEffect = `${label}:${step}:${doubled}`;
  });

  function move(direction: number) {
    count += direction * step;
    history.push(count);
  }
</script>

<article style:--accent={accent}>
  <div class="label">{label}</div>
  <div class="value">{count}</div>
  <div class="derived">derived ×2 = {doubled}</div>
  <div class="controls">
    <button aria-label="decrement" onclick={() => move(-1)}>−</button>
    <input aria-label="step" type="number" min="1" max="10" bind:value={step} />
    <button aria-label="increment" onclick={() => move(1)}>+</button>
  </div>
  <div class="effect-controls">
    <button aria-label="effect-pulse" onclick={() => (effectPulse += 1)}>Pulse effect</button>
    <button aria-label="effect-branch" onclick={() => (effectBranch = effectBranch === 'count' ? 'history' : 'count')}>
      Branch: {effectBranch}
    </button>
    <button aria-label="effect-deep" onclick={() => (effectProbe.nested.value += 1)}>Deep +1</button>
  </div>
  <div class="effect-state">effect pulse {effectPulse} · deep {effectProbe.nested.value}</div>
  <div class="history">history: {history.join(' → ')}</div>
</article>

<style>
  article { min-height: 260px; padding: 22px; border: 1px solid #292d38; border-radius: 14px; background: #13161d; box-shadow: inset 0 1px rgba(255,255,255,.025); }
  .label { color: #a7adbb; font-size: 13px; font-weight: 650; }
  .value { margin: 18px 0 4px; color: var(--accent); font: 760 72px/.9 ui-monospace, monospace; letter-spacing: -.08em; }
  .derived { color: #697184; font: 12px/1.4 ui-monospace, monospace; }
  .controls { display: grid; grid-template-columns: 42px 1fr 42px; gap: 8px; margin-top: 24px; }
  button, input { height: 38px; border: 1px solid #343a49; border-radius: 8px; color: #f7f8fb; background: #1a1e28; }
  button { cursor: pointer; font-size: 20px; }
  input { width: 100%; padding: 0 10px; font: 13px ui-monospace, monospace; }
  .effect-controls { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .effect-controls button { flex: 1 1 auto; height: 30px; padding: 0 8px; color: #939bad; font: 10px/1 ui-monospace, monospace; }
  .effect-state { margin-top: 8px; color: #596174; font: 10px/1.4 ui-monospace, monospace; }
  .history { margin-top: 18px; overflow: hidden; color: #666e80; font: 11px/1.5 ui-monospace, monospace; text-overflow: ellipsis; white-space: nowrap; }
</style>
