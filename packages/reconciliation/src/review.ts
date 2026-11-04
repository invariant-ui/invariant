import type { ContractDraft, FactRecord } from "@invariant/contract"
import { hashJson } from "@invariant/shared"
import { cmp } from "./util.js"

export interface ReviewItem {
  /** Stable across runs for the same subject, path and kind. */
  id: string
  kind: "conflict" | "inferred-fact" | "pattern-fact"
  subject: string
  path?: string
  priority: "high" | "medium" | "low"
  reason: string
  confidence?: number
  rule?: string
  /** The contract conflict this item is about, for decisions. */
  conflictId?: string
  evidenceIds: string[]
  /** Nothing inferred or conflicting becomes authoritative without a person's decision. */
  approvalRequired: true
  /** Conflict resolution state; inferred and authored pattern facts are `pending` until approved. */
  state: "open" | "pending"
}

const PRIORITY = { high: 0, medium: 1, low: 2 } as const

/**
 * Everything a person must look at: open conflicts and every inferred fact. Derived from the contract and
 * not stored in it; rebuilding it from the same contract gives the same list.
 */
export function buildReviewQueue(contract: ContractDraft): ReviewItem[] {
  const items: ReviewItem[] = []
  for (const c of contract.conflicts) {
    if (c.resolution.state !== "open") continue
    items.push({
      id: `rv_${hashJson({ kind: "conflict", id: c.id }).slice(0, 16)}`,
      kind: "conflict",
      conflictId: c.id,
      subject: c.subject,
      ...(c.path ? { path: c.path } : {}),
      priority: c.severity === "error" ? "high" : c.severity === "warning" ? "medium" : "low",
      reason: `${c.type}: ${c.claims.length} claims disagree${c.suggestedResolution ? `. ${c.suggestedResolution}` : ""}`,
      evidenceIds: [...new Set(c.claims.flatMap((x) => x.evidenceIds))].sort(),
      approvalRequired: true,
      state: "open"
    })
  }
  const entities: Array<{ id: string; facts: Record<string, FactRecord> }> = [
    ...contract.components,
    ...contract.tokens,
    ...contract.guidelines,
    ...contract.patterns,
    ...contract.constraints
  ]
  for (const e of entities) {
    for (const [path, fact] of Object.entries(e.facts)) {
      if (fact.status !== "inferred") continue
      const confidence = fact.confidence ?? 0
      items.push({
        id: `rv_${hashJson({ kind: "inferred-fact", subject: e.id, path }).slice(0, 16)}`,
        kind: "inferred-fact",
        subject: e.id,
        path,
        priority: confidence < 0.6 ? "high" : confidence < 0.85 ? "medium" : "low",
        reason: fact.derivation?.reasoning ?? "inferred",
        confidence,
        ...(fact.derivation ? { rule: fact.derivation.rule } : {}),
        evidenceIds: [...fact.evidenceIds].sort(),
        approvalRequired: true,
        state: "pending"
      })
    }
  }
  // A pattern written by a person is `documented`, not approved: someone must still say it is the standard.
  // Its constraints are listed too, so each fact can be approved on its own.
  const owned = new Set(contract.patterns.flatMap((p) => p.constraints ?? []))
  const authored: Array<{ id: string; facts: Record<string, FactRecord> }> = [
    ...contract.patterns,
    ...contract.constraints.filter((c) => owned.has(c.id))
  ]
  for (const e of authored)
    for (const [path, fact] of Object.entries(e.facts)) {
      if (fact.status !== "documented") continue
      items.push({
        id: `rv_${hashJson({ kind: "pattern-fact", subject: e.id, path }).slice(0, 16)}`,
        kind: "pattern-fact",
        subject: e.id,
        path,
        priority: "low",
        reason: "Authored pattern definition that has not been approved. Approve it to make it a standard.",
        evidenceIds: [...fact.evidenceIds].sort(),
        approvalRequired: true,
        state: "pending"
      })
    }
  return items.sort(
    (a, b) =>
      PRIORITY[a.priority] - PRIORITY[b.priority] ||
      cmp(a.subject, b.subject) ||
      cmp(a.path ?? "", b.path ?? "") ||
      cmp(a.kind, b.kind)
  )
}
