import { canonicalStringify, hashJson } from "@invariant/shared"
import type { Contract, ContractDraft } from "./contract.js"
import type { EvidenceFile } from "./evidence.js"

/**
 * The content hash covers everything except the integrity block and volatile timestamps
 * (`metadata.compiledAt`, `sources[].lastSyncedAt`), so recompiling unchanged inputs yields the same hash.
 */
export function computeContentHash(contract: ContractDraft): string {
  const { integrity: _integrity, ...body } = contract as ContractDraft & { integrity?: unknown }
  const { compiledAt: _compiledAt, ...metadata } = body.metadata
  const sources = body.sources.map(({ lastSyncedAt: _lastSyncedAt, ...source }) => source)
  return hashJson({ ...body, metadata, sources })
}

export function finalizeContract(draft: ContractDraft): Contract {
  return { ...draft, integrity: { algorithm: "sha256", contentHash: computeContentHash(draft) } }
}

export function serializeContract(contract: Contract): string {
  return `${canonicalStringify(contract, 2)}\n`
}

export function serializeEvidenceFile(file: EvidenceFile): string {
  return `${canonicalStringify(file, 2)}\n`
}
