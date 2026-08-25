import path from "node:path";

import MagicString from "magic-string";
import { parse } from "svelte/compiler";

const SOURCE_MARKER = "/* svelte-lens:component */";
const END_MARKER = "/* svelte-lens:end */";

type AstNode = {
  type: string;
  start?: number;
  end?: number;
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

type PropPart =
  | { kind: "entry"; key: string; local: string }
  | { kind: "spread"; local: string };

type ComponentBindings = {
  props: PropPart[];
  state: Map<string, boolean>;
  derived: Set<string>;
  inspected: Set<string>;
};

export interface InstrumentationResult {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
}

export interface SourceInstrumentationOptions {
  filename: string;
  displayFilename?: string;
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
        bindings.state.set(name, declaration.kind !== "const");
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

function renderState(state: Map<string, boolean>): string {
  if (state.size === 0) return "{}";
  const entries = [...state].map(([name, writable]) => {
    const setter = writable ? `, set: (value) => { ${name} = value; }` : "";
    return `${JSON.stringify(name)}: { get: () => ${name}${setter} }`;
  });
  return `{ ${entries.join(", ")} }`;
}

function renderDerived(derived: Set<string>): string {
  if (derived.size === 0) return "{}";
  const entries = [...derived].map((name) => `${JSON.stringify(name)}: { get: () => ${name} }`);
  return `{ ${entries.join(", ")} }`;
}

function renderInstrumentation(
  bindings: ComponentBindings,
  componentName: string,
  displayFilename: string,
  identifier: string,
  onDestroyIdentifier: string,
): string {
  const inspected = [...bindings.inspected];
  const update =
    inspected.length > 0
      ? `$inspect(${inspected.join(", ")}).with((phase) => {\n  if (${identifier} != null) globalThis.__SVELTE_LENS__?.updateComponent(${identifier}, phase);\n});`
      : `if (${identifier} != null) globalThis.__SVELTE_LENS__?.updateComponent(${identifier}, "init");`;

  return `
${SOURCE_MARKER}
const ${identifier} = globalThis.__SVELTE_LENS__?.beginComponent({
  name: ${JSON.stringify(componentName)},
  file: ${JSON.stringify(displayFilename)},
  props: () => (${renderProps(bindings.props)}),
  state: ${renderState(bindings.state)},
  derived: ${renderDerived(bindings.derived)}
}) ?? null;
${update}
${onDestroyIdentifier}(() => {
  if (${identifier} != null) globalThis.__SVELTE_LENS__?.unregisterComponent(${identifier});
});
`;
}

export function instrumentSvelteSource(
  source: string,
  options: SourceInstrumentationOptions,
): InstrumentationResult | null {
  if (source.includes(SOURCE_MARKER)) return null;

  let root: AstNode;
  try {
    root = parse(source, { filename: options.filename, modern: true }) as unknown as AstNode;
  } catch {
    // A custom script preprocessor may own syntax the Svelte parser cannot read yet.
    // Skipping preserves the application's dev build when this plugin runs before it.
    return null;
  }
  const instance = isNode(root.instance) ? root.instance : null;
  const program = instance && isNode(instance.content) ? instance.content : ({ type: "Program", body: [] } as AstNode);
  const bindings = collectComponentBindings(program);
  const displayFilename = options.displayFilename ?? options.filename;
  const hash = shortHash(displayFilename);
  const reserved = new Set<string>();
  const identifier = uniqueIdentifier(`__svelte_lens_id_${hash}`, source, reserved);
  const onDestroyIdentifier = uniqueIdentifier(`__svelte_lens_on_destroy_${hash}`, source, reserved);
  const instrumentation = renderInstrumentation(
    bindings,
    sanitizeComponentName(displayFilename),
    displayFilename,
    identifier,
    onDestroyIdentifier,
  );
  const magic = new MagicString(source);

  if (instance && program.start !== undefined && program.end !== undefined) {
    magic.appendLeft(program.start, `\nimport { onDestroy as ${onDestroyIdentifier} } from "svelte";\n`);
    magic.appendLeft(program.end, instrumentation);
  } else {
    magic.prepend(`<script>\nimport { onDestroy as ${onDestroyIdentifier} } from "svelte";\n${instrumentation}</script>\n`);
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

function findComponentIdentifier(code: string): { identifier: string; end: number } | null {
  const match = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*globalThis\.__SVELTE_LENS__\?\.beginComponent\s*\(/m.exec(code);
  if (!match || !match[1]) return null;
  return { identifier: match[1], end: match.index + match[0].length };
}

function findComponentPop(code: string, from: number): { index: number; indent: string } | null {
  const pop = /(^|\n)([ \t]*)(?:return\s+)?\$\.pop\s*\(/gm;
  pop.lastIndex = from;
  const match = pop.exec(code);
  if (!match) return null;

  return {
    index: match.index + (match[1]?.length ?? 0),
    indent: match[2] ?? "",
  };
}

export function instrumentCompiledSvelte(code: string, filename: string): InstrumentationResult | null {
  if (code.includes(END_MARKER)) return null;
  if (!code.includes("svelte/internal/client")) return null;

  const component = findComponentIdentifier(code);
  if (!component) return null;
  const pop = findComponentPop(code, component.end);
  if (!pop) return null;

  const magic = new MagicString(code);
  magic.appendLeft(
    pop.index,
    `${pop.indent}${END_MARKER}\n${pop.indent}if (${component.identifier} != null) globalThis.__SVELTE_LENS__?.endComponent(${component.identifier});\n`,
  );

  return {
    code: magic.toString(),
    map: magic.generateMap({
      hires: true,
      includeContent: true,
      source: filename,
    }),
  };
}
