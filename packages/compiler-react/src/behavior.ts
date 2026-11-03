import type { Analysis } from "@invariant/compiler-core"
import { walkSameFunction } from "@invariant/compiler-core"
import ts from "typescript"
import type { Candidate } from "./detect.js"
import type { PropInfo } from "./props.js"

export interface SlotInfo {
  name: string
  required: boolean
  prop: string
  typeText: string
  renderProp: boolean
}

/**
 * Slots are derived from props: `children` is the default slot, any other prop whose declared type is
 * renderable (ReactNode, ReactElement, JSX.Element) is a named slot, and a function prop returning
 * renderable output is a render-prop slot.
 */
export function slotsOf(props: readonly PropInfo[]): SlotInfo[] {
  return props
    .filter((p) => p.role === "children" || p.role === "slot" || p.role === "render-prop")
    .map((p) => ({
      name: p.role === "children" ? "default" : p.name,
      required: p.required,
      prop: p.name,
      typeText: p.typeText,
      renderProp: p.role === "render-prop"
    }))
}

export interface AccessibilityInfo {
  role?: string
  attributes: string[]
}

/** Static `role` and `aria-*` attributes on intrinsic (lowercase) JSX elements in the component body. */
export function accessibilityOf(candidate: Candidate): AccessibilityInfo | undefined {
  const impl = candidate.impl
  if (!impl) return undefined
  const roles = new Set<string>()
  const attributes = new Set<string>()
  const visit = (n: ts.Node): void => {
    const element = ts.isJsxSelfClosingElement(n) ? n : ts.isJsxOpeningElement(n) ? n : undefined
    if (!element || !/^[a-z]/.test(element.tagName.getText())) return
    for (const attribute of element.attributes.properties) {
      if (!ts.isJsxAttribute(attribute)) continue
      const name = attribute.name.getText()
      if (name === "role" && attribute.initializer && ts.isStringLiteral(attribute.initializer))
        roles.add(attribute.initializer.text)
      else if (name.startsWith("aria-")) attributes.add(name)
    }
  }
  const walk = (n: ts.Node): void => {
    visit(n)
    ts.forEachChild(n, walk)
  }
  // Nested component definitions inside the body are not this component's markup.
  if (ts.isFunctionLike(impl) && impl.body) walkSameFunction(impl, visit)
  else if (ts.isClassLike(impl)) walk(impl)
  if (roles.size === 0 && attributes.size === 0) return undefined
  const only = roles.size === 1 ? [...roles][0] : undefined
  return { ...(only ? { role: only } : {}), attributes: [...attributes].sort() }
}

export interface DocInfo {
  description?: string
  deprecated?: { reason?: string }
  examples: string[]
}

/** JSDoc on the component declaration: description, `@deprecated`, and `@example` blocks. */
export function docsOf(analysis: Analysis, candidate: Candidate): DocInfo {
  const { checker } = analysis
  const nameNode = (candidate.decl as { name?: ts.Node }).name
  const symbol = nameNode ? checker.getSymbolAtLocation(nameNode) : undefined
  if (!symbol) return { examples: [] }
  const description = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim()
  const tags = symbol.getJsDocTags(checker)
  const deprecated = tags.find((t) => t.name === "deprecated")
  const examples = tags
    .filter((t) => t.name === "example")
    .map((t) => ts.displayPartsToString(t.text).trim())
    .filter((t) => t.length > 0)
  const reason = deprecated ? ts.displayPartsToString(deprecated.text).trim() : undefined
  return {
    ...(description ? { description } : {}),
    ...(deprecated ? { deprecated: reason ? { reason } : {} } : {}),
    examples
  }
}
