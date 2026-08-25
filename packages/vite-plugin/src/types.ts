export type SvelteLensUpdatePhase = "init" | "update";

export interface SvelteLensStateAdapter {
  get: () => unknown;
  canSet?: () => boolean;
  set?: (value: unknown) => void;
}

export interface SvelteLensDerivedAdapter {
  get: () => unknown;
}

export interface SvelteLensComponentDescriptor {
  name: string;
  file: string;
  props: () => Record<string, unknown>;
  state: Record<string, SvelteLensStateAdapter>;
  derived: Record<string, SvelteLensDerivedAdapter>;
}

export type SvelteLensEffectKind = "effect" | "pre";

export interface SvelteLensEffectDescriptor {
  siteId: string;
  componentId: string | null;
  kind: SvelteLensEffectKind;
  source: {
    file: string;
    line: number;
    column: number;
  };
}

export interface SvelteLensRuntimeAdapter {
  activeEffect: unknown;
  untrack: <Value>(read: () => Value) => Value;
  enableTracing?: () => unknown;
}

export type SvelteLensRuntimeResolver = () => SvelteLensRuntimeAdapter | null;

export interface SvelteLensPageApi {
  beginComponent: (descriptor: SvelteLensComponentDescriptor) => string | null;
  endComponent: (id: string) => void;
  updateComponent: (id: string, phase?: SvelteLensUpdatePhase) => void;
  unregisterComponent: (id: string) => void;
  abortComponent: (id: string, error?: unknown) => void;
  canReplaceStateInPlace: (value: unknown) => boolean;
  replaceStateInPlace: (target: unknown, replacement: unknown) => void;
  installRuntime: (resolve: SvelteLensRuntimeResolver) => void;
  registerEffect: <Callback>(
    descriptor: SvelteLensEffectDescriptor,
    callback: Callback,
  ) => Callback;
}

export interface SvelteLensOptions {
  /** Enable instrumentation. The plugin is otherwise active only for Vite's dev server. */
  enabled?: boolean;
}
