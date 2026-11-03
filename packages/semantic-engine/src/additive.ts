import type { ContractDraft } from "@invariant/contract"
import { canonicalStringify } from "@invariant/shared"

const same = (a: unknown, b: unknown): boolean =>
  canonicalStringify(a ?? null) === canonicalStringify(b ?? null)

type Entity = { id: string; facts: Record<string, unknown> }

function entityViolations(
  kind: string,
  before: readonly Entity[],
  after: readonly Entity[],
  ignore: (key: string, id: string) => boolean
): string[] {
  const out: string[] = []
  const afterById = new Map(after.map((e) => [e.id, e]))
  for (const b of before) {
    const a = afterById.get(b.id)
    if (!a) {
      out.push(`${kind} ${b.id} was removed`)
      continue
    }
    for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
      if (key === "facts" || ignore(key, b.id)) continue
      if (!same((b as Record<string, unknown>)[key], (a as Record<string, unknown>)[key]))
        out.push(`${kind} ${b.id}: ${key} changed`)
    }
    for (const [path, fact] of Object.entries(b.facts))
      if (!same(fact, a.facts[path])) out.push(`${kind} ${b.id}: fact ${path} changed`)
  }
  return out
}

/**
 * Enrichment may add entities, facts, and relationships. It may not change or remove anything reconciliation
 * produced, except the token `category` placeholder (and only while that has no fact). Returns violations.
 */
export function assertAdditive(before: ContractDraft, after: ContractDraft): string[] {
  const out: string[] = []
  for (const key of ["contractVersion", "metadata", "sources", "themes", "conflicts"] as const)
    if (!same(before[key], after[key])) out.push(`${key} changed`)
  if (after.policies.length !== 0 || before.policies.length !== 0) {
    if (!same(before.policies, after.policies))
      out.push("policies changed: the engine never produces policies")
  }

  out.push(...entityViolations("guideline", before.guidelines, after.guidelines, () => false))
  out.push(...entityViolations("pattern", before.patterns, after.patterns, () => false))
  out.push(...entityViolations("constraint", before.constraints, after.constraints, () => false))
  const placeholderOnly = (id: string): boolean =>
    before.tokens.find((t) => t.id === id)?.facts.category === undefined
  out.push(
    ...entityViolations(
      "token",
      before.tokens,
      after.tokens,
      (key, id) => key === "category" && placeholderOnly(id)
    )
  )
  const beforeComponents = new Map(before.components.map((c) => [c.id, c]))
  out.push(
    ...entityViolations("component", before.components, after.components, (key) => key === "composition")
  )
  for (const a of after.components) {
    const b = beforeComponents.get(a.id)
    if (b && !same(b.composition, a.composition.slice(0, b.composition.length)))
      out.push(`component ${a.id}: existing composition entries changed`)
  }
  return out
}
