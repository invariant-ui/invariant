import type { JsonValue } from "@invariant/shared"

export type ResolvedFactPath = { found: true; value: JsonValue } | { found: false }

/**
 * Resolves a dotted fact path inside an entity. A segment addresses an object member, or, when the
 * current node is an array, the item whose `name` (or else `id`) equals the segment, or else the
 * item at that numeric index.
 */
export function resolveFactPath(entity: unknown, path: string): ResolvedFactPath {
  let node: unknown = entity
  for (const segment of path.split(".")) {
    if (Array.isArray(node)) {
      const item = node.find((candidate) => keyOf(candidate) === segment) ?? byIndex(node, segment)
      if (item === undefined) return { found: false }
      node = item
    } else if (isRecord(node) && Object.hasOwn(node, segment)) {
      node = node[segment]
    } else {
      return { found: false }
    }
  }
  return node === undefined ? { found: false } : { found: true, value: node as JsonValue }
}

function keyOf(item: unknown): string | undefined {
  if (!isRecord(item)) return undefined
  if (typeof item.name === "string") return item.name
  if (typeof item.id === "string") return item.id
  return undefined
}

function byIndex(items: unknown[], segment: string): unknown {
  return /^\d+$/.test(segment) ? items[Number(segment)] : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
