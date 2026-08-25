import { compile } from "svelte/compiler";
import { describe, expect, it } from "vitest";

import {
  instrumentCompiledSvelte,
  instrumentSvelteSource,
  svelteLens,
} from "../src/index.js";

const filename = "/repo/src/Counter.svelte";

function instrument(source: string) {
  const result = instrumentSvelteSource(source, {
    filename,
    displayFilename: "src/Counter.svelte",
  });
  if (!result) throw new Error("Expected source instrumentation");
  return result;
}

function compileDev(source: string): string {
  return compile(source, {
    dev: true,
    filename,
    generate: "client",
    rootDir: "/repo",
  }).js.code;
}

describe("instrumentSvelteSource", () => {
  it("captures rune props, writable state, readonly state, and derived values", () => {
    const source = `<script lang="ts">
      let { title: heading = "Hello", ...rest }: { title?: string; [key: string]: unknown } = $props();
      let count = $state(0);
      const frozen = $state.raw({ value: 1 });
      const doubled = $derived(count * 2);
      const lazy = $derived.by(() => doubled + 1);
    </script>
    <button onclick={() => count++}>{heading}: {lazy}</button>`;

    const result = instrument(source);

    expect(result.code).toContain('import { onDestroy as __svelte_lens_on_destroy_');
    expect(result.code).toContain('name: "Counter"');
    expect(result.code).toContain('file: "src/Counter.svelte"');
    expect(result.code).toContain('props: () => ({ "title": heading, ...rest })');
    expect(result.code).toContain('"count": { get: () => count, set: (value) => { count = value; } }');
    expect(result.code).toContain('"frozen": { get: () => frozen }');
    expect(result.code).toContain('"doubled": { get: () => doubled }');
    expect(result.code).toContain('"lazy": { get: () => lazy }');
    expect(result.code).toContain('$inspect(heading, rest, count, frozen, doubled, lazy).with((phase) =>');
    expect(result.code).toContain('globalThis.__SVELTE_LENS__?.unregisterComponent(');
    expect(result.map.sources).toEqual([filename]);
    expect(result.map.sourcesContent).toEqual([source]);

    expect(() => compileDev(result.code)).not.toThrow();
  });

  it("keeps legacy components in legacy mode and emits an initial update", () => {
    const source = `<script>
      export let name = "world";
      let local = 0;
    </script>
    <p>Hello {name}</p>`;

    const result = instrument(source);

    expect(result.code).toContain('props: () => ({ "name": name })');
    expect(result.code).toContain("state: {}");
    expect(result.code).not.toContain("$inspect(");
    expect(result.code).toMatch(/updateComponent\([^;]+, "init"\)/);
    expect(() => compileDev(result.code)).not.toThrow();
  });

  it("adds an instance script to components that do not have one", () => {
    const source = `<h1>Static component</h1>`;
    const result = instrument(source);

    expect(result.code.startsWith("<script>\n")).toBe(true);
    expect(result.code).toContain("props: () => ({})");
    expect(result.code).toContain("state: {}");
    expect(result.code).toContain("derived: {}");
    expect(() => compileDev(result.code)).not.toThrow();
  });

  it("is idempotent on already-instrumented source", () => {
    const result = instrument(`<script>let count = $state(0);</script>`);
    expect(
      instrumentSvelteSource(result.code, {
        filename,
        displayFilename: "src/Counter.svelte",
      }),
    ).toBeNull();
  });

  it("leaves syntax owned by a custom preprocessor alone", () => {
    expect(
      instrumentSvelteSource(`<script lang="coffee">square = (x) -> x * x</script>`, {
        filename,
        displayFilename: "src/Counter.svelte",
      }),
    ).toBeNull();
  });
});

describe("instrumentCompiledSvelte", () => {
  it("inserts endComponent before a returned pop without changing the return", () => {
    const source = `<script>let count = $state(0);</script><p>{count}</p>`;
    const compiled = compileDev(instrument(source).code);
    const result = instrumentCompiledSvelte(compiled, filename);
    if (!result) throw new Error("Expected compiled instrumentation");

    const endIndex = result.code.indexOf("?.endComponent(");
    const popIndex = result.code.indexOf("return $.pop(", endIndex);
    expect(endIndex).toBeGreaterThan(-1);
    expect(popIndex).toBeGreaterThan(endIndex);
    expect(result.code).toContain("return $.pop($$exports);");
    expect(result.map.sources).toEqual([filename]);
    expect(result.map.sourcesContent).toEqual([compiled]);
  });

  it("handles a bare component-context pop", () => {
    const compiled = `import * as $ from 'svelte/internal/client';
function Counter($$anchor, $$props) {
  $.push($$props, true, Counter);
  const __svelte_lens_id_fixture = globalThis.__SVELTE_LENS__?.beginComponent({}) ?? null;
  $.pop();
}`;

    const result = instrumentCompiledSvelte(compiled, filename);
    if (!result) throw new Error("Expected compiled instrumentation");

    expect(result.code).toContain(
      "if (__svelte_lens_id_fixture != null) globalThis.__SVELTE_LENS__?.endComponent(__svelte_lens_id_fixture);\n  $.pop();",
    );
  });

  it("ignores server output and already-instrumented output", () => {
    expect(instrumentCompiledSvelte("export default function Component() {}", filename)).toBeNull();

    const compiled = `import * as $ from 'svelte/internal/client';
function Counter() {
  const __svelte_lens_id_fixture = globalThis.__SVELTE_LENS__?.beginComponent({});
  $.pop();
}`;
    const once = instrumentCompiledSvelte(compiled, filename);
    if (!once) throw new Error("Expected compiled instrumentation");
    expect(instrumentCompiledSvelte(once.code, filename)).toBeNull();
  });
});

describe("svelteLens", () => {
  it("returns serve-only pre and post plugins", () => {
    const plugins = svelteLens();
    expect(plugins.map((plugin) => plugin.name)).toEqual([
      "svelte-lens:instrument-source",
      "svelte-lens:instrument-compiled",
    ]);
    expect(plugins.map((plugin) => plugin.enforce)).toEqual(["pre", "post"]);
    expect(plugins.map((plugin) => plugin.apply)).toEqual(["serve", "serve"]);
  });

  it("can be disabled", () => {
    expect(svelteLens({ enabled: false })).toEqual([]);
  });
});
