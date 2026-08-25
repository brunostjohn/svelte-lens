import path from "node:path";

import { originalPositionFor, TraceMap, type SourceMapInput } from "@jridgewell/trace-mapping";
import { parse as parseJavaScript } from "acorn";
import MagicString from "magic-string";
import { parse } from "svelte/compiler";

const SOURCE_MARKER = "/* svelte-lens:component */";
const END_MARKER = "/* svelte-lens:end */";
const RUNTIME_MARKER = "/* svelte-lens:runtime */";

type AstNode = {
  type: string;
  start?: number;
  end?: number;
  [key: string]: unknown;
};

type JsNode = {
  type: string;
  start: number;
  end: number;
  loc?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  } | null;
  [key: string]: unknown;
};

type VariableDeclaration = AstNode & {
  declarations: VariableDeclarator[];
  kind: "const" | "let" | "var";
};

type VariableDeclarator = AstNode & {
  id: AstNode;
  init?: AstNode | null;
};

export type PropPart =
  | { kind: "entry"; key: string; local: string }
  | { kind: "spread"; local: string };

export type ComponentBindings = {
  props: PropPart[];
  state: Map<string, { raw: boolean; writable: boolean }>;
  derived: Set<string>;
  inspected: Set<string>;
};

export interface SourceInstrumentationPlan {
  bindings: ComponentBindings;
  componentName: string;
  displayFilename: string;
  identifier: string;
  onDestroyIdentifier: string;
}

export interface InstrumentationResult {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
}

export interface SourceInstrumentationOptions {
  filename: string;
  displayFilename?: string;
}

export interface CompiledInstrumentationOptions {
  inputMap?: SourceMapInput | null;
  displayFilename?: string;
  sourcePlan?: SourceInstrumentationPlan | null;
}

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && "type" in value;
}

function unwrapExpression(node: AstNode | null | undefined): AstNode | null {
  let current = node ?? null;

  while (
    current &&
    (current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "TSNonNullExpression" ||
      current.type === "TypeCastExpression" ||
      current.type === "ChainExpression")
  ) {
    current = isNode(current.expression) ? current.expression : null;
  }

  return current;
}

function runeName(node: AstNode | null | undefined): string | null {
  const expression = unwrapExpression(node);
  if (!expression || expression.type !== "CallExpression") return null;

  const callee = unwrapExpression(isNode(expression.callee) ? expression.callee : null);
  if (!callee) return null;

  if (callee.type === "Identifier" && typeof callee.name === "string") {
    if (callee.name === "$props" || callee.name === "$state" || callee.name === "$derived") {
      return callee.name;
    }
    return null;
  }

  if (callee.type !== "MemberExpression" || callee.computed === true) return null;
  const object = unwrapExpression(isNode(callee.object) ? callee.object : null);
  const property = isNode(callee.property) ? callee.property : null;
  if (!object || object.type !== "Identifier" || typeof object.name !== "string") return null;
  if (!property || property.type !== "Identifier" || typeof property.name !== "string") return null;

  if (object.name === "$state" && property.name === "raw") return "$state.raw";
  if (object.name === "$derived" && property.name === "by") return "$derived.by";
  return null;
}

function staticPropertyName(node: AstNode): string | null {
  if (node.type === "Identifier" && typeof node.name === "string") return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number")) {
    return String(node.value);
  }
  return null;
}

function collectBindingNames(pattern: AstNode | null | undefined, names: string[] = []): string[] {
  if (!pattern) return names;

  switch (pattern.type) {
    case "Identifier":
      if (typeof pattern.name === "string") names.push(pattern.name);
      break;
    case "AssignmentPattern":
      if (isNode(pattern.left)) collectBindingNames(pattern.left, names);
      break;
    case "RestElement":
      if (isNode(pattern.argument)) collectBindingNames(pattern.argument, names);
      break;
    case "ArrayPattern":
      if (Array.isArray(pattern.elements)) {
        for (const element of pattern.elements) {
          if (isNode(element)) collectBindingNames(element, names);
        }
      }
      break;
    case "ObjectPattern":
      if (Array.isArray(pattern.properties)) {
        for (const property of pattern.properties) {
          if (!isNode(property)) continue;
          if (property.type === "Property" && isNode(property.value)) {
            collectBindingNames(property.value, names);
          } else if (property.type === "RestElement" && isNode(property.argument)) {
            collectBindingNames(property.argument, names);
          }
        }
      }
      break;
  }

  return names;
}

function collectPropParts(pattern: AstNode): PropPart[] {
  if (pattern.type === "Identifier" && typeof pattern.name === "string") {
    return [{ kind: "spread", local: pattern.name }];
  }

  if (pattern.type !== "ObjectPattern" || !Array.isArray(pattern.properties)) {
    return collectBindingNames(pattern).map((local) => ({ kind: "entry", key: local, local }));
  }

  const parts: PropPart[] = [];
  for (const property of pattern.properties) {
    if (!isNode(property)) continue;

    if (property.type === "RestElement" && isNode(property.argument)) {
      for (const local of collectBindingNames(property.argument)) {
        parts.push({ kind: "spread", local });
      }
      continue;
    }

    if (property.type !== "Property" || !isNode(property.value)) continue;
    const key = isNode(property.key) ? staticPropertyName(property.key) : null;
    const locals = collectBindingNames(property.value);
    for (const local of locals) {
      parts.push({ kind: "entry", key: key ?? local, local });
    }
  }

  return parts;
}

function addPropParts(bindings: ComponentBindings, parts: PropPart[], inspect = true): void {
  for (const part of parts) {
    const key = part.kind === "entry" ? `${part.kind}:${part.key}:${part.local}` : `${part.kind}:${part.local}`;
    const exists = bindings.props.some((candidate) => {
      const candidateKey =
        candidate.kind === "entry"
          ? `${candidate.kind}:${candidate.key}:${candidate.local}`
          : `${candidate.kind}:${candidate.local}`;
      return candidateKey === key;
    });
    if (!exists) bindings.props.push(part);
    if (inspect) bindings.inspected.add(part.local);
  }
}

function processDeclaration(
  declaration: VariableDeclaration,
  bindings: ComponentBindings,
  legacyExport = false,
): void {
  for (const declarator of declaration.declarations) {
    if (!isNode(declarator.id)) continue;

    if (legacyExport) {
      addPropParts(
        bindings,
        collectBindingNames(declarator.id).map((local) => ({
          kind: "entry",
          key: local,
          local,
        })),
        false,
      );
    }

    const rune = runeName(declarator.init);
    if (rune === "$props") {
      addPropParts(bindings, collectPropParts(declarator.id));
      continue;
    }

    const names = collectBindingNames(declarator.id);
    if (rune === "$state" || rune === "$state.raw") {
      for (const name of names) {
        bindings.state.set(name, {
          raw: rune === "$state.raw",
          writable: declaration.kind !== "const",
        });
        bindings.inspected.add(name);
      }
    } else if (rune === "$derived" || rune === "$derived.by") {
      for (const name of names) {
        bindings.derived.add(name);
        bindings.inspected.add(name);
      }
    }
  }
}

function collectComponentBindings(program: AstNode): ComponentBindings {
  const bindings: ComponentBindings = {
    props: [],
    state: new Map(),
    derived: new Set(),
    inspected: new Set(),
  };

  const body = Array.isArray(program.body) ? program.body : [];
  for (const statement of body) {
    if (!isNode(statement)) continue;

    if (statement.type === "VariableDeclaration" && Array.isArray(statement.declarations)) {
      processDeclaration(statement as VariableDeclaration, bindings);
      continue;
    }

    if (
      statement.type === "ExportNamedDeclaration" &&
      isNode(statement.declaration) &&
      statement.declaration.type === "VariableDeclaration" &&
      Array.isArray(statement.declaration.declarations)
    ) {
      processDeclaration(statement.declaration as VariableDeclaration, bindings, true);
    }
  }

  return bindings;
}

type EffectKind = "effect" | "pre";

function sanitizeComponentName(filename: string): string {
  const base = path.basename(filename).replace(/\.svelte$/i, "").replace(/^\+/, "");
  const words = base.split(/[^A-Za-z0-9_$]+/).filter(Boolean);
  let name = words.map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`).join("");
  if (!name) name = "Component";
  if (!/^[A-Za-z_$]/.test(name)) name = `_${name}`;
  return name;
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function uniqueIdentifier(base: string, source: string, reserved: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  const identifierPattern = (name: string) => new RegExp(`(^|[^\\w$])${name.replace(/[$]/g, "\\$")}([^\\w$]|$)`);

  while (reserved.has(candidate) || identifierPattern(candidate).test(source)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  reserved.add(candidate);
  return candidate;
}

function renderProps(parts: PropPart[]): string {
  if (parts.length === 0) return "{}";
  const fields = parts.map((part) =>
    part.kind === "spread" ? `...${part.local}` : `${JSON.stringify(part.key)}: ${part.local}`,
  );
  return `{ ${fields.join(", ")} }`;
}

function renderState(state: ComponentBindings["state"]): string {
  if (state.size === 0) return "{}";
  const entries = [...state].map(([name, binding]) => {
    const setter = binding.writable ? `, set: (value) => { ${name} = value; }` : "";
    return `${JSON.stringify(name)}: { get: () => ${name}${setter} }`;
  });
  return `{ ${entries.join(", ")} }`;
}

function renderDerived(derived: Set<string>): string {
  if (derived.size === 0) return "{}";
  const entries = [...derived].map((name) => `${JSON.stringify(name)}: { get: () => ${name} }`);
  return `{ ${entries.join(", ")} }`;
}

function renderBeginInstrumentation(
  bindings: ComponentBindings,
  componentName: string,
  displayFilename: string,
  identifier: string,
): string {
  return `${SOURCE_MARKER}const ${identifier}=globalThis.__SVELTE_LENS__?.beginComponent({name:${JSON.stringify(componentName)},file:${JSON.stringify(displayFilename)},props:()=>(${renderProps(bindings.props)}),state:${renderState(bindings.state)},derived:${renderDerived(bindings.derived)}})??null;`;
}

function renderEndInstrumentation(
  bindings: ComponentBindings,
  identifier: string,
  onDestroyIdentifier: string,
): string {
  const inspected = [...bindings.inspected];
  const update =
    inspected.length > 0
      ? `$inspect(${inspected.join(",")}).with((phase)=>{if(${identifier}!=null)globalThis.__SVELTE_LENS__?.updateComponent(${identifier},phase);});`
      : `if(${identifier}!=null)globalThis.__SVELTE_LENS__?.updateComponent(${identifier},"init");`;

  return `;${update}${onDestroyIdentifier}(()=>{if(${identifier}!=null)globalThis.__SVELTE_LENS__?.unregisterComponent(${identifier});});`;
}

export function instrumentSvelteSource(
  source: string,
  options: SourceInstrumentationOptions,
): InstrumentationResult | null {
  const plan = createSourceInstrumentationPlan(source, options);
  if (!plan) return null;
  const {
    bindings,
    componentName,
    displayFilename,
    identifier,
    onDestroyIdentifier,
  } = plan;

  let root: AstNode;
  try {
    root = parse(source, { filename: options.filename, modern: true }) as unknown as AstNode;
  } catch {
    return null;
  }
  const instance = isNode(root.instance) ? root.instance : null;
  const program = instance && isNode(instance.content) ? instance.content : ({ type: "Program", body: [] } as AstNode);
  const beginInstrumentation = renderBeginInstrumentation(
    bindings,
    componentName,
    displayFilename,
    identifier,
  );
  const endInstrumentation = renderEndInstrumentation(
    bindings,
    identifier,
    onDestroyIdentifier,
  );
  const magic = new MagicString(source);

  if (instance && program.start !== undefined && program.end !== undefined) {
    magic.appendLeft(
      program.start,
      `import {onDestroy as ${onDestroyIdentifier}} from "svelte";${beginInstrumentation}`,
    );
    magic.appendLeft(program.end, `\n${endInstrumentation}`);
  } else {
    magic.append(
      `<script>import {onDestroy as ${onDestroyIdentifier}} from "svelte";${beginInstrumentation}${endInstrumentation}</script>`,
    );
  }

  return {
    code: magic.toString(),
    map: magic.generateMap({
      hires: true,
      includeContent: true,
      source: options.filename,
    }),
  };
}

export function createSourceInstrumentationPlan(
  source: string,
  options: SourceInstrumentationOptions,
): SourceInstrumentationPlan | null {
  if (source.includes(SOURCE_MARKER)) return null;

  const displayFilename = options.displayFilename ?? options.filename;
  const hash = shortHash(displayFilename);
  const reserved = new Set<string>();
  const identifier = uniqueIdentifier(`__svelte_lens_id_${hash}`, source, reserved);
  const onDestroyIdentifier = uniqueIdentifier(`__svelte_lens_on_destroy_${hash}`, source, reserved);

  let root: AstNode;
  try {
    root = parse(source, { filename: options.filename, modern: true }) as unknown as AstNode;
  } catch {
    // A custom preprocessor can own syntax that only becomes JavaScript inside
    // Svelte's transform. Preserve component/effect instrumentation with a
    // binding-empty plan; the post pass receives the preprocessor's source map.
    return {
      bindings: { props: [], state: new Map(), derived: new Set(), inspected: new Set() },
      componentName: sanitizeComponentName(displayFilename),
      displayFilename,
      identifier,
      onDestroyIdentifier,
    };
  }
  const instance = isNode(root.instance) ? root.instance : null;
  const program = instance && isNode(instance.content) ? instance.content : ({ type: "Program", body: [] } as AstNode);
  const bindings = collectComponentBindings(program);
  return {
    bindings,
    componentName: sanitizeComponentName(displayFilename),
    displayFilename,
    identifier,
    onDestroyIdentifier,
  };
}

function findComponentIdentifier(code: string): { identifier: string; end: number } | null {
  const match = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*globalThis\.__SVELTE_LENS__\?\.beginComponent\s*\(/m.exec(code);
  if (!match || !match[1]) return null;
  return { identifier: match[1], end: match.index + match[0].length };
}

function isJsNode(value: unknown): value is JsNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string" &&
    typeof (value as { start?: unknown }).start === "number" &&
    typeof (value as { end?: unknown }).end === "number"
  );
}

function walkJavaScript(node: JsNode, visit: (node: JsNode) => void): void {
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    if (isJsNode(value)) {
      walkJavaScript(value, visit);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (isJsNode(item)) walkJavaScript(item, visit);
      }
    }
  }
}

function parseCompiledJavaScript(code: string): JsNode | null {
  try {
    return parseJavaScript(code, {
      allowHashBang: true,
      ecmaVersion: "latest",
      locations: true,
      sourceType: "module",
    }) as unknown as JsNode;
  } catch {
    return null;
  }
}

function isFunctionNode(node: JsNode): boolean {
  return node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression";
}

function findContainingFunction(program: JsNode, position: number): JsNode | null {
  let containing: JsNode | null = null;
  walkJavaScript(program, (node) => {
    if (!isFunctionNode(node) || node.start > position || node.end < position) return;
    if (!containing || node.end - node.start < containing.end - containing.start) {
      containing = node;
    }
  });
  return containing;
}

function runtimeMemberName(node: unknown, namespace: string): string | null {
  if (!isJsNode(node) || node.type !== "MemberExpression" || node.computed === true) return null;
  if (!isNode(node.object) || node.object.type !== "Identifier" || node.object.name !== namespace) return null;
  if (!isNode(node.property) || node.property.type !== "Identifier" || typeof node.property.name !== "string") {
    return null;
  }
  return node.property.name;
}

function findComponentPop(
  code: string,
  componentFunction: JsNode,
  namespace: string,
): { index: number; indent: string } | null {
  const body = isJsNode(componentFunction.body) && Array.isArray(componentFunction.body.body)
    ? componentFunction.body.body
    : [];
  for (let index = body.length - 1; index >= 0; index--) {
    const statement = body[index];
    if (!isJsNode(statement)) continue;
    let expression = statement.type === "ExpressionStatement"
      ? statement.expression
      : statement.type === "ReturnStatement"
        ? statement.argument
        : null;
    if (statement.type === "VariableDeclaration" && Array.isArray(statement.declarations)) {
      const popDeclarator = statement.declarations.find((declaration) => {
        if (!isJsNode(declaration) || !isJsNode(declaration.init)) return false;
        return declaration.init.type === "CallExpression" &&
          runtimeMemberName(declaration.init.callee, namespace) === "pop";
      });
      expression = isJsNode(popDeclarator) ? popDeclarator.init : null;
    }
    if (!isJsNode(expression) || expression.type !== "CallExpression") continue;
    if (runtimeMemberName(expression.callee, namespace) !== "pop") continue;

    const lineStart = code.lastIndexOf("\n", Math.max(0, statement.start - 1)) + 1;
    const prefix = code.slice(lineStart, statement.start);
    if (/^[ \t]*$/.test(prefix)) return { index: lineStart, indent: prefix };
    return { index: statement.start, indent: "" };
  }
  return null;
}

function findDirectRuntimeCallStatement(
  componentFunction: JsNode,
  namespace: string,
  member: string,
): JsNode | null {
  const body = isJsNode(componentFunction.body) && Array.isArray(componentFunction.body.body)
    ? componentFunction.body.body
    : [];
  for (const statement of body) {
    if (!isJsNode(statement) || statement.type !== "ExpressionStatement") continue;
    const expression = statement.expression;
    if (!isJsNode(expression) || expression.type !== "CallExpression") continue;
    if (runtimeMemberName(expression.callee, namespace) === member) return statement;
  }
  return null;
}

function findDirectStatementContaining(componentFunction: JsNode, position: number): JsNode | null {
  const body = isJsNode(componentFunction.body) && Array.isArray(componentFunction.body.body)
    ? componentFunction.body.body
    : [];
  for (const statement of body) {
    if (isJsNode(statement) && statement.start <= position && statement.end >= position) return statement;
  }
  return null;
}

function uniqueCompiledIdentifier(componentFunction: JsNode, base: string): string {
  const names = new Set<string>();
  walkJavaScript(componentFunction, (node) => {
    if (node.type === "Identifier" && typeof node.name === "string") names.add(node.name);
  });
  let identifier = base;
  let suffix = 2;
  while (names.has(identifier)) identifier = `${base}_${suffix++}`;
  return identifier;
}

function findCompiledComponentFunction(program: JsNode, namespace: string): JsNode | null {
  let component: JsNode | null = null;
  walkJavaScript(program, (node) => {
    if (!isFunctionNode(node) || !isJsNode(node.body)) return;
    let hasPush = false;
    let hasPop = false;
    walkJavaScript(node.body, (child) => {
      if (child.type !== "CallExpression") return;
      const member = runtimeMemberName(child.callee, namespace);
      if (member === "push") hasPush = true;
      if (member === "pop") hasPop = true;
    });
    if (!hasPush || !hasPop) return;
    if (!component || node.end - node.start < component.end - component.start) component = node;
  });
  return component;
}

type CompiledAccessKind = "direct" | "prop" | "proxy" | "signal";

function compiledAccessKinds(
  componentFunction: JsNode,
  namespace: string,
  names: Set<string>,
): Map<string, CompiledAccessKind> {
  const result = new Map<string, CompiledAccessKind>();
  const body = isJsNode(componentFunction.body) && Array.isArray(componentFunction.body.body)
    ? componentFunction.body.body
    : [];
  for (const statement of body) {
    if (!isJsNode(statement) || statement.type !== "VariableDeclaration" || !Array.isArray(statement.declarations)) {
      continue;
    }
    for (const declaration of statement.declarations) {
      if (!isJsNode(declaration) || !isNode(declaration.id) || declaration.id.type !== "Identifier") continue;
      const name = declaration.id.name;
      if (typeof name !== "string" || !names.has(name) || !isJsNode(declaration.init)) continue;
      let kind: CompiledAccessKind = "direct";
      walkJavaScript(declaration.init, (node) => {
        if (node.type !== "CallExpression") return;
        const member = runtimeMemberName(node.callee, namespace);
        if (member === "prop") kind = "prop";
        else if (member === "state" || member === "derived" || member === "derived_safe_equal") kind = "signal";
        else if (member === "proxy" && kind === "direct") kind = "proxy";
      });
      result.set(name, kind);
    }
  }
  return result;
}

function renderCompiledRead(name: string, kind: CompiledAccessKind, namespace: string): string {
  if (kind === "signal") return `${namespace}.get(${name})`;
  if (kind === "prop") return `${name}()`;
  return name;
}

function componentPropsIdentifier(componentFunction: JsNode): string {
  const params = Array.isArray(componentFunction.params) ? componentFunction.params : [];
  const props = params[1];
  return isNode(props) && props.type === "Identifier" && typeof props.name === "string"
    ? props.name
    : "$$props";
}

function renderPlanRead(
  name: string,
  plan: SourceInstrumentationPlan,
  namespace: string,
  propsIdentifier: string,
  access: Map<string, CompiledAccessKind>,
): string {
  const kind = access.get(name);
  if (kind) return renderCompiledRead(name, kind, namespace);
  const prop = plan.bindings.props.find((part) => part.local === name);
  if (prop?.kind === "entry") return `${propsIdentifier}[${JSON.stringify(prop.key)}]`;
  if (prop?.kind === "spread") return propsIdentifier;
  return name;
}

function renderCompiledBegin(
  plan: SourceInstrumentationPlan,
  namespace: string,
  propsIdentifier: string,
  access: Map<string, CompiledAccessKind>,
): string {
  const read = (name: string) => renderPlanRead(name, plan, namespace, propsIdentifier, access);
  const props = plan.bindings.props.length === 0
    ? "{}"
    : `{ ${plan.bindings.props.map((part) =>
        part.kind === "spread" ? `...${read(part.local)}` : `${JSON.stringify(part.key)}: ${read(part.local)}`
      ).join(", ")} }`;
  const state = plan.bindings.state.size === 0
    ? "{}"
    : `{ ${[...plan.bindings.state].map(([name, binding]) => {
        const kind = access.get(name) ?? "direct";
        const setter = binding.writable
          ? kind === "signal"
            ? `, set: (value) => { ${namespace}.set(${name}, value${binding.raw ? "" : ", true"}); }`
            : kind === "proxy"
              ? `, canSet: () => globalThis.__SVELTE_LENS__?.canReplaceStateInPlace?.(${name}) === true, set: (value) => { globalThis.__SVELTE_LENS__?.replaceStateInPlace?.(${name}, value); }`
              : ""
          : "";
        return `${JSON.stringify(name)}: { get: () => ${read(name)}${setter} }`;
      }).join(", ")} }`;
  const derived = plan.bindings.derived.size === 0
    ? "{}"
    : `{ ${[...plan.bindings.derived].map(
        (name) => `${JSON.stringify(name)}: { get: () => ${read(name)} }`,
      ).join(", ")} }`;
  return `${SOURCE_MARKER}${plan.identifier}=globalThis.__SVELTE_LENS__?.beginComponent({name:${JSON.stringify(plan.componentName)},file:${JSON.stringify(plan.displayFilename)},props:()=>(${props}),state:${state},derived:${derived}})??null;`;
}

function renderCompiledLifecycle(
  plan: SourceInstrumentationPlan,
  namespace: string,
  propsIdentifier: string,
  access: Map<string, CompiledAccessKind>,
): string {
  const inspected = [...plan.bindings.inspected].map(
    (name) => renderPlanRead(name, plan, namespace, propsIdentifier, access),
  );
  const update = inspected.length > 0
    ? `${namespace}.inspect(()=>[${inspected.join(",")}],(phase)=>{if(${plan.identifier}!=null)globalThis.__SVELTE_LENS__?.updateComponent(${plan.identifier},phase);});`
    : `if(${plan.identifier}!=null)globalThis.__SVELTE_LENS__?.updateComponent(${plan.identifier},"init");`;
  const destroy = `${plan.onDestroyIdentifier}(()=>{if(${plan.identifier}!=null)globalThis.__SVELTE_LENS__?.unregisterComponent(${plan.identifier});});`;
  return `${update}${destroy}`;
}

interface CompiledEffectCall {
  argument: JsNode;
  callee: JsNode;
  kind: EffectKind;
}

interface CompiledAnalysis {
  namespace: string;
  namespaceImport: JsNode;
  effects: CompiledEffectCall[];
}

function analyzeCompiledJavaScript(program: JsNode): CompiledAnalysis | null {
  let namespace: string | null = null;
  let namespaceImport: JsNode | null = null;
  walkJavaScript(program, (node) => {
    if (node.type !== "ImportDeclaration" || !isNode(node.source)) return;
    if (namespace) return;
    if (node.source.value !== "svelte/internal/client" || !Array.isArray(node.specifiers)) return;
    for (const specifier of node.specifiers) {
      if (
        isJsNode(specifier) &&
        specifier.type === "ImportNamespaceSpecifier" &&
        isNode(specifier.local) &&
        specifier.local.type === "Identifier" &&
        typeof specifier.local.name === "string"
      ) {
        namespace = specifier.local.name;
        namespaceImport = node;
        break;
      }
    }
  });
  if (!namespace || !namespaceImport) return null;

  const effects: CompiledEffectCall[] = [];
  walkJavaScript(program, (node) => {
    if (node.type !== "CallExpression" || !isJsNode(node.callee) || !Array.isArray(node.arguments)) return;
    const callee = node.callee;
    if (callee.type !== "MemberExpression" || callee.computed === true) return;
    if (!isNode(callee.object) || callee.object.type !== "Identifier" || callee.object.name !== namespace) return;
    if (!isNode(callee.property) || callee.property.type !== "Identifier") return;
    const property = callee.property.name;
    const kind = property === "user_effect" ? "effect" : property === "user_pre_effect" ? "pre" : null;
    const argument = node.arguments[0];
    if (kind && isJsNode(argument)) effects.push({ argument, callee, kind });
  });
  return { namespace, namespaceImport, effects };
}

function resolveEffectSource(
  call: CompiledEffectCall,
  filename: string,
  options: CompiledInstrumentationOptions,
  traceMap: TraceMap | null,
): { file: string; line: number; column: number } {
  const generated = call.callee.loc?.start;
  if (generated && traceMap) {
    try {
      const original = originalPositionFor(traceMap, generated);
      if (original.line !== null && original.column !== null) {
        return {
          file: options.displayFilename ?? original.source ?? filename,
          line: original.line,
          column: original.column,
        };
      }
    } catch {
      // A malformed upstream source map should only reduce source precision.
    }
  }
  return {
    file: options.displayFilename ?? filename,
    line: generated?.line ?? 1,
    column: generated?.column ?? 0,
  };
}

function createTraceMap(input: SourceMapInput | null | undefined): TraceMap | null {
  if (!input) return null;
  try {
    return input instanceof TraceMap ? input : new TraceMap(input);
  } catch {
    return null;
  }
}

function renderEffectWrapperStart(
  identifier: string,
  kind: EffectKind,
  source: { file: string; line: number; column: number },
): string {
  const siteId = `site:${shortHash(`${source.file}:${source.line}:${source.column}:${kind}`)}`;
  const descriptor = JSON.stringify({
    siteId,
    componentId: `__SVELTE_LENS_COMPONENT_ID__`,
    kind,
    source,
  }).replace('"__SVELTE_LENS_COMPONENT_ID__"', identifier);
  return `((__svelte_lens_effect_fn) => (globalThis.__SVELTE_LENS__?.registerEffect?.(${descriptor}, __svelte_lens_effect_fn) ?? __svelte_lens_effect_fn))(`;
}

export function instrumentCompiledSvelte(
  code: string,
  filename: string,
  options: CompiledInstrumentationOptions = {},
): InstrumentationResult | null {
  if (code.includes(END_MARKER)) return null;
  if (!code.includes("svelte/internal/client")) return null;

  const program = parseCompiledJavaScript(code);
  const analysis = program ? analyzeCompiledJavaScript(program) : null;
  if (!program || !analysis) return null;
  const existingComponent = findComponentIdentifier(code);
  const componentFunction = options.sourcePlan
    ? findCompiledComponentFunction(program, analysis.namespace)
    : existingComponent
      ? findContainingFunction(program, existingComponent.end)
      : null;
  const componentIdentifier = options.sourcePlan?.identifier ?? existingComponent?.identifier;
  if (!componentFunction || !componentIdentifier) return null;
  const componentBody = isJsNode(componentFunction.body) && componentFunction.body.type === "BlockStatement"
    ? componentFunction.body
    : null;
  if (!componentBody) return null;
  const pop = findComponentPop(code, componentFunction, analysis.namespace);
  if (!pop) return null;

  const magic = new MagicString(code);
  let access = new Map<string, CompiledAccessKind>();
  let propsIdentifier = "$$props";
  let abortIdentifier = componentIdentifier;
  if (options.sourcePlan) {
    const names = new Set([
      ...options.sourcePlan.bindings.props.map((part) => part.local),
      ...options.sourcePlan.bindings.state.keys(),
      ...options.sourcePlan.bindings.derived,
      ...options.sourcePlan.bindings.inspected,
    ]);
    access = compiledAccessKinds(componentFunction, analysis.namespace, names);
    propsIdentifier = componentPropsIdentifier(componentFunction);
    const pushStatement = findDirectRuntimeCallStatement(componentFunction, analysis.namespace, "push");
    if (!pushStatement) return null;
    const pushLineStart = code.lastIndexOf("\n", Math.max(0, pushStatement.start - 1)) + 1;
    const pushPrefix = code.slice(pushLineStart, pushStatement.start);
    const pushIndent = /^[ \t]*$/.test(pushPrefix) ? pushPrefix : "";
    magic.prepend(
      `import { onDestroy as ${options.sourcePlan.onDestroyIdentifier} } from "svelte";\n`,
    );
    magic.appendLeft(
      pushStatement.end,
      `\n${pushIndent}let ${componentIdentifier}=null;\n${pushIndent}try {\n${pushIndent}${renderCompiledBegin(options.sourcePlan, analysis.namespace, propsIdentifier, access)}\n`,
    );
  } else if (existingComponent) {
    const beginStatement = findDirectStatementContaining(componentFunction, existingComponent.end);
    if (!beginStatement) return null;
    abortIdentifier = uniqueCompiledIdentifier(
      componentFunction,
      `__svelte_lens_abort_${shortHash(filename)}`,
    );
    const lineStart = code.lastIndexOf("\n", Math.max(0, beginStatement.start - 1)) + 1;
    const prefix = code.slice(lineStart, beginStatement.start);
    const insertionIndex = /^[ \t]*$/.test(prefix) ? lineStart : beginStatement.start;
    const indent = /^[ \t]*$/.test(prefix) ? prefix : "";
    magic.appendLeft(insertionIndex, `${indent}let ${abortIdentifier}=null;\n${indent}try {\n`);
    magic.appendLeft(
      beginStatement.end,
      `\n${indent}${abortIdentifier}=${componentIdentifier};`,
    );
  }
  if (analysis && analysis.effects.length > 0) {
    const traceMap = createTraceMap(options.inputMap);
    const componentEffects = analysis.effects.filter(
      (effect) => effect.callee.start >= componentFunction.start && effect.callee.end <= componentFunction.end,
    );
    for (const effect of componentEffects) {
      const source = resolveEffectSource(effect, filename, options, traceMap);
      magic.appendLeft(
        effect.argument.start,
        renderEffectWrapperStart(componentIdentifier, effect.kind, source),
      );
      magic.appendRight(effect.argument.end, ")");
    }
    if (componentEffects.length > 0) {
      magic.appendRight(
        analysis.namespaceImport.end,
        `\n${RUNTIME_MARKER}\nglobalThis.__SVELTE_LENS__?.installRuntime?.(() => ({ activeEffect: ${analysis.namespace}.active_effect, untrack: ${analysis.namespace}.untrack }));`,
      );
    }
  }
  const lifecycle = options.sourcePlan
    ? `${pop.indent}${renderCompiledLifecycle(options.sourcePlan, analysis.namespace, propsIdentifier, access)}\n`
    : "";
  const abortGuard = `${pop.indent}} catch (__svelte_lens_error) {\n${pop.indent}  if (${abortIdentifier} != null) globalThis.__SVELTE_LENS__?.abortComponent?.(${abortIdentifier}, __svelte_lens_error);\n${pop.indent}  throw __svelte_lens_error;\n${pop.indent}}\n`;
  magic.appendLeft(
    pop.index,
    `${lifecycle}${pop.indent}${END_MARKER}\n${pop.indent}if (${componentIdentifier} != null) globalThis.__SVELTE_LENS__?.endComponent(${componentIdentifier});\n`,
  );
  magic.appendLeft(componentBody.end - 1, `${abortGuard}`);

  return {
    code: magic.toString(),
    map: magic.generateMap({
      hires: true,
      includeContent: true,
      source: filename,
    }),
  };
}
