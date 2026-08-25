<script lang="ts">
  import Counter from './Counter.svelte';
  import TodoList from './TodoList.svelte';

  let accent = $state('#ff3e78');
  let showSecond = $state(true);
  let interactions = $state(0);

  function randomizeAccent() {
    const colors = ['#ff3e78', '#40b3ff', '#a78bfa', '#f59e0b'];
    accent = colors[Math.floor(Math.random() * colors.length)] ?? colors[0]!;
    interactions += 1;
  }
</script>

<svelte:head>
  <meta name="theme-color" content={accent} />
</svelte:head>

<main style:--accent={accent}>
  <header>
    <div class="eyebrow">Svelte Lens fixture</div>
    <h1>See the component, then see the cause.</h1>
    <p>
      Open Chrome DevTools → Svelte Lens. Pick any element, change some state, and scrub the
      trace.
    </p>
    <div class="actions">
      <button class="primary" onclick={randomizeAccent}>Change accent</button>
      <button onclick={() => (showSecond = !showSecond)}>
        {showSecond ? 'Unmount' : 'Mount'} second counter
      </button>
    </div>
    <small>{interactions} parent interactions</small>
  </header>

  <section class="grid">
    <Counter label="Primary counter" start={2} {accent} />
    {#if showSecond}
      <Counter label="Conditional counter" start={10} {accent} />
    {/if}
    <TodoList />
  </section>
</main>

<style>
  :global(*) { box-sizing: border-box; }
  :global(body) {
    margin: 0;
    min-width: 320px;
    min-height: 100vh;
    color: #f6f7fb;
    background: #0d0f14;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  main { width: min(1120px, calc(100% - 40px)); margin: 0 auto; padding: 72px 0; }
  header { max-width: 760px; margin-bottom: 40px; }
  .eyebrow { color: var(--accent); font: 700 12px/1 ui-monospace, monospace; letter-spacing: .14em; text-transform: uppercase; }
  h1 { margin: 16px 0; max-width: 700px; font-size: clamp(42px, 7vw, 76px); line-height: .96; letter-spacing: -.055em; }
  p { color: #a7adbb; font-size: 18px; line-height: 1.6; }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 28px 0 14px; }
  button { border: 1px solid #333846; border-radius: 9px; padding: 10px 14px; color: #f7f8fb; background: #171a22; cursor: pointer; }
  button:hover { border-color: #555d70; }
  button.primary { border-color: color-mix(in srgb, var(--accent) 70%, white); background: var(--accent); color: #090a0d; font-weight: 750; }
  small { color: #747b8c; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; align-items: start; }
</style>
