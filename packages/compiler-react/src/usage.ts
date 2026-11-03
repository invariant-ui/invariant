import type { Analysis } from "@invariant/compiler-core"
import { lineOf, literalValue, relativeFileOf } from "@invariant/compiler-core"
import type { JsonValue } from "@invariant/shared"
import ts from "typescript"
import type { Candidate } from "./detect.js"

export interface UsageStats {
  sites: number
  props: Map<string, { count: number; values: JsonValue[]; valuesTruncated: boolean; dynamic: number }>
  combinations: Map<string, number>
  undeclared: Set<string>
  samples: Array<{ file: string; line: number; text: string }>
}

export interface UsageResult {
  byTarget: Map<Candidate, UsageStats>
  /** parent candidate -> child candidate -> number of JSX sites */
  renders: Map<Candidate, Map<Candidate, number>>
}

const MAX_VALUES = 20
const MAX_SAMPLES = 5
// Attributes that every element accepts regardless of its declared props.
const UNIVERSAL = new Set(["key", "ref"])

/**
 * Counts JSX sites that statically resolve to a known component: observed prop names and literal
 * values, prop combinations, undeclared props, and which components render which. Values passed as
 * expressions are counted as dynamic, never guessed. Frequencies are static source counts, not runtime.
 */
export function analyzeUsage(input: {
  analysis: Analysis
  files: readonly string[]
  resolveTarget: (tagName: ts.JsxTagNameExpression) => Candidate | undefined
  enclosing: (node: ts.Node) => Candidate | undefined
  declared: (candidate: Candidate) => { names: Set<string>; closed: boolean }
}): UsageResult {
  const { analysis, files, resolveTarget, enclosing, declared } = input
  const byTarget = new Map<Candidate, UsageStats>()
  const renders = new Map<Candidate, Map<Candidate, number>>()

  for (const file of files) {
    const sf = analysis.sourceFile(file)
    if (!sf) continue
    const visit = (node: ts.Node): void => {
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) record(node)
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return { byTarget, renders }

  function record(element: ts.JsxSelfClosingElement | ts.JsxOpeningElement): void {
    const tag = element.tagName
    if (ts.isIdentifier(tag) && /^[a-z]/.test(tag.text)) return
    const target = resolveTarget(tag)
    if (!target) return
    const stats: UsageStats = byTarget.get(target) ?? {
      sites: 0,
      props: new Map(),
      combinations: new Map(),
      undeclared: new Set(),
      samples: []
    }
    byTarget.set(target, stats)
    stats.sites++
    const file = relativeFileOf(analysis, element)
    if (file && stats.samples.length < MAX_SAMPLES)
      stats.samples.push({
        file,
        line: lineOf(element),
        text: element.getText().split("\n")[0]?.slice(0, 200) ?? ""
      })

    const names: string[] = []
    let spread = false
    for (const attribute of element.attributes.properties) {
      if (ts.isJsxSpreadAttribute(attribute)) {
        spread = true
        continue
      }
      const name = attribute.name.getText()
      if (name.includes(":") && !name.startsWith("aria-") && !name.startsWith("data-")) continue
      names.push(name)
      const entry = stats.props.get(name) ?? { count: 0, values: [], valuesTruncated: false, dynamic: 0 }
      entry.count++
      const value = attributeValue(attribute)
      if (value === undefined) entry.dynamic++
      else if (!entry.values.some((v) => JSON.stringify(v) === JSON.stringify(value))) {
        if (entry.values.length < MAX_VALUES) entry.values.push(value)
        else entry.valuesTruncated = true
      }
      stats.props.set(name, entry)
    }
    if (
      ts.isJsxOpeningElement(element) &&
      ts.isJsxElement(element.parent) &&
      element.parent.children.some((c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces))
    ) {
      names.push("children")
      const entry = stats.props.get("children") ?? {
        count: 0,
        values: [],
        valuesTruncated: false,
        dynamic: 0
      }
      entry.count++
      entry.dynamic++
      stats.props.set("children", entry)
    }
    const key = [...new Set(names)].sort().join(",")
    stats.combinations.set(key, (stats.combinations.get(key) ?? 0) + 1)

    const { names: known, closed } = declared(target)
    if (closed && !spread)
      for (const name of names) if (!known.has(name) && !UNIVERSAL.has(name)) stats.undeclared.add(name)

    const parent = enclosing(element)
    if (parent) {
      const children = renders.get(parent) ?? new Map<Candidate, number>()
      children.set(target, (children.get(target) ?? 0) + 1)
      renders.set(parent, children)
    }
  }
}

function attributeValue(attribute: ts.JsxAttribute): JsonValue | undefined {
  const init = attribute.initializer
  if (!init) return true
  if (ts.isStringLiteral(init)) return init.text
  if (ts.isJsxExpression(init) && init.expression) {
    const value = literalValue(init.expression)
    return value !== undefined && typeof value !== "object" ? value : undefined
  }
  return undefined
}
