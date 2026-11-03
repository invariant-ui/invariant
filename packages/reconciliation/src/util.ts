import { canonicalStringify, type JsonValue } from "@invariant/shared"

export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Lower-case id segment matching the contract's name grammar `[a-z0-9][a-z0-9._-]*`. */
export function slug(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-{2,}/g, "-")
    .replace(/[-.]+$/, "")
  return s === "" ? "x" : s
}

/** Equality key for names: case and separators are ignored. */
export function normalizeName(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "")
}

export function sameValue(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  return (
    canonicalStringify(a ?? null) === canonicalStringify(b ?? null) && (a === undefined) === (b === undefined)
  )
}

/** Order-insensitive equality for arrays of scalars (value domains); other values compare exactly. */
export function sameDomain(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    const key = (v: JsonValue): string => canonicalStringify(v)
    return canonicalStringify([...a].map(key).sort()) === canonicalStringify([...b].map(key).sort())
  }
  return sameValue(a, b)
}

/** Sets `value` at a nested path. Returns false when the path collides with an existing leaf or branch. */
export function setNested(
  target: Record<string, JsonValue>,
  segments: readonly string[],
  value: JsonValue
): boolean {
  let node = target
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i] as string
    const next = node[key]
    if (next === undefined) {
      const created: Record<string, JsonValue> = {}
      node[key] = created
      node = created
    } else if (next !== null && typeof next === "object" && !Array.isArray(next))
      node = next as Record<string, JsonValue>
    else return false
  }
  const last = segments[segments.length - 1] as string
  if (last in node) return false
  node[last] = value
  return true
}

export function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)]
}
