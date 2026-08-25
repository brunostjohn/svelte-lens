<script lang="ts">
  type Todo = { id: number; text: string; done: boolean };

  let draft = $state('Inspect this update');
  let nextId = $state(3);
  let todos = $state<Todo[]>([
    { id: 1, text: 'Open Svelte Lens', done: true },
    { id: 2, text: 'Pick this component', done: false }
  ]);
  let remaining = $derived(todos.filter((todo) => !todo.done).length);

  function add() {
    const text = draft.trim();
    if (!text) return;
    todos.push({ id: nextId++, text, done: false });
    draft = '';
  }
</script>

<article>
  <div class="heading">
    <strong>Nested state</strong>
    <span>{remaining} remaining</span>
  </div>
  <form onsubmit={(event) => { event.preventDefault(); add(); }}>
    <input aria-label="New todo" bind:value={draft} />
    <button>Add</button>
  </form>
  <ul>
    {#each todos as todo (todo.id)}
      <li class:done={todo.done}>
        <label>
          <input type="checkbox" bind:checked={todo.done} />
          <span>{todo.text}</span>
        </label>
        <button class="remove" aria-label={`Remove ${todo.text}`} onclick={() => (todos = todos.filter((item) => item.id !== todo.id))}>×</button>
      </li>
    {/each}
  </ul>
</article>

<style>
  article { min-height: 260px; padding: 22px; border: 1px solid #292d38; border-radius: 14px; background: #13161d; }
  .heading, li, form, label { display: flex; align-items: center; }
  .heading { justify-content: space-between; margin-bottom: 20px; }
  .heading span { color: #747b8c; font: 11px ui-monospace, monospace; }
  form { gap: 8px; }
  form input { flex: 1; min-width: 0; }
  input, button { height: 36px; border: 1px solid #343a49; border-radius: 8px; color: #f7f8fb; background: #1a1e28; }
  input { padding: 0 10px; }
  button { padding: 0 12px; cursor: pointer; }
  ul { display: grid; gap: 8px; margin: 18px 0 0; padding: 0; list-style: none; }
  li { justify-content: space-between; gap: 8px; color: #cbd0dc; }
  label { min-width: 0; gap: 9px; }
  label input { width: 16px; height: 16px; }
  li.done span { color: #626a7a; text-decoration: line-through; }
  .remove { width: 30px; height: 30px; padding: 0; border-color: transparent; color: #747b8c; background: transparent; }
</style>
