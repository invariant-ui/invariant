import type { Analysis } from "@invariant/compiler-core"
import { posix, relativeFileOf, unwrap } from "@invariant/compiler-core"
import ts from "typescript"
import type { Candidate } from "./detect.js"

export interface StylingInfo {
  cssModules: Array<{ path: string; variables: Array<{ name: string; line: number }> }>
  /** Variables referenced by the component's own source (strings and templates). */
  inlineVariables: string[]
  classNames: string[]
  tailwind: boolean
  libraries: string[]
}

const CSS_MODULE = /\.module\.(?:css|scss|sass|less)$/
const VAR_REFERENCE = /var\(\s*(--[\w-]+)/g
const CLASS_HELPERS = new Set(["cn", "clsx", "classNames", "classnames", "cx", "twMerge"])
const MAX_CLASSES = 200

/**
 * Styling references found in a component: imported CSS modules and the custom properties they use,
 * `var(--x)` references in the component source, literal `className` tokens, and CSS-in-JS libraries.
 * References are recorded as written; they are not resolved to tokens here.
 */
export function stylingOf(
  analysis: Analysis,
  candidate: Candidate,
  context: { files: ReadonlyMap<string, string>; tailwind: boolean }
): StylingInfo | undefined {
  const node = candidate.impl ?? candidate.decl
  const file = relativeFileOf(analysis, candidate.decl)
  if (!file) return undefined
  const sf = candidate.decl.getSourceFile()
  const cssModules: StylingInfo["cssModules"] = []
  const libraries = new Set<string>()
  if (candidate.styled) libraries.add(candidate.styled.library)

  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const specifier = statement.moduleSpecifier.text
    if (specifier === "@emotion/react" && usesCssProp(node)) libraries.add("emotion")
    if (!CSS_MODULE.test(specifier) || !specifier.startsWith(".")) continue
    const local = statement.importClause?.name?.text
    if (!local || !referencesIdentifier(node, local)) continue
    const path = posix.normalize(posix.join(posix.dirname(file), specifier))
    const text = context.files.get(path)
    cssModules.push({ path, variables: text === undefined ? [] : variableLines(text) })
  }

  const source = node.getText(sf)
  const inlineVariables = [...new Set([...source.matchAll(VAR_REFERENCE)].map((m) => m[1] as string))].sort()
  const classNames = classNamesIn(node)
  if (
    cssModules.length === 0 &&
    inlineVariables.length === 0 &&
    classNames.length === 0 &&
    libraries.size === 0
  )
    return undefined
  return {
    cssModules,
    inlineVariables,
    classNames,
    tailwind: context.tailwind,
    libraries: [...libraries].sort()
  }
}

function variableLines(css: string): Array<{ name: string; line: number }> {
  const seen = new Map<string, number>()
  css.split("\n").forEach((text, index) => {
    for (const match of text.matchAll(VAR_REFERENCE))
      if (!seen.has(match[1] as string)) seen.set(match[1] as string, index + 1)
  })
  return [...seen]
    .map(([name, line]) => ({ name, line }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

function referencesIdentifier(root: ts.Node, name: string): boolean {
  let found = false
  const walk = (n: ts.Node): void => {
    if (found) return
    if (ts.isIdentifier(n) && n.text === name) found = true
    else ts.forEachChild(n, walk)
  }
  walk(root)
  return found
}

function usesCssProp(root: ts.Node): boolean {
  let found = false
  const walk = (n: ts.Node): void => {
    if (found) return
    if (ts.isJsxAttribute(n) && n.name.getText() === "css") found = true
    else ts.forEachChild(n, walk)
  }
  walk(root)
  return found
}

function classNamesIn(root: ts.Node): string[] {
  const out = new Set<string>()
  const add = (text: string): void => {
    for (const token of text.split(/\s+/)) if (token && out.size < MAX_CLASSES) out.add(token)
  }
  const fromExpression = (expression: ts.Expression): void => {
    const node = unwrap(expression)
    if (ts.isStringLiteralLike(node)) add(node.text)
    else if (ts.isTemplateExpression(node)) {
      add(node.head.text)
      for (const span of node.templateSpans) {
        add(span.literal.text)
        fromExpression(span.expression)
      }
    } else if (ts.isConditionalExpression(node)) {
      fromExpression(node.whenTrue)
      fromExpression(node.whenFalse)
    } else if (ts.isBinaryExpression(node)) {
      fromExpression(node.right)
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      CLASS_HELPERS.has(node.expression.text)
    ) {
      for (const argument of node.arguments) fromExpression(argument)
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) fromExpression(element)
    }
  }
  const walk = (n: ts.Node): void => {
    if (ts.isJsxAttribute(n) && n.name.getText() === "className" && n.initializer) {
      if (ts.isStringLiteral(n.initializer)) add(n.initializer.text)
      else if (ts.isJsxExpression(n.initializer) && n.initializer.expression)
        fromExpression(n.initializer.expression)
    }
    ts.forEachChild(n, walk)
  }
  walk(root)
  return [...out].sort()
}
