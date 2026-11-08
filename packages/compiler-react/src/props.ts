import type { Analysis, MemberKind } from "@invariant/compiler-core"
import {
  collapse,
  describeMember,
  externalBases,
  hasModifier,
  isProjectNode,
  literalValue,
  topLevelAssignments,
  unwrap
} from "@invariant/compiler-core"
import type { JsonValue } from "@invariant/shared"
import ts from "typescript"
import type { Candidate } from "./detect.js"

export type PropKind = MemberKind

export interface PropInfo {
  name: string
  typeText: string
  kind: PropKind
  required: boolean
  default?: JsonValue
  /** Source text of a default that is not a plain literal. */
  defaultExpression?: string
  allowedValues?: Array<string | number | boolean>
  description?: string
  deprecated?: { reason?: string }
  /** Declaring interface or alias when it is not the props type itself. */
  inheritedFrom?: string
  role: "prop" | "children" | "event-handler" | "slot" | "render-prop" | "ref"
  declaration: { node: ts.Node; line: number }
}

export interface PropsResult {
  props: PropInfo[]
  /** Base types whose props are not enumerated (external or unresolved). */
  inheritsFrom: string[]
  generics: string[]
  /** False when props cannot be fully enumerated. */
  complete: boolean
  skipped: string[]
  notes: string[]
}

const RENDERABLE_OR_COMPONENT_TYPE =
  /^(?:(?:React\.)?(?:ReactNode|ReactElement|ReactChild|ReactFragment|JSX\.Element)(?:<.*>)?|(?:React\.)?ComponentType\b.*)$/
const RENDER_FUNCTION = /=>\s*(?:React\.)?(?:ReactNode|ReactElement|JSX\.Element)\b/
const PROP_NAME = /^[A-Za-z0-9_:-]+$/

export function extractProps(analysis: Analysis, candidate: Candidate): PropsResult {
  const { checker } = analysis
  const notes: string[] = []
  const typeNode = candidate.propsTypeNode ?? firstParameterType(candidate)
  const generics =
    candidate.impl && ts.isFunctionLike(candidate.impl)
      ? (candidate.impl.typeParameters?.map((p) => p.name.text) ?? [])
      : []
  if (!typeNode) {
    if (candidate.kind === "lazy")
      notes.push("lazy component: props are defined by the dynamically imported module")
    else if (candidate.kind === "styled") notes.push("styled component without a props type argument")
    else notes.push("no props type could be determined from syntax")
    return { props: [], inheritsFrom: [], generics, complete: false, skipped: [], notes }
  }

  const type = checker.getTypeFromTypeNode(typeNode)
  const inheritsFrom = [...new Set(externalBases(analysis, typeNode))].sort()
  const defaults = collectDefaults(candidate)
  const rootName = declaredTypeName(typeNode)
  const props: PropInfo[] = []
  const skipped: string[] = []

  // One member that does not resolve (a type from a package that is not installed) turns the whole intersection into
  // `any`; reading the members one by one keeps the props of the rest.
  const parts = ts.isIntersectionTypeNode(typeNode) && (type.flags & ts.TypeFlags.Any) !== 0 ? typeNode.types.map((n) => checker.getTypeFromTypeNode(n)) : [type]
  const seen = new Set<string>()
  for (const part of parts) {
    if ((part.flags & ts.TypeFlags.Any) !== 0) continue
    for (const symbol of checker.getPropertiesOfType(part)) {
      if (seen.has(symbol.name)) continue
      seen.add(symbol.name)
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
      if (!declaration || !isProjectNode(analysis, declaration)) continue
      if (!PROP_NAME.test(symbol.name)) {
        skipped.push(symbol.name)
        continue
      }
      props.push(describeProp({ analysis, symbol, declaration, rootName, defaults, candidate }))
    }
  }
  props.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const resolvedAny = (type.flags & ts.TypeFlags.Any) !== 0
  if (resolvedAny) notes.push("props type did not resolve")
  if (candidate.propsUnknown && props.length === 0) notes.push("props type did not resolve")
  return {
    props,
    inheritsFrom,
    generics,
    complete:
      !candidate.openProps &&
      inheritsFrom.length === 0 &&
      skipped.length === 0 &&
      !resolvedAny &&
      !(candidate.propsUnknown && props.length === 0),
    skipped,
    notes
  }
}

function describeProp(input: {
  analysis: Analysis
  symbol: ts.Symbol
  declaration: ts.Declaration
  rootName: string | undefined
  defaults: Map<string, { value?: JsonValue; expression: string }>
  candidate: Candidate
}): PropInfo {
  const { analysis, symbol, declaration, rootName, defaults } = input
  const member = describeMember(analysis, symbol, declaration, { renderable: RENDERABLE_OR_COMPONENT_TYPE })
  const fallback = defaults.get(symbol.name)
  return {
    name: member.name,
    typeText: member.typeText,
    kind: member.kind,
    required: member.required,
    ...(fallback?.value !== undefined ? { default: fallback.value } : {}),
    ...(fallback && fallback.value === undefined ? { defaultExpression: fallback.expression } : {}),
    ...(member.allowedValues ? { allowedValues: member.allowedValues } : {}),
    ...(member.description ? { description: member.description } : {}),
    ...(member.deprecated ? { deprecated: member.deprecated } : {}),
    ...(member.parentName && member.parentName !== rootName ? { inheritedFrom: member.parentName } : {}),
    role: roleOf(member.name, member.typeText, member.kind),
    declaration: { node: declaration, line: member.line }
  }
}

function roleOf(name: string, typeText: string, kind: PropKind): PropInfo["role"] {
  if (name === "children") return "children"
  if (name === "ref") return "ref"
  if (kind === "function")
    return RENDER_FUNCTION.test(typeText) ? "render-prop" : /^on[A-Z]/.test(name) ? "event-handler" : "prop"
  if (kind === "component") return "slot"
  return "prop"
}

function firstParameterType(candidate: Candidate): ts.TypeNode | undefined {
  const impl = candidate.impl
  if (!impl) return undefined
  if (ts.isClassLike(impl)) return undefined
  return impl.parameters[0]?.type
}

function declaredTypeName(node: ts.TypeNode): string | undefined {
  return ts.isTypeReferenceNode(node) ? node.typeName.getText() : undefined
}

/** Defaults from destructuring initializers, `static defaultProps`, and `Name.defaultProps = {…}`. */
function collectDefaults(candidate: Candidate): Map<string, { value?: JsonValue; expression: string }> {
  const defaults = new Map<string, { value?: JsonValue; expression: string }>()
  const set = (name: string, init: ts.Expression): void => {
    const value = literalValue(init)
    defaults.set(name, {
      ...(value !== undefined ? { value } : {}),
      expression: collapse(init.getText()).slice(0, 200)
    })
  }
  const impl = candidate.impl
  if (impl && ts.isFunctionLike(impl)) {
    const first = impl.parameters[0]
    if (first && ts.isObjectBindingPattern(first.name)) {
      for (const element of first.name.elements) {
        if (!element.initializer || element.dotDotDotToken) continue
        const key = element.propertyName ?? element.name
        if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) set(key.text, element.initializer)
      }
    }
  }
  const fromObject = (expression: ts.Expression): void => {
    const object = unwrap(expression)
    if (!ts.isObjectLiteralExpression(object)) return
    for (const p of object.properties) {
      if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)))
        set(p.name.text, p.initializer)
    }
  }
  if (impl && ts.isClassLike(impl)) {
    for (const member of impl.members) {
      if (
        ts.isPropertyDeclaration(member) &&
        hasModifier(member, ts.SyntaxKind.StaticKeyword) &&
        member.name.getText() === "defaultProps" &&
        member.initializer
      )
        fromObject(member.initializer)
    }
  }
  const assigned = topLevelAssignments(candidate.decl.getSourceFile()).get(`${candidate.name}.defaultProps`)
  if (assigned) fromObject(assigned)
  return defaults
}
