import type { Analysis } from "@invariant/compiler-core"
import {
  declarationOf,
  literalValue,
  resolveSymbol,
  unwrap,
  walkSameFunction
} from "@invariant/compiler-core"
import type { JsonValue } from "@invariant/shared"
import ts from "typescript"
import type { Candidate } from "./detect.js"
import type { PropInfo } from "./props.js"

export interface VariantInfo {
  name: string
  values: string[]
  default?: string
  source: "prop-union" | "cva"
  /** For `cva`: the variants function name. */
  via?: string
  node?: ts.Node
}

/**
 * Variants come from two deterministic sources: props typed as a union of two or more string
 * literals, and `cva(...)` configs (`variants` + `defaultVariants`) whose function the component calls.
 */
export function variantsOf(
  analysis: Analysis,
  candidate: Candidate,
  props: readonly PropInfo[]
): VariantInfo[] {
  const out = new Map<string, VariantInfo>()
  for (const p of props) {
    const values = p.allowedValues
    if (p.kind !== "enum" || !values || values.length < 2 || !values.every((v) => typeof v === "string"))
      continue
    const fallback =
      typeof p.default === "string" && (values as string[]).includes(p.default) ? p.default : undefined
    out.set(p.name, {
      name: p.name,
      values: values as string[],
      ...(fallback ? { default: fallback } : {}),
      source: "prop-union",
      node: p.declaration.node
    })
  }
  for (const cva of cvaCallsUsedBy(analysis, candidate)) {
    for (const [name, info] of cva.variants) {
      const existing = out.get(name)
      if (existing?.source !== "cva") out.set(name, { ...info, via: cva.via, node: cva.node })
    }
  }
  return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

function cvaCallsUsedBy(
  analysis: Analysis,
  candidate: Candidate
): Array<{ via: string; node: ts.Node; variants: Map<string, VariantInfo> }> {
  const impl = candidate.impl
  if (!impl) return []
  const { checker } = analysis
  const found = new Map<ts.Node, string>()
  const consider = (identifier: ts.Identifier): void => {
    const decl = declarationOf(resolveSymbol(checker, checker.getSymbolAtLocation(identifier)))
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer && isCva(decl.initializer))
      found.set(decl, identifier.text)
  }
  if (ts.isFunctionLike(impl)) {
    walkSameFunction(impl, (n) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) consider(n.expression)
    })
  } else {
    const walk = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) consider(n.expression)
      ts.forEachChild(n, walk)
    }
    walk(impl)
  }
  return [...found].map(([decl, via]) => {
    const init = unwrap((decl as ts.VariableDeclaration).initializer as ts.Expression) as ts.CallExpression
    return { via, node: decl, variants: parseCva(init, via) }
  })
}

function isCva(expression: ts.Expression): boolean {
  const node = unwrap(expression)
  return ts.isCallExpression(node) && node.expression.getText() === "cva"
}

function parseCva(call: ts.CallExpression, via: string): Map<string, VariantInfo> {
  const result = new Map<string, VariantInfo>()
  const config = call.arguments[1] ? unwrap(call.arguments[1]) : undefined
  if (!config || !ts.isObjectLiteralExpression(config)) return result
  const member = (name: string): ts.Expression | undefined => {
    const p = config.properties.find((x) => ts.isPropertyAssignment(x) && x.name.getText() === name)
    return p && ts.isPropertyAssignment(p) ? unwrap(p.initializer) : undefined
  }
  const variants = member("variants")
  const defaults = member("defaultVariants")
  const defaultMap = new Map<string, JsonValue>()
  if (defaults && ts.isObjectLiteralExpression(defaults)) {
    for (const p of defaults.properties) {
      if (ts.isPropertyAssignment(p)) {
        const v = literalValue(p.initializer)
        if (v !== undefined) defaultMap.set(p.name.getText().replace(/^["']|["']$/g, ""), v)
      }
    }
  }
  if (variants && ts.isObjectLiteralExpression(variants)) {
    for (const p of variants.properties) {
      if (!ts.isPropertyAssignment(p)) continue
      const inner = unwrap(p.initializer)
      if (!ts.isObjectLiteralExpression(inner)) continue
      const name = p.name.getText().replace(/^["']|["']$/g, "")
      const values = inner.properties.flatMap((v) =>
        ts.isPropertyAssignment(v) || ts.isShorthandPropertyAssignment(v)
          ? [v.name.getText().replace(/^["']|["']$/g, "")]
          : []
      )
      const fallback = defaultMap.get(name)
      result.set(name, {
        name,
        values,
        ...(typeof fallback === "string" || typeof fallback === "boolean" || typeof fallback === "number"
          ? { default: String(fallback) }
          : {}),
        source: "cva",
        via
      })
    }
  }
  return result
}
