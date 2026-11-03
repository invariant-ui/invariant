import type { FactRecord } from "@invariant/contract"

export interface Inference {
  rule: string
  confidence: number
  reasoning: string
  /** Fact paths or entity refs the conclusion rests on. */
  inputs: string[]
  evidenceIds: string[]
}

/**
 * The only way the engine writes a fact. An inference without evidence, reasoning or a usable confidence
 * is a bug in a rule, not something to store: it throws, so a rule can never emit an unattributable claim.
 */
export function inferredFact(i: Inference): FactRecord {
  if (i.evidenceIds.length === 0) throw new Error(`rule ${i.rule} produced an inference without evidence`)
  if (i.reasoning.trim() === "") throw new Error(`rule ${i.rule} produced an inference without reasoning`)
  if (!(i.confidence > 0 && i.confidence < 1))
    throw new Error(`rule ${i.rule} produced confidence ${i.confidence}; inferences are never certain`)
  return {
    status: "inferred",
    evidenceIds: [...new Set(i.evidenceIds)].sort(),
    confidence: i.confidence,
    derivation: { rule: i.rule, reasoning: i.reasoning, inputs: [...new Set(i.inputs)].sort() }
  }
}

export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function slugSegment(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-{2,}/g, "-")
    .replace(/[-.]+$/, "")
  return s === "" ? "x" : s
}
