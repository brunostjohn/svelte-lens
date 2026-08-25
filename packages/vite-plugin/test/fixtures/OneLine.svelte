<script>let x=$state(0);$effect(()=>{const y=x;});</script>{#if x}<button onclick={()=>x++}>{x}</button>{/if}
