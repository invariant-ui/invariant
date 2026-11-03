import ts from "typescript"
import type { DynamicValue, PropValue } from "./validate-usage.js"

export interface ScannedUse {
  tag: string
  line: number
  column: number
  attrs: Record<string, PropValue>
  hasChildren: boolean | undefined
  hasSpread: boolean
  /** Index in the scan result of the nearest enclosing element, if any. */
  parent: number | undefined
}

export interface ImportBinding {
  module: string
  /** The exported name, or `default`. For a namespace import this is `*`. */
  imported: string
}

export interface JsxScan {
  uses: ScannedUse[]
  /** Local names bound by import declarations in the snippet. */
  imports: Map<string, ImportBinding>
}

const dyn = (text: string): DynamicValue => ({ expression: text.replace(/\s+/g, " ").trim().slice(0, 80) })

function jsxValue(init: ts.JsxAttribute["initializer"], sf: ts.SourceFile): PropValue {
  if (!init) return true
  if (ts.isStringLiteral(init)) return init.text
  if (ts.isJsxExpression(init) && init.expression) {
    const e = init.expression
    if (ts.isStringLiteralLike(e)) return e.text
    if (ts.isNumericLiteral(e)) return Number(e.text)
    if (e.kind === ts.SyntaxKind.TrueKeyword) return true
    if (e.kind === ts.SyntaxKind.FalseKeyword) return false
    if (e.kind === ts.SyntaxKind.NullKeyword) return null
    return dyn(e.getText(sf))
  }
  return dyn(init.getText(sf))
}

/** JSX elements and import bindings in a TypeScript/JavaScript snippet, by syntax only. Nothing is evaluated. */
export function scanJsx(code: string, filename = "snippet.tsx"): JsxScan {
  const kind = /\.jsx?$/i.test(filename) ? ts.ScriptKind.JSX : ts.ScriptKind.TSX
  const sf = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true, kind)
  const uses: ScannedUse[] = []
  const imports = new Map<string, ImportBinding>()

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const module = stmt.moduleSpecifier.text
    const clause = stmt.importClause
    if (!clause) continue
    if (clause.name) imports.set(clause.name.text, { module, imported: "default" })
    const bindings = clause.namedBindings
    if (bindings && ts.isNamespaceImport(bindings)) imports.set(bindings.name.text, { module, imported: "*" })
    else if (bindings)
      for (const el of bindings.elements)
        imports.set(el.name.text, { module, imported: (el.propertyName ?? el.name).text })
  }

  const visit = (node: ts.Node, parent: number | undefined): void => {
    let next = parent
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node
      const attrs: Record<string, PropValue> = {}
      let spread = false
      for (const a of opening.attributes.properties) {
        if (ts.isJsxSpreadAttribute(a)) spread = true
        else attrs[a.name.getText(sf)] = jsxValue(a.initializer, sf)
      }
      const hasChildren = ts.isJsxElement(node)
        ? node.children.some((c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces))
        : false
      const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf))
      uses.push({
        tag: opening.tagName.getText(sf),
        line: pos.line + 1,
        column: pos.character + 1,
        attrs,
        hasChildren,
        hasSpread: spread,
        parent
      })
      next = uses.length - 1
    }
    ts.forEachChild(node, (child) => visit(child, next))
  }
  visit(sf, undefined)
  return { uses, imports }
}

const RAW_TEXT = new Set(["script", "style"])
const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr"
])
const camel = (n: string): string =>
  /^(data|aria)-/.test(n) ? n : n.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())

/**
 * Element start tags in an HTML-like template (Vue, Angular, HTML), with their nesting. A single linear pass:
 * no DOM, no expression evaluation. Event handlers, structural directives and references are skipped;
 * bindings are kept as dynamic values.
 */
export function scanMarkup(code: string): ScannedUse[] {
  const uses: ScannedUse[] = []
  const stack: Array<{ tag: string; index: number }> = []
  let i = 0
  let line = 1
  let lineStart = 0
  const n = code.length
  const advance = (to: number): void => {
    for (; i < to && i < n; i++)
      if (code[i] === "\n") {
        line++
        lineStart = i + 1
      }
  }
  while (i < n) {
    const lt = code.indexOf("<", i)
    if (lt < 0) break
    advance(lt)
    if (code.startsWith("<!--", i)) {
      const end = code.indexOf("-->", i + 4)
      advance(end < 0 ? n : end + 3)
      continue
    }
    if (code.startsWith("</", i)) {
      const close = /^<\/([A-Za-z][A-Za-z0-9_.:-]*)/.exec(code.slice(i, i + 130))
      if (close) {
        const at = stack.map((s) => s.tag).lastIndexOf(close[1] as string)
        if (at >= 0) stack.length = at
      }
      advance(i + 2)
      continue
    }
    const m = /^<([A-Za-z][A-Za-z0-9_.:-]*)/.exec(code.slice(i, i + 130))
    if (!m) {
      advance(i + 1)
      continue
    }
    const tag = m[1] as string
    const startLine = line
    const startColumn = i - lineStart + 1
    let j = i + m[0].length
    const attrs: Record<string, PropValue> = {}
    let spread = false
    let selfClosing = false
    while (j < n) {
      while (j < n && /\s/.test(code[j] as string)) j++
      const c = code[j]
      if (c === undefined) break
      if (c === ">") {
        j++
        break
      }
      if (c === "/" && code[j + 1] === ">") {
        selfClosing = true
        j += 2
        break
      }
      const nm = /^[^\s=>/"']+/.exec(code.slice(j, j + 200))
      if (!nm) {
        j++
        continue
      }
      const raw = nm[0]
      j += raw.length
      let value: string | undefined
      let k = j
      while (k < n && /\s/.test(code[k] as string)) k++
      if (code[k] === "=") {
        k++
        while (k < n && /\s/.test(code[k] as string)) k++
        const q = code[k]
        if (q === '"' || q === "'") {
          const end = code.indexOf(q, k + 1)
          value = code.slice(k + 1, end < 0 ? n : end)
          j = end < 0 ? n : end + 1
        } else {
          const um = /^[^\s>]+/.exec(code.slice(k, k + 200))
          value = um?.[0] ?? ""
          j = k + value.length
        }
      }
      if (
        /^(@|\(|v-on:|v-on$|#|\*|v-if|v-else|v-for|v-show|v-model|v-slot|ng)/.test(raw) &&
        !/^\[/.test(raw)
      ) {
        if (raw === "v-bind" || raw.startsWith("v-bind=")) spread = true
        continue
      }
      const bound = /^(:|v-bind:|\[)/.test(raw)
      const name = camel(
        raw
          .replace(/^(:|v-bind:)/, "")
          .replace(/^\[|\]$/g, "")
          .replace(/^attr\./, "")
      )
      attrs[name] = bound ? dyn(value ?? "") : value === undefined ? true : value
    }
    uses.push({
      tag,
      line: startLine,
      column: startColumn,
      attrs,
      hasChildren: selfClosing ? false : undefined,
      hasSpread: spread,
      parent: stack[stack.length - 1]?.index
    })
    if (!selfClosing && !VOID.has(tag.toLowerCase()) && !RAW_TEXT.has(tag.toLowerCase()))
      stack.push({ tag, index: uses.length - 1 })
    advance(j)
    if (RAW_TEXT.has(tag.toLowerCase()) && !selfClosing) {
      const close = code.toLowerCase().indexOf(`</${tag.toLowerCase()}`, i)
      advance(close < 0 ? n : close)
    }
  }
  return uses
}
