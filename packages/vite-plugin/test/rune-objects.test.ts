import { compileModule } from "svelte/compiler";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { describe, expect, it } from "vitest";

import { svelteLens } from "../src/index.js";
import {
  MAX_RUNE_FIELDS_PER_CLASS,
  RUNE_OBJECT_MARKER,
  instrumentCompiledSvelteModule,
} from "../src/rune-objects.js";

function compile(source: string, filename = "src/model.svelte.js") {
  return compileModule(source, {
    dev: true,
    filename,
    generate: "client",
  }).js;
}

describe("rune object instrumentation", () => {
  it("registers source-known public, private, constructor, and derived rune fields lazily", () => {
    const source = `export class Model {
  count = $state(1);
  #secret = $state('hidden');
  doubled = $derived(this.count * 2);
  get explosive() { throw new Error('must not run'); }

  constructor(label) {
    this.label = $state(label);
  }
}`;
    const compiled = compile(source);
    const result = instrumentCompiledSvelteModule(compiled.code, "src/model.svelte.js", {
      displayFilename: "src/model.svelte.js",
      inputMap: JSON.stringify(compiled.map),
    });

    expect(result).not.toBeNull();
    expect(result?.code).toContain(RUNE_OBJECT_MARKER);
    expect(result?.code).toContain('"count":{kind:"state",source:{"file":"src/model.svelte.js","line":2');
    expect(result?.code).toContain('"#secret":{kind:"state"');
    expect(result?.code).toContain('"doubled":{kind:"derived"');
    expect(result?.code).toContain('"label":{kind:"state"');
    expect(result?.code).not.toContain("Object.getPrototypeOf");
    expect(result?.code).not.toContain("Object.getOwnPropertyNames");
    expect(instrumentCompiledSvelteModule(result?.code ?? "", "src/model.svelte.js")).toBeNull();

    const registered: Array<{ target: object; descriptor: RuneDescriptor }> = [];
    const previousHook = (globalThis as { __SVELTE_LENS__?: unknown }).__SVELTE_LENS__;
    (globalThis as { __SVELTE_LENS__?: unknown }).__SVELTE_LENS__ = {
      registerRuneObject(target: object, descriptor: RuneDescriptor) {
        registered.push({ target, descriptor });
        return "rune:1";
      },
    };

    try {
      const executable = (result?.code ?? "")
        .replace(
          /import \* as ([A-Za-z_$][\w$]*) from 'svelte\/internal\/client';/,
          `const $1 = {
            state: (value) => ({ value }),
            proxy: (value) => value,
            tag: (value) => value,
            derived: (read) => ({ read }),
            get: (signal) => 'read' in signal ? signal.read() : signal.value,
            set: (signal, value) => { signal.value = value; }
          };`,
        )
        .replace("export class Model", "class Model")
        .concat("\nreturn Model;");
      const Model = new Function(executable)() as new (label: string) => object;
      const instance = new Model("named");
      expect(registered).toHaveLength(1);
      const registration = registered[0];
      expect(registration?.target).toBe(instance);
      expect(registration?.descriptor).toMatchObject({
        name: "Model",
        file: "src/model.svelte.js",
        totalFields: 4,
        truncated: false,
      });
      expect(Object.keys(registration?.descriptor.fields ?? {})).toEqual([
        "count",
        "#secret",
        "doubled",
        "label",
      ]);
      expect(registration?.descriptor.fields.count?.get(instance)).toBe(1);
      expect(registration?.descriptor.fields["#secret"]?.get(instance)).toBe("hidden");
      expect(registration?.descriptor.fields.label?.get(instance)).toBe("named");
      expect(registration?.descriptor.fields.doubled?.get(instance)).toBe(2);
    } finally {
      (globalThis as { __SVELTE_LENS__?: unknown }).__SVELTE_LENS__ = previousHook;
    }
  });

  it("ignores ordinary and anonymous classes and caps generated adapters", () => {
    const fields = Array.from(
      { length: MAX_RUNE_FIELDS_PER_CLASS + 6 },
      (_, index) => `field${index} = $state(${index});`,
    ).join("\n");
    const compiled = compile(`
      class Plain { value = 1; }
      export default class { hidden = $state(1); }
      export class Large { ${fields} }
    `);
    const result = instrumentCompiledSvelteModule(compiled.code, "src/model.svelte.js", {
      inputMap: JSON.stringify(compiled.map),
    });

    expect(result).not.toBeNull();
    expect(result?.code.match(/registerRuneObject/g)).toHaveLength(1);
    expect(result?.code).toContain(`totalFields:${MAX_RUNE_FIELDS_PER_CLASS + 6},truncated:true`);
    expect(result?.code.match(/kind:"state"/g)).toHaveLength(MAX_RUNE_FIELDS_PER_CLASS);
  });

  it("does nothing for non-Svelte compiled modules or malformed input", () => {
    expect(instrumentCompiledSvelteModule("export class Plain {}", "plain.js")).toBeNull();
    expect(
      instrumentCompiledSvelteModule(
        "import * as $ from 'svelte/internal/client'; export class Broken {",
        "broken.svelte.js",
      ),
    ).toBeNull();
  });

  it.each(["lens-first", "svelte-first"] as const)(
    "runs after Svelte's real .svelte.ts module compiler in the dev server (%s)",
    async (order) => {
    const root = fileURLToPath(new URL("./fixtures", import.meta.url));
    const lens = svelteLens();
    const sveltePlugins = svelte();
    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      plugins: order === "lens-first" ? [lens, sveltePlugins] : [sveltePlugins, lens],
      server: { middlewareMode: true },
    });

    try {
      const transformed = await server.transformRequest("/RuneModel.svelte.ts");
      expect(transformed?.code).toContain(RUNE_OBJECT_MARKER);
      expect(transformed?.code).toContain("registerRuneObject");
      expect(transformed?.code).toContain('name:"RuneModel"');
      expect(transformed?.code).toContain('"#secret":{kind:"state"');
      expect(transformed?.code).toContain('"doubled":{kind:"derived"');
      expect(transformed?.code).toContain('"line":2');
    } finally {
      await server.close();
    }
    },
  );

  it("keeps rune modules inert when the Playwright flag appears after server setup", async () => {
    const previous = process.env.IN_PLAYWRIGHT;
    process.env.IN_PLAYWRIGHT = "false";
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
      process.env.IN_PLAYWRIGHT = "true";
      const transformed = await server.transformRequest("/RuneModel.svelte.ts");
      expect(transformed?.code).not.toContain(RUNE_OBJECT_MARKER);
      expect(transformed?.code).not.toContain("registerRuneObject");
      expect(transformed?.code).not.toContain("__SVELTE_LENS__");
    } finally {
      await server.close();
      if (previous === undefined) delete process.env.IN_PLAYWRIGHT;
      else process.env.IN_PLAYWRIGHT = previous;
    }
  });
});

interface RuneDescriptor {
  name: string;
  file: string;
  source: { file: string; line: number; column: number };
  fields: Record<
    string,
    {
      kind: "state" | "derived";
      source: { file: string; line: number; column: number };
      get: (target: object) => unknown;
    }
  >;
  totalFields: number;
  truncated: boolean;
}
