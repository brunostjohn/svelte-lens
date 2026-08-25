<script>
  import { writable } from "svelte/store";

  const value = writable(1);

  $effect(() => {
    $value;
  });
</script>

<p>{$value}</p>
