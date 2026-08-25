<script lang="ts">
  import App from './App.svelte';

  function reportPanelError(error: unknown) {
    console.error('[Svelte Lens] The DevTools panel recovered from an error', error);
  }
</script>

<svelte:boundary onerror={reportPanelError}>
  <App />

  {#snippet failed(error, reset)}
    <main class="panel-failure">
      <div class="panel-failure-mark">!</div>
      <h1>Svelte Lens hit a panel error</h1>
      <p>The inspected page is still running. Retry the panel, or reload it if the same error returns.</p>
      <pre>{error instanceof Error ? error.message : String(error)}</pre>
      <div>
        <button onclick={reset}>Retry panel</button>
        <button class="primary" onclick={() => location.reload()}>Reload panel</button>
      </div>
    </main>
  {/snippet}
</svelte:boundary>
