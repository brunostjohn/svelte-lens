chrome.devtools.panels.create('Svelte Lens', 'lens.svg', 'src/panel/panel.html', () => {
  if (chrome.runtime.lastError) {
    console.error('[svelte-lens] unable to create DevTools panel', chrome.runtime.lastError);
  }
});
