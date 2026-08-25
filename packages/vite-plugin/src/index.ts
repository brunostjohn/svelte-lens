import path from "node:path";

import type { Plugin } from "vite";

import {
  createSourceInstrumentationPlan,
  instrumentCompiledSvelte,
  type SourceInstrumentationPlan,
} from "./instrument.js";
import { instrumentCompiledSvelteModule } from "./rune-objects.js";
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
  SvelteLensRuneFieldAdapter,
  SvelteLensRuneFieldKind,
  SvelteLensRuneObjectDescriptor,
  SvelteLensStateAdapter,
  SvelteLensUpdatePhase,
} from "./types.js";

export { instrumentCompiledSvelte, instrumentSvelteSource } from "./instrument.js";
export { instrumentCompiledSvelteModule } from "./rune-objects.js";
export type {
  CompiledInstrumentationOptions,
  InstrumentationResult,
  SourceInstrumentationOptions,
} from "./instrument.js";
export type {
  RuneObjectInstrumentationOptions,
  RuneObjectInstrumentationResult,
} from "./rune-objects.js";

function cleanId(id: string): string {
  return id.split("?", 1)[0] ?? id;
}

function normalizePath(filename: string): string {
  return filename.replaceAll(path.sep, "/");
}

function isSvelteComponent(id: string): boolean {
  return !id.includes("?") && cleanId(id).endsWith(".svelte") && !normalizePath(id).includes("/node_modules/");
}

function isSvelteRuneModule(id: string): boolean {
  const normalized = normalizePath(id);
  return (
    !id.includes("?") &&
    /\.svelte(?:\.[^/]+)*\.[cm]?[jt]s$/.test(cleanId(normalized)) &&
    !normalized.includes("/node_modules/")
  );
}

function isPlaywrightEnvironment(): boolean {
  return process.env.IN_PLAYWRIGHT === "true" || process.env.VITE_PLAYWRIGHT === "true";
}

export function svelteLens(options: SvelteLensOptions = {}): Plugin[] {
  if (options.enabled === false || isPlaywrightEnvironment()) return [];

  let root = process.cwd();
  // Fail closed: transforms are inert until Vite has positively identified a
  // development-server invocation. `apply` is the primary Vite boundary; the
  // transform guards below are an independent backstop if a hook is invoked by
  // another plugin runner or a future Vite lifecycle changes unexpectedly.
  let developmentServerActive = false;
  const sourcePlans = new Map<string, SourceInstrumentationPlan>();
  const applyToDevelopmentServer: NonNullable<Plugin["apply"]> = (_config, environment) => {
    developmentServerActive =
      !isPlaywrightEnvironment() && environment.command === "serve" && environment.isPreview !== true;
    if (!developmentServerActive) sourcePlans.clear();
    return developmentServerActive;
  };

  const sourcePlugin: Plugin = {
    name: "svelte-lens:instrument-source",
    enforce: "pre",
    apply: applyToDevelopmentServer,
    configResolved(config) {
      developmentServerActive =
        developmentServerActive && !isPlaywrightEnvironment() && config.command === "serve";
      if (!developmentServerActive) sourcePlans.clear();
      root = config.root;
    },
    transform(code, id, transformOptions) {
      if (isPlaywrightEnvironment()) {
        developmentServerActive = false;
        sourcePlans.clear();
        return null;
      }
      if (!developmentServerActive || transformOptions?.ssr || !isSvelteComponent(id)) return null;
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
    apply: applyToDevelopmentServer,
    configResolved(config) {
      developmentServerActive =
        developmentServerActive && !isPlaywrightEnvironment() && config.command === "serve";
      if (!developmentServerActive) sourcePlans.clear();
      root = config.root;
    },
    transform(code, id, transformOptions) {
      if (isPlaywrightEnvironment()) {
        developmentServerActive = false;
        sourcePlans.clear();
        return null;
      }
      if (!developmentServerActive || transformOptions?.ssr || !isSvelteComponent(id)) return null;
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

  const runeObjectPlugin: Plugin = {
    name: "svelte-lens:instrument-rune-objects",
    enforce: "post",
    apply: applyToDevelopmentServer,
    configResolved(config) {
      developmentServerActive =
        developmentServerActive && !isPlaywrightEnvironment() && config.command === "serve";
      if (!developmentServerActive) sourcePlans.clear();
      root = config.root;
    },
    transform: {
      // Svelte's rune-module compiler is also a post transform. Running this
      // hook last makes plugin-list order irrelevant; the adapter recognizes
      // both the package specifier and Vite's already-rewritten dev URL.
      order: "post",
      handler(code, id, transformOptions) {
        if (isPlaywrightEnvironment()) {
          developmentServerActive = false;
          sourcePlans.clear();
          return null;
        }
        if (!developmentServerActive || transformOptions?.ssr || !isSvelteRuneModule(id)) return null;
        const filename = cleanId(id);
        const relative = path.relative(root, filename);
        const displayFilename = relative.startsWith("..") ? filename : relative;
        return instrumentCompiledSvelteModule(code, filename, {
          inputMap: JSON.stringify(this.getCombinedSourcemap()),
          displayFilename: normalizePath(displayFilename),
        });
      },
    },
  };

  return [sourcePlugin, compiledPlugin, runeObjectPlugin];
}

export default svelteLens;
