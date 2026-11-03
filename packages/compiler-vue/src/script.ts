import {
  type Analysis,
  classifyKind,
  collapse,
  describeMember,
  externalBases,
  literalDomain,
  literalValue,
  type MemberKind,
  ownProperties,
  unwrap
} from "@invariant/compiler-core"
import type { JsonValue } from "@invariant/shared"
import ts from "typescript"

export interface VueProp {
  name: string
  typeText: string
  kind: MemberKind
  required: boolean
  default?: JsonValue
  defaultExpression?: string
  allowedValues?: Array<string | number | boolean>
  description?: string
  deprecated?: { reason?: string }
  /** How the prop was declared. */
  source: "type" | "runtime" | "array" | "model"
  node: ts.Node
}

export interface VueEmit {
  name: string
  payloadText?: string
  source: "type" | "runtime" | "array" | "model"
  node: ts.Node
}

export interface VueSlot {
  name: string
  propsText?: string
  node: ts.Node
}

export interface ScriptInfo {
  props: VueProp[]
  emits: VueEmit[]
  slots: VueSlot[]
  exposed: string[]
  options: { name?: string; inheritAttrs?: boolean }
  /** `<script setup generic="…">` type parameters, as written. */
  inheritsFrom: string[]
  /** False when props cannot be fully enumerated (external or unresolved types, spread declarations). */
  complete: boolean
  notes: string[]
  /** `defineComponent`/options-object declaration found. */
  optionsApi: boolean
  /** Imports by local name, for resolving template component tags. */
  imports: Map<string, string>
}

const RENDERABLE = /^(?:VNode|VNodeChild|VNodeArrayChildren|Component|DefineComponent)(?:<.*>)?$/
const RUNTIME_KINDS: Record<string, { text: string; kind: MemberKind }> = {
  String: { text: "string", kind: "string" },
  Number: { text: "number", kind: "number" },
  Boolean: { text: "boolean", kind: "boolean" },
  Array: { text: "unknown[]", kind: "array" },
  Object: { text: "object", kind: "object" },
  Function: { text: "Function", kind: "function" },
  Symbol: { text: "symbol", kind: "unknown" },
  Date: { text: "Date", kind: "object" }
}

/** Reads the component declaration of a (virtual) script module. Never evaluates or runs anything. */
export function analyzeScript(analysis: Analysis, sf: ts.SourceFile): ScriptInfo {
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
    imports: readImports(sf)
  }
  const state = { analysis, info }

  for (const statement of sf.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const d of statement.declarationList.declarations)
        if (d.initializer) macro(state, unwrap(d.initializer), d)
    } else if (ts.isExpressionStatement(statement)) macro(state, unwrap(statement.expression), undefined)
    else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const options = optionsObject(unwrap(statement.expression))
      if (options) readOptions(state, options)
    }
  }
  return info
}

/** Analyzes `defineComponent({...})`/options-object declarations in a TS file (for non-SFC components). */
export function analyzeOptionsDeclaration(
  analysis: Analysis,
  declaration: ts.VariableDeclaration
): ScriptInfo | undefined {
  if (!declaration.initializer) return undefined
  const options = optionsObject(unwrap(declaration.initializer))
  if (!options) return undefined
  const info: ScriptInfo = {
    props: [],
    emits: [],
    slots: [],
    exposed: [],
    options: {},
    inheritsFrom: [],
    complete: true,
    notes: [],
    optionsApi: true,
    imports: readImports(declaration.getSourceFile())
  }
  readOptions({ analysis, info }, options)
  return info
}

interface State {
  analysis: Analysis
  info: ScriptInfo
}

function macro(state: State, call: ts.Expression, declaration: ts.VariableDeclaration | undefined): void {
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return
  const name = call.expression.text
  const { info } = state
  if (name === "withDefaults") {
    const inner = call.arguments[0] ? unwrap(call.arguments[0]) : undefined
    if (
      inner &&
      ts.isCallExpression(inner) &&
      ts.isIdentifier(inner.expression) &&
      inner.expression.text === "defineProps"
    ) {
      definePropsMacro(state, inner, defaultsFromObject(call.arguments[1]), declaration)
    }
  } else if (name === "defineProps") definePropsMacro(state, call, new Map(), declaration)
  else if (name === "defineEmits") defineEmitsMacro(state, call)
  else if (name === "defineSlots") defineSlotsMacro(state, call)
  else if (name === "defineModel") defineModelMacro(state, call)
  else if (name === "defineExpose") {
    const arg = call.arguments[0] ? unwrap(call.arguments[0]) : undefined
    if (arg && ts.isObjectLiteralExpression(arg))
      info.exposed = arg.properties
        .flatMap((p) =>
          p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? [p.name.text] : []
        )
        .sort()
    else if (arg) info.notes.push("defineExpose argument is not an object literal")
  } else if (name === "defineOptions") {
    const arg = call.arguments[0] ? unwrap(call.arguments[0]) : undefined
    if (arg && ts.isObjectLiteralExpression(arg)) readOptionMetadata(info, arg)
  }
}

function definePropsMacro(
  state: State,
  call: ts.CallExpression,
  withDefaults: Map<string, DefaultSpec>,
  declaration: ts.VariableDeclaration | undefined
): void {
  const { analysis, info } = state
  const defaults = new Map(withDefaults)
  // Reactive props destructure (Vue 3.5+): `const { size = "md" } = defineProps<…>()`.
  if (declaration && ts.isObjectBindingPattern(declaration.name)) {
    for (const element of declaration.name.elements) {
      if (!element.initializer || element.dotDotDotToken) continue
      const key = element.propertyName ?? element.name
      if (ts.isIdentifier(key) || ts.isStringLiteralLike(key))
        defaults.set(key.text, specOf(element.initializer))
    }
  }
  const typeArgument = call.typeArguments?.[0]
  if (typeArgument) {
    const type = analysis.checker.getTypeFromTypeNode(typeArgument)
    if (type.flags & ts.TypeFlags.Any) {
      info.complete = false
      info.notes.push("defineProps type did not resolve")
    }
    info.inheritsFrom.push(...externalBases(analysis, typeArgument))
    for (const { symbol, declaration: decl } of ownProperties(analysis, type)) {
      const member = describeMember(analysis, symbol, decl, { renderable: RENDERABLE })
      const fallback = defaults.get(member.name)
      info.props.push({
        name: member.name,
        typeText: member.typeText,
        kind: member.kind,
        required: member.required,
        ...(fallback?.value !== undefined ? { default: fallback.value } : {}),
        ...(fallback && fallback.value === undefined ? { defaultExpression: fallback.expression } : {}),
        ...(member.allowedValues ? { allowedValues: member.allowedValues } : {}),
        ...(member.description ? { description: member.description } : {}),
        ...(member.deprecated ? { deprecated: member.deprecated } : {}),
        source: "type",
        node: decl
      })
    }
    if (info.inheritsFrom.length > 0) info.complete = false
    return
  }
  const arg = call.arguments[0] ? unwrap(call.arguments[0]) : undefined
  if (arg) readRuntimeProps(state, arg)
}

interface DefaultSpec {
  value?: JsonValue
  expression: string
}

function specOf(expression: ts.Expression): DefaultSpec {
  const value = literalValue(expression)
  return {
    ...(value !== undefined ? { value } : {}),
    expression: collapse(expression.getText()).slice(0, 200)
  }
}

function defaultsFromObject(node: ts.Expression | undefined): Map<string, DefaultSpec> {
  const out = new Map<string, DefaultSpec>()
  const object = node ? unwrap(node) : undefined
  if (!object || !ts.isObjectLiteralExpression(object)) return out
  for (const p of object.properties) {
    if (!p.name || !(ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name))) continue
    if (ts.isPropertyAssignment(p)) out.set(p.name.text, specOf(p.initializer))
    else if (ts.isMethodDeclaration(p))
      out.set(p.name.text, { expression: collapse(p.getText()).slice(0, 200) })
  }
  return out
}

/** `props: ['a', 'b']` and `props: { a: String, b: { type: Number, default: 1 } }` (also the `defineProps(...)` argument). */
function readRuntimeProps(state: State, node: ts.Expression): void {
  const { analysis, info } = state
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) {
      if (ts.isStringLiteralLike(element))
        info.props.push({
          name: element.text,
          typeText: "unknown",
          kind: "unknown",
          required: false,
          source: "array",
          node: element
        })
      else info.complete = false
    }
    return
  }
  if (!ts.isObjectLiteralExpression(node)) {
    info.complete = false
    info.notes.push("props declaration is not an object or array literal")
    return
  }
  for (const property of node.properties) {
    if (
      !property.name ||
      !(ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) ||
      ts.isSpreadAssignment(property)
    ) {
      info.complete = false
      continue
    }
    const name = property.name.text
    // Keep `as PropType<…>` casts: they carry the type. Only parentheses are stripped.
    const value = ts.isPropertyAssignment(property) ? withoutParens(property.initializer) : undefined
    const spec = value
      ? runtimeSpec(analysis, value)
      : { typeText: "unknown", kind: "unknown" as MemberKind, required: false }
    info.props.push({ name, ...spec, source: "runtime", node: property })
  }
}

function withoutParens(node: ts.Expression): ts.Expression {
  let current = node
  while (ts.isParenthesizedExpression(current)) current = current.expression
  return current
}

function runtimeSpec(analysis: Analysis, value: ts.Expression): Omit<VueProp, "name" | "source" | "node"> {
  const base = { typeText: "unknown", kind: "unknown" as MemberKind, required: false }
  if (ts.isIdentifier(value))
    return {
      ...base,
      ...(RUNTIME_KINDS[value.text]
        ? {
            typeText: (RUNTIME_KINDS[value.text] as { text: string }).text,
            kind: (RUNTIME_KINDS[value.text] as { kind: MemberKind }).kind
          }
        : {})
    }
  if (ts.isAsExpression(value)) return typeFromCast(analysis, value, base)
  if (ts.isArrayLiteralExpression(value)) {
    const names = value.elements.flatMap((e) =>
      ts.isIdentifier(e) && RUNTIME_KINDS[e.text] ? [(RUNTIME_KINDS[e.text] as { text: string }).text] : []
    )
    return {
      ...base,
      typeText: names.join(" | ") || "unknown",
      kind:
        names.length > 1
          ? "union"
          : names.length === 1
            ? (RUNTIME_KINDS[(value.elements[0] as ts.Identifier).text] as { kind: MemberKind }).kind
            : "unknown"
    }
  }
  if (!ts.isObjectLiteralExpression(value)) return base
  const get = (key: string): ts.Expression | undefined => {
    const p = value.properties.find((x) => ts.isPropertyAssignment(x) && x.name.getText() === key)
    return p && ts.isPropertyAssignment(p) ? unwrap(p.initializer) : undefined
  }
  // `type: String as PropType<…>`: the cast carries the type, so it must not be unwrapped.
  const typeProperty = value.properties.find((x) => ts.isPropertyAssignment(x) && x.name.getText() === "type")
  const typeExpression =
    typeProperty && ts.isPropertyAssignment(typeProperty) ? typeProperty.initializer : undefined
  const typed = typeExpression ? runtimeSpec(analysis, typeExpression) : base
  const requiredNode = get("required")
  const defaultNode = get("default")
  const fallback = defaultNode ? specOf(defaultNode) : undefined
  return {
    ...typed,
    required: requiredNode?.kind === ts.SyntaxKind.TrueKeyword,
    ...(fallback?.value !== undefined ? { default: fallback.value } : {}),
    ...(fallback && fallback.value === undefined ? { defaultExpression: fallback.expression } : {})
  }
}

/** `String as PropType<"a" | "b">`. */
function typeFromCast(
  analysis: Analysis,
  cast: ts.AsExpression,
  base: Omit<VueProp, "name" | "source" | "node">
): Omit<VueProp, "name" | "source" | "node"> {
  const target = cast.type
  if (
    ts.isTypeReferenceNode(target) &&
    target.typeName.getText().endsWith("PropType") &&
    target.typeArguments?.[0]
  ) {
    const inner = target.typeArguments[0]
    const text = collapse(inner.getText())
    const checker = analysis.checker
    const type = checker.getTypeFromTypeNode(inner)
    const allowed = literalDomain(checker, inner)
    const kind =
      allowed && allowed.length > 0 && !allowed.every((v) => typeof v === "boolean")
        ? "enum"
        : classifyKind(checker, type, text, RENDERABLE)
    return {
      ...base,
      typeText: text,
      kind,
      ...(kind === "enum" && allowed && allowed.length > 0 ? { allowedValues: allowed } : {})
    }
  }
  return base
}

function defineEmitsMacro(state: State, call: ts.CallExpression): void {
  const { analysis, info } = state
  const typeArgument = call.typeArguments?.[0]
  if (typeArgument) {
    const checker = analysis.checker
    const type = checker.getTypeFromTypeNode(typeArgument)
    // Call-signature form: (e: 'change', id: number): void
    for (const signature of type.getCallSignatures()) {
      const [first, ...rest] = signature.getParameters()
      const eventType = first ? checker.getTypeOfSymbolAtLocation(first, typeArgument) : undefined
      if (!eventType?.isStringLiteral()) continue
      const payload = rest
        .map((p) => `${p.name}: ${checker.typeToString(checker.getTypeOfSymbolAtLocation(p, typeArgument))}`)
        .join(", ")
      info.emits.push({
        name: eventType.value,
        ...(payload ? { payloadText: payload } : {}),
        source: "type",
        node: typeArgument
      })
    }
    // Named-tuple form (Vue 3.3+): change: [id: number]
    for (const property of type.getProperties()) {
      const propType = checker.getTypeOfSymbolAtLocation(property, typeArgument)
      if (!checker.isTupleType(propType) && !checker.isArrayType(propType)) continue
      const text = checker.typeToString(propType)
      info.emits.push({
        name: property.name,
        ...(text !== "[]" ? { payloadText: text } : {}),
        source: "type",
        node: property.valueDeclaration ?? typeArgument
      })
    }
    return
  }
  const arg = call.arguments[0] ? unwrap(call.arguments[0]) : undefined
  if (arg) readRuntimeEmits(info, arg)
}

function readRuntimeEmits(info: ScriptInfo, node: ts.Expression): void {
  if (ts.isArrayLiteralExpression(node)) {
    for (const e of node.elements) {
      if (ts.isStringLiteralLike(e)) info.emits.push({ name: e.text, source: "array", node: e })
      else info.complete = false
    }
  } else if (ts.isObjectLiteralExpression(node)) {
    for (const p of node.properties) {
      if (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)))
        info.emits.push({ name: p.name.text, source: "runtime", node: p })
    }
  } else info.notes.push("emits declaration is not an array or object literal")
}

function defineSlotsMacro(state: State, call: ts.CallExpression): void {
  const { analysis, info } = state
  const typeArgument = call.typeArguments?.[0]
  if (!typeArgument) return
  const checker = analysis.checker
  const type = checker.getTypeFromTypeNode(typeArgument)
  for (const property of type.getProperties()) {
    const propType = checker.getTypeOfSymbolAtLocation(property, typeArgument)
    const parameter = propType.getCallSignatures()[0]?.getParameters()[0]
    const propsText = parameter
      ? checker.typeToString(checker.getTypeOfSymbolAtLocation(parameter, typeArgument))
      : undefined
    info.slots.push({
      name: property.name,
      ...(propsText ? { propsText } : {}),
      node: property.valueDeclaration ?? typeArgument
    })
  }
}

/** `defineModel()` is a prop named `modelValue` (or the given name) plus an `update:<name>` event. */
function defineModelMacro(state: State, call: ts.CallExpression): void {
  const { analysis, info } = state
  const first = call.arguments[0] ? unwrap(call.arguments[0]) : undefined
  const named = first && ts.isStringLiteralLike(first)
  const name = named ? first.text : "modelValue"
  const options = (named ? call.arguments[1] : call.arguments[0]) as ts.Expression | undefined
  const object = options ? unwrap(options) : undefined
  const checker = analysis.checker
  const typeArgument = call.typeArguments?.[0]
  const typeText = typeArgument ? collapse(typeArgument.getText()) : "unknown"
  let kind: MemberKind = "unknown"
  let allowedValues: Array<string | number | boolean> | undefined
  if (typeArgument) {
    const allowed = literalDomain(checker, typeArgument)
    kind =
      allowed && allowed.length > 0 && !allowed.every((v) => typeof v === "boolean")
        ? "enum"
        : classifyKind(checker, checker.getTypeFromTypeNode(typeArgument), typeText, RENDERABLE)
    if (kind === "enum") allowedValues = allowed
  } else if (object && ts.isObjectLiteralExpression(object)) {
    const type = object.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === "type")
    if (type && ts.isPropertyAssignment(type)) kind = runtimeSpec(analysis, unwrap(type.initializer)).kind
  }
  let required = false
  let fallback: DefaultSpec | undefined
  if (object && ts.isObjectLiteralExpression(object)) {
    for (const p of object.properties) {
      if (!ts.isPropertyAssignment(p)) continue
      if (p.name.getText() === "required") required = unwrap(p.initializer).kind === ts.SyntaxKind.TrueKeyword
      if (p.name.getText() === "default") fallback = specOf(p.initializer)
    }
  }
  info.props.push({
    name,
    typeText,
    kind,
    required,
    ...(fallback?.value !== undefined ? { default: fallback.value } : {}),
    ...(fallback && fallback.value === undefined ? { defaultExpression: fallback.expression } : {}),
    ...(allowedValues ? { allowedValues } : {}),
    source: "model",
    node: call
  })
  info.emits.push({ name: `update:${name}`, payloadText: typeText, source: "model", node: call })
}

/** `export default { … }` and `defineComponent({ … })`. */
function optionsObject(node: ts.Expression): ts.ObjectLiteralExpression | undefined {
  if (ts.isObjectLiteralExpression(node)) return node
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "defineComponent" &&
    node.arguments[0]
  ) {
    const arg = unwrap(node.arguments[0])
    return ts.isObjectLiteralExpression(arg) ? arg : undefined
  }
  return undefined
}

function readOptions(state: State, options: ts.ObjectLiteralExpression): void {
  const { info } = state
  info.optionsApi = true
  readOptionMetadata(info, options)
  for (const p of options.properties) {
    if (!ts.isPropertyAssignment(p) || !p.name) continue
    const key = p.name.getText().replace(/^["']|["']$/g, "")
    if (key === "props") readRuntimeProps(state, unwrap(p.initializer))
    else if (key === "emits") readRuntimeEmits(info, unwrap(p.initializer))
  }
}

function readOptionMetadata(info: ScriptInfo, options: ts.ObjectLiteralExpression): void {
  for (const p of options.properties) {
    if (!ts.isPropertyAssignment(p) || !p.name) continue
    const key = p.name.getText().replace(/^["']|["']$/g, "")
    const value = unwrap(p.initializer)
    if (key === "name" && ts.isStringLiteralLike(value)) info.options.name = value.text
    if (key === "inheritAttrs") info.options.inheritAttrs = value.kind === ts.SyntaxKind.TrueKeyword
  }
}

function readImports(sf: ts.SourceFile): Map<string, string> {
  const imports = new Map<string, string>()
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const clause = statement.importClause
    if (clause?.name) imports.set(clause.name.text, statement.moduleSpecifier.text)
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const e of clause.namedBindings.elements)
        imports.set(e.name.text, `${statement.moduleSpecifier.text}#${(e.propertyName ?? e.name).text}`)
    }
  }
  return imports
}
