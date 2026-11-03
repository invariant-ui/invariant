import {
  type Component,
  type Conflict,
  type ContractDraft,
  computeFactFingerprint,
  type FactRecord,
  type Guideline,
  resolveFactPath,
  type Token
} from "@invariant/contract"
import { type Diagnostic, DiagnosticCollector } from "@invariant/diagnostics"
import { canonicalStringify, hashJson, type JsonValue } from "@invariant/shared"
import { z } from "zod"

export const DECISIONS_FILE = "invariant.decisions.json"

const who = {
  by: z.string().min(1).max(200),
  at: z.iso.datetime(),
  note: z.string().min(1).max(2000).optional()
}

export const decisionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("fact"),
    action: z.enum(["approve", "reject"]),
    subject: z.string().min(1).max(300),
    path: z.string().min(1).max(300),
    /** The value at `path` when the decision was made. If it has changed since, the decision is stale. */
    value: z.custom<JsonValue>((v) => v !== undefined),
    role: z.string().min(1).max(200).optional(),
    reference: z.string().min(1).max(500).optional(),
    ...who
  }),
  z.strictObject({
    kind: z.literal("conflict"),
    action: z.enum(["resolve", "accept", "dismiss"]),
    id: z.string().min(1).max(300),
    /** Hash of the conflict's claims when the decision was made. */
    claimsHash: z.string().regex(/^[0-9a-f]{64}$/),
    chosenSourceId: z.string().min(1).max(100).optional(),
    ...who
  })
])
export type Decision = z.infer<typeof decisionSchema>

export const decisionsFileSchema = z.strictObject({
  version: z.literal(1),
  decisions: z.array(decisionSchema)
})
export type DecisionsFile = z.infer<typeof decisionsFileSchema>

export type ParseDecisions = { ok: true; value: DecisionsFile } | { ok: false; message: string }

export function parseDecisions(text: string): ParseDecisions {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ok: false, message: `${DECISIONS_FILE} is not valid JSON: ${(error as Error).message}` }
  }
  const parsed = decisionsFileSchema.safeParse(raw)
  if (!parsed.success) {
    const i = parsed.error.issues[0]
    return {
      ok: false,
      message: `${DECISIONS_FILE} is invalid at ${i?.path.join(".") || "(root)"}: ${i?.message ?? "schema error"}`
    }
  }
  return { ok: true, value: parsed.data }
}

export const serializeDecisions = (file: DecisionsFile): string => `${canonicalStringify(file, 2)}\n`

export const claimsHash = (conflict: Pick<Conflict, "claims">): string =>
  hashJson(conflict.claims as unknown as JsonValue)

const targetKey = (d: Decision): string =>
  d.kind === "conflict"
    ? `conflict\u0000${d.id}`
    : `fact\u0000${d.subject}\u0000${canonicalStringify(d.value)}\u0000${d.path.replace(/\.\d+$/, "")}`

/** Adds a decision, replacing an earlier one about the same target so the last word stands. */
export function addDecision(file: DecisionsFile | undefined, decision: Decision): DecisionsFile {
  const kept = (file?.decisions ?? []).filter((d) => targetKey(d) !== targetKey(decision))
  return { version: 1, decisions: [...kept, decision] }
}

type Entity =
  | Component
  | Token
  | Guideline
  | ContractDraft["patterns"][number]
  | ContractDraft["constraints"][number]
type Collection = "components" | "tokens" | "guidelines" | "patterns" | "constraints"
const COLLECTIONS: Collection[] = ["components", "tokens", "guidelines", "patterns", "constraints"]

const same = (a: unknown, b: unknown): boolean =>
  canonicalStringify(a ?? null) === canonicalStringify(b ?? null)
const INDEXED = /^(composition|appliesTo)\.(\d+)$/

function find(draft: ContractDraft, id: string): { collection: Collection; entity: Entity } | undefined {
  for (const collection of COLLECTIONS) {
    const entity = (draft[collection] as Entity[]).find((e) => e.id === id)
    if (entity) return { collection, entity }
  }
  return undefined
}

export interface Applied {
  action: string
  target: string
}

export interface DecisionResult {
  contract: ContractDraft
  diagnostics: Diagnostic[]
  applied: Applied[]
  /** Decisions that no longer match the contract, so were not applied. */
  stale: Decision[]
}

/** Removes array item `index` from an entity and renumbers its facts for that collection. */
function removeIndexed(entity: Entity, collection: "composition" | "appliesTo", index: number): Entity {
  const e = entity as unknown as Record<string, unknown> & { facts: Record<string, FactRecord> }
  const items = [...(e[collection] as unknown[])]
  items.splice(index, 1)
  const facts: Record<string, FactRecord> = {}
  for (const [path, fact] of Object.entries(e.facts)) {
    const m = new RegExp(`^${collection}\\.(\\d+)$`).exec(path)
    if (!m) facts[path] = fact
    else {
      const n = Number(m[1])
      if (n < index) facts[path] = fact
      else if (n > index) facts[`${collection}.${n - 1}`] = fact
    }
  }
  return {
    ...e,
    [collection]: items,
    facts: Object.fromEntries(Object.entries(facts).sort((a, b) => (a[0] < b[0] ? -1 : 1)))
  } as unknown as Entity
}

/**
 * Applies people's decisions to a contract draft, in file order. Approving layers `approved` over the
 * fact's prior status with the contract's own fingerprint; rejecting removes an inferred fact where removal
 * is well defined; resolving a conflict records the decision and leaves the kept value alone (the fix
 * belongs in the source). A decision about a value or claims that have since changed is stale and ignored.
 */
export function applyDecisions(
  draft: ContractDraft,
  file: DecisionsFile | undefined,
  options: { approvers?: readonly string[] | undefined } = {}
): DecisionResult {
  const collector = new DiagnosticCollector()
  const applied: Applied[] = []
  const stale: Decision[] = []
  let contract = draft
  const approvers = options.approvers && options.approvers.length > 0 ? new Set(options.approvers) : undefined

  const replace = (collection: Collection, entity: Entity): void => {
    contract = {
      ...contract,
      [collection]: (contract[collection] as Entity[]).map((e) => (e.id === entity.id ? entity : e))
    } as ContractDraft
  }

  for (const d of file?.decisions ?? []) {
    const label = d.kind === "conflict" ? d.id : `${d.subject} ${d.path}`
    if (approvers && !approvers.has(d.by)) {
      collector.error(
        "governance.unauthorized",
        `${label}: "${d.by}" is not listed in governance.approvers, so the decision was not applied`
      )
      continue
    }
    if (d.kind === "conflict") {
      const conflict = contract.conflicts.find((c) => c.id === d.id)
      if (!conflict) {
        collector.warning(
          "governance.decision-target-missing",
          `${d.id}: the conflict no longer exists (it may have been fixed at the source); remove the decision`
        )
        continue
      }
      if (claimsHash(conflict) !== d.claimsHash) {
        collector.warning(
          "governance.decision-stale",
          `${d.id}: the claims changed since ${d.by} decided, so the decision was not applied`
        )
        stale.push(d)
        continue
      }
      if (d.chosenSourceId && !conflict.claims.some((c) => c.sourceId === d.chosenSourceId)) {
        collector.error(
          "governance.decision-invalid",
          `${d.id}: "${d.chosenSourceId}" is not one of the conflict's sources`
        )
        continue
      }
      const state = d.action === "resolve" ? "resolved" : d.action === "accept" ? "accepted" : "dismissed"
      const next: Conflict = {
        ...conflict,
        resolution: {
          state,
          ...(d.chosenSourceId ? { chosenSourceId: d.chosenSourceId } : {}),
          decidedBy: d.by,
          decidedAt: d.at,
          ...(d.note ? { note: d.note } : {})
        }
      }
      contract = { ...contract, conflicts: contract.conflicts.map((c) => (c.id === conflict.id ? next : c)) }
      applied.push({ action: d.action, target: d.id })
      continue
    }

    const hit = find(contract, d.subject)
    if (!hit) {
      collector.warning(
        "governance.decision-target-missing",
        `${label}: ${d.subject} is no longer in the contract; remove the decision`
      )
      continue
    }
    let path = d.path
    const indexed = INDEXED.exec(d.path)
    const entity = hit.entity as unknown as Record<string, unknown> & {
      id: string
      facts: Record<string, FactRecord>
    }
    if (indexed) {
      const items = (entity[indexed[1] as string] as unknown[] | undefined) ?? []
      const at = items.findIndex((item) => same(item, d.value))
      if (at < 0) {
        collector.warning(
          "governance.decision-stale",
          `${label}: the value it was about is gone, so the decision was not applied`
        )
        stale.push(d)
        continue
      }
      path = `${indexed[1]}.${at}`
    } else {
      const current = resolveFactPath(entity, path)
      if (!current.found || !same(current.value, d.value)) {
        collector.warning(
          "governance.decision-stale",
          `${label}: the value changed since ${d.by} decided, so the decision was not applied`
        )
        stale.push(d)
        continue
      }
    }
    const record = entity.facts[path]
    if (!record) {
      collector.warning("governance.decision-target-missing", `${label}: there is no fact at ${path}`)
      continue
    }
    if (d.action === "approve") {
      if (record.status === "approved") continue
      const value = resolveFactPath(entity, path)
      if (!value.found) continue
      const next: FactRecord = {
        ...record,
        status: "approved",
        approval: {
          approvedBy: d.by,
          approvedAt: d.at,
          ...(d.role ? { role: d.role } : {}),
          ...(d.reference ? { reference: d.reference } : {}),
          fingerprint: computeFactFingerprint({ entityId: entity.id, path, value: value.value as JsonValue }),
          priorStatus: record.status
        }
      }
      replace(hit.collection, { ...entity, facts: { ...entity.facts, [path]: next } } as unknown as Entity)
      applied.push({ action: "approve", target: label })
      continue
    }
    if (record.status === "approved") {
      collector.error(
        "governance.reject-approved",
        `${label}: the fact is approved; remove its approval decision before rejecting it`
      )
      continue
    }
    if (record.status !== "inferred") {
      collector.error(
        "governance.reject-unsupported",
        `${label}: only inferred facts can be rejected; a ${record.status} fact is stated by a source, so fix the source`
      )
      continue
    }
    if (indexed) {
      replace(
        hit.collection,
        removeIndexed(hit.entity, indexed[1] as "composition" | "appliesTo", Number(path.split(".")[1]))
      )
    } else if (hit.collection === "tokens" && path === "category") {
      const { category: _gone, ...facts } = entity.facts
      replace("tokens", { ...entity, category: "other", facts } as unknown as Entity)
    } else {
      collector.error(
        "governance.reject-unsupported",
        `${label}: rejecting this kind of inference is not supported (for an inferred identity between implementations, fix the names or split the component at the source)`
      )
      continue
    }
    applied.push({ action: "reject", target: label })
  }
  return { contract, diagnostics: collector.toArray(), applied, stale }
}
