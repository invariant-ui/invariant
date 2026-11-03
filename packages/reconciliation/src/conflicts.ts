import type { Conflict } from "@invariant/contract"
import type { JsonValue } from "@invariant/shared"
import type { ConflictDraft } from "./components.js"
import type { IdentityAmbiguity, Implementation } from "./resolve.js"
import type { Discrepancy } from "./storybook.js"
import { cmp, sameValue, slug, unique } from "./util.js"

type Claim = ConflictDraft["claims"][number]

/**
 * Storybook findings that cite evidence on both sides become conflicts: a story or control says one thing
 * and the implementation another. Coverage findings (not demonstrated, unlinked, unverifiable) stay
 * diagnostics, because a conflict needs two evidenced claims.
 */
export function storybookConflicts(
  discrepancies: readonly Discrepancy[],
  refToId: ReadonlyMap<string, string>,
  implementations: ReadonlyMap<string, Implementation>
): ConflictDraft[] {
  const drafts: ConflictDraft[] = []
  for (const d of discrepancies) {
    const subject = d.component ? refToId.get(d.component) : undefined
    const impl = d.component ? implementations.get(d.component) : undefined
    if (!subject || !d.prop || !d.claim || d.storybookEvidence.length === 0) continue
    const code = d.code.replace("reconcile.storybook.", "")
    const base = { subject: subject as Conflict["subject"], severity: d.severity }
    const storybook = (value?: JsonValue): Claim => ({
      sourceId: d.sourceId,
      ...(value === undefined ? {} : { value }),
      status: "discovered",
      evidenceIds: d.storybookEvidence
    })
    const codeEvidence =
      d.codeEvidence.length > 0
        ? d.codeEvidence
        : (impl?.facts.find((f) => f.path.endsWith(".propsComplete"))?.evidenceIds ?? [])
    if (codeEvidence.length === 0 || !impl) continue
    const codeClaim = (value?: JsonValue): Claim => ({
      sourceId: impl.code.sourceId,
      ...(value === undefined ? {} : { value }),
      status: "discovered",
      evidenceIds: codeEvidence
    })
    if (code === "arg-value-not-allowed" || code === "control-option-not-allowed")
      drafts.push({
        ...base,
        type: "value-mismatch",
        path: `props.${d.prop}.allowedValues`,
        claims: [codeClaim(d.claim.code), storybook(d.claim.storybook)],
        suggestedResolution:
          "Change the story or control to a declared value, or add the value to the component."
      })
    else if (code === "default-mismatch")
      drafts.push({
        ...base,
        type: "value-mismatch",
        path: `props.${d.prop}.default`,
        claims: [codeClaim(d.claim.code), storybook(d.claim.storybook)],
        suggestedResolution: "Update the documented default or the code default."
      })
    else if (code === "arg-undeclared" || code === "control-undeclared")
      drafts.push({
        ...base,
        type: "existence-mismatch",
        path: `props.${d.prop}`,
        claims: [codeClaim(), storybook(true)],
        suggestedResolution: "Remove the arg or control, or add the prop to the component."
      })
    else if (code === "deprecated-demonstrated")
      drafts.push({
        ...base,
        type: "deprecation-mismatch",
        path: `props.${d.prop}.deprecated`,
        claims: [codeClaim(true), storybook()],
        suggestedResolution: "Stop demonstrating the deprecated prop, or mark it as supported."
      })
  }
  return drafts
}

export function ambiguityConflicts(
  ambiguities: readonly IdentityAmbiguity[],
  refToId: ReadonlyMap<string, string>
): ConflictDraft[] {
  const out: ConflictDraft[] = []
  for (const a of ambiguities) {
    const first = a.candidates[0]
    const subject = first ? refToId.get(first.code.ref) : undefined
    if (!first || !subject) continue
    out.push({
      type: "identity-ambiguity",
      severity: "warning",
      subject: subject as Conflict["subject"],
      claims: a.candidates.map((c) => ({
        sourceId: c.code.sourceId,
        value: c.code.ref,
        status: "discovered" as const,
        evidenceIds: c.facts.find((f) => f.path === "name")?.evidenceIds ?? c.facts[0]?.evidenceIds ?? []
      })),
      suggestedResolution: `Several implementations match the name "${a.key}" and no single pairing is certain. They were not merged; link the ones that are the same component.`
    })
  }
  return out
}

/** Merges drafts about the same subject and path, then mints stable ids. Claims are never dropped. */
export function mintConflicts(drafts: readonly ConflictDraft[]): Conflict[] {
  const grouped = new Map<string, ConflictDraft>()
  for (const d of drafts) {
    const key = `${d.type}\u0000${d.subject}\u0000${d.path ?? ""}`
    let existing = grouped.get(key)
    if (!existing) {
      existing = { ...d, claims: [] }
      grouped.set(key, existing)
    } else if (d.severity === "warning" || (d.severity === "error" && existing.severity !== "error"))
      existing.severity = d.severity
    for (const claim of d.claims) {
      const same = existing.claims.find(
        (c) => c.sourceId === claim.sourceId && c.status === claim.status && sameValue(c.value, claim.value)
      )
      if (same) same.evidenceIds = unique([...same.evidenceIds, ...claim.evidenceIds]).sort()
      else existing.claims.push({ ...claim })
    }
  }
  const used = new Set<string>()
  const out: Conflict[] = []
  for (const [, d] of [...grouped.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    const subject = d.subject.slice(d.subject.indexOf(":") + 1)
    const base = `conflict:${d.type}/${slug(subject)}${d.path ? `/${slug(d.path)}` : ""}`
    let id = base
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`
    used.add(id)
    const claims = d.claims
      .map((c) => ({ ...c, evidenceIds: unique(c.evidenceIds).sort() }))
      .sort(
        (a, b) =>
          cmp(a.sourceId, b.sourceId) || cmp(JSON.stringify(a.value ?? null), JSON.stringify(b.value ?? null))
      )
    out.push({ ...d, id: id as Conflict["id"], claims, resolution: { state: "open" } })
  }
  return out
}
