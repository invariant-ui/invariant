import type { CssVariable, TokenFile } from "./schema.js"
import { cmp, type DiscoveryEnv, hashText, posix, readBounded } from "./support.js"

const NOT_TOKENS =
  /^(?:package(?:-lock)?|tsconfig(?:\..+)?|angular|turbo|nx|lerna|biome|deno|composer)\.json$/i
const NAMED_TOKEN_JSON = /(?:^|[./-])tokens?\.json$/i
const TOKEN_DIR_JSON = /(?:^|\/)(?:design-)?tokens\/[^/]+\.json$/i
const STYLE_DICTIONARY_CONFIG = /^(?:style-dictionary|sd)\.config\.[cm]?[jt]s(?:on)?$/
const TAILWIND_CONFIG = /^tailwind\.config\.[cm]?[jt]s$/

/** CSS custom-property files, token JSON files, and token-tool config files. Values are recorded raw, never evaluated. */
export async function discoverTokenFiles(env: DiscoveryEnv): Promise<TokenFile[]> {
  const out: TokenFile[] = []
  for (const file of env.files) {
    const base = posix.basename(file)
    if (/\.css$/.test(file) && !/\.min\.css$/.test(file)) {
      const text = await readBounded(env, file)
      if (text === undefined) continue
      const variables = parseCssCustomProperties(text)
      if (variables.length === 0) continue
      const truncated = variables.length > env.limits.maxCssVariablesPerFile
      out.push({
        path: file,
        kind: "css-custom-properties",
        contentHash: hashText(text),
        cssVariables: variables.slice(0, env.limits.maxCssVariablesPerFile),
        ...(truncated ? { cssVariablesTruncated: true } : {})
      })
    } else if (STYLE_DICTIONARY_CONFIG.test(base) || TAILWIND_CONFIG.test(base)) {
      const text = await readBounded(env, file)
      if (text === undefined) continue
      out.push({
        path: file,
        kind: STYLE_DICTIONARY_CONFIG.test(base) ? "style-dictionary-config" : "tailwind-config",
        contentHash: hashText(text)
      })
    } else if (!NOT_TOKENS.test(base) && (NAMED_TOKEN_JSON.test(file) || TOKEN_DIR_JSON.test(file))) {
      const text = await readBounded(env, file)
      if (text === undefined) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        env.diagnostics.warning(
          "discovery.token-json-invalid",
          `${file} looks like a token file but is not valid JSON`,
          { location: { path: file } }
        )
        continue
      }
      const shape = classifyTokenJson(parsed)
      // A file only matched by directory name must actually look like tokens.
      if (!NAMED_TOKEN_JSON.test(file) && shape.count === 0) continue
      out.push({
        path: file,
        kind: "json-tokens",
        format: shape.format,
        tokenCount: shape.count,
        contentHash: hashText(text)
      })
    }
  }
  return out.sort((a, b) => cmp(a.path, b.path))
}

function classifyTokenJson(root: unknown): { format: NonNullable<TokenFile["format"]>; count: number } {
  let dtcg = 0
  let sd = 0
  const visit = (node: unknown, depth: number): void => {
    if (typeof node !== "object" || node === null || depth > 20) return
    const record = node as Record<string, unknown>
    if ("$value" in record) dtcg++
    else if ("value" in record && typeof record.value !== "object") sd++
    else for (const child of Object.values(record)) visit(child, depth + 1)
  }
  visit(root, 0)
  if (dtcg > 0 && dtcg >= sd) return { format: "dtcg-like", count: dtcg }
  if (sd > 0) return { format: "style-dictionary-like", count: sd }
  return { format: "unknown", count: 0 }
}

/**
 * Tolerant CSS scanner for custom-property declarations. Tracks the enclosing selector/at-rule chain,
 * skips comments, strings, and parenthesized `;` (such as in `url(data:…;base64,…)`).
 */
export function parseCssCustomProperties(source: string): CssVariable[] {
  return scanCssCustomProperties(source).map(({ chain: _chain, ...variable }) => variable)
}

/** Like `parseCssCustomProperties`, but also returns the enclosing rule chain (outermost first). */
export function scanCssCustomProperties(source: string): Array<CssVariable & { chain: string[] }> {
  const css = blankComments(source)
  const found: Array<CssVariable & { chain: string[] }> = []
  const lineStarts = [0]
  for (let i = 0; i < css.length; i++) if (css[i] === "\n") lineStarts.push(i + 1)
  const lineAt = (index: number): number => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if ((lineStarts[mid] as number) <= index) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }

  const stack: string[] = []
  let segmentStart = 0
  let parens = 0
  const flushDeclaration = (end: number): void => {
    const raw = css.slice(segmentStart, end)
    const trimmed = raw.trimStart()
    const match = /^(--[A-Za-z0-9_-]+)\s*:([\s\S]*)$/.exec(trimmed)
    if (match && stack.length > 0) {
      const value = (match[2] as string).trim().replace(/\s+/g, " ")
      const alias = /^var\(\s*(--[A-Za-z0-9_-]+)\s*\)$/.exec(value)
      found.push({
        name: match[1] as string,
        scope: stack.join(" "),
        chain: [...stack],
        line: lineAt(segmentStart + (raw.length - trimmed.length)),
        value: value.slice(0, 200),
        ...(alias ? { aliasOf: alias[1] as string } : {})
      })
    }
  }

  for (let i = 0; i < css.length; i++) {
    const c = css[i] as string
    if (c === '"' || c === "'") {
      for (i++; i < css.length && css[i] !== c; i++) if (css[i] === "\\") i++
    } else if (c === "(") parens++
    else if (c === ")") parens = Math.max(0, parens - 1)
    else if (parens > 0) continue
    else if (c === "{") {
      stack.push(css.slice(segmentStart, i).trim().replace(/\s+/g, " "))
      segmentStart = i + 1
    } else if (c === ";") {
      flushDeclaration(i)
      segmentStart = i + 1
    } else if (c === "}") {
      flushDeclaration(i)
      stack.pop()
      segmentStart = i + 1
    }
  }
  return found
}

/** Replaces comment text with spaces (keeping newlines) so offsets and line numbers stay valid. */
function blankComments(css: string): string {
  let out = ""
  for (let i = 0; i < css.length; i++) {
    const c = css[i] as string
    if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2)
      const stop = end < 0 ? css.length : end + 2
      out += css.slice(i, stop).replace(/[^\n]/g, " ")
      i = stop - 1
    } else if (c === '"' || c === "'") {
      let j = i + 1
      while (j < css.length && css[j] !== c) j += css[j] === "\\" ? 2 : 1
      out += css.slice(i, j + 1)
      i = j
    } else out += c
  }
  return out
}
