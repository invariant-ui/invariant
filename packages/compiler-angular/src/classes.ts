import {
  type Analysis,
  allowedValuesOf,
  classifyKind,
  collapse,
  declarationOf,
  externalBases,
  isProjectNode,
  lineOf,
  literalValue,
  type MemberKind,
  relativeFileOf,
  resolveSymbol,
  unwrap
} from "@invariant/compiler-core"
import type { JsonValue } from "@invariant/shared"
import ts from "typescript"

export interface NameRef {
  name: string
  /** Project-relative file and declaration name when the reference resolves to the project. */
  file?: string
  localName?: string
}

export interface AngularInput {
  /** Public (template) name: the alias when there is one. */
  name: string
  property: string
  kind: "input" | "signal-input" | "model"
  typeText: string
  typeKind: MemberKind
  required: boolean
  default?: JsonValue
  defaultExpression?: string
  allowedValues?: Array<string | number | boolean>
  alias?: string
  transform?: string
  writeType?: string
  typeInferred?: boolean
  description?: string
  deprecated?: { reason?: string }
  inheritedFrom?: string
  node: ts.Node
}

export interface AngularOutput {
  name: string
  property: string
  kind: "output" | "signal-output" | "model"
  payloadText?: string
  alias?: string
  description?: string
  inheritedFrom?: string
  node: ts.Node
}

export interface ClassMetadata {
  node: ts.ClassDeclaration
  name: string
  file: string
  line: number
  kind: "component" | "directive" | "module"
  selector?: string
  standalone?: boolean
  imports: NameRef[]
  declarations: NameRef[]
  exports: NameRef[]
  template?: { inline: string; line: number } | { url: string }
  styles: Array<{ text: string; line: number }>
  styleUrls: string[]
  host: Record<string, string>
  changeDetection?: string
  encapsulation?: string
  exportAs?: string
  hostDirectives: string[]
  metadataInputs: string[]
  metadataOutputs: string[]
  inputs: AngularInput[]
  outputs: AngularOutput[]
  hostListeners: string[]
  hostBindings: string[]
  queries: Array<{ kind: string; property: string; selector?: string }>
  inheritsFrom: string[]
  notes: string[]
}

const CORE = "@angular/core"
const SIGNAL_INPUTS = new Set(["input", "model"])

/** Local names bound to `@angular/core` exports in a file: `Component`, or `Cmp` for `import { Component as Cmp }`. */
export function coreBindings(sf: ts.SourceFile): Map<string, string> {
  const bindings = new Map<string, string>()
  for (const statement of sf.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== CORE
    )
      continue
    const named = statement.importClause?.namedBindings
    if (named && ts.isNamedImports(named))
      for (const e of named.elements) bindings.set(e.name.text, (e.propertyName ?? e.name).text)
    if (named && ts.isNamespaceImport(named)) bindings.set(`${named.name.text}.`, "*")
  }
  return bindings
}

/** Reads a class decorated with `@Component`, `@Directive` or `@NgModule`. Nothing is executed. */
export function readClass(analysis: Analysis, node: ts.ClassDeclaration): ClassMetadata | undefined {
  const sf = node.getSourceFile()
  const bindings = coreBindings(sf)
  const decorator = classDecorator(node, bindings)
  if (!decorator || !node.name) return undefined
  const file = relativeFileOf(analysis, node)
  if (!file) return undefined
  const meta =
    decorator.call.arguments[0] && ts.isObjectLiteralExpression(unwrap(decorator.call.arguments[0]))
      ? (unwrap(decorator.call.arguments[0]) as ts.ObjectLiteralExpression)
      : undefined
  const result: ClassMetadata = {
    node,
    name: node.name.text,
    file,
    line: lineOf(node),
    kind:
      decorator.name === "Component" ? "component" : decorator.name === "Directive" ? "directive" : "module",
    imports: [],
    declarations: [],
    exports: [],
    styles: [],
    styleUrls: [],
    host: {},
    hostDirectives: [],
    metadataInputs: [],
    metadataOutputs: [],
    inputs: [],
    outputs: [],
    hostListeners: [],
    hostBindings: [],
    queries: [],
    inheritsFrom: [],
    notes: []
  }
  if (meta) readMetadata(analysis, meta, result)
  readMembers(analysis, node, result, undefined, new Set())
  return result
}

function classDecorator(
  node: ts.ClassDeclaration,
  bindings: Map<string, string>
): { name: "Component" | "Directive" | "NgModule"; call: ts.CallExpression } | undefined {
  for (const d of ts.getDecorators(node) ?? []) {
    if (!ts.isCallExpression(d.expression)) continue
    const canonical = coreName(d.expression.expression, bindings)
    if (canonical === "Component" || canonical === "Directive" || canonical === "NgModule")
      return { name: canonical, call: d.expression }
  }
  return undefined
}

/** `Component`, or `core.Component` when `@angular/core` is a namespace import. */
function coreName(expression: ts.Expression, bindings: Map<string, string>): string | undefined {
  if (ts.isIdentifier(expression)) return bindings.get(expression.text)
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    bindings.has(`${expression.expression.text}.`)
  )
    return expression.name.text
  return undefined
}

function property(object: ts.ObjectLiteralExpression, key: string): ts.PropertyAssignment | undefined {
  const p = object.properties.find(
    (x) =>
      ts.isPropertyAssignment(x) &&
      (ts.isIdentifier(x.name) || ts.isStringLiteralLike(x.name)) &&
      x.name.text === key
  )
  return p && ts.isPropertyAssignment(p) ? p : undefined
}

function stringOf(node: ts.Expression | undefined): string | undefined {
  const n = node ? unwrap(node) : undefined
  return n && ts.isStringLiteralLike(n) ? n.text : undefined
}

function readMetadata(analysis: Analysis, meta: ts.ObjectLiteralExpression, out: ClassMetadata): void {
  const selector = stringOf(property(meta, "selector")?.initializer)
  if (selector !== undefined) out.selector = selector
  else if (property(meta, "selector")) out.notes.push("selector is not a string literal")
  const standalone = property(meta, "standalone")?.initializer
  if (standalone) {
    const v = unwrap(standalone)
    if (v.kind === ts.SyntaxKind.TrueKeyword) out.standalone = true
    else if (v.kind === ts.SyntaxKind.FalseKeyword) out.standalone = false
  }
  out.imports = nameRefs(analysis, property(meta, "imports")?.initializer)
  out.declarations = nameRefs(analysis, property(meta, "declarations")?.initializer)
  out.exports = nameRefs(analysis, property(meta, "exports")?.initializer)
  out.hostDirectives = nameRefs(analysis, property(meta, "hostDirectives")?.initializer).map((r) => r.name)

  const template = property(meta, "template")?.initializer
  const templateUrl = stringOf(property(meta, "templateUrl")?.initializer)
  if (template) {
    const t = unwrap(template)
    if (ts.isStringLiteralLike(t)) out.template = { inline: t.text, line: lineOf(t) }
    else out.notes.push("template is not a static string")
  } else if (templateUrl) out.template = { url: templateUrl }

  const styles = property(meta, "styles")?.initializer
  if (styles) {
    const s = unwrap(styles)
    const items = ts.isArrayLiteralExpression(s) ? s.elements.map(unwrap) : [s]
    for (const item of items) {
      if (ts.isStringLiteralLike(item)) out.styles.push({ text: item.text, line: lineOf(item) })
      else out.notes.push("a styles entry is not a static string")
    }
  }
  const styleUrl = stringOf(property(meta, "styleUrl")?.initializer)
  if (styleUrl) out.styleUrls.push(styleUrl)
  const styleUrls = property(meta, "styleUrls")?.initializer
  if (styleUrls && ts.isArrayLiteralExpression(unwrap(styleUrls))) {
    for (const e of (unwrap(styleUrls) as ts.ArrayLiteralExpression).elements) {
      const text = stringOf(e)
      if (text) out.styleUrls.push(text)
    }
  }

  const host = property(meta, "host")?.initializer
  if (host && ts.isObjectLiteralExpression(unwrap(host))) {
    for (const p of (unwrap(host) as ts.ObjectLiteralExpression).properties) {
      if (ts.isPropertyAssignment(p) && (ts.isStringLiteralLike(p.name) || ts.isIdentifier(p.name)))
        out.host[p.name.text] = stringOf(p.initializer) ?? collapse(p.initializer.getText()).slice(0, 120)
    }
  }
  const lastName = (expr: ts.Expression | undefined): string | undefined =>
    expr ? collapse(expr.getText()).split(".").pop() : undefined
  const change = lastName(property(meta, "changeDetection")?.initializer)
  if (change) out.changeDetection = change
  const encapsulation = lastName(property(meta, "encapsulation")?.initializer)
  if (encapsulation) out.encapsulation = encapsulation
  const exportAs = stringOf(property(meta, "exportAs")?.initializer)
  if (exportAs) out.exportAs = exportAs
  for (const [key, target] of [
    ["inputs", out.metadataInputs],
    ["outputs", out.metadataOutputs]
  ] as const) {
    const arr = property(meta, key)?.initializer
    if (arr && ts.isArrayLiteralExpression(unwrap(arr))) {
      for (const e of (unwrap(arr) as ts.ArrayLiteralExpression).elements) {
        const text = stringOf(e)
        if (text) target.push(text)
      }
    }
  }
}

function nameRefs(analysis: Analysis, expression: ts.Expression | undefined): NameRef[] {
  const array = expression ? unwrap(expression) : undefined
  if (!array || !ts.isArrayLiteralExpression(array)) return []
  const refs: NameRef[] = []
  for (const element of array.elements) {
    const e = ts.isSpreadElement(element) ? element.expression : element
    const name = ts.isObjectLiteralExpression(e) ? collapse(e.getText()).slice(0, 80) : collapse(e.getText())
    const target =
      ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)
        ? declarationOf(resolveSymbol(analysis.checker, analysis.checker.getSymbolAtLocation(e)))
        : undefined
    const file = target && isProjectNode(analysis, target) ? relativeFileOf(analysis, target) : undefined
    const localName =
      target && "name" in target && target.name && ts.isIdentifier(target.name as ts.Node)
        ? (target.name as ts.Identifier).text
        : undefined
    refs.push({ name, ...(file ? { file } : {}), ...(file && localName ? { localName } : {}) })
  }
  return refs
}

function readMembers(
  analysis: Analysis,
  node: ts.ClassDeclaration,
  out: ClassMetadata,
  inheritedFrom: string | undefined,
  seen: Set<ts.ClassDeclaration>
): void {
  if (seen.has(node)) return
  seen.add(node)
  const bindings = coreBindings(node.getSourceFile())
  for (const member of node.members) {
    if (
      !ts.isPropertyDeclaration(member) &&
      !ts.isSetAccessorDeclaration(member) &&
      !ts.isMethodDeclaration(member) &&
      !ts.isGetAccessorDeclaration(member)
    )
      continue
    if (!member.name || !(ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name))) continue
    const property = member.name.text
    const symbol = analysis.checker.getSymbolAtLocation(member.name)
    const doc = symbol ? ts.displayPartsToString(symbol.getDocumentationComment(analysis.checker)).trim() : ""
    const depTag = symbol?.getJsDocTags(analysis.checker).find((t) => t.name === "deprecated")
    const common = {
      ...(doc ? { description: doc } : {}),
      ...(depTag
        ? {
            deprecated: ts.displayPartsToString(depTag.text).trim()
              ? { reason: ts.displayPartsToString(depTag.text).trim() }
              : {}
          }
        : {}),
      ...(inheritedFrom ? { inheritedFrom } : {})
    }
    for (const d of ts.getDecorators(member) ?? []) {
      const call = ts.isCallExpression(d.expression) ? d.expression : undefined
      const callee = call ? call.expression : d.expression
      const name = coreName(callee, bindings)
      if (name === "Input") out.inputs.push(decoratorInput(analysis, member, property, call, common))
      else if (name === "Output") out.outputs.push(decoratorOutput(member, property, call, common))
      else if (name === "HostBinding" && call)
        out.hostBindings.push(`${stringOf(call.arguments[0]) ?? property}`)
      else if (name === "HostListener" && call)
        out.hostListeners.push(stringOf(call.arguments[0]) ?? property)
      else if (name && /^(Content|View)Child(ren)?$/.test(name)) {
        const sel = call?.arguments[0]
          ? (stringOf(call.arguments[0]) ?? collapse(call.arguments[0].getText()))
          : undefined
        out.queries.push({ kind: name, property, ...(sel ? { selector: sel } : {}) })
      }
    }
    if (ts.isPropertyDeclaration(member) && member.initializer)
      readSignalMember(analysis, member, property, bindings, out, common)
  }
  readBase(analysis, node, out, seen)
}

function readSignalMember(
  analysis: Analysis,
  member: ts.PropertyDeclaration,
  property: string,
  bindings: Map<string, string>,
  out: ClassMetadata,
  common: Partial<AngularInput>
): void {
  const init = unwrap(member.initializer as ts.Expression)
  if (!ts.isCallExpression(init)) return
  const callee = init.expression
  const base =
    ts.isPropertyAccessExpression(callee) && callee.name.text === "required" ? callee.expression : callee
  const required = ts.isPropertyAccessExpression(callee) && callee.name.text === "required"
  const fn = coreName(base, bindings)
  if (fn && SIGNAL_INPUTS.has(fn)) {
    const optionsArg = required ? init.arguments[0] : init.arguments[1]
    const options =
      optionsArg && ts.isObjectLiteralExpression(unwrap(optionsArg))
        ? (unwrap(optionsArg) as ts.ObjectLiteralExpression)
        : undefined
    const alias = options ? stringOf(propertyOf(options, "alias")?.initializer) : undefined
    const transform = options ? propertyOf(options, "transform")?.initializer : undefined
    const firstGeneric = init.typeArguments?.[0]
    const secondGeneric = init.typeArguments?.[1]
    const defaultNode = required ? undefined : init.arguments[0]
    const fallback = defaultNode ? literalValue(defaultNode) : undefined
    const inferred = !firstGeneric ? inferLiteralType(defaultNode) : undefined
    const typeInfo = firstGeneric
      ? typeInfoOf(analysis, firstGeneric)
      : { text: inferred ?? "unknown", kind: kindOfLiteral(inferred), allowedValues: undefined }
    const input: AngularInput = {
      name: alias ?? property,
      property,
      kind: fn === "model" ? "model" : "signal-input",
      typeText: typeInfo.text,
      typeKind: typeInfo.kind,
      required,
      ...(fallback !== undefined ? { default: fallback } : {}),
      ...(defaultNode && fallback === undefined
        ? { defaultExpression: collapse(defaultNode.getText()).slice(0, 200) }
        : {}),
      ...(typeInfo.allowedValues ? { allowedValues: typeInfo.allowedValues } : {}),
      ...(alias ? { alias } : {}),
      ...(transform ? { transform: collapse(transform.getText()) } : {}),
      ...(secondGeneric ? { writeType: collapse(secondGeneric.getText()) } : {}),
      ...(inferred ? { typeInferred: true } : {}),
      ...common,
      node: member
    }
    out.inputs.push(input)
    if (fn === "model")
      out.outputs.push({
        name: `${alias ?? property}Change`,
        property,
        kind: "model",
        payloadText: typeInfo.text,
        ...(common.inheritedFrom ? { inheritedFrom: common.inheritedFrom } : {}),
        node: member
      })
    return
  }
  if (fn === "output") {
    const optionsArg = init.arguments[0]
    const options =
      optionsArg && ts.isObjectLiteralExpression(unwrap(optionsArg))
        ? (unwrap(optionsArg) as ts.ObjectLiteralExpression)
        : undefined
    const alias = options ? stringOf(propertyOf(options, "alias")?.initializer) : undefined
    out.outputs.push({
      name: alias ?? property,
      property,
      kind: "signal-output",
      ...(init.typeArguments?.[0] ? { payloadText: collapse(init.typeArguments[0].getText()) } : {}),
      ...(alias ? { alias } : {}),
      ...(common.description ? { description: common.description } : {}),
      ...(common.inheritedFrom ? { inheritedFrom: common.inheritedFrom } : {}),
      node: member
    })
    return
  }
  if (fn === "outputFromObservable") out.notes.push(`outputFromObservable (${property}) is not analyzed`)
  if (fn && /^(content|view)Child(ren)?$/.test(fn)) {
    const sel = init.arguments[0]
      ? (stringOf(init.arguments[0]) ?? collapse(init.arguments[0].getText()))
      : undefined
    out.queries.push({ kind: fn, property, ...(sel ? { selector: sel } : {}) })
  }
}

function decoratorInput(
  analysis: Analysis,
  member: ts.ClassElement,
  property: string,
  call: ts.CallExpression | undefined,
  common: Partial<AngularInput>
): AngularInput {
  const arg = call?.arguments[0] ? unwrap(call.arguments[0]) : undefined
  const options = arg && ts.isObjectLiteralExpression(arg) ? arg : undefined
  const alias =
    arg && ts.isStringLiteralLike(arg)
      ? arg.text
      : options
        ? stringOf(propertyOf(options, "alias")?.initializer)
        : undefined
  const required = options
    ? unwrap(propertyOf(options, "required")?.initializer ?? ts.factory.createFalse()).kind ===
      ts.SyntaxKind.TrueKeyword
    : false
  const transform = options ? propertyOf(options, "transform")?.initializer : undefined
  const typeNode = ts.isPropertyDeclaration(member)
    ? member.type
    : ts.isSetAccessorDeclaration(member)
      ? member.parameters[0]?.type
      : undefined
  const init = ts.isPropertyDeclaration(member) ? member.initializer : undefined
  const fallback = init ? literalValue(init) : undefined
  // Without a written type, a literal initializer fixes the type (string, number or boolean), as in TypeScript.
  const literalType = typeNode ? undefined : inferLiteralType(init)
  // Otherwise ask the checker: it can infer a type from the project's own declarations (a config class).
  const checked =
    !typeNode && !literalType && ts.isPropertyDeclaration(member) ? checkedType(analysis, member) : undefined
  const inferred = literalType ?? checked?.text
  const info = typeNode
    ? typeInfoOf(analysis, typeNode)
    : checked
      ? { text: checked.text, kind: checked.kind, allowedValues: undefined }
      : { text: literalType ?? "unknown", kind: kindOfLiteral(literalType), allowedValues: undefined }
  return {
    name: alias ?? property,
    property,
    kind: "input",
    typeText: info.text,
    typeKind: info.kind,
    required,
    ...(fallback !== undefined ? { default: fallback } : {}),
    ...(init && fallback === undefined ? { defaultExpression: collapse(init.getText()).slice(0, 200) } : {}),
    ...(info.allowedValues ? { allowedValues: info.allowedValues } : {}),
    ...(alias ? { alias } : {}),
    ...(transform ? { transform: collapse(transform.getText()) } : {}),
    ...(inferred ? { typeInferred: true } : {}),
    ...common,
    node: member
  }
}

function decoratorOutput(
  member: ts.ClassElement,
  property: string,
  call: ts.CallExpression | undefined,
  common: Partial<AngularInput>
): AngularOutput {
  const alias = call?.arguments[0] ? stringOf(call.arguments[0]) : undefined
  const init = ts.isPropertyDeclaration(member) && member.initializer ? unwrap(member.initializer) : undefined
  const payload =
    init && ts.isNewExpression(init) && init.typeArguments?.[0]
      ? collapse(init.typeArguments[0].getText())
      : undefined
  return {
    name: alias ?? property,
    property,
    kind: "output",
    ...(payload ? { payloadText: payload } : {}),
    ...(alias ? { alias } : {}),
    ...(common.description ? { description: common.description } : {}),
    ...(common.inheritedFrom ? { inheritedFrom: common.inheritedFrom } : {}),
    node: member
  }
}

function readBase(
  analysis: Analysis,
  node: ts.ClassDeclaration,
  out: ClassMetadata,
  seen: Set<ts.ClassDeclaration>
): void {
  const base = node.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]
  if (!base) return
  const target = declarationOf(
    resolveSymbol(analysis.checker, analysis.checker.getSymbolAtLocation(base.expression))
  )
  if (target && ts.isClassDeclaration(target) && isProjectNode(analysis, target)) {
    readMembers(analysis, target, out, target.name?.text, seen)
    if (ts.getDecorators(target)?.length) readInheritedMetadata(analysis, target, out)
  } else out.inheritsFrom.push(...externalBases(analysis, base))
}

/** Metadata `inputs`/`outputs` arrays of a decorated base class also apply to its subclasses. */
function readInheritedMetadata(analysis: Analysis, base: ts.ClassDeclaration, out: ClassMetadata): void {
  const parent = readClass(analysis, base)
  if (parent) {
    out.metadataInputs.push(...parent.metadataInputs)
    out.metadataOutputs.push(...parent.metadataOutputs)
  }
}

function propertyOf(object: ts.ObjectLiteralExpression, key: string): ts.PropertyAssignment | undefined {
  return property(object, key)
}

function typeInfoOf(
  analysis: Analysis,
  node: ts.TypeNode
): { text: string; kind: MemberKind; allowedValues: Array<string | number | boolean> | undefined } {
  const { checker } = analysis
  const text = collapse(node.getText())
  const type = checker.getTypeFromTypeNode(node)
  const kind = classifyKind(checker, type, text)
  return { text, kind, allowedValues: allowedValuesOf(checker, node, type, kind) }
}

/** The checker's inferred type of a property, unless it is unresolved (`any`/`unknown`). */
function checkedType(
  analysis: Analysis,
  member: ts.PropertyDeclaration
): { text: string; kind: MemberKind } | undefined {
  const { checker } = analysis
  const type = checker.getTypeAtLocation(member.name)
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return undefined
  const text = checker.typeToString(type)
  return { text, kind: classifyKind(checker, type, text) }
}

function inferLiteralType(node: ts.Expression | undefined): string | undefined {
  const n = node ? unwrap(node) : undefined
  if (!n) return undefined
  if (ts.isStringLiteralLike(n)) return "string"
  if (ts.isNumericLiteral(n)) return "number"
  if (n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword) return "boolean"
  return undefined
}

function kindOfLiteral(text: string | undefined): MemberKind {
  return text === "string" || text === "number" || text === "boolean" ? text : "unknown"
}
