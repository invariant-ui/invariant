import type { IrDocument } from "@invariant/compiler-ir"
import type { ContractDraft, Evidence } from "@invariant/contract"
import { type Diagnostic, DiagnosticCollector } from "@invariant/shared"
import { assertAdditive } from "./additive.js"
import { inferCompounds } from "./compounds.js"
import { classifyDocuments } from "./documents.js"
import { cmp } from "./infer.js"
import { classifyTokens } from "./tokens.js"

export interface EnrichInput {
  contract: ContractDraft
  evidence: readonly Evidence[]
  /** The IR documents the contract was built from; pages and their evidence come from here. */
  docs: readonly IrDocument[]
}

export interface EnrichResult {
  contract: ContractDraft
  evidence: Evidence[]
  diagnostics: Diagnostic[]
}

/**
 * Adds inferred semantics to a reconciled contract: token categories, guidelines from documentation pages,
 * and compound-component containment. Every output is an `inferred` fact with a rule, reasoning, confidence
 * and existing evidence. The result is checked to be purely additive; if it is not, the input contract is
 * returned unchanged with an error. Nothing here promotes a fact to `approved` or creates a policy.
 */
export function enrich(input: EnrichInput): EnrichResult {
  const diagnostics = new DiagnosticCollector()
  const documents = classifyDocuments(input.docs, input.contract.components)
  for (const s of documents.skipped)
    diagnostics.info("semantic.page-skipped", `${s.ref} was not classified: ${s.reason}`, {
      sourceId: s.sourceId,
      entityId: s.ref
    })

  const candidate: ContractDraft = {
    ...input.contract,
    components: inferCompounds(input.contract.components),
    tokens: classifyTokens(input.contract.tokens),
    guidelines: [...input.contract.guidelines, ...documents.guidelines].sort((a, b) => cmp(a.id, b.id))
  }

  const violations = assertAdditive(input.contract, candidate)
  if (violations.length > 0) {
    for (const v of violations)
      diagnostics.error("semantic.not-additive", `Enrichment would alter existing data: ${v}`)
    return { contract: input.contract, evidence: [...input.evidence], diagnostics: diagnostics.toArray() }
  }

  const evidence = new Map(input.evidence.map((e) => [e.id, e]))
  for (const e of documents.evidence) evidence.set(e.id, e)
  return {
    contract: candidate,
    evidence: [...evidence.values()].sort((a, b) => cmp(a.id, b.id)),
    diagnostics: diagnostics.toArray()
  }
}
