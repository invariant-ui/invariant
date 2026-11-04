import { z } from "zod"

export const CANDIDATES_FILE = "invariant.candidates.json"
export const CANDIDATES_FILE_VERSION = 1
export const REVIEWS_FILE = "invariant.candidate-reviews.json"
export const REVIEWS_FILE_VERSION = 1

export const CANDIDATE_KINDS = ["arrangement", "similar-files"] as const
export type CandidateKind = (typeof CANDIDATE_KINDS)[number]

/** `proposed` until a person decides; the other states come only from a recorded review. */
export const CANDIDATE_STATUSES = ["proposed", "accepted", "rejected", "deferred"] as const
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number]

export const DECISIONS = ["accepted", "rejected", "deferred"] as const
export type Decision = (typeof DECISIONS)[number]

const occurrence = z.strictObject({
  file: z.string().min(1),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  detail: z.string().min(1)
})
export type Occurrence = z.infer<typeof occurrence>

const part = z.strictObject({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]*$/)
    .max(64),
  ref: z.string().min(1),
  role: z.enum(["required", "optional"])
})

/** The start of a pattern definition. It has no id, no intent and no approval: those are for a person to give. */
const definitionDraft = z.strictObject({
  name: z.string().min(1).max(200),
  /** Always `composition`: what the shape is for is the reviewer's call, made when promoting. */
  category: z.literal("composition"),
  description: z.string().min(1).max(2000),
  composition: z.strictObject({ parts: z.array(part).min(1) })
})
export type DefinitionDraft = z.infer<typeof definitionDraft>

const featureCount = z.strictObject({ feature: z.string().min(1), files: z.number().int().positive() })

export const reviewSchema = z.strictObject({
  candidate: z.string().min(1),
  decision: z.enum(DECISIONS),
  /** Asserted, not authenticated, like every approver in the project. */
  decidedBy: z.string().min(1).max(200),
  decidedAt: z.iso.datetime(),
  reason: z.string().min(1).max(1000).optional(),
  reference: z.string().min(1).max(500).optional(),
  /** Set when the accepted candidate was written into the definitions file, with the id it was given. */
  promotedTo: z.string().min(1).max(200).optional()
})
export type Review = z.infer<typeof reviewSchema>

export const candidateSchema = z.strictObject({
  id: z.string().regex(/^candidate:(arrangement|similar-files)\.[0-9a-f]{8}(-\d+)?$/),
  kind: z.enum(CANDIDATE_KINDS),
  status: z.enum(CANDIDATE_STATUSES),
  /** Always `inferred`: discovery observes recurrence, it does not learn what anyone intended. */
  basis: z.literal("inferred"),
  /** Always `not-established`: structural similarity is measured, never taken to mean the same purpose. */
  equivalence: z.literal("not-established"),
  suggestedName: z.string().min(1),
  nameSource: z.literal("derived"),
  summary: z.string().min(1),
  /** Why this was found and what it does and does not say. */
  explanation: z.array(z.string().min(1)).min(1),
  support: z.strictObject({
    files: z.number().int().positive(),
    occurrences: z.number().int().positive()
  }),
  /** For `similar-files`: how alike the members are, measured, not estimated. */
  consistency: z
    .strictObject({
      minimumPairwise: z.number().min(0).max(1),
      meanPairwise: z.number().min(0).max(1)
    })
    .optional(),
  structure: z.strictObject({
    /** `arrangement`: the canonical form of the shape. `similar-files`: the features every member has. */
    key: z.string().min(1),
    common: z.array(z.string()),
    frequent: z.array(featureCount),
    variable: z.array(featureCount),
    variableTruncated: z.boolean()
  }),
  evidence: z.array(occurrence).min(1),
  evidenceTruncated: z.boolean(),
  definition: definitionDraft,
  derivation: z.strictObject({
    method: z.enum(["exact-structure", "complete-linkage-overlap"]),
    version: z.literal(1),
    parameters: z.record(z.string(), z.union([z.number(), z.string()]))
  }),
  /** Another candidate whose occurrences contain every occurrence of this one. Kept, not dropped. */
  subsumedBy: z.string().optional(),
  /** The latest recorded decision, when there is one. */
  review: reviewSchema.optional()
})
export type Candidate = z.infer<typeof candidateSchema>

export const discoveryDiagnosticSchema = z.strictObject({
  code: z.string().min(1),
  severity: z.enum(["info", "warning"]),
  message: z.string().min(1),
  file: z.string().optional()
})
export type DiscoveryDiagnostic = z.infer<typeof discoveryDiagnosticSchema>

export const candidatesFileSchema = z.strictObject({
  version: z.literal(CANDIDATES_FILE_VERSION),
  /** The contract the components were resolved against. */
  contract: z.strictObject({ contentHash: z.string().min(1) }),
  parameters: z.strictObject({
    minFiles: z.number().int().positive(),
    minUses: z.number().int().positive(),
    similarity: z.number().min(0).max(1),
    maxDepth: z.number().int().positive()
  }),
  summary: z.strictObject({
    files: z.number().int().nonnegative(),
    filesAnalyzed: z.number().int().nonnegative(),
    candidates: z.number().int().nonnegative()
  }),
  candidates: z.array(candidateSchema),
  diagnostics: z.array(discoveryDiagnosticSchema)
})
export type CandidatesFile = z.infer<typeof candidatesFileSchema>

export const reviewsFileSchema = z.strictObject({
  $schema: z.string().optional(),
  version: z.literal(REVIEWS_FILE_VERSION),
  reviews: z.array(reviewSchema)
})
export type ReviewsFile = z.infer<typeof reviewsFileSchema>
