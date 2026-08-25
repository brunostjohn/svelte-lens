import path from "node:path";

import type { Plugin } from "vite";

import {
  createSourceInstrumentationPlan,
  instrumentCompiledSvelte,
  type SourceInstrumentationPlan,
} from "./instrument.js";
import type { SvelteLensOptions } from "./types.js";

export type {
  SvelteLensComponentDescriptor,
  SvelteLensDerivedAdapter,
  SvelteLensEffectDescriptor,
  SvelteLensEffectKind,
  SvelteLensOptions,
  SvelteLensPageApi,
  SvelteLensRuntimeAdapter,
  SvelteLensRuntimeResolver,
  SvelteLensStateAdapter,
  SvelteLensUpdatePhase,
} from "./types.js";

export { instrumentCompiledSvelte, instrumentSvelteSource } from "./instrument.js";
export type {
  CompiledInstrumentationOptions,
  InstrumentationResult,
  SourceInstrumentationOptions,
} from "./instrument.js";

function cleanId(id: string): string {
  return id.split("?", 1)[0] ?? id;
}

function normalizePath(filename: string): string {
  return filename.replaceAll(path.sep, "/");
}

function isSvelteComponent(id: string): boolean {
  return !id.includes("?") && cleanId(id).endsWith(".svelte") && !normalizePath(id).includes("/node_modules/");
}

export function svelteLens(options: SvelteLensOptions = {}): Plugin[] {
  if (options.enabled === false) return [];

  let root = process.cwd();
  const sourcePlans = new Map<string, SourceInstrumentationPlan>();

  const sourcePlugin: Plugin = {
    name: "svelte-lens:instrument-source",
    enforce: "pre",
    apply: "serve",
    configResolved(config) {
      root = config.root;
    },
    transform(code, id, transformOptions) {
      if (transformOptions?.ssr || !isSvelteComponent(id)) return null;
      const filename = cleanId(id);
      const relative = path.relative(root, filename);
      const displayFilename = relative.startsWith("..") ? filename : relative;
      const plan = createSourceInstrumentationPlan(code, {
        filename,
        displayFilename: normalizePath(displayFilename),
      });
      if (plan) sourcePlans.set(filename, plan);
      else sourcePlans.delete(filename);
      // Keep Svelte's input byte-for-byte intact. The post pass uses this plan
      // against the compiled output, preserving compiler locations and maps.
      return null;
    },
  };

  const compiledPlugin: Plugin = {
    name: "svelte-lens:instrument-compiled",
    enforce: "post",
    apply: "serve",
    transform(code, id, transformOptions) {
      if (transformOptions?.ssr || !isSvelteComponent(id)) return null;
      const filename = cleanId(id);
      const relative = path.relative(root, filename);
      const displayFilename = relative.startsWith("..") ? filename : relative;
      return instrumentCompiledSvelte(code, filename, {
        inputMap: JSON.stringify(this.getCombinedSourcemap()),
        sourcePlan: sourcePlans.get(filename),
        displayFilename: normalizePath(displayFilename),
      });
    },
  };

  return [sourcePlugin, compiledPlugin];
}

export default svelteLens;
