import type { Candidate } from "./model.js"

export interface PromoteInput {
  /** The pattern id to give it, as written in a definitions file (`composition.card-with-header`). */
  id: string
  name?: string | undefined
  category?: string | undefined
}

/**
 * A pattern definition for an accepted candidate, ready to add to the definitions file. It carries no approval,
 * no intent and no constraints: it records what was observed, who accepted it, and where it came from. Compiling
 * it gives `documented` facts; approving them, and writing rules to enforce, are separate steps for a person.
 */
export function toDefinition(candidate: Candidate, input: PromoteInput): Record<string, unknown> {
  const review = candidate.review
  return {
    id: input.id,
    name: input.name ?? candidate.definition.name,
    category: input.category ?? candidate.definition.category,
    description: candidate.definition.description,
    composition: candidate.definition.composition,
    origin: {
      candidate: candidate.id,
      method: candidate.derivation.method,
      support: candidate.support.occurrences,
      files: candidate.support.files,
      ...(review ? { acceptedBy: review.decidedBy, acceptedAt: review.decidedAt } : {}),
      ...(review?.reference ? { reference: review.reference } : {})
    }
  }
}
