import ts from "typescript"
import { collapse, declarationOf, isProjectNode, lineOf, resolveSymbol } from "./ast.js"
import type { Analysis } from "./program.js"

export type MemberKind =
  | "string"
  | "number"
  | "boolean"
  | "enum"
  | "function"
  | "component"
  | "object"
  | "array"
  | "union"
  | "unknown"

export interface MemberInfo {
  name: string
  typeText: string
  kind: MemberKind
  required: boolean
  allowedValues?: Array<string | number | boolean>
  description?: string
  deprecated?: { reason?: string }
  /** Declaring interface, class or alias name. */
  parentName?: string
  node: ts.Node
  line: number
}

const UTILITY_TYPES = new Set(["Omit", "Pick", "Partial", "Required", "Readonly"])

/**
 * Properties of `type` declared inside the analyzed project. Members inherited from types outside the
 * project (or unresolved) are not returned; use `externalBases` to report them.
 */
export function ownProperties(
  analysis: Analysis,
  type: ts.Type
): Array<{ symbol: ts.Symbol; declaration: ts.Declaration }> {
  const out: Array<{ symbol: ts.Symbol; declaration: ts.Declaration }> = []
  for (const symbol of analysis.checker.getPropertiesOfType(type)) {
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
    if (declaration && isProjectNode(analysis, declaration)) out.push({ symbol, declaration })
  }
  return out
}

/**
 * Describes one property: its declared type text, a framework-neutral kind, whether it is required,
 * its literal domain in declaration order, and its JSDoc description and deprecation. `renderable`
 * marks a framework's "renderable content" types (for example React's ReactNode) as kind `component`.
 */
export function describeMember(
  analysis: Analysis,
  symbol: ts.Symbol,
  declaration: ts.Declaration,
  options: { renderable?: RegExp } = {}
): MemberInfo {
  const { checker } = analysis
  const typeNode =
    ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration)
      ? declaration.type
      : undefined
  const type = checker.getTypeOfSymbolAtLocation(symbol, declaration)
  const typeText = collapse(typeNode ? typeNode.getText() : checker.typeToString(type))
  const kind = classifyKind(checker, type, typeText, options.renderable)
  const allowedValues = allowedValuesOf(checker, typeNode, type, kind)
  const doc = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim()
  const deprecatedTag = symbol.getJsDocTags(checker).find((t) => t.name === "deprecated")
  const deprecatedText = deprecatedTag ? ts.displayPartsToString(deprecatedTag.text).trim() : undefined
  const parentName = declarationParentName(declaration)
  return {
    name: symbol.name,
    typeText,
    kind,
    required: (symbol.flags & ts.SymbolFlags.Optional) === 0,
    ...(allowedValues ? { allowedValues } : {}),
    ...(doc ? { description: doc } : {}),
    ...(deprecatedTag ? { deprecated: deprecatedText ? { reason: deprecatedText } : {} } : {}),
    ...(parentName ? { parentName } : {}),
    node: declaration,
    line: lineOf(declaration)
  }
}

export function classifyKind(
  checker: ts.TypeChecker,
  type: ts.Type,
  typeText: string,
  renderable?: RegExp
): MemberKind {
  if (renderable?.test(typeText.replace(/\s*\|\s*(?:undefined|null)/g, ""))) return "component"
  const nonNull = checker.getNonNullableType(type)
  if (nonNull.getCallSignatures().length > 0) return "function"
  if (nonNull.flags & ts.TypeFlags.BooleanLike) return "boolean"
  if (nonNull.isUnion()) {
    const parts = nonNull.types
    if (parts.every((t) => t.flags & ts.TypeFlags.BooleanLiteral)) return "boolean"
    if (
      parts.every(
        (t) =>
          t.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral)
      )
    )
      return "enum"
    return "union"
  }
  if (nonNull.flags & ts.TypeFlags.StringLike)
    return nonNull.flags & ts.TypeFlags.StringLiteral ? "enum" : "string"
  if (nonNull.flags & ts.TypeFlags.NumberLike)
    return nonNull.flags & ts.TypeFlags.NumberLiteral ? "enum" : "number"
  if (checker.isArrayType(nonNull) || checker.isTupleType(nonNull)) return "array"
  if (nonNull.flags & ts.TypeFlags.Object) return "object"
  return "unknown"
}

/** Finite literal domain in declaration order when the declared type is a union of literals (through aliases). */
export function allowedValuesOf(
  checker: ts.TypeChecker,
  typeNode: ts.TypeNode | undefined,
  type: ts.Type,
  kind: MemberKind
): Array<string | number | boolean> | undefined {
  if (kind !== "enum") return undefined
  const ordered = typeNode ? literalDomain(checker, typeNode, 0) : undefined
  if (ordered && ordered.length > 0) return ordered
  const nonNull = checker.getNonNullableType(type)
  const parts = nonNull.isUnion() ? nonNull.types : [nonNull]
  const values = parts.flatMap((t) => (t.isStringLiteral() || t.isNumberLiteral() ? [t.value] : []))
  return values.length > 0 ? values.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) : undefined
}

/** Ordered literal values of a union-of-literals type node, or undefined when any member is not a literal. */
export function literalDomain(
  checker: ts.TypeChecker,
  node: ts.TypeNode,
  depth = 0
): Array<string | number | boolean> | undefined {
  if (depth > 5) return undefined
  if (ts.isParenthesizedTypeNode(node)) return literalDomain(checker, node.type, depth + 1)
  if (ts.isUnionTypeNode(node)) {
    const parts = node.types.map((t) => literalDomain(checker, t, depth + 1))
    return parts.every((p) => p !== undefined)
      ? (parts as Array<Array<string | number | boolean>>).flat()
      : undefined
  }
  if (ts.isLiteralTypeNode(node)) {
    const literal = node.literal
    if (ts.isStringLiteral(literal)) return [literal.text]
    if (ts.isNumericLiteral(literal)) return [Number(literal.text)]
    if (literal.kind === ts.SyntaxKind.NullKeyword) return []
    if (literal.kind === ts.SyntaxKind.TrueKeyword) return [true]
    if (literal.kind === ts.SyntaxKind.FalseKeyword) return [false]
    return undefined
  }
  if (node.kind === ts.SyntaxKind.UndefinedKeyword) return []
  if (ts.isTypeReferenceNode(node)) {
    const target = declarationOf(resolveSymbol(checker, checker.getSymbolAtLocation(node.typeName)))
    if (target && ts.isTypeAliasDeclaration(target)) return literalDomain(checker, target.type, depth + 1)
  }
  return undefined
}

export function declarationParentName(declaration: ts.Declaration): string | undefined {
  const parent = declaration.parent
  if (ts.isInterfaceDeclaration(parent) || ts.isClassDeclaration(parent)) return parent.name?.text
  if (ts.isTypeLiteralNode(parent) && ts.isTypeAliasDeclaration(parent.parent)) return parent.parent.name.text
  return undefined
}

/** Types in the heritage of a props type that are external to the project or unresolved. */
export function externalBases(analysis: Analysis, node: ts.Node | undefined, depth = 0): string[] {
  if (!node || depth > 6) return []
  const { checker } = analysis
  if (ts.isIntersectionTypeNode(node) || ts.isUnionTypeNode(node))
    return node.types.flatMap((t) => externalBases(analysis, t, depth + 1))
  if (ts.isParenthesizedTypeNode(node)) return externalBases(analysis, node.type, depth + 1)
  // `import("pkg").Type` always refers to something outside the analyzed project.
  if (ts.isImportTypeNode(node)) return [collapse(node.getText())]
  const reference = ts.isTypeReferenceNode(node)
    ? { name: node.typeName, args: node.typeArguments }
    : ts.isExpressionWithTypeArguments(node)
      ? { name: node.expression, args: node.typeArguments }
      : undefined
  if (!reference) return []
  const text = collapse(node.getText())
  if (UTILITY_TYPES.has(reference.name.getText()) && reference.args?.[0])
    return externalBases(analysis, reference.args[0], depth + 1)
  const symbol = resolveSymbol(checker, checker.getSymbolAtLocation(reference.name))
  const local = (symbol?.declarations ?? []).filter((d) => isProjectNode(analysis, d))
  if (local.length === 0) return [text]
  return local.flatMap((d) => {
    if (ts.isInterfaceDeclaration(d))
      return (d.heritageClauses ?? []).flatMap((h) =>
        h.types.flatMap((t) => externalBases(analysis, t, depth + 1))
      )
    if (ts.isTypeAliasDeclaration(d)) return externalBases(analysis, d.type, depth + 1)
    return []
  })
}
