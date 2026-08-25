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

export type SvelteLensRuneFieldKind = "state" | "derived";

export interface SvelteLensRuneFieldAdapter {
  kind: SvelteLensRuneFieldKind;
  source: {
    file: string;
    line: number;
    column: number;
  };
  /** Reads a compiler-known rune signal from the supplied instance. */
  get: (target: object) => unknown;
}

export interface SvelteLensRuneObjectDescriptor {
  name: string;
  file: string;
  source: {
    file: string;
    line: number;
    column: number;
  };
  fields: Record<string, SvelteLensRuneFieldAdapter>;
  totalFields: number;
  truncated: boolean;
}

export interface SvelteLensRuntimeAdapter {
  activeEffect: unknown;
  untrack: <Value>(read: () => Value) => Value;
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
  registerRuneObject: (
    target: object,
    descriptor: SvelteLensRuneObjectDescriptor,
  ) => string | null;
}

export interface SvelteLensOptions {
  /** Enable instrumentation. The plugin is otherwise active only for Vite's dev server. */
  enabled?: boolean;
}
