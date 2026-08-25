<script module>
  export function setup() {
    $effect(() => 'module helper');
  }
</script>

<script>
  setup();
  $effect(() => 'instance effect');
</script>
