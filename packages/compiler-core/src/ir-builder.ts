import {
  canonicalizeIrDocument,
  IR_VERSION,
  type IrDocument,
  type IrEntity,
  type IrFact
} from "@invariant/compiler-ir"
import {
  computeEvidenceId,
  type Evidence,
  type EvidenceLocation,
  type ExtractionMethod
} from "@invariant/contract"
import type { Diagnostic, JsonValue } from "@invariant/shared"

const MAX_ORIGINAL = 2000

/**
 * Assembles an IR document. Evidence is content-addressed and deduplicated, every fact must cite
 * evidence, and the result is canonical (sorted), so adapters cannot emit order-dependent output.
 */
export class IrBuilder {
  private readonly options: {
    source: IrDocument["source"]
    extractor: { name: string; version: string }
    capabilities: string[]
    clock: () => string
  }
  private readonly entities = new Map<string, IrEntity>()
  private readonly facts: IrFact[] = []
  private readonly evidenceById = new Map<string, Evidence>()
  private readonly diagnostics: Diagnostic[] = []

  constructor(options: IrBuilder["options"]) {
    this.options = options
  }

  entity(ref: string, kind: IrEntity["kind"], name: string): string {
    this.entities.set(ref, { ref, kind, name })
    return ref
  }

  evidence(input: {
    sourceRef: string
    location: EvidenceLocation
    method: ExtractionMethod
    original?: string
  }): Evidence {
    const original = input.original === undefined ? undefined : input.original.slice(0, MAX_ORIGINAL)
    const base = {
      sourceId: this.options.source.id,
      sourceRef: input.sourceRef,
      location: input.location,
      method: input.method,
      extractor: this.options.extractor,
      ...(original === undefined ? {} : { original })
    }
    const evidence: Evidence = {
      ...base,
      id: computeEvidenceId(base),
      verificationStatus: "unverified",
      capturedAt: this.options.clock()
    }
    if (!this.evidenceById.has(evidence.id)) this.evidenceById.set(evidence.id, evidence)
    return evidence
  }

  fact(
    subject: string,
    path: string,
    value: JsonValue,
    evidence: Evidence | readonly Evidence[],
    options: { origin?: IrFact["origin"]; completeness?: NonNullable<IrFact["completeness"]> } = {}
  ): void {
    const list = Array.isArray(evidence) ? evidence : [evidence as Evidence]
    this.facts.push({
      subject,
      path,
      value,
      origin: options.origin ?? "extracted",
      evidenceIds: [...new Set(list.map((e) => e.id))].sort(),
      ...(options.completeness ? { completeness: options.completeness } : {})
    })
  }

  diagnostic(diagnostic: Diagnostic): void {
    this.diagnostics.push({ ...diagnostic, sourceId: this.options.source.id })
  }

  build(completeness: IrDocument["completeness"]): IrDocument {
    return canonicalizeIrDocument({
      irVersion: IR_VERSION,
      source: this.options.source,
      capabilities: this.options.capabilities,
      completeness,
      entities: [...this.entities.values()],
      facts: this.facts,
      evidence: [...this.evidenceById.values()],
      diagnostics: this.diagnostics
    })
  }
}
