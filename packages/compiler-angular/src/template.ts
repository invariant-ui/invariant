export interface TemplateAttribute {
  /** Attribute name without binding syntax: `[size]`, `size` and `[attr.size]` are all `size`-like names (see `bound`). */
  name: string
  value?: string
  /** `[x]`, `(x)`, `[(x)]`, `*x`, `bind-x`, `on-x`. */
  bound: boolean
}

export interface TemplateElement {
  tag: string
  line: number
  attributes: TemplateAttribute[]
}

export interface TemplateInfo {
  elements: TemplateElement[]
  slots: Array<{ name: string; select?: string; line: number }>
}

/**
 * Tolerant scanner for Angular templates: finds element start tags with their attributes, and the
 * `<ng-content>` projection slots. It respects quoted attribute values, skips comments and `{{ }}`
 * interpolations, and ignores control-flow blocks (`@if`, `@for`) because they are not tags. It does
 * not build a DOM and does not evaluate expressions.
 */
export function scanTemplate(text: string, firstLine: number): TemplateInfo {
  const elements: TemplateElement[] = []
  let i = 0
  let line = firstLine
  const advance = (to: number): void => {
    for (; i < to; i++) if (text[i] === "\n") line++
  }
  while (i < text.length) {
    const c = text[i]
    if (c === "{" && text[i + 1] === "{") {
      const end = text.indexOf("}}", i + 2)
      advance(end < 0 ? text.length : end + 2)
    } else if (c === "@" && CONTROL_FLOW.test(text.slice(i, i + 24))) {
      // `@if (a<b) {`: the condition is an expression, not markup, so skip its balanced parentheses.
      advance(skipParentheses(text, text.indexOf("(", i)))
    } else if (c === "<" && text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4)
      advance(end < 0 ? text.length : end + 3)
    } else if (c === "<" && /[A-Za-z]/.test(text[i + 1] ?? "")) {
      const start = line
      const tag = /^[A-Za-z][\w:.-]*/.exec(text.slice(i + 1))?.[0] ?? ""
      let j = i + 1 + tag.length
      const attributes: TemplateAttribute[] = []
      while (j < text.length && text[j] !== ">") {
        if (/\s|\//.test(text[j] as string)) {
          j++
          continue
        }
        const name = /^[^\s=/>]+/.exec(text.slice(j))?.[0] ?? ""
        j += name.length
        let value: string | undefined
        if (text[j] === "=") {
          j++
          const quote = text[j]
          if (quote === '"' || quote === "'") {
            const end = text.indexOf(quote, j + 1)
            value = text.slice(j + 1, end < 0 ? text.length : end)
            j = end < 0 ? text.length : end + 1
          } else {
            const unquoted = /^[^\s>]+/.exec(text.slice(j))?.[0] ?? ""
            value = unquoted
            j += unquoted.length
          }
        }
        if (name) attributes.push({ ...normalize(name), ...(value !== undefined ? { value } : {}) })
      }
      elements.push({ tag, line: start, attributes })
      advance(Math.min(j + 1, text.length))
    } else advance(i + 1)
  }
  return { elements, slots: slotsOf(elements) }
}

const CONTROL_FLOW = /^@(?:else\s+if|if|for|switch|case|defer)\s*\(/

/** Index just past the parenthesis that closes the one at `open`, honoring quotes. */
function skipParentheses(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === '"' || c === "'" || c === "`") {
      const end = text.indexOf(c, i + 1)
      if (end < 0) return text.length
      i = end
    } else if (c === "(") depth++
    else if (c === ")" && --depth === 0) return i + 1
  }
  return text.length
}

function normalize(raw: string): { name: string; bound: boolean } {
  const wrapped = /^\[\(?(.+?)\)?\]$/.exec(raw) ?? /^\((.+)\)$/.exec(raw)
  if (wrapped) return { name: (wrapped[1] as string).replace(/^attr\./, ""), bound: true }
  if (raw.startsWith("*")) return { name: raw.slice(1), bound: true }
  const prefixed = /^(?:bind|on|bindon)-(.+)$/.exec(raw)
  if (prefixed) return { name: prefixed[1] as string, bound: true }
  return { name: raw, bound: false }
}

function slotsOf(elements: readonly TemplateElement[]): TemplateInfo["slots"] {
  const used = new Set<string>()
  const out: TemplateInfo["slots"] = []
  for (const e of elements) {
    if (e.tag !== "ng-content") continue
    const select = e.attributes.find((a) => a.name === "select" && !a.bound)?.value
    let name = select === undefined ? "default" : slotName(select)
    for (let n = 2; used.has(name); n++) name = `${slotName(select ?? "default")}_${n}`
    used.add(name)
    out.push({ name, ...(select !== undefined ? { select } : {}), line: e.line })
  }
  return out
}

/** `[slot=icon]` and `icon` and `[icon]` and `.icon` all name the slot `icon`; anything else is sanitized. */
export function slotName(select: string): string {
  const trimmed = select.trim()
  const attrValue = /^\[[\w-]*slot[\w-]*=["']?([\w-]+)["']?\]$/.exec(trimmed)
  if (attrValue) return attrValue[1] as string
  const simple = /^(?:\[([\w-]+)\]|\.([\w-]+)|([A-Za-z][\w-]*))$/.exec(trimmed)
  if (simple) return (simple[1] ?? simple[2] ?? simple[3]) as string
  return trimmed.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "slot"
}

export interface SimpleSelector {
  element?: string
  attributes: string[]
}

/** Element and attribute parts of a component selector. Class, `:not()` and complex selectors are ignored. */
export function parseSelector(selector: string): SimpleSelector[] {
  const out: SimpleSelector[] = []
  for (const alternative of selector.split(",")) {
    const text = alternative.trim()
    if (!text || text.includes(":not(") || text.includes(" ") || text.includes(">")) continue
    const element = /^[A-Za-z][\w-]*/.exec(text)?.[0]
    const attributes = [...text.matchAll(/\[([\w-]+)(?:=[^\]]*)?\]/g)].map((m) => m[1] as string)
    if (element || attributes.length > 0) out.push({ ...(element ? { element } : {}), attributes })
  }
  return out
}

export function matchesSelector(element: TemplateElement, selectors: readonly SimpleSelector[]): boolean {
  const names = new Set(element.attributes.map((a) => a.name))
  return selectors.some(
    (s) => (s.element === undefined || s.element === element.tag) && s.attributes.every((a) => names.has(a))
  )
}
