<script>
  let deep = $state({ nested: { count: 0 } });
  let raw = $state.raw({ nested: { count: 0 } });

  function replace() {
    deep = { nested: { count: 1 } };
    raw = { nested: { count: 1 } };
  }
</script>

<button onclick={replace}>{deep.nested.count}:{raw.nested.count}</button>
