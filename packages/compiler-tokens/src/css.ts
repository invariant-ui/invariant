export type ScopeKind =
  | { kind: "root" }
  | { kind: "theme"; mode: string; via: "selector" | "media" }
  | { kind: "other" }

const ROOT = /^(?::root|html|:host|body)$/
const THEME_ATTR =
  /^(?:html|:root|body)?\[data-(?:theme|mode|color-scheme|color-mode)(?:[~^$*|]?=)?["']?([\w-]+)["']?\]$/
const THEME_CLASS = /^(?:html|:root|body)?\.(dark|light)$/
const THEME_PREFIX_CLASS = /^(?:html|:root|body)?\.theme-([\w-]+)$/
const MEDIA_SCHEME = /^@media\b.*prefers-color-scheme\s*:\s*(dark|light)\b/i

/**
 * Classifies the rule chain around a custom property. Only well-known theme conventions are treated as
 * themes: a data-theme-style attribute, `.dark`/`.light`/`.theme-*` classes, and
 * `@media (prefers-color-scheme)` around a root selector. Any other selector is `other`, which usually
 * means a component-private variable, and is never presented as a theme or default value.
 */
export function classifyScope(chain: readonly string[]): ScopeKind {
  const selector = [...chain].reverse().find((entry) => !entry.startsWith("@"))
  if (selector === undefined) return { kind: "other" }
  const media = chain
    .map((entry) => MEDIA_SCHEME.exec(entry)?.[1]?.toLowerCase())
    .find((m) => m !== undefined)
  const parts = selector.split(",").map((p) => p.trim())
  const classified = parts.map((part): ScopeKind => {
    if (ROOT.test(part)) return media ? { kind: "theme", mode: media, via: "media" } : { kind: "root" }
    const match = THEME_ATTR.exec(part) ?? THEME_CLASS.exec(part) ?? THEME_PREFIX_CLASS.exec(part)
    if (match?.[1]) return { kind: "theme", mode: match[1].toLowerCase(), via: "selector" }
    return { kind: "other" }
  })
  const first = classified[0]
  if (!first) return { kind: "other" }
  const same = classified.every(
    (c) => c.kind === first.kind && (c.kind !== "theme" || (first.kind === "theme" && c.mode === first.mode))
  )
  return same ? first : { kind: "other" }
}

const COLOR_FN = /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i
const LENGTH = /^-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|%|vh|vw|vmin|vmax|ch|ex|pt|cm|mm|in)$/i
const TIME = /^-?(?:\d+\.?\d*|\.\d+)(?:ms|s)$/i
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)$/

/** Syntactic classification of a raw value. It says what the text looks like, nothing about design intent. */
export function valueKind(
  raw: string
): "color" | "length" | "time" | "number" | "reference" | "expression" | "url" | "string" | "other" {
  const value = raw.trim()
  if (/^var\(/i.test(value)) return "reference"
  if (/^#[0-9a-f]{3,8}$/i.test(value) || COLOR_FN.test(value)) return "color"
  if (LENGTH.test(value)) return "length"
  if (TIME.test(value)) return "time"
  if (NUMBER.test(value)) return "number"
  if (/^(?:calc|min|max|clamp)\(/i.test(value)) return "expression"
  if (/^url\(/i.test(value)) return "url"
  if (/^["']/.test(value)) return "string"
  return "other"
}
