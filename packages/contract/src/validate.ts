import { type Diagnostic, sortDiagnostics } from "@invariant/diagnostics"
import type { z } from "zod"
import { CONTRACT_VERSION, type Contract, contractSchema } from "./contract.js"
import { computeEvidenceId, type EvidenceFile } from "./evidence.js"
import { resolveFactPath } from "./fact-path.js"
import { computeFactFingerprint, type FactRecord } from "./facts.js"
import { computeContentHash } from "./integrity.js"

export type ParseResult<T> = { ok: true; value: T } | { ok: false; diagnostics: Diagnostic[] }

/**
 * Structural validation. Major-version mismatches are reported before schema errors. A migration
 * registry will be added with the first breaking schema change; v1 has nothing to migrate from.
 */
export function parseContract(input: unknown): ParseResult<Contract> {
  const version = declaredVersion(input)
  if (version !== undefined && version.split(".")[0] !== CONTRACT_VERSION.split(".")[0]) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "contract.unsupported-version",
          severity: "error",
          message: `Contract version ${version} is not supported; this build reads ${CONTRACT_VERSION}`
        }
      ]
    }
  }
  const result = contractSchema.safeParse(input)
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, diagnostics: schemaDiagnostics(result.error) }
}

/** Semantic validation: cross-references, ordering, fact paths, approvals, hashes and evidence links. */
export function verifyContract(contract: Contract, evidenceFile?: EvidenceFile): Diagnostic[] {
  const found: Diagnostic[] = []
  const report = (code: string, message: string, entityId?: string): void => {
    found.push({ code, severity: "error", message, ...(entityId ? { entityId } : {}) })
  }

  const sourceIds = new Set(contract.sources.map((s) => s.id))
  const themeIds = new Set<string>(contract.themes.map((t) => t.id))
  const entityIds = new Set<string>()
  checkOrdering(
    "source",
    contract.sources.map((s) => s.id),
    report
  )
  for (const [kind, ids] of collectionIds(contract)) {
    checkOrdering(kind, ids, report)
    for (const id of ids) entityIds.add(id)
  }

  for (const { from, to } of entityReferences(contract)) {
    if (!entityIds.has(to))
      report("contract.dangling-reference", `${from} references unknown entity ${to}`, from)
  }
  for (const { from, sourceId } of sourceReferences(contract)) {
    if (!sourceIds.has(sourceId))
      report("contract.unknown-source", `${from} references unknown source ${sourceId}`, from)
  }
  for (const token of contract.tokens) {
    for (const theme of Object.keys(token.modes ?? {})) {
      if (!themeIds.has(theme))
        report("contract.dangling-reference", `${token.id} has a mode for unknown theme ${theme}`, token.id)
    }
  }
  const frameworks = new Set<string>(contract.metadata.frameworks)
  for (const component of contract.components) {
    for (const impl of component.implementations) {
      if (!frameworks.has(impl.framework)) {
        report(
          "contract.framework-mismatch",
          `${component.id} uses framework ${impl.framework} missing from metadata.frameworks`,
          component.id
        )
      }
    }
  }

  const evidenceIdsUsed = new Set<string>()
  for (const entity of factBearingEntities(contract)) {
    for (const [path, fact] of Object.entries(entity.facts)) {
      for (const id of fact.evidenceIds) evidenceIdsUsed.add(id)
      checkFact({ entity, path, fact, report })
    }
  }
  for (const conflict of contract.conflicts)
    for (const claim of conflict.claims) for (const id of claim.evidenceIds) evidenceIdsUsed.add(id)

  for (const token of contract.tokens)
    checkAliasCycles({ token, tokens: contract.tokens, themeIds: [...themeIds], report })

  if (computeContentHash(contract) !== contract.integrity.contentHash) {
    report("contract.hash-mismatch", "integrity.contentHash does not match the contract content")
  }
  if (evidenceFile) checkEvidence({ contract, evidenceFile, evidenceIdsUsed, sourceIds, report })

  return sortDiagnostics(found)
}

type Report = (code: string, message: string, entityId?: string) => void

function checkFact(input: {
  entity: { id: string; facts: Record<string, FactRecord> }
  path: string
  fact: FactRecord
  report: Report
}): void {
  const { entity, path, fact, report } = input
  const resolved = resolveFactPath(entity, path)
  if (!resolved.found) {
    report(
      "contract.unresolvable-fact-path",
      `${entity.id} has a fact for '${path}' but the path does not resolve`,
      entity.id
    )
    return
  }
  if (fact.status === "approved" && fact.approval) {
    const fingerprint = computeFactFingerprint({ entityId: entity.id, path, value: resolved.value })
    if (fingerprint !== fact.approval.fingerprint) {
      report(
        "contract.approval-stale",
        `Approval of ${entity.id} '${path}' no longer matches its current value`,
        entity.id
      )
    }
  }
}

function checkOrdering(kind: string, ids: string[], report: Report): void {
  for (let i = 1; i < ids.length; i++) {
    const previous = ids[i - 1] as string
    const current = ids[i] as string
    if (current === previous) report("contract.duplicate-id", `Duplicate ${kind} id ${current}`, current)
    else if (current < previous)
      report("contract.unsorted", `${kind} ids must be sorted: ${current} follows ${previous}`, current)
  }
}

function checkAliasCycles(input: {
  token: Contract["tokens"][number]
  tokens: Contract["tokens"]
  themeIds: string[]
  report: Report
}): void {
  const { token, tokens, themeIds, report } = input
  const byId = new Map(tokens.map((t) => [t.id, t]))
  for (const layer of [undefined, ...themeIds]) {
    const seen = new Set<string>([token.id])
    let current: Contract["tokens"][number] | undefined = token
    while (current) {
      const modes: Record<string, Contract["tokens"][number]["value"]> = current.modes ?? {}
      const value = (layer && modes[layer]) || current.value
      if (!value.aliasOf) break
      if (seen.has(value.aliasOf)) {
        report(
          "contract.token-alias-cycle",
          `Token ${token.id} is part of an alias cycle${layer ? ` in ${layer}` : ""}`,
          token.id
        )
        return
      }
      seen.add(value.aliasOf)
      current = byId.get(value.aliasOf)
    }
  }
}

function checkEvidence(input: {
  contract: Contract
  evidenceFile: EvidenceFile
  evidenceIdsUsed: Set<string>
  sourceIds: Set<string>
  report: Report
}): void {
  const { contract, evidenceFile, evidenceIdsUsed, sourceIds, report } = input
  if (evidenceFile.contractContentHash !== contract.integrity.contentHash) {
    report("contract.evidence-hash-mismatch", "Evidence file belongs to a different contract content hash")
  }
  const known = new Set<string>()
  checkOrdering(
    "evidence",
    evidenceFile.evidence.map((e) => e.id),
    report
  )
  for (const evidence of evidenceFile.evidence) {
    known.add(evidence.id)
    if (computeEvidenceId(evidence) !== evidence.id)
      report("contract.evidence-id-mismatch", `Evidence ${evidence.id} id does not match its content`)
    if (!sourceIds.has(evidence.sourceId))
      report(
        "contract.unknown-source",
        `Evidence ${evidence.id} references unknown source ${evidence.sourceId}`
      )
  }
  for (const id of [...evidenceIdsUsed].sort()) {
    if (!known.has(id))
      report("contract.unknown-evidence", `Evidence ${id} is referenced but missing from the evidence file`)
  }
}

function collectionIds(contract: Contract): Array<[string, string[]]> {
  return [
    ["component", contract.components.map((e) => e.id)],
    ["token", contract.tokens.map((e) => e.id)],
    ["theme", contract.themes.map((e) => e.id)],
    ["pattern", contract.patterns.map((e) => e.id)],
    ["guideline", contract.guidelines.map((e) => e.id)],
    ["constraint", contract.constraints.map((e) => e.id)],
    ["policy", contract.policies.map((e) => e.id)],
    ["conflict", contract.conflicts.map((e) => e.id)]
  ]
}

function factBearingEntities(contract: Contract): Array<{ id: string; facts: Record<string, FactRecord> }> {
  return [
    ...contract.components,
    ...contract.tokens,
    ...contract.patterns,
    ...contract.guidelines,
    ...contract.constraints
  ]
}

function entityReferences(contract: Contract): Array<{ from: string; to: string }> {
  const refs: Array<{ from: string; to: string }> = []
  const add = (from: string, to: string | undefined): void => {
    if (to) refs.push({ from, to })
  }
  for (const c of contract.components) {
    add(c.id, c.deprecated?.replacedBy)
    for (const prop of c.props) add(c.id, prop.deprecated?.replacedBy)
    for (const event of c.events) add(c.id, event.deprecated?.replacedBy)
    for (const slot of c.slots) for (const target of slot.accepts ?? []) add(c.id, target)
    for (const rel of c.composition) add(c.id, rel.target)
  }
  for (const t of contract.tokens) {
    add(t.id, t.deprecated?.replacedBy)
    add(t.id, t.value.aliasOf)
    for (const mode of Object.values(t.modes ?? {})) add(t.id, mode.aliasOf)
  }
  for (const p of contract.patterns) for (const to of [...p.components, ...p.guidelines]) add(p.id, to)
  for (const g of contract.guidelines) for (const to of g.appliesTo) add(g.id, to)
  for (const c of contract.constraints) for (const to of c.subjects) add(c.id, to)
  for (const p of contract.policies)
    for (const to of [...(p.scope.entities ?? []), ...p.basedOn]) add(p.id, to)
  for (const c of contract.conflicts) add(c.id, c.subject)
  return refs
}

function sourceReferences(contract: Contract): Array<{ from: string; sourceId: string }> {
  const refs: Array<{ from: string; sourceId: string }> = []
  for (const c of contract.components) {
    for (const impl of c.implementations) refs.push({ from: c.id, sourceId: impl.sourceId })
    for (const example of c.examples)
      if (example.sourceId) refs.push({ from: c.id, sourceId: example.sourceId })
  }
  for (const g of contract.guidelines)
    for (const ref of g.references) refs.push({ from: g.id, sourceId: ref.sourceId })
  for (const c of contract.conflicts)
    for (const claim of c.claims) refs.push({ from: c.id, sourceId: claim.sourceId })
  return refs
}

function declaredVersion(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const version = (input as { contractVersion?: unknown }).contractVersion
  return typeof version === "string" ? version : undefined
}

function schemaDiagnostics(error: z.ZodError): Diagnostic[] {
  return sortDiagnostics(
    error.issues.map((issue) => ({
      code: "contract.invalid-schema",
      severity: "error" as const,
      message: `${formatPath(issue.path)}: ${issue.message}`
    }))
  )
}

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  return path.reduce<string>(
    (acc, part) => (typeof part === "number" ? `${acc}[${part}]` : `${acc}.${String(part)}`),
    "$"
  )
}
