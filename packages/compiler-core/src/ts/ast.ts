import type { JsonValue } from "@invariant/shared"
import ts from "typescript"
import type { Analysis } from "./program.js"

export function unwrap(node: ts.Expression): ts.Expression {
  let current = node
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression
  }
  return current
}

export function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/** JSON value of a static literal expression, or undefined when the expression is not a plain literal. */
export function literalValue(expression: ts.Expression): JsonValue | undefined {
  const node = unwrap(expression)
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isNumericLiteral(node)) return Number(node.text)
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (node.kind === ts.SyntaxKind.NullKeyword) return null
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return -Number(node.operand.text)
  }
  if (ts.isArrayLiteralExpression(node)) {
    const items = node.elements.map((e) => literalValue(e))
    return items.every((i) => i !== undefined) ? (items as JsonValue[]) : undefined
  }
  if (ts.isObjectLiteralExpression(node)) {
    const out: Record<string, JsonValue> = {}
    for (const p of node.properties) {
      if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)))
        return undefined
      const v = literalValue(p.initializer)
      if (v === undefined) return undefined
      out[p.name.text] = v
    }
    return out
  }
  return undefined
}

export function lineOf(node: ts.Node): number {
  const sf = node.getSourceFile()
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

/** First source line of a node, trimmed and bounded, for use as an evidence excerpt. */
export function excerpt(node: ts.Node): string {
  const text = node.getText(node.getSourceFile())
  return collapse(text.split("\n")[0] ?? "").slice(0, 200)
}

export function relativeFileOf(analysis: Analysis, node: ts.Node): string | undefined {
  return analysis.relativePath(node.getSourceFile().fileName)
}

export function isProjectNode(analysis: Analysis, node: ts.Node): boolean {
  return relativeFileOf(analysis, node) !== undefined
}

export function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === kind)
}

/** Resolves aliases (imports and re-exports) to the symbol that declares the value. */
export function resolveSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  if (!symbol) return undefined
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
}

export function declarationOf(symbol: ts.Symbol | undefined): ts.Declaration | undefined {
  return symbol?.valueDeclaration ?? symbol?.declarations?.[0]
}

/** `Foo.bar = value` assignments at the top level of a file, keyed `Foo.bar`. */
export function topLevelAssignments(sf: ts.SourceFile): Map<string, ts.Expression> {
  const out = new Map<string, ts.Expression>()
  for (const statement of sf.statements) {
    if (!ts.isExpressionStatement(statement)) continue
    const e = statement.expression
    if (
      ts.isBinaryExpression(e) &&
      e.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(e.left) &&
      ts.isIdentifier(e.left.expression)
    ) {
      out.set(`${e.left.expression.text}.${e.left.name.text}`, e.right)
    }
  }
  return out
}

/** Walks `node` without descending into nested function-like bodies (other than `node` itself). */
export function walkSameFunction(node: ts.Node, visit: (n: ts.Node) => void): void {
  const go = (n: ts.Node): void => {
    if (n !== node && ts.isFunctionLike(n)) return
    visit(n)
    ts.forEachChild(n, go)
  }
  ts.forEachChild(node, go)
}

export function subTarget(checker: ts.TypeChecker, node: ts.Node): ts.Node | undefined {
  if (ts.isShorthandPropertyAssignment(node))
    return declarationOf(resolveSymbol(checker, checker.getShorthandAssignmentValueSymbol(node)))
  const expression = ts.isPropertyAssignment(node)
    ? unwrap(node.initializer)
    : ts.isExpression(node)
      ? unwrap(node)
      : undefined
  if (expression && ts.isIdentifier(expression))
    return declarationOf(resolveSymbol(checker, checker.getSymbolAtLocation(expression)))
  return undefined
}

/** Declaration a JSX tag refers to, following imports, `export default X`, and `Root.Child` properties. */
export function jsxTargetDeclaration(
  checker: ts.TypeChecker,
  tag: ts.JsxTagNameExpression
): ts.Node | undefined {
  const symbol = ts.isPropertyAccessExpression(tag)
    ? checker.getSymbolAtLocation(tag.name)
    : checker.getSymbolAtLocation(tag)
  let decl: ts.Node | undefined = declarationOf(resolveSymbol(checker, symbol))
  for (let hops = 0; decl && hops < 4; hops++) {
    if (ts.isExportAssignment(decl)) {
      const e = unwrap(decl.expression)
      decl = ts.isIdentifier(e) ? declarationOf(resolveSymbol(checker, checker.getSymbolAtLocation(e))) : decl
      if (!ts.isExportAssignment(decl as ts.Node)) continue
      return decl
    }
    if (ts.isPropertyAssignment(decl) || ts.isShorthandPropertyAssignment(decl)) {
      decl = subTarget(checker, decl)
      continue
    }
    if (
      ts.isPropertyAccessExpression(decl) &&
      ts.isBinaryExpression(decl.parent) &&
      decl.parent.left === decl
    ) {
      decl = subTarget(checker, decl.parent.right)
      continue
    }
    return decl
  }
  return decl
}

/**
 * Component name for a single-file component path: the PascalCase file name (`button-group.vue` is
 * `ButtonGroup`). This is the convention both the Vue adapter and Storybook linking use.
 */
export function componentNameFromFile(path: string): string {
  const base = path.replace(/^.*\//, "").replace(/\.[^.]+$/, "")
  return base
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")
}

/** The name and type arguments of `Foo<P>`, `ns.Foo<P>` and `import("pkg").Foo<P>`: the written form, nothing resolved. */
export function typeReferenceInfo(
  type: ts.TypeNode
): { name: string; typeArguments: readonly ts.TypeNode[] } | undefined {
  const lastName = (n: ts.EntityName): string => (ts.isQualifiedName(n) ? n.right.text : n.text)
  if (ts.isTypeReferenceNode(type))
    return { name: lastName(type.typeName), typeArguments: type.typeArguments ?? [] }
  if (ts.isImportTypeNode(type) && type.qualifier)
    return { name: lastName(type.qualifier), typeArguments: type.typeArguments ?? [] }
  return undefined
}
