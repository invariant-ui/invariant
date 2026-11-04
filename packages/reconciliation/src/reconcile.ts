import type { IrDocument } from "@invariant/compiler-ir"
import {
  CONTRACT_VERSION,
  type Component,
  type Contract,
  type ContractDraft,
  createEvidenceFile,
  type Evidence,
  type EvidenceFile,
  type FactRecord,
  finalizeContract,
  type Source,
  verifyContract
} from "@invariant/contract"
import { type Diagnostic, DiagnosticCollector } from "@invariant/shared"
import { buildComponent, type ConflictDraft } from "./components.js"
import { ambiguityConflicts, mintConflicts, storybookConflicts } from "./conflicts.js"
import { type IdentityLink, type Implementation, resolveComponents } from "./resolve.js"
import { reconcileStorybook } from "./storybook.js"
import { buildTokens } from "./tokens.js"
import { cmp, slug, unique } from "./util.js"

export interface ReconcileOptions {
  name: string
  /** Stable id of the design system; defaults to a slug of `name`. */
  contractId?: string
  description?: string
  compilerVersion: string
  clock?: () => string
}

export interface ReconcileResult {
  contract: ContractDraft
  /** Every evidence entry the contract cites, once each. */
  evidence: Evidence[]
  diagnostics: Diagnostic[]
}

function inferredFact(link: IdentityLink): FactRecord {
  return {
    status: "inferred",
    evidenceIds: link.evidenceIds,
    confidence: link.confidence,
    derivation: { rule: link.rule, reasoning: link.reasoning, inputs: link.inputs }
  }
}

function sourceOf(doc: IrDocument): Source {
  return {
    id: doc.source.id,
    type: doc.source.type,
    location: doc.source.location,
    ...(doc.source.version ? { version: doc.source.version } : {}),
    capabilities: [...doc.capabilities].sort(),
    health: {
      status: doc.completeness === "complete" ? "ok" : doc.completeness === "partial" ? "degraded" : "failed",
      diagnosticCount: doc.diagnostics.length
    }
  }
}

/**
 * Turns IR documents into one contract draft. Deterministic: same documents and options, same bytes. Every
 * value and fact comes from an IR claim; the only things reconciliation adds are identity links between
 * differently named entities, and those are `inferred` with a rule and confidence.
 */
export function reconcile(docs: readonly IrDocument[], options: ReconcileOptions): ReconcileResult {
  const diagnostics = new DiagnosticCollector()
  const conflicts: ConflictDraft[] = []

  const resolution = resolveComponents(docs)
  const refToId = new Map<string, string>()
  const byRef = new Map<string, Implementation>()
  for (const rc of resolution.components)
    for (const impl of rc.implementations) {
      refToId.set(impl.code.ref, rc.id)
      byRef.set(impl.code.ref, impl)
    }

  const components: Component[] = resolution.components.map((rc) => {
    const component = buildComponent(rc, { refToId, diagnostics, conflicts })
    const facts = { ...component.facts }
    for (const impl of rc.implementations) {
      facts[`implementations.${impl.id}`] = rc.identity
        ? inferredFact(rc.identity)
        : {
            status: "discovered",
            evidenceIds:
              impl.facts.find((f) => f.path === "name")?.evidenceIds ?? impl.facts[0]?.evidenceIds ?? []
          }
    }
    return { ...component, facts: Object.fromEntries(Object.entries(facts).sort((a, b) => cmp(a[0], b[0]))) }
  })

  const tokenResult = buildTokens(docs, { diagnostics, conflicts })
  const tokens = tokenResult.tokens.map((t) => {
    const link = tokenResult.identities.find((i) => i.tokenId === t.id)?.link
    return link ? { ...t, facts: { ...t.facts, name: inferredFact(link) } } : t
  })

  const storybook = reconcileStorybook(docs)
  diagnostics.addAll(storybook.diagnostics)
  conflicts.push(...storybookConflicts(storybook.discrepancies, refToId, byRef))
  conflicts.push(...ambiguityConflicts(resolution.ambiguities, refToId))
  for (const doc of docs)
    for (const e of doc.entities)
      if (e.kind === "component" && !refToId.has(e.ref))
        diagnostics.info(
          "reconcile.component-skipped",
          `${e.name} publishes no framework link key and was not placed in the contract`,
          {
            sourceId: doc.source.id,
            entityId: e.ref
          }
        )

  const minted = mintConflicts(conflicts)
  const sources = new Map<string, Source>()
  for (const doc of [...docs].sort((a, b) => cmp(a.source.id, b.source.id)))
    if (!sources.has(doc.source.id)) sources.set(doc.source.id, sourceOf(doc))

  const cited = new Set<string>()
  for (const c of components)
    for (const f of Object.values(c.facts)) for (const id of f.evidenceIds) cited.add(id)
  for (const t of tokens)
    for (const f of Object.values(t.facts)) for (const id of f.evidenceIds) cited.add(id)
  for (const c of minted) for (const claim of c.claims) for (const id of claim.evidenceIds) cited.add(id)
  const pool = new Map<string, Evidence>()
  for (const doc of docs) for (const e of doc.evidence) if (!pool.has(e.id)) pool.set(e.id, e)
  const evidence: Evidence[] = []
  for (const id of [...cited].sort()) {
    const found = pool.get(id)
    if (found) evidence.push(found)
    else
      diagnostics.error(
        "reconcile.missing-evidence",
        `A fact cites evidence ${id}, which no IR document contains`
      )
  }

  const contract: ContractDraft = {
    contractVersion: CONTRACT_VERSION,
    metadata: {
      contractId: options.contractId ?? slug(options.name),
      name: options.name,
      ...(options.description ? { description: options.description } : {}),
      compilerVersion: options.compilerVersion,
      frameworks: unique(components.flatMap((c) => c.implementations.map((i) => i.framework))).sort(),
      compiledAt: (options.clock ?? (() => new Date().toISOString()))()
    },
    sources: [...sources.values()],
    themes: tokenResult.themes,
    components,
    tokens,
    patterns: [],
    guidelines: [],
    constraints: [],
    policies: [],
    conflicts: minted
  }
  return { contract, evidence, diagnostics: diagnostics.toArray() }
}

export interface FinalizedContract {
  contract: Contract
  evidenceFile: EvidenceFile
  /** Structural and cross-reference findings from `verifyContract`. Empty means the contract is valid. */
  diagnostics: Diagnostic[]
}

/** Hashes the draft and verifies it, with its evidence, against the contract's own rules. */
export function finalizeAndVerify(draft: ContractDraft, evidence: readonly Evidence[]): FinalizedContract {
  const contract = finalizeContract(draft)
  const evidenceFile = createEvidenceFile(contract.integrity.contentHash, evidence)
  return { contract, evidenceFile, diagnostics: verifyContract(contract, evidenceFile) }
}
