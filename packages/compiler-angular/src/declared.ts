import {
  type Analysis,
  collapse,
  declarationOf,
  externalBases,
  hasModifier,
  isProjectNode,
  lineOf,
  relativeFileOf,
  resolveSymbol,
  typeReferenceInfo
} from "@invariant/compiler-core"
import ts from "typescript"
import {
  type AngularInput,
  type AngularOutput,
  type ClassMetadata,
  type NameRef,
  typeInfoOf
} from "./classes.js"
import { slotName } from "./template.js"

const DECLARATIONS = {
  ɵɵComponentDeclaration: "component",
  ɵɵDirectiveDeclaration: "directive",
  ɵɵNgModuleDeclaration: "module"
} as const
const MARKERS = new Set(["ɵcmp", "ɵdir", "ɵmod"])
/** Positions of `ɵɵComponentDeclaration<T, Selector, ExportAs, Inputs, Outputs, Queries, NgContent, Standalone, HostDirectives>`. */
const SELECTOR = 1
const EXPORT_AS = 2
const INPUTS = 3
const OUTPUTS = 4
const NG_CONTENT = 6
const STANDALONE = 7
const HOST_DIRECTIVES = 8
const SIGNAL_INPUTS: Record<string, "signal-input" | "model"> = {
  InputSignal: "signal-input",
  InputSignalWithTransform: "signal-input",
  ModelSignal: "model"
}

/**
 * Reads a class of a declaration file the way the Angular compiler wrote it. A published library has no
 * decorators left: ng-packagr emits `static ɵcmp: ɵɵComponentDeclaration<Button, "ui-button", never, { "variant":
 * { "alias": "variant"; "required": false } }, { "clicked": "clicked" }, never, ["*"], true>` for a component
 * (`ɵdir` for a directive, `ɵmod` for an NgModule). That type is the compiled metadata: selector, public input and
 * output names, projection slots and standalone. Property types come from the class members. Nothing is executed.
 */
export function readDeclaredClass(
  analysis: Analysis,
  node: ts.ClassDeclaration,
  seen: Set<ts.ClassDeclaration> = new Set()
): ClassMetadata | undefined {
  if (!node.name || !node.getSourceFile().isDeclarationFile || seen.has(node)) return undefined
  seen.add(node)
  const file = relativeFileOf(analysis, node)
  const marker = node.members.find(
    (m): m is ts.PropertyDeclaration =>
      ts.isPropertyDeclaration(m) &&
      hasModifier(m, ts.SyntaxKind.StaticKeyword) &&
      ts.isIdentifier(m.name) &&
      MARKERS.has(m.name.text)
  )
  const ref = marker?.type ? typeReferenceInfo(marker.type) : undefined
  const kind = ref ? (DECLARATIONS as Record<string, ClassMetadata["kind"]>)[ref.name] : undefined
  if (!file || !ref || !kind) return undefined

  const out: ClassMetadata = {
    node,
    name: node.name.text,
    file,
    line: lineOf(node),
    kind,
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
  const arg = (i: number): ts.TypeNode | undefined => ref.typeArguments[i]
  if (kind === "module") {
    out.declarations = namesOf(analysis, arg(1))
    out.imports = namesOf(analysis, arg(2))
    out.exports = namesOf(analysis, arg(3))
    return out
  }

  const selector = stringOf(arg(SELECTOR))
  if (selector !== undefined) out.selector = selector
  const standalone = arg(STANDALONE)?.getText()
  if (standalone === "true" || standalone === "false") out.standalone = standalone === "true"
  const exportAs = tupleOf(arg(EXPORT_AS))[0]
  if (exportAs !== undefined) out.exportAs = exportAs
  out.hostDirectives = hostDirectivesOf(arg(HOST_DIRECTIVES))
  const used = new Set<string>()
  out.projection = tupleOf(arg(NG_CONTENT)).map((select) => {
    let name = select === "*" ? "default" : slotName(select)
    for (let n = 2; used.has(name); n++) name = `${select === "*" ? "default" : slotName(select)}_${n}`
    used.add(name)
    return { name, ...(select === "*" ? {} : { select }) }
  })

  const members = membersOf(node)
  for (const [property, spec] of inputMap(arg(INPUTS))) {
    out.inputs.push(inputOf(analysis, members, property, spec, node))
  }
  for (const [property, alias] of outputMap(arg(OUTPUTS))) {
    out.outputs.push(outputOf(analysis, members, out.inputs, property, alias, node))
  }

  const base = node.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]
  if (base) {
    const target = declarationOf(
      resolveSymbol(analysis.checker, analysis.checker.getSymbolAtLocation(base.expression))
    )
    const parent =
      target && ts.isClassDeclaration(target) && isProjectNode(analysis, target)
        ? readDeclaredClass(analysis, target, seen)
        : undefined
    if (parent) {
      for (const i of parent.inputs)
        if (!out.inputs.some((x) => x.name === i.name))
          out.inputs.push({ ...i, inheritedFrom: i.inheritedFrom ?? parent.name })
      for (const o of parent.outputs)
        if (!out.outputs.some((x) => x.name === o.name))
          out.outputs.push({ ...o, inheritedFrom: o.inheritedFrom ?? parent.name })
      out.inheritsFrom.push(...parent.inheritsFrom)
    } else out.inheritsFrom.push(...externalBases(analysis, base))
  }
  return out
}

function unparen(type: ts.TypeNode): ts.TypeNode {
  return ts.isParenthesizedTypeNode(type) ? unparen(type.type) : type
}

/** `"ui-button"`; `never` and anything else is undefined. */
function stringOf(type: ts.TypeNode | undefined): string | undefined {
  const t = type ? unparen(type) : undefined
  return t && ts.isLiteralTypeNode(t) && ts.isStringLiteralLike(t.literal) ? t.literal.text : undefined
}

/** `["*", "[header]"]`; `never` is the empty list. */
function tupleOf(type: ts.TypeNode | undefined): string[] {
  const t = type ? unparen(type) : undefined
  return t && ts.isTupleTypeNode(t) ? t.elements.flatMap((e) => stringOf(e) ?? []) : []
}

function keyOf(member: ts.TypeElement): string | undefined {
  return member.name && (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name))
    ? member.name.text
    : undefined
}

interface InputSpec {
  alias: string
  required: boolean
  isSignal: boolean
}

/** `{ "variant": { "alias": "variant"; "required": false; "isSignal": true } }`, or the older `{ "variant": "alias" }`. */
function inputMap(type: ts.TypeNode | undefined): Array<[string, InputSpec]> {
  const t = type ? unparen(type) : undefined
  if (!t || !ts.isTypeLiteralNode(t)) return []
  const out: Array<[string, InputSpec]> = []
  for (const member of t.members) {
    const property = keyOf(member)
    if (property === undefined || !ts.isPropertySignature(member) || !member.type) continue
    const value = unparen(member.type)
    const alias = stringOf(value)
    if (alias !== undefined) {
      out.push([property, { alias, required: false, isSignal: false }])
      continue
    }
    if (!ts.isTypeLiteralNode(value)) continue
    const field = (key: string): ts.TypeNode | undefined =>
      value.members.find((m): m is ts.PropertySignature => ts.isPropertySignature(m) && keyOf(m) === key)
        ?.type
    out.push([
      property,
      {
        alias: stringOf(field("alias")) ?? property,
        required: field("required")?.getText() === "true",
        isSignal: field("isSignal")?.getText() === "true"
      }
    ])
  }
  return out
}

/** `{ "clicked": "clicked" }`: class property to public event name. */
function outputMap(type: ts.TypeNode | undefined): Array<[string, string]> {
  const t = type ? unparen(type) : undefined
  if (!t || !ts.isTypeLiteralNode(t)) return []
  return t.members.flatMap((member): Array<[string, string]> => {
    const property = keyOf(member)
    const alias = ts.isPropertySignature(member) ? stringOf(member.type) : undefined
    return property !== undefined && alias !== undefined ? [[property, alias]] : []
  })
}

function hostDirectivesOf(type: ts.TypeNode | undefined): string[] {
  const t = type ? unparen(type) : undefined
  if (!t || !ts.isTupleTypeNode(t)) return []
  return t.elements.flatMap((e) => {
    const literal = ts.isTypeLiteralNode(unparen(e)) ? (unparen(e) as ts.TypeLiteralNode) : undefined
    const directive = literal?.members.find(
      (m): m is ts.PropertySignature => ts.isPropertySignature(m) && keyOf(m) === "directive"
    )?.type
    return directive && ts.isTypeQueryNode(directive) ? [collapse(directive.exprName.getText())] : []
  })
}

function namesOf(analysis: Analysis, type: ts.TypeNode | undefined): NameRef[] {
  const t = type ? unparen(type) : undefined
  if (!t || !ts.isTupleTypeNode(t)) return []
  return t.elements.map((element): NameRef => {
    const e = unparen(element)
    if (!ts.isTypeQueryNode(e)) return { name: collapse(e.getText()) }
    const target = declarationOf(
      resolveSymbol(analysis.checker, analysis.checker.getSymbolAtLocation(e.exprName))
    )
    const file = target && isProjectNode(analysis, target) ? relativeFileOf(analysis, target) : undefined
    const localName =
      target && "name" in target && target.name && ts.isIdentifier(target.name as ts.Node)
        ? (target.name as ts.Identifier).text
        : undefined
    return {
      name: collapse(e.exprName.getText()),
      ...(file ? { file } : {}),
      ...(file && localName ? { localName } : {})
    }
  })
}

interface Member {
  node: ts.ClassElement
  type?: ts.TypeNode
}

/** Property types by name; a setter's parameter type wins over the getter's, as it is what an input accepts. */
function membersOf(node: ts.ClassDeclaration): Map<string, Member> {
  const out = new Map<string, Member>()
  for (const member of node.members) {
    if (!member.name || !(ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name))) continue
    const name = member.name.text
    if (ts.isSetAccessorDeclaration(member))
      out.set(name, {
        node: member,
        ...(member.parameters[0]?.type ? { type: member.parameters[0].type } : {})
      })
    else if (ts.isPropertyDeclaration(member) || ts.isGetAccessorDeclaration(member)) {
      if (!out.has(name) || !ts.isSetAccessorDeclaration(out.get(name)?.node as ts.ClassElement))
        out.set(name, { node: member, ...(member.type ? { type: member.type } : {}) })
    }
  }
  return out
}

function docOf(
  analysis: Analysis,
  member: ts.ClassElement | undefined
): { description?: string; deprecated?: { reason?: string } } {
  const symbol = member?.name ? analysis.checker.getSymbolAtLocation(member.name) : undefined
  if (!symbol) return {}
  const doc = ts.displayPartsToString(symbol.getDocumentationComment(analysis.checker)).trim()
  const tag = symbol.getJsDocTags(analysis.checker).find((t) => t.name === "deprecated")
  const reason = tag ? ts.displayPartsToString(tag.text).trim() : ""
  return {
    ...(doc ? { description: doc } : {}),
    ...(tag ? { deprecated: reason ? { reason } : {} } : {})
  }
}

function inputOf(
  analysis: Analysis,
  members: Map<string, Member>,
  property: string,
  spec: InputSpec,
  cls: ts.ClassDeclaration
): AngularInput {
  const member = members.get(property)
  const ref = member?.type ? typeReferenceInfo(member.type) : undefined
  const signalKind = ref ? SIGNAL_INPUTS[ref.name] : undefined
  const kind = signalKind ?? (spec.isSignal ? "signal-input" : "input")
  // `InputSignal<T>` and `ModelSignal<T>` wrap the value type; `InputSignalWithTransform<T, W>` also names what is written.
  const valueType = signalKind ? ref?.typeArguments[0] : member?.type
  const info = valueType
    ? typeInfoOf(analysis, valueType)
    : { text: "unknown", kind: "unknown" as const, allowedValues: undefined }
  const accepted = cls.members.find(
    (m): m is ts.PropertyDeclaration =>
      ts.isPropertyDeclaration(m) &&
      ts.isIdentifier(m.name) &&
      m.name.text === `ngAcceptInputType_${property}`
  )?.type
  const writeType = ref?.typeArguments[1] ?? accepted
  return {
    name: spec.alias,
    property,
    kind,
    typeText: info.text,
    typeKind: info.kind,
    required: spec.required,
    ...(info.allowedValues ? { allowedValues: info.allowedValues } : {}),
    ...(spec.alias !== property ? { alias: spec.alias } : {}),
    ...(writeType ? { writeType: collapse(writeType.getText()) } : {}),
    ...docOf(analysis, member?.node),
    node: member?.node ?? cls
  }
}

function outputOf(
  analysis: Analysis,
  members: Map<string, Member>,
  inputs: readonly AngularInput[],
  property: string,
  alias: string,
  cls: ts.ClassDeclaration
): AngularOutput {
  const member = members.get(property)
  const ref = member?.type ? typeReferenceInfo(member.type) : undefined
  const payload = ref?.typeArguments[0] ? collapse(ref.typeArguments[0].getText()) : undefined
  // A `model()` declares an input and a `<name>Change` output with no class member of its own.
  const model = member ? undefined : inputs.find((i) => i.kind === "model" && `${i.name}Change` === alias)
  const { description } = docOf(analysis, member?.node)
  return {
    name: alias,
    property,
    kind: model ? "model" : ref?.name === "OutputEmitterRef" ? "signal-output" : "output",
    ...(model ? { payloadText: model.typeText } : payload ? { payloadText: payload } : {}),
    ...(alias !== property ? { alias } : {}),
    ...(description ? { description } : {}),
    node: member?.node ?? model?.node ?? cls
  }
}
