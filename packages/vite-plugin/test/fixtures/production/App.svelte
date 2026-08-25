<script>
  let count = $state(0);
  const doubled = $derived(count * 2);

  $effect(() => {
    document.title = `Count ${count}`;
  });
</script>

<button onclick={() => count += 1}>{count} / {doubled}</button>
