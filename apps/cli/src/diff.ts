import type { Contract } from "@invariant/contract"
import { canonicalStringify } from "@invariant/shared"

/** Collections of the contract that are keyed by `id` and compared entity by entity. */
const COLLECTIONS = [
  "sources",
  "themes",
  "components",
  "tokens",
  "patterns",
  "guidelines",
  "constraints",
  "policies",
  "conflicts"
] as const

/** Fields that change on every compile or sync and never mean the sources changed. */
const VOLATILE = new Set(["lastSyncedAt"])

type Entity = { id: string } & Record<string, unknown>

export interface CollectionDiff {
  collection: string
  added: string[]
  removed: string[]
  /** Entity id and the top-level fields whose value differs. */
  changed: { id: string; fields: string[] }[]
}

const same = (a: unknown, b: unknown): boolean =>
  a === undefined || b === undefined ? a === b : canonicalStringify(a) === canonicalStringify(b)

function changedFields(a: Entity, b: Entity): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].filter((k) => !VOLATILE.has(k) && !same(a[k], b[k])).sort()
}

/**
 * What differs between two compiled contracts, by collection and entity id. `metadata.compiledAt` and
 * `sources[].lastSyncedAt` are ignored: they are carried but never part of the content hash.
 */
export function diffContracts(previous: Contract, next: Contract): CollectionDiff[] {
  const out: CollectionDiff[] = []
  for (const collection of COLLECTIONS) {
    const before = new Map((previous[collection] as Entity[]).map((e) => [e.id, e]))
    const after = new Map((next[collection] as Entity[]).map((e) => [e.id, e]))
    const added = [...after.keys()].filter((id) => !before.has(id)).sort()
    const removed = [...before.keys()].filter((id) => !after.has(id)).sort()
    const changed: CollectionDiff["changed"] = []
    for (const [id, a] of before) {
      const b = after.get(id)
      if (!b) continue
      const fields = changedFields(a, b)
      if (fields.length > 0) changed.push({ id, fields })
    }
    changed.sort((x, y) => x.id.localeCompare(y.id))
    if (added.length + removed.length + changed.length > 0) out.push({ collection, added, removed, changed })
  }
  const meta = changedFields(
    { id: "metadata", ...previous.metadata, compiledAt: undefined } as Entity,
    { id: "metadata", ...next.metadata, compiledAt: undefined } as Entity
  ).filter((k) => k !== "compiledAt" && k !== "id")
  if (meta.length > 0)
    out.push({ collection: "metadata", added: [], removed: [], changed: [{ id: "metadata", fields: meta }] })
  return out
}

/** Human-readable lines, at most `limit` entity lines per collection. */
export function formatDiff(diff: readonly CollectionDiff[], limit = 10): string[] {
  const lines: string[] = []
  for (const d of diff) {
    lines.push(`${d.collection}: +${d.added.length} -${d.removed.length} ~${d.changed.length}`)
    const entries = [
      ...d.added.map((id) => `  + ${id}`),
      ...d.removed.map((id) => `  - ${id}`),
      ...d.changed.map((c) => `  ~ ${c.id} (${c.fields.join(", ")})`)
    ]
    lines.push(...entries.slice(0, limit))
    if (entries.length > limit) lines.push(`  ... ${entries.length - limit} more`)
  }
  return lines
}
