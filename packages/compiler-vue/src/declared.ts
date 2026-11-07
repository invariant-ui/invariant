import {
  type Analysis,
  declarationOf,
  describeMember,
  literalDomain,
  type MemberKind,
  ownProperties,
  resolveSymbol,
  typeReferenceInfo
} from "@invariant/compiler-core"
import ts from "typescript"
import type { ScriptInfo } from "./script.js"

const RENDERABLE = /^(?:VNode|VNodeChild|VNodeArrayChildren|Component|DefineComponent)(?:<.*>)?$/
const CONSTRUCTORS: Record<string, { text: string; kind: MemberKind }> = {
  StringConstructor: { text: "string", kind: "string" },
  NumberConstructor: { text: "number", kind: "number" },
  BooleanConstructor: { text: "boolean", kind: "boolean" },
  ArrayConstructor: { text: "unknown[]", kind: "array" },
  ObjectConstructor: { text: "object", kind: "object" },
  FunctionConstructor: { text: "Function", kind: "function" },
  DateConstructor: { text: "Date", kind: "object" }
}
/** Positions of `DefineComponent<Props, RawBindings, D, C, M, Mixin, Extends, Emits, …>`. */
const PROPS = 0
const EMITS = 7
/** Helpers that vue-tsc writes around the props type of a `<script setup lang="ts">` component. */
const PROPS_WRAPPERS = /^__VLS_(?:TypePropsToRuntimeProps|TypePropsToOption|WithDefaults|Prettify)$/
const SLOTS_WRAPPER = /^__VLS_WithTemplateSlots$/

interface Found {
  args: readonly ts.TypeNode[]
  slots?: ts.TypeNode
}

/**
 * A component a declaration file declares by type: `declare const _default: DefineComponent<Props, …, Emits, …>`
 * (what vue-tsc and vite-plugin-dts write for a `.vue` file or a `defineComponent` call). There is no script
 * to read, so props, events and slots come from the written type arguments. Default values are not part of
 * a declaration file and are not reported.
 */
export function analyzeDeclaredComponent(
  analysis: Analysis,
  declaration: ts.VariableDeclaration
): ScriptInfo | undefined {
  if (declaration.initializer || !declaration.type) return undefined
  const found = findDefineComponent(analysis, declaration.type, 0)
  if (!found) return undefined
  const info: ScriptInfo = {
    props: [],
    emits: [],
    slots: [],
    exposed: [],
    options: {},
    inheritsFrom: [],
    complete: true,
    notes: [],
    optionsApi: false,
    imports: new Map()
  }
  const props = found.args[PROPS]
  if (props) readProps(analysis, props, info, 0)
  const emits = found.args[EMITS]
  if (emits) readEmits(analysis, emits, info)
  if (found.slots) readSlots(analysis, found.slots, info)
  return info
}

function unparen(type: ts.TypeNode): ts.TypeNode {
  return ts.isParenthesizedTypeNode(type) ? unparen(type.type) : type
}

function targetOf(analysis: Analysis, name: ts.EntityName | ts.Expression): ts.Declaration | undefined {
  return declarationOf(resolveSymbol(analysis.checker, analysis.checker.getSymbolAtLocation(name)))
}

function findDefineComponent(analysis: Analysis, type: ts.TypeNode, depth: number): Found | undefined {
  if (depth > 5) return undefined
  const t = unparen(type)
  if (ts.isIntersectionTypeNode(t)) {
    let found: Found | undefined
    let slots: ts.TypeNode | undefined
    for (const part of t.types) {
      found ??= findDefineComponent(analysis, part, depth + 1)
      slots ??= slotsOfConstructor(part)
    }
    const slot = found?.slots ?? slots
    return found ? { args: found.args, ...(slot ? { slots: slot } : {}) } : undefined
  }
  if (ts.isTypeQueryNode(t)) {
    const target = targetOf(analysis, t.exprName)
    return target && ts.isVariableDeclaration(target) && target.type
      ? findDefineComponent(analysis, target.type, depth + 1)
      : undefined
  }
  const ref = typeReferenceInfo(t)
  if (!ref) return undefined
  if (ref.name === "DefineComponent") return { args: ref.typeArguments }
  if (SLOTS_WRAPPER.test(ref.name) && ref.typeArguments[0]) {
    const inner = findDefineComponent(analysis, ref.typeArguments[0], depth + 1)
    return inner ? { ...inner, ...(ref.typeArguments[1] ? { slots: ref.typeArguments[1] } : {}) } : undefined
  }
  // `type ButtonComponent = DefineComponent<…>`
  if (ts.isTypeReferenceNode(t)) {
    const target = targetOf(analysis, t.typeName)
    if (target && ts.isTypeAliasDeclaration(target) && !target.typeParameters)
      return findDefineComponent(analysis, target.type, depth + 1)
  }
  return undefined
}

/** `{ new (): { $slots: S } }`, the way a declaration file attaches slot types to a component. */
function slotsOfConstructor(type: ts.TypeNode): ts.TypeNode | undefined {
  const t = unparen(type)
  if (!ts.isTypeLiteralNode(t)) return undefined
  for (const member of t.members) {
    if (!ts.isConstructSignatureDeclaration(member) || !member.type || !ts.isTypeLiteralNode(member.type))
      continue
    for (const inner of member.type.members)
      if (ts.isPropertySignature(inner) && inner.name.getText() === "$slots") return inner.type
  }
  return undefined
}

function readProps(analysis: Analysis, type: ts.TypeNode, info: ScriptInfo, depth: number): void {
  const t = unparen(type)
  const ref = typeReferenceInfo(t)
  if (depth < 4 && ref && PROPS_WRAPPERS.test(ref.name) && ref.typeArguments[0]) {
    readProps(analysis, ref.typeArguments[0], info, depth + 1)
    return
  }
  // `ExtractPropTypes<{ size: { type: PropType<"a" | "b">; default: string } }>`: the runtime options, as a type.
  if (ref?.name === "ExtractPropTypes" && ref.typeArguments[0]) {
    readRuntimeProps(analysis, ref.typeArguments[0], info, 0)
    return
  }
  // `("size" | "tone")[]`: props declared as an array of names.
  if (ts.isArrayTypeNode(t) || ts.isTupleTypeNode(t)) {
    const names = ts.isArrayTypeNode(t)
      ? literalDomain(analysis.checker, t.elementType)
      : t.elements.flatMap((e) => literalDomain(analysis.checker, e) ?? [])
    for (const name of names ?? [])
      info.props.push({
        name: String(name),
        typeText: "unknown",
        kind: "unknown",
        required: false,
        source: "array",
        node: t
      })
    if (!names) info.complete = false
    return
  }
  const type_ = analysis.checker.getTypeFromTypeNode(t)
  if (type_.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
    info.complete = false
    info.notes.push("the props type did not resolve")
    return
  }
  for (const { symbol, declaration } of ownProperties(analysis, type_)) {
    const member = describeMember(analysis, symbol, declaration, { renderable: RENDERABLE })
    info.props.push({
      name: member.name,
      typeText: member.typeText,
      kind: member.kind,
      required: member.required,
      ...(member.allowedValues ? { allowedValues: member.allowedValues } : {}),
      ...(member.description ? { description: member.description } : {}),
      ...(member.deprecated ? { deprecated: member.deprecated } : {}),
      source: "type",
      node: declaration
    })
  }
}

function readRuntimeProps(analysis: Analysis, type: ts.TypeNode, info: ScriptInfo, depth: number): void {
  let t = unparen(type)
  // `typeof props`: follow to the declared type of the constant.
  if (ts.isTypeQueryNode(t) && depth < 3) {
    const target = targetOf(analysis, t.exprName)
    if (target && ts.isVariableDeclaration(target) && target.type) {
      readRuntimeProps(analysis, target.type, info, depth + 1)
      return
    }
  }
  if (!ts.isTypeLiteralNode(t)) {
    info.complete = false
    info.notes.push("the runtime props type is not an object type")
    return
  }
  for (const member of t.members) {
    if (!ts.isPropertySignature(member) || !member.name || !member.type) continue
    if (!(ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name))) continue
    t = unparen(member.type)
    const spec = ts.isTypeLiteralNode(t) ? t : undefined
    const field = (key: string): ts.PropertySignature | undefined =>
      spec?.members.find(
        (m): m is ts.PropertySignature => ts.isPropertySignature(m) && m.name.getText() === key
      )
    // A bare constructor (`name: StringConstructor`) or a list of them is the shorthand for `{ type }`.
    const typeNode = spec ? field("type")?.type : t
    const required = field("required")?.type?.getText() === "true"
    const described = typeNode ? describeRuntimeType(analysis, typeNode) : undefined
    info.props.push({
      name: member.name.text,
      typeText: described?.text ?? "unknown",
      kind: described?.kind ?? "unknown",
      required,
      ...(described?.allowedValues ? { allowedValues: described.allowedValues } : {}),
      source: "runtime",
      node: member
    })
  }
}

function describeRuntimeType(
  analysis: Analysis,
  node: ts.TypeNode
): { text: string; kind: MemberKind; allowedValues?: Array<string | number | boolean> } | undefined {
  const t = unparen(node)
  const ref = typeReferenceInfo(t)
  if (ref?.name === "PropType" && ref.typeArguments[0]) {
    const inner = ref.typeArguments[0]
    const checkerType = analysis.checker.getTypeFromTypeNode(inner)
    const text = inner.getText().replace(/\s+/g, " ")
    const kind = kindOf(analysis, checkerType)
    const allowedValues = kind === "enum" ? literalDomain(analysis.checker, inner) : undefined
    return { text, kind, ...(allowedValues ? { allowedValues } : {}) }
  }
  if (ref && CONSTRUCTORS[ref.name]) return CONSTRUCTORS[ref.name]
  if (ts.isUnionTypeNode(t)) {
    const parts = t.types.map((p) => describeRuntimeType(analysis, p))
    if (parts.every((p) => p)) return { text: parts.map((p) => p?.text).join(" | "), kind: "union" }
  }
  return undefined
}

function kindOf(analysis: Analysis, type: ts.Type): MemberKind {
  const text = analysis.checker.typeToString(type)
  if (type.flags & ts.TypeFlags.Any) return "unknown"
  if (type.getCallSignatures().length > 0) return "function"
  if (type.isUnion()) {
    return type.types.every((x) => x.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral))
      ? "enum"
      : "union"
  }
  if (type.flags & ts.TypeFlags.StringLike) return "string"
  if (type.flags & ts.TypeFlags.NumberLike) return "number"
  if (type.flags & ts.TypeFlags.BooleanLike) return "boolean"
  if (analysis.checker.isArrayType(type)) return "array"
  return text === "unknown" ? "unknown" : "object"
}

function readEmits(analysis: Analysis, type: ts.TypeNode, info: ScriptInfo): void {
  const t = unparen(type)
  // `{}` and `string[]`-like placeholders: Vue's own default for a component with no emits.
  if (ts.isTypeLiteralNode(t) && t.members.length === 0) return
  if (ts.isArrayTypeNode(t) || ts.isTupleTypeNode(t)) {
    const names = ts.isArrayTypeNode(t)
      ? literalDomain(analysis.checker, t.elementType)
      : t.elements.flatMap((e) => literalDomain(analysis.checker, e) ?? [])
    for (const name of names ?? []) info.emits.push({ name: String(name), source: "array", node: t })
    return
  }
  const checker = analysis.checker
  const resolved = checker.getTypeFromTypeNode(t)
  // Call-signature form: `(e: "change", id: number): void`
  for (const signature of resolved.getCallSignatures()) {
    const [first, ...rest] = signature.getParameters()
    const eventType = first ? checker.getTypeOfSymbolAtLocation(first, t) : undefined
    if (!eventType?.isStringLiteral()) continue
    const payload = rest
      .map((p) => `${p.name}: ${checker.typeToString(checker.getTypeOfSymbolAtLocation(p, t))}`)
      .join(", ")
    info.emits.push({
      name: eventType.value,
      ...(payload ? { payloadText: payload } : {}),
      source: "type",
      node: t
    })
  }
  // Object form: `change: (id: number) => void` or the named-tuple form `change: [id: number]`.
  for (const property of resolved.getProperties()) {
    const propType = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(property, t))
    const node = property.valueDeclaration ?? t
    const signature = propType.getCallSignatures()[0]
    if (signature) {
      const payload = signature
        .getParameters()
        .map((p) => `${p.name}: ${checker.typeToString(checker.getTypeOfSymbolAtLocation(p, t))}`)
        .join(", ")
      info.emits.push({
        name: property.name,
        ...(payload ? { payloadText: payload } : {}),
        source: "type",
        node
      })
    } else if (checker.isTupleType(propType) || checker.isArrayType(propType)) {
      const text = checker.typeToString(propType)
      info.emits.push({
        name: property.name,
        ...(text !== "[]" ? { payloadText: text } : {}),
        source: "type",
        node
      })
    } else info.emits.push({ name: property.name, source: "type", node })
  }
}

function readSlots(analysis: Analysis, type: ts.TypeNode, info: ScriptInfo): void {
  const checker = analysis.checker
  for (const property of checker.getTypeFromTypeNode(type).getProperties()) {
    const propType = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(property, type))
    const parameter = propType.getCallSignatures()[0]?.getParameters()[0]
    const propsText = parameter
      ? checker.typeToString(checker.getTypeOfSymbolAtLocation(parameter, type))
      : undefined
    info.slots.push({
      name: property.name,
      ...(propsText && propsText !== "{}" ? { propsText } : {}),
      node: property.valueDeclaration ?? type
    })
  }
}
