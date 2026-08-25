export type SvelteLensUpdatePhase = "init" | "update";

export interface SvelteLensStateAdapter {
  get: () => unknown;
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

export interface SvelteLensPageApi {
  beginComponent: (descriptor: SvelteLensComponentDescriptor) => string | null;
  endComponent: (id: string) => void;
  updateComponent: (id: string, phase?: SvelteLensUpdatePhase) => void;
  unregisterComponent: (id: string) => void;
}

export interface SvelteLensOptions {
  /** Enable instrumentation. The plugin is otherwise active only for Vite's dev server. */
  enabled?: boolean;
}
