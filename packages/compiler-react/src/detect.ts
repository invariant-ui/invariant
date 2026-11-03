import {
  declarationOf,
  resolveSymbol,
  topLevelAssignments,
  unwrap,
  walkSameFunction
} from "@invariant/compiler-core"
import ts from "typescript"

export type ComponentKind = "function" | "class" | "forwardRef" | "memo" | "lazy" | "styled"

export interface Candidate {
  /** Identity: the declaration node (function, class or variable declaration). */
  decl: ts.Node
  /** Local declaration name (`default` for an anonymous default export). */
  name: string
  kind: ComponentKind
  /** Outermost first, for example `["memo", "forwardRef"]`. */
  wrappers: string[]
  impl?: ts.FunctionLikeDeclaration | ts.ClassLikeDeclaration
  propsTypeNode?: ts.TypeNode
  refTypeText?: string
  styled?: { library: "styled-components" | "emotion" }
  /** Props cannot be determined from syntax (lazy, untyped, unknown wrapper). */
  propsUnknown: boolean
  /** `Object.assign(Root, { Item })` and `Root.Item = Item` children. */
  subcomponents: Array<{ key: string; target: ts.Node }>
  /** Catalog name override, set for compound children (`Card.Header`). */
  displayName?: string
  /** Value of an explicit `X.displayName = "…"` assignment (a React DevTools label, not the catalog name). */
  reactDisplayName?: string
}

export interface HocFinding {
  hoc: true
  name: string
  node: ts.Node
}

const PASCAL = /^[A-Z]/
const COMPONENT_BASES = new Set(["Component", "React.Component", "PureComponent", "React.PureComponent"])
const FC_TYPES = new Set([
  "FC",
  "React.FC",
  "FunctionComponent",
  "React.FunctionComponent",
  "VFC",
  "React.VFC"
])
const STYLED_MODULES: Record<string, "styled-components" | "emotion"> = {
  "styled-components": "styled-components",
  "@emotion/styled": "emotion"
}

/**
 * Decides whether a declaration is a React component using syntax only: a Pascal-case function (or
 * class extending Component/PureComponent) that returns JSX, optionally wrapped in forwardRef, memo or
 * lazy, a styled-components/emotion tagged template, or `Object.assign(Root, { Child })`. Anything
 * that returns a component (a higher-order component) is reported, not analyzed.
 */
export function classifyDeclaration(
  checker: ts.TypeChecker,
  decl: ts.Node,
  displayHint: string,
  depth = 0
): Candidate | HocFinding | undefined {
  if (depth > 6) return undefined
  if (ts.isFunctionDeclaration(decl)) {
    const name = decl.name?.text ?? displayHint
    if (isComponentFunction(decl, name))
      return finish(
        { decl, name, kind: "function", wrappers: [], impl: decl, propsUnknown: false, subcomponents: [] },
        decl
      )
    return returnsComponentFunction(decl) ? { hoc: true, name, node: decl } : undefined
  }
  if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
    const name = decl.name.text
    let fromInit = decl.initializer
      ? classifyExpression(checker, decl.initializer, { name, decl, depth })
      : undefined
    // A Pascal-case function declared as `React.FC<P>` is a component even when its return value is not literal JSX.
    const init = decl.initializer ? unwrap(decl.initializer) : undefined
    if (
      !fromInit &&
      PASCAL.test(name) &&
      fcTypeArgument(decl.type) &&
      init &&
      (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
    ) {
      fromInit = {
        decl,
        name,
        kind: "function",
        wrappers: [],
        impl: init,
        propsUnknown: false,
        subcomponents: []
      }
    }
    if (fromInit && "hoc" in fromInit) return fromInit
    if (fromInit) {
      const fcProps = fcTypeArgument(decl.type)
      if (fcProps && !fromInit.propsTypeNode) fromInit.propsTypeNode = fcProps
      return finish(fromInit, decl)
    }
    return undefined
  }
  if (ts.isClassDeclaration(decl)) {
    const base = componentBase(decl)
    if (!base) return undefined
    const name = decl.name?.text ?? displayHint
    return finish(
      {
        decl,
        name,
        kind: "class",
        wrappers: [],
        impl: decl,
        ...(base.typeArguments?.[0] ? { propsTypeNode: base.typeArguments[0] } : {}),
        propsUnknown: !base.typeArguments?.[0],
        subcomponents: []
      },
      decl
    )
  }
  if (ts.isExportAssignment(decl) && !decl.isExportEquals) {
    const expression = unwrap(decl.expression)
    if (ts.isIdentifier(expression)) {
      // `export default Link`: the component is whatever `Link` declares, under its own name.
      const target = declarationOf(resolveSymbol(checker, checker.getSymbolAtLocation(expression)))
      return target && target !== decl
        ? classifyDeclaration(checker, target, expression.text, depth + 1)
        : undefined
    }
    return classifyExpression(checker, expression, { name: displayHint, decl, depth })
  }
  return undefined
}

function classifyExpression(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  ctx: { name: string; decl: ts.Node; depth: number }
): Candidate | HocFinding | undefined {
  const node = unwrap(expression)
  const { name, decl, depth } = ctx
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    if (isComponentFunction(node, name))
      return {
        decl,
        name,
        kind: "function",
        wrappers: [],
        impl: node,
        propsUnknown: false,
        subcomponents: []
      }
    return returnsComponentFunction(node) ? { hoc: true, name, node } : undefined
  }
  if (ts.isIdentifier(node)) {
    const target = declarationOf(resolveSymbol(checker, checker.getSymbolAtLocation(node)))
    if (!target || target === decl) return undefined
    const inner = classifyDeclaration(checker, target, name, depth + 1)
    return inner && !("hoc" in inner) ? { ...inner, decl, name } : inner
  }
  if (ts.isTaggedTemplateExpression(node)) {
    const library = styledLibrary(node.tag)
    if (!library) return undefined
    return {
      decl,
      name,
      kind: "styled",
      wrappers: [],
      styled: { library },
      ...(node.typeArguments?.[0] ? { propsTypeNode: node.typeArguments[0] } : {}),
      propsUnknown: !node.typeArguments?.[0],
      subcomponents: []
    }
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression.getText()
    const arg = node.arguments[0]
    if ((callee === "forwardRef" || callee === "React.forwardRef") && arg) {
      const inner = classifyExpression(checker, arg, { name, decl, depth: depth + 1 })
      const impl = inner && !("hoc" in inner) ? inner.impl : undefined
      const refType = node.typeArguments?.[0]
      return {
        decl,
        name,
        kind: "forwardRef",
        wrappers: ["forwardRef"],
        ...(impl ? { impl } : {}),
        ...(node.typeArguments?.[1] ? { propsTypeNode: node.typeArguments[1] } : {}),
        ...(refType ? { refTypeText: refType.getText() } : {}),
        propsUnknown: false,
        subcomponents: []
      }
    }
    if ((callee === "memo" || callee === "React.memo") && arg) {
      const inner = classifyExpression(checker, arg, { name, decl, depth: depth + 1 })
      if (!inner || "hoc" in inner) return inner
      return { ...inner, decl, kind: "memo", wrappers: ["memo", ...inner.wrappers] }
    }
    if ((callee === "lazy" || callee === "React.lazy") && arg) {
      return { decl, name, kind: "lazy", wrappers: ["lazy"], propsUnknown: true, subcomponents: [] }
    }
    if (callee === "Object.assign" && node.arguments.length >= 2) {
      const root = classifyExpression(checker, node.arguments[0] as ts.Expression, {
        name,
        decl,
        depth: depth + 1
      })
      if (!root || "hoc" in root) return root
      const extras = unwrap(node.arguments[1] as ts.Expression)
      const subcomponents: Candidate["subcomponents"] = []
      if (ts.isObjectLiteralExpression(extras)) {
        for (const property of extras.properties) {
          const key =
            property.name && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))
              ? property.name.text
              : undefined
          if (key && (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)))
            subcomponents.push({ key, target: property })
        }
      }
      return { ...root, decl, subcomponents: [...root.subcomponents, ...subcomponents] }
    }
  }
  return undefined
}

/** Adds `Root.displayName = "…"` and `Root.Item = Item` information found next to the declaration. */
function finish(candidate: Candidate, decl: ts.Node): Candidate {
  const assignments = topLevelAssignments(decl.getSourceFile())
  const display = assignments.get(`${candidate.name}.displayName`)
  if (display && ts.isStringLiteralLike(unwrap(display)))
    candidate.reactDisplayName = (unwrap(display) as ts.StringLiteralLike).text
  for (const [key, value] of assignments) {
    if (!key.startsWith(`${candidate.name}.`)) continue
    const member = key.slice(candidate.name.length + 1)
    if (member === "displayName" || member === "defaultProps" || !PASCAL.test(member)) continue
    candidate.subcomponents.push({ key: member, target: value })
  }
  return candidate
}

function isComponentFunction(fn: ts.FunctionLikeDeclaration, name: string): boolean {
  return PASCAL.test(name) && returnsJsx(fn)
}

export function returnsJsx(fn: ts.FunctionLikeDeclaration): boolean {
  if (!fn.body) return false
  if (!ts.isBlock(fn.body)) return yieldsJsx(fn.body)
  let found = false
  walkSameFunction(fn, (n) => {
    if (!found && ts.isReturnStatement(n) && n.expression && yieldsJsx(n.expression)) found = true
  })
  return found
}

function yieldsJsx(expression: ts.Expression): boolean {
  const node = unwrap(expression)
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return true
  if (ts.isConditionalExpression(node)) return yieldsJsx(node.whenTrue) || yieldsJsx(node.whenFalse)
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind
    if (
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return yieldsJsx(node.left) || yieldsJsx(node.right)
    }
  }
  if (ts.isCallExpression(node))
    return /(?:^|\.)(?:_?jsxs?|createElement|cloneElement|createPortal)$/.test(node.expression.getText())
  return false
}

function returnsComponentFunction(fn: ts.FunctionLikeDeclaration): boolean {
  if (!fn.body) return false
  const isInner = (e: ts.Expression): boolean => {
    const inner = unwrap(e)
    return (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) && returnsJsx(inner)
  }
  if (!ts.isBlock(fn.body)) return isInner(fn.body)
  let found = false
  walkSameFunction(fn, (n) => {
    if (!found && ts.isReturnStatement(n) && n.expression && isInner(n.expression)) found = true
  })
  return found
}

function componentBase(cls: ts.ClassDeclaration): ts.ExpressionWithTypeArguments | undefined {
  const extendsClause = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)
  const base = extendsClause?.types[0]
  return base && COMPONENT_BASES.has(base.expression.getText()) ? base : undefined
}

function fcTypeArgument(type: ts.TypeNode | undefined): ts.TypeNode | undefined {
  if (type && ts.isTypeReferenceNode(type) && FC_TYPES.has(type.typeName.getText()))
    return type.typeArguments?.[0]
  return undefined
}

function styledLibrary(tag: ts.Expression): "styled-components" | "emotion" | undefined {
  let root: ts.Expression = tag
  while (ts.isPropertyAccessExpression(root) || ts.isCallExpression(root))
    root = ts.isCallExpression(root) ? root.expression : root.expression
  if (!ts.isIdentifier(root)) return undefined
  for (const statement of root.getSourceFile().statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const library = STYLED_MODULES[statement.moduleSpecifier.text]
    const clause = statement.importClause
    if (!library || !clause) continue
    if (clause.name?.text === root.text) return library
    if (
      clause.namedBindings &&
      ts.isNamedImports(clause.namedBindings) &&
      clause.namedBindings.elements.some((e) => e.name.text === root.text)
    )
      return library
  }
  return undefined
}
