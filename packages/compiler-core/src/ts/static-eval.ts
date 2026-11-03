import { declarationOf, resolveSymbol, unwrap } from "@invariant/compiler-core"
import type { JsonValue } from "@invariant/shared"
import ts from "typescript"

/**
 * Result of statically evaluating an expression. `value` holds whatever could be resolved; every key
 * path that could not be (functions, JSX, calls, unresolvable identifiers) is listed in `unresolved`,
 * so a consumer never mistakes a partial object for a complete one. Nothing is ever executed.
 */
export interface Evaluated {
  value?: JsonValue
  unresolved: string[]
  /** Key paths whose value is a call to `fn()` / `action()` (a test spy), which has no static value. */
  spies: string[]
  /** For objects: every top-level key present in the source, including ones whose value is `undefined` or unresolved. */
  keys?: string[]
}

const MAX_DEPTH = 8
const SPY_CALLEES = new Set(["fn", "action"])

export function evaluate(checker: ts.TypeChecker, expression: ts.Expression, depth = 0): Evaluated {
  const node = unwrap(expression)
  if (depth > MAX_DEPTH) return dynamic()
  if (ts.isStringLiteralLike(node)) return resolved(node.text)
  if (ts.isNumericLiteral(node)) return resolved(Number(node.text))
  if (node.kind === ts.SyntaxKind.TrueKeyword) return resolved(true)
  if (node.kind === ts.SyntaxKind.FalseKeyword) return resolved(false)
  if (node.kind === ts.SyntaxKind.NullKeyword) return resolved(null)
  if (ts.isIdentifier(node) && node.text === "undefined") return { unresolved: [], spies: [] }
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return resolved(-Number(node.operand.text))
  }
  if (ts.isObjectLiteralExpression(node)) return evaluateObject(checker, node, depth)
  if (ts.isArrayLiteralExpression(node)) {
    const items: JsonValue[] = []
    const unresolved: string[] = []
    for (const element of node.elements) {
      const inner = evaluate(checker, element, depth + 1)
      if (inner.value === undefined || inner.unresolved.length > 0) unresolved.push("[]")
      else items.push(inner.value)
    }
    // An array with any unresolvable element is not partially trusted.
    return unresolved.length > 0 ? dynamic() : resolved(items)
  }
  if (ts.isIdentifier(node)) {
    const decl = declarationOf(resolveSymbol(checker, checker.getSymbolAtLocation(node)))
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer && decl !== node.parent)
      return evaluate(checker, decl.initializer, depth + 1)
    return dynamic()
  }
  if (
    ts.isPropertyAccessExpression(node) ||
    (ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      ts.isStringLiteralLike(node.argumentExpression))
  ) {
    const key = ts.isPropertyAccessExpression(node)
      ? node.name.text
      : (node.argumentExpression as ts.StringLiteralLike).text
    const base = evaluate(checker, node.expression, depth + 1)
    if (
      base.value !== null &&
      typeof base.value === "object" &&
      !Array.isArray(base.value) &&
      key in base.value
    ) {
      const picked = base.value[key]
      return {
        ...(picked === undefined ? {} : { value: picked }),
        unresolved: base.unresolved
          .filter((p) => p === key || p.startsWith(`${key}.`))
          .map((p) => (p === key ? "" : p.slice(key.length + 1))),
        spies: base.spies
          .filter((p) => p === key || p.startsWith(`${key}.`))
          .map((p) => (p === key ? "" : p.slice(key.length + 1)))
      }
    }
    return dynamic()
  }
  if (ts.isCallExpression(node) && SPY_CALLEES.has(node.expression.getText().replace(/^.*\./, ""))) {
    return { unresolved: [""], spies: [""] }
  }
  return dynamic()
}

function evaluateObject(checker: ts.TypeChecker, node: ts.ObjectLiteralExpression, depth: number): Evaluated {
  const value: Record<string, JsonValue> = {}
  const unresolved: string[] = []
  const spies: string[] = []
  const keys = new Set<string>()
  const mark = (key: string, inner: Evaluated): void => {
    for (const p of inner.unresolved) unresolved.push(p === "" ? key : `${key}.${p}`)
    for (const p of inner.spies) spies.push(p === "" ? key : `${key}.${p}`)
  }
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) {
      const inner = evaluate(checker, property.expression, depth + 1)
      if (inner.value !== null && typeof inner.value === "object" && !Array.isArray(inner.value)) {
        for (const [k, v] of Object.entries(inner.value)) value[k] = v
        for (const k of inner.keys ?? Object.keys(inner.value)) keys.add(k)
        unresolved.push(...inner.unresolved)
        spies.push(...inner.spies)
      } else unresolved.push("...")
      continue
    }
    const name = propertyName(property)
    if (name === undefined) {
      unresolved.push("<computed>")
      continue
    }
    keys.add(name)
    if (ts.isPropertyAssignment(property)) {
      const inner = evaluate(checker, property.initializer, depth + 1)
      if (inner.value !== undefined) value[name] = inner.value
      mark(name, inner)
    } else if (ts.isShorthandPropertyAssignment(property)) {
      const target = declarationOf(
        resolveSymbol(checker, checker.getShorthandAssignmentValueSymbol(property))
      )
      const inner =
        target && ts.isVariableDeclaration(target) && target.initializer
          ? evaluate(checker, target.initializer, depth + 1)
          : dynamic()
      if (inner.value !== undefined) value[name] = inner.value
      mark(name, inner)
    } else {
      // Methods and accessors: present, but not statically evaluable.
      unresolved.push(name)
    }
  }
  return { value, unresolved, spies, keys: [...keys].sort() }
}

function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  const name = property.name
  if (!name) return undefined
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text
  return undefined
}

function resolved(value: JsonValue): Evaluated {
  return { value, unresolved: [], spies: [] }
}

function dynamic(): Evaluated {
  return { unresolved: [""], spies: [] }
}
