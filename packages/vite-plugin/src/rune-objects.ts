import {
  LEAST_UPPER_BOUND,
  originalPositionFor,
  TraceMap,
  type SourceMapInput,
} from "@jridgewell/trace-mapping";
import { parse as parseJavaScript } from "acorn";
import MagicString from "magic-string";

const RUNE_OBJECT_MARKER = "/* svelte-lens:rune-object */";
const MAX_RUNE_FIELDS_PER_CLASS = 64;

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

type RuneKind = "state" | "derived";

interface RuneField {
  backingName: string;
  displayName: string;
  kind: RuneKind;
  sourceNode: JsNode;
}

interface RuneClass {
  className: string;
  node: JsNode;
  fields: RuneField[];
}

export interface RuneObjectInstrumentationOptions {
  displayFilename?: string;
  inputMap?: SourceMapInput | null;
}

export interface RuneObjectInstrumentationResult {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
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

function walkOwnScope(
  node: JsNode,
  visit: (node: JsNode) => void,
  root = true,
): void {
  if (
    !root &&
    (node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression" ||
      node.type === "ClassDeclaration" ||
      node.type === "ClassExpression")
  ) return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    if (isJsNode(value)) {
      walkOwnScope(value, visit, false);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (isJsNode(item)) walkOwnScope(item, visit, false);
      }
    }
  }
}

function parseCompiledModule(code: string): JsNode | null {
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

function runtimeNamespace(program: JsNode): string | null {
  let namespace: string | null = null;
  walkJavaScript(program, (node) => {
    if (namespace || node.type !== "ImportDeclaration" || !isJsNode(node.source)) return;
    if (!isSvelteClientRuntime(node.source.value) || !Array.isArray(node.specifiers)) return;
    for (const specifier of node.specifiers) {
      if (
        isJsNode(specifier) &&
        specifier.type === "ImportNamespaceSpecifier" &&
        isJsNode(specifier.local) &&
        specifier.local.type === "Identifier" &&
        typeof specifier.local.name === "string"
      ) {
        namespace = specifier.local.name;
        return;
      }
    }
  });
  return namespace;
}

function isSvelteClientRuntime(value: unknown): boolean {
  if (value === "svelte/internal/client") return true;
  return typeof value === "string" && /(?:^|\/)svelte_internal_client\.js(?:\?|$)/.test(value);
}

function memberName(node: unknown, namespace: string): string | null {
  if (!isJsNode(node) || node.type !== "MemberExpression" || node.computed === true) return null;
  if (!isJsNode(node.object) || node.object.type !== "Identifier" || node.object.name !== namespace) {
    return null;
  }
  return isJsNode(node.property) &&
    node.property.type === "Identifier" &&
    typeof node.property.name === "string"
    ? node.property.name
    : null;
}

function callMemberName(node: unknown, namespace: string): string | null {
  return isJsNode(node) && node.type === "CallExpression"
    ? memberName(node.callee, namespace)
    : null;
}

function unwrapRuneKind(node: unknown, namespace: string): RuneKind | null {
  if (!isJsNode(node) || node.type !== "CallExpression") return null;
  const member = callMemberName(node, namespace);
  if (member === "state") return "state";
  if (member === "derived" || member === "derived_safe_equal") return "derived";
  if ((member === "tag" || member === "tag_proxy") && Array.isArray(node.arguments)) {
    return unwrapRuneKind(node.arguments[0], namespace);
  }
  return null;
}

function runeLabel(node: unknown, namespace: string): string | null {
  if (!isJsNode(node) || node.type !== "CallExpression") return null;
  const member = callMemberName(node, namespace);
  if ((member !== "tag" && member !== "tag_proxy") || !Array.isArray(node.arguments)) return null;
  const label = node.arguments[1];
  return isJsNode(label) && label.type === "Literal" && typeof label.value === "string"
    ? label.value
    : null;
}

function privateName(node: unknown): string | null {
  return isJsNode(node) && node.type === "PrivateIdentifier" && typeof node.name === "string"
    ? node.name
    : null;
}

function className(node: JsNode): string | null {
  return isJsNode(node.id) && node.id.type === "Identifier" && typeof node.id.name === "string"
    ? node.id.name
    : null;
}

function classMembers(node: JsNode): JsNode[] {
  return isJsNode(node.body) && Array.isArray(node.body.body)
    ? node.body.body.filter(isJsNode)
    : [];
}

function publicAccessorForBacking(members: JsNode[], backingName: string, namespace: string): string | null {
  for (const member of members) {
    if (member.type !== "MethodDefinition" || member.kind !== "get" || !isJsNode(member.value)) continue;
    let readsBacking = false;
    walkOwnScope(member.value, (candidate) => {
      if (candidate.type !== "CallExpression" || callMemberName(candidate, namespace) !== "get") return;
      const argument = Array.isArray(candidate.arguments) ? candidate.arguments[0] : null;
      if (
        isJsNode(argument) &&
        argument.type === "MemberExpression" &&
        isJsNode(argument.object) &&
        argument.object.type === "ThisExpression" &&
        privateName(argument.property) === backingName
      ) {
        readsBacking = true;
      }
    });
    if (!readsBacking) continue;
    if (isJsNode(member.key) && member.key.type === "Identifier" && typeof member.key.name === "string") {
      return member.key.name;
    }
    if (
      isJsNode(member.key) &&
      member.key.type === "Literal" &&
      (typeof member.key.value === "string" || typeof member.key.value === "number")
    ) {
      return String(member.key.value);
    }
  }
  return null;
}

function labelFieldName(label: string | null, fallback: string, ownerName: string): string {
  if (!label) return fallback;
  const prefix = `${ownerName}.`;
  return label.startsWith(prefix) && label.length > prefix.length
    ? label.slice(prefix.length)
    : fallback;
}

function collectRuneClasses(program: JsNode, namespace: string): RuneClass[] {
  const classes: RuneClass[] = [];
  walkJavaScript(program, (node) => {
    if (node.type !== "ClassDeclaration" && node.type !== "ClassExpression") return;
    const ownerName = className(node);
    if (!ownerName) return;
    const members = classMembers(node);
    const fieldsByBacking = new Map<string, RuneField>();

    for (const member of members) {
      if (member.type !== "PropertyDefinition" || member.static === true) continue;
      const backingName = privateName(member.key);
      const kind = unwrapRuneKind(member.value, namespace);
      if (!backingName || !kind) continue;
      const accessor = publicAccessorForBacking(members, backingName, namespace);
      const fallback = accessor ?? `#${backingName}`;
      fieldsByBacking.set(backingName, {
        backingName,
        displayName: labelFieldName(runeLabel(member.value, namespace), fallback, ownerName),
        kind,
        sourceNode: member,
      });
    }

    for (const member of members) {
      if (member.type !== "MethodDefinition" || member.kind !== "constructor" || !isJsNode(member.value)) {
        continue;
      }
      walkOwnScope(member.value, (candidate) => {
        if (candidate.type !== "AssignmentExpression" || !isJsNode(candidate.left)) return;
        const left = candidate.left;
        if (
          left.type !== "MemberExpression" ||
          !isJsNode(left.object) ||
          left.object.type !== "ThisExpression"
        ) {
          return;
        }
        const backingName = privateName(left.property);
        const kind = unwrapRuneKind(candidate.right, namespace);
        if (!backingName || !kind || fieldsByBacking.has(backingName)) return;
        const accessor = publicAccessorForBacking(members, backingName, namespace);
        const fallback = accessor ?? `#${backingName}`;
        fieldsByBacking.set(backingName, {
          backingName,
          displayName: labelFieldName(runeLabel(candidate.right, namespace), fallback, ownerName),
          kind,
          sourceNode: candidate,
        });
      });
    }

    const fields = [...fieldsByBacking.values()];
    if (fields.length > 0) classes.push({ className: ownerName, node, fields });
  });
  return classes;
}

function createTraceMap(input: SourceMapInput | null | undefined): TraceMap | null {
  if (!input) return null;
  try {
    return input instanceof TraceMap ? input : new TraceMap(input);
  } catch {
    return null;
  }
}

function sourceLocation(
  node: JsNode,
  fallbackFile: string,
  traceMap: TraceMap | null,
): { file: string; line: number; column: number } {
  const generated = node.loc?.start;
  if (generated && traceMap) {
    try {
      // Compiler-generated backing fields often have no segment at column 0.
      // The first mapped token on that generated line points at the original
      // rune expression, which is the location useful to a developer.
      const original = originalPositionFor(traceMap, {
        ...generated,
        bias: LEAST_UPPER_BOUND,
      });
      if (original.line !== null && original.column !== null) {
        return {
          file: fallbackFile || original.source || "unknown",
          line: original.line,
          column: original.column,
        };
      }
    } catch {
      // A malformed upstream map only reduces source precision.
    }
  }
  return {
    file: fallbackFile,
    line: generated?.line ?? 1,
    column: generated?.column ?? 0,
  };
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function uniquePrivateName(code: string, classNode: JsNode, base: string): string {
  const classCode = code.slice(classNode.start, classNode.end);
  let candidate = base;
  let suffix = 2;
  while (classCode.includes(`#${candidate}`)) candidate = `${base}_${suffix++}`;
  return candidate;
}

function insertionIndent(code: string, classNode: JsNode): string {
  const closingBrace = classNode.end - 1;
  const lineStart = code.lastIndexOf("\n", Math.max(0, closingBrace - 1)) + 1;
  const closeIndent = code.slice(lineStart, closingBrace);
  return /^[ \t]*$/.test(closeIndent) ? `${closeIndent}\t` : "\t";
}

function renderRuneClassInstrumentation(
  code: string,
  runeClass: RuneClass,
  namespace: string,
  fallbackFile: string,
  traceMap: TraceMap | null,
): string {
  const hash = shortHash(`${fallbackFile}:${runeClass.className}:${runeClass.node.start}`);
  const descriptorName = uniquePrivateName(code, runeClass.node, `__svelte_lens_descriptor_${hash}`);
  const registrationName = uniquePrivateName(code, runeClass.node, `__svelte_lens_registration_${hash}`);
  const indent = insertionIndent(code, runeClass.node);
  const included = runeClass.fields.slice(0, MAX_RUNE_FIELDS_PER_CLASS);
  const classSource = sourceLocation(runeClass.node, fallbackFile, traceMap);
  const fields = included.map((field) => {
    const source = sourceLocation(field.sourceNode, fallbackFile, traceMap);
    return `${JSON.stringify(field.displayName)}:{kind:${JSON.stringify(field.kind)},source:${JSON.stringify(source)},get:(__svelte_lens_target)=>${namespace}.get(__svelte_lens_target.#${field.backingName})}`;
  }).join(",");
  const descriptor = `{name:${JSON.stringify(runeClass.className)},file:${JSON.stringify(fallbackFile)},source:${JSON.stringify(classSource)},fields:{${fields}},totalFields:${runeClass.fields.length},truncated:${runeClass.fields.length > included.length}}`;

  return `\n${indent}${RUNE_OBJECT_MARKER}\n${indent}static #${descriptorName}=${descriptor};\n${indent}#${registrationName}=(globalThis.__SVELTE_LENS__?.registerRuneObject?.(this,${runeClass.className}.#${descriptorName})??null);\n`;
}

/**
 * Adds dev-only, source-known rune field adapters to Svelte-compiled rune classes.
 * It intentionally ignores anonymous classes and never inspects prototypes.
 */
export function instrumentCompiledSvelteModule(
  code: string,
  filename: string,
  options: RuneObjectInstrumentationOptions = {},
): RuneObjectInstrumentationResult | null {
  if (
    code.includes(RUNE_OBJECT_MARKER) ||
    (!code.includes("svelte/internal/client") && !code.includes("svelte_internal_client.js"))
  ) return null;
  const program = parseCompiledModule(code);
  if (!program) return null;
  const namespace = runtimeNamespace(program);
  if (!namespace) return null;
  const runeClasses = collectRuneClasses(program, namespace);
  if (runeClasses.length === 0) return null;

  const displayFilename = options.displayFilename ?? filename;
  const traceMap = createTraceMap(options.inputMap);
  const magic = new MagicString(code);
  for (const runeClass of runeClasses) {
    magic.appendLeft(
      runeClass.node.end - 1,
      renderRuneClassInstrumentation(code, runeClass, namespace, displayFilename, traceMap),
    );
  }

  return {
    code: magic.toString(),
    map: magic.generateMap({
      hires: true,
      includeContent: true,
      source: filename,
    }),
  };
}

export { MAX_RUNE_FIELDS_PER_CLASS, RUNE_OBJECT_MARKER };
