import path from "node:path";

import type { Plugin } from "vite";

import { instrumentCompiledSvelte, instrumentSvelteSource } from "./instrument.js";
import type { SvelteLensOptions } from "./types.js";

export type {
  SvelteLensComponentDescriptor,
  SvelteLensDerivedAdapter,
  SvelteLensOptions,
  SvelteLensPageApi,
  SvelteLensStateAdapter,
  SvelteLensUpdatePhase,
} from "./types.js";

export { instrumentCompiledSvelte, instrumentSvelteSource } from "./instrument.js";

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
      return instrumentSvelteSource(code, {
        filename,
        displayFilename: normalizePath(displayFilename),
      });
    },
  };

  const compiledPlugin: Plugin = {
    name: "svelte-lens:instrument-compiled",
    enforce: "post",
    apply: "serve",
    transform(code, id, transformOptions) {
      if (transformOptions?.ssr || !isSvelteComponent(id)) return null;
      return instrumentCompiledSvelte(code, cleanId(id));
    },
  };

  return [sourcePlugin, compiledPlugin];
}

export default svelteLens;
