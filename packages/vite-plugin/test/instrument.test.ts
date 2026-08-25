import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { compile } from "svelte/compiler";
import { build, createServer } from "vite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { svelteLens } from "../src/index.js";
import {
  createSourceInstrumentationPlan,
  instrumentCompiledSvelte,
  instrumentSvelteSource,
} from "../src/instrument.js";

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
  return compileDevOutput(source).code;
}

function compileDevOutput(source: string) {
  return compile(source, {
    dev: true,
    filename,
    generate: "client",
    rootDir: "/repo",
  }).js;
}

function generatedPosition(code: string, needle: string) {
  const offset = code.indexOf(needle);
  if (offset < 0) throw new Error(`Missing generated token: ${needle}`);
  const before = code.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length, column: lines.at(-1)?.length ?? 0 };
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

    expect(result.code).toContain('import {onDestroy as __svelte_lens_on_destroy_');
    expect(result.code).toContain('name:"Counter"');
    expect(result.code).toContain('file:"src/Counter.svelte"');
    expect(result.code).toContain('props:()=>({ "title": heading, ...rest })');
    expect(result.code).toContain('"count": { get: () => count, set: (value) => { count = value; } }');
    expect(result.code).toContain('"frozen": { get: () => frozen }');
    expect(result.code).toContain('"doubled": { get: () => doubled }');
    expect(result.code).toContain('"lazy": { get: () => lazy }');
    expect(result.code).toContain('$inspect(heading,rest,count,frozen,doubled,lazy).with((phase)=>');
    expect(result.code).toContain('globalThis.__SVELTE_LENS__?.unregisterComponent(');
    expect(result.map.sources).toEqual([filename]);
    expect(result.map.sourcesContent).toEqual([source]);

    expect(() => compileDev(result.code)).not.toThrow();
  });

  it("registers the component before pre-effects can execute", () => {
    const result = instrument(`<script>
      let count = $state(0);
      $effect.pre(() => count);
    </script>`);

    expect(result.code.indexOf("?.beginComponent(")).toBeLessThan(result.code.indexOf("let count"));
    expect(result.code.indexOf("?.beginComponent(")).toBeLessThan(result.code.indexOf("$effect.pre"));
    expect(() => compileDev(result.code)).not.toThrow();
  });

  it("keeps legacy components in legacy mode and emits an initial update", () => {
    const source = `<script>
      export let name = "world";
      let local = 0;
    </script>
    <p>Hello {name}</p>`;

    const result = instrument(source);

    expect(result.code).toContain('props:()=>({ "name": name })');
    expect(result.code).toContain("state:{}");
    expect(result.code).not.toContain("$inspect(");
    expect(result.code).toMatch(/updateComponent\([^;]+,"init"\)/);
    expect(() => compileDev(result.code)).not.toThrow();
  });

  it("adds an instance script to components that do not have one", () => {
    const source = `<h1>Static component</h1>`;
    const result = instrument(source);

    expect(result.code.startsWith(source)).toBe(true);
    expect(result.code).toContain("<script>import {onDestroy as");
    expect(result.code).toContain("props:()=>({})");
    expect(result.code).toContain("state:{}");
    expect(result.code).toContain("derived:{}");
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
  it("wraps real compiled effects and pre-effects with guarded runtime metadata", () => {
    const source = `<script>
      let count = $state(0);
      function makeEffect() { return () => count; }
      $effect(makeEffect());
      $effect.pre(() => count);
      $effect.root(() => {
        $effect(() => count);
      });
    </script>`;
    const sourceResult = instrument(source);
    const compiled = compileDevOutput(sourceResult.code);
    const result = instrumentCompiledSvelte(compiled.code, filename, {
      inputMap: JSON.stringify(compiled.map),
      displayFilename: "src/Counter.svelte",
    });
    if (!result) throw new Error("Expected compiled instrumentation");

    expect(result.code.match(/registerEffect/g)).toHaveLength(3);
    expect(result.code.match(/makeEffect\(\)/g)).toHaveLength(compiled.code.match(/makeEffect\(\)/g)?.length ?? 0);
    expect(result.code).toMatch(/"kind":\s*"effect"/);
    expect(result.code).toMatch(/"kind":\s*"pre"/);
    expect(result.code).not.toMatch(/"kind":\s*"root"/);
    expect(result.code).not.toContain('svelte/internal/flags/tracing');
    expect(result.code).toContain("activeEffect: $.active_effect, untrack: $.untrack");
    expect(result.code).toMatch(/"siteId":\s*"site:/);
    expect(result.code).toMatch(
      /"source":\s*\{\s*"file":\s*"src\/Counter\.svelte",\s*"line":\s*4,\s*"column":\s*6\s*\}/,
    );
    expect(result.code).toMatch(
      /"source":\s*\{\s*"file":\s*"src\/Counter\.svelte",\s*"line":\s*5,\s*"column":\s*6\s*\}/,
    );
    expect(result.code).toMatch(
      /"source":\s*\{\s*"file":\s*"src\/Counter\.svelte",\s*"line":\s*7,\s*"column":\s*8\s*\}/,
    );
  });

  it("preserves user-authored inspect.trace without adding another tracing side effect", () => {
    const source = `<script>
      let count = $state(0);
      $effect(() => { $inspect.trace('existing'); count; });
    </script>`;
    const sourceResult = instrument(source);
    const compiled = compileDevOutput(sourceResult.code);
    const result = instrumentCompiledSvelte(compiled.code, filename);
    if (!result) throw new Error("Expected compiled instrumentation");

    expect(result.code.match(/svelte\/internal\/flags\/tracing/g)).toHaveLength(1);
    expect(result.code).toContain("$.trace(");
  });

  it("does not mistake user text for the tracing side-effect import", () => {
    const source = `<script>
      let count = $state(0);
      $effect(() => { "svelte/internal/flags/tracing"; count; });
    </script>`;
    const sourceResult = instrument(source);
    const compiled = compileDevOutput(sourceResult.code);
    const result = instrumentCompiledSvelte(compiled.code, filename);
    if (!result) throw new Error("Expected compiled instrumentation");

    expect(result.code).not.toContain('import("svelte/internal/flags/tracing")');
  });

  it("does not bind module-script effects to a component-local identifier", () => {
    const source = `<script module>
      export function setup() {
        $effect(() => 'module helper');
      }
    </script>
    <script>
      setup();
      $effect(() => 'instance effect');
    </script>`;
    const sourceResult = instrument(source);
    const compiled = compileDevOutput(sourceResult.code);
    const result = instrumentCompiledSvelte(compiled.code, filename, {
      inputMap: JSON.stringify(compiled.map),
      displayFilename: "src/Counter.svelte",
    });
    if (!result) throw new Error("Expected compiled instrumentation");

    expect(compiled.code.match(/\$\.user_effect/g)).toHaveLength(2);
    expect(result.code.match(/registerEffect/g)).toHaveLength(1);
    const setupStart = result.code.indexOf("export function setup");
    const componentStart = result.code.indexOf("export default function Counter");
    expect(setupStart).toBeGreaterThan(-1);
    expect(componentStart).toBeGreaterThan(setupStart);
    expect(result.code.slice(setupStart, componentStart)).not.toContain("registerEffect");
  });

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
      "if (__svelte_lens_id_fixture != null) globalThis.__SVELTE_LENS__?.endComponent(__svelte_lens_id_fixture);",
    );
    expect(result.code).toContain("globalThis.__SVELTE_LENS__?.abortComponent?.(");
    expect(result.code.indexOf("?.endComponent(")).toBeLessThan(result.code.indexOf("$.pop();"));
  });

  it("never inserts lifecycle code into user text that resembles a runtime pop", () => {
    const compiled = `import * as $ from 'svelte/internal/client';
function Counter($$anchor, $$props) {
  $.push($$props, true, Counter);
  const __svelte_lens_id_fixture = globalThis.__SVELTE_LENS__?.beginComponent({}) ?? null;
  const text = \`before
$.pop(
after\`;
  console.log(text);
  $.pop();
}`;

    const result = instrumentCompiledSvelte(compiled, filename);
    if (!result) throw new Error("Expected compiled instrumentation");

    expect(result.code).toContain("const text = `before\n$.pop(\nafter`;");
    expect(result.code.match(/svelte-lens:end/g)).toHaveLength(1);
    expect(result.code.indexOf("svelte-lens:end")).toBeGreaterThan(result.code.indexOf("after`;"));
    expect(result.code.indexOf("?.endComponent(")).toBeLessThan(result.code.lastIndexOf("$.pop();"));
  });

  it("keeps component and effect coverage after a custom preprocessor owns the source syntax", () => {
    const plan = createSourceInstrumentationPlan(
      `<script lang="coffee">value = 1\n$effect -> value</script>`,
      { filename, displayFilename: "src/Counter.svelte" },
    );
    expect(plan).not.toBeNull();
    expect(plan?.bindings.inspected.size).toBe(0);
    const compiled = `import * as $ from 'svelte/internal/client';
export default function Counter($$anchor, $$props) {
  $.push($$props, true, Counter);
  $.user_effect(() => 1);
  $.pop();
}`;
    const result = instrumentCompiledSvelte(compiled, filename, { sourcePlan: plan });
    if (!result) throw new Error("Expected compiled instrumentation");

    expect(result.code).toContain("beginComponent");
    expect(result.code).toContain("registerEffect");
    expect(result.code).toContain("abortComponent?.(");
  });

  it("starts component tracking after the legacy constructor early return", () => {
    const source = `<script>let count = $state(0); $effect(() => count);</script><p>{count}</p>`;
    const plan = createSourceInstrumentationPlan(source, {
      filename,
      displayFilename: "src/Counter.svelte",
    });
    if (!plan) throw new Error("Expected a source instrumentation plan");
    const compiled = compile(source, {
      compatibility: { componentApi: 4 },
      dev: true,
      filename,
      generate: "client",
      rootDir: "/repo",
    }).js;
    const result = instrumentCompiledSvelte(compiled.code, filename, { sourcePlan: plan });
    if (!result) throw new Error("Expected compiled instrumentation");

    const constructorGuard = result.code.indexOf("if (new.target)");
    const push = result.code.indexOf("$.push(", constructorGuard);
    const declaration = result.code.indexOf(`let ${plan.identifier}=null`, push);
    const begin = result.code.indexOf("?.beginComponent(", declaration);
    expect(constructorGuard).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(constructorGuard);
    expect(declaration).toBeGreaterThan(push);
    expect(begin).toBeGreaterThan(declaration);
  });

  it("keeps compiler-optimized direct state read-only", () => {
    const source = `<script>
      let primitive = $state(0);
      let raw = $state.raw({ value: 1 });
    </script><p>{primitive}:{raw.value}</p>`;
    const plan = createSourceInstrumentationPlan(source, {
      filename,
      displayFilename: "src/Counter.svelte",
    });
    if (!plan) throw new Error("Expected a source instrumentation plan");
    const compiled = compileDevOutput(source);
    const result = instrumentCompiledSvelte(compiled.code, filename, { sourcePlan: plan });
    if (!result) throw new Error("Expected compiled instrumentation");

    expect(compiled.code).toContain("let primitive = 0");
    expect(compiled.code).toContain("let raw = { value: 1 }");
    expect(result.code).toContain('"primitive": { get: () => primitive }');
    expect(result.code).toContain('"raw": { get: () => raw }');
    expect(result.code).not.toMatch(/"primitive": \{[^}]*set:/);
    expect(result.code).not.toMatch(/"raw": \{[^}]*set:/);
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
  beforeEach(() => {
    vi.stubEnv("IN_PLAYWRIGHT", "false");
    vi.stubEnv("VITE_PLAYWRIGHT", "false");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns fail-closed development-server-only instrumentation plugins", () => {
    const plugins = svelteLens();
    expect(plugins.map((plugin) => plugin.name)).toEqual([
      "svelte-lens:instrument-source",
      "svelte-lens:instrument-compiled",
      "svelte-lens:instrument-rune-objects",
    ]);
    expect(plugins.map((plugin) => plugin.enforce)).toEqual(["pre", "post", "post"]);
    for (const plugin of plugins) {
      if (typeof plugin.apply !== "function") throw new Error("Expected an explicit environment gate");
      expect(plugin.apply({}, { command: "build", mode: "production" })).toBe(false);
      expect(plugin.apply({}, { command: "build", mode: "development" })).toBe(false);
      expect(plugin.apply({}, { command: "serve", mode: "production", isPreview: true })).toBe(false);
      expect(plugin.apply({}, { command: "serve", mode: "development" })).toBe(true);
    }
  });

  it("can be disabled", () => {
    expect(svelteLens({ enabled: false })).toEqual([]);
  });

  it.each(["IN_PLAYWRIGHT", "VITE_PLAYWRIGHT"])(
    "returns no plugins when %s is exactly true",
    (environmentVariable) => {
      vi.stubEnv(environmentVariable, "true");
      expect(svelteLens()).toEqual([]);
      expect(svelteLens({ enabled: true })).toEqual([]);
    },
  );

  it("stays inert if the Reintersect Playwright flag appears after Vite config resolution", async () => {
    const root = fileURLToPath(new URL("./fixtures", import.meta.url));
    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      plugins: [svelteLens(), svelte()],
      server: { middlewareMode: true },
    });

    try {
      vi.stubEnv("IN_PLAYWRIGHT", "true");
      const transformed = await server.transformRequest("/OneLine.svelte");
      expect(transformed?.code).not.toContain("__SVELTE_LENS__");
      expect(transformed?.code).not.toContain("__svelte_lens_");
      expect(transformed?.code).not.toContain("svelte/internal/flags/tracing");
    } finally {
      await server.close();
    }
  });

  it("does not infer Playwright from CI or non-exact flag values", () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("IN_PLAYWRIGHT", "1");
    vi.stubEnv("VITE_PLAYWRIGHT", "TRUE");
    expect(svelteLens()).toHaveLength(3);
  });

  it.each(["production", "development"])(
    "never emits Lens instrumentation during a real Vite build in %s mode",
    async (mode) => {
      const root = fileURLToPath(new URL("./fixtures/production", import.meta.url));
      const result = await build({
        root,
        mode,
        configFile: false,
        logLevel: "silent",
        plugins: [svelteLens(), svelte()],
        build: {
          write: false,
          minify: false,
        },
      });

      if (!Array.isArray(result) && !("output" in result)) {
        throw new Error("Expected an in-memory Vite build output");
      }
      const builds = Array.isArray(result) ? result : [result];
      const javascript = builds
        .flatMap((output) => {
          if (!("output" in output)) throw new Error("Unexpected Vite watcher result");
          return output.output;
        })
        .filter((output) => output.type === "chunk")
        .map((output) => output.code)
        .join("\n");

      expect(javascript.length).toBeGreaterThan(0);
      expect(javascript).toContain("Count ");
      for (const forbidden of [
        "svelte-lens",
        "__SVELTE_LENS__",
        "__svelte_lens_",
        "svelte-lens:component",
        "svelte-lens:end",
        "svelte-lens:runtime",
        "svelte-lens:rune-object",
        "svelte/internal/flags/tracing",
        "beginComponent({name:",
        ".registerEffect?.(",
        ".registerRuneObject?.(",
        ".installRuntime?.(",
      ]) {
        expect(javascript, `production output contained ${forbidden}`).not.toContain(forbidden);
      }
    },
  );

  it("preserves original Svelte locations through a real Vite transform", async () => {
    const root = fileURLToPath(new URL("../../../examples/playground", import.meta.url));
    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      plugins: [svelteLens(), svelte()],
      server: { middlewareMode: true },
    });

    try {
      const transformed = await server.transformRequest("/src/Counter.svelte");
      if (!transformed?.map) throw new Error("Expected a transformed Counter source map");
      const map = new TraceMap(JSON.stringify(transformed.map));
      const effect = originalPositionFor(map, generatedPosition(transformed.code, "$.user_effect"));
      const body = originalPositionFor(map, generatedPosition(transformed.code, "const pulse"));

      expect(effect.source).toMatch(/Counter\.svelte$/);
      expect(effect).toMatchObject({ line: 13, column: 2 });
      expect(body.source).toMatch(/Counter\.svelte$/);
      expect(body).toMatchObject({ line: 14, column: 4 });
      expect(transformed.code).toContain("?.canReplaceStateInPlace?.(effectProbe)");
      expect(transformed.code).toContain("?.replaceStateInPlace?.(effectProbe, value)");
      expect(transformed.code).not.toContain("effectProbe = $.proxy(value)");
      expect(transformed.code).toContain('"label": $$props["label"]');
      expect(transformed.code).toContain('"accent": $$props["accent"]');
      expect(transformed.code).toMatch(/import \{ onDestroy as __svelte_lens_on_destroy_/);
      expect(transformed.code).not.toContain("$.teardown(");
      const beginIndex = transformed.code.indexOf("?.beginComponent(");
      const guardIndex = transformed.code.lastIndexOf("try {", beginIndex);
      const idDeclarationIndex = transformed.code.lastIndexOf("let __svelte_lens_id_", beginIndex);
      const stateDeclarationIndex = transformed.code.indexOf("let effectProbe", beginIndex);
      expect(idDeclarationIndex).toBeGreaterThan(-1);
      expect(idDeclarationIndex).toBeLessThan(guardIndex);
      expect(guardIndex).toBeLessThan(beginIndex);
      expect(beginIndex).toBeLessThan(stateDeclarationIndex);
    } finally {
      await server.close();
    }
  });

  it("preserves one-line script, effect, block, and DOM locations", async () => {
    const root = fileURLToPath(new URL("./fixtures", import.meta.url));
    const source = readFileSync(new URL("./fixtures/OneLine.svelte", import.meta.url), "utf8");
    const effectColumn = source.indexOf("$effect");
    const ifColumn = source.indexOf("{#if");
    const buttonColumn = source.indexOf("<button");
    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      plugins: [svelteLens(), svelte()],
      server: { middlewareMode: true },
    });

    try {
      const transformed = await server.transformRequest("/OneLine.svelte");
      if (!transformed?.map) throw new Error("Expected a transformed one-line source map");
      const map = new TraceMap(JSON.stringify(transformed.map));
      const effect = originalPositionFor(map, generatedPosition(transformed.code, "$.user_effect"));

      expect(effect.source).toMatch(/OneLine\.svelte$/);
      expect(effect).toMatchObject({ line: 1, column: effectColumn });
      expect(transformed.code).toContain(`\"line\":1,\"column\":${effectColumn}`);
      expect(transformed.code).toMatch(
        new RegExp(`[\"']if[\"'][\\s\\S]*?OneLine,\\s*1,\\s*${ifColumn}\\s*(?:,|\\))`),
      );
      expect(transformed.code).toMatch(
        new RegExp(`add_locations\\([\\s\\S]*?\\[\\s*\\[\\s*1,\\s*${buttonColumn}(?:,|\\])`),
      );
    } finally {
      await server.close();
    }
  });

  it("keeps lifecycle instrumentation outside a trailing source comment", async () => {
    const root = fileURLToPath(new URL("./fixtures", import.meta.url));
    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      plugins: [svelteLens(), svelte()],
      server: { middlewareMode: true },
    });

    try {
      const transformed = await server.transformRequest("/TrailingComment.svelte");
      expect(transformed?.code).toContain("beginComponent");
      expect(transformed?.code).toContain("updateComponent");
      expect(transformed?.code).toContain("unregisterComponent");
      expect(transformed?.code).toContain("endComponent");
    } finally {
      await server.close();
    }
  });

  it("keeps module helpers free of component-local effect descriptors in Vite", async () => {
    const root = fileURLToPath(new URL("./fixtures", import.meta.url));
    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      plugins: [svelteLens(), svelte()],
      server: { middlewareMode: true },
    });

    try {
      const transformed = await server.transformRequest("/ModuleEffect.svelte");
      expect(transformed?.code.match(/\$\.user_effect/g)).toHaveLength(2);
      expect(transformed?.code.match(/registerEffect/g)).toHaveLength(1);
      const setupStart = transformed?.code.indexOf("function setup") ?? -1;
      const componentStart = transformed?.code.indexOf("function ModuleEffect") ?? -1;
      expect(setupStart).toBeGreaterThan(-1);
      expect(componentStart).toBeGreaterThan(setupStart);
      expect(transformed?.code.slice(setupStart, componentStart)).not.toContain("registerEffect");
    } finally {
      await server.close();
    }
  });

  it("instruments components whose store cleanup saves pop into a temporary", async () => {
    const root = fileURLToPath(new URL("./fixtures", import.meta.url));
    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      plugins: [svelteLens(), svelte()],
      server: { middlewareMode: true },
    });

    try {
      const transformed = await server.transformRequest("/StoreEffect.svelte");
      if (!transformed) throw new Error("Expected a transformed store component");
      const end = transformed.code.indexOf("?.endComponent(");
      const pop = transformed.code.indexOf("$.pop(", end);
      const cleanup = transformed.code.indexOf("$$cleanup()", pop);
      const catchGuard = transformed.code.indexOf("catch (__svelte_lens_error)", cleanup);
      expect(transformed.code).toContain("beginComponent");
      expect(transformed.code).toContain("registerEffect");
      expect(end).toBeGreaterThan(-1);
      expect(pop).toBeGreaterThan(end);
      expect(cleanup).toBeGreaterThan(pop);
      expect(catchGuard).toBeGreaterThan(cleanup);
    } finally {
      await server.close();
    }
  });

  it("preserves normal and raw state replacement semantics", async () => {
    const root = fileURLToPath(new URL("./fixtures", import.meta.url));
    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      plugins: [svelteLens(), svelte()],
      server: { middlewareMode: true },
    });

    try {
      const transformed = await server.transformRequest("/StateKinds.svelte");
      expect(transformed?.code).toMatch(/set:\s*\(value\)\s*=>\s*\{\s*\$\.set\(deep, value, true\);\s*\}/);
      expect(transformed?.code).toMatch(/set:\s*\(value\)\s*=>\s*\{\s*\$\.set\(raw, value\);\s*\}/);
      expect(transformed?.code).not.toContain("$.set(raw, value, true)");
    } finally {
      await server.close();
    }
  });
});
