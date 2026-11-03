import { hashJson } from "@invariant/shared"
import { z } from "zod"
import {
  confidenceSchema,
  isoTimestampSchema,
  relativePathSchema,
  sha256HexSchema,
  sourceIdSchema
} from "./primitives.js"

export const EVIDENCE_VERSION = "1.0.0"

export const evidenceIdSchema = z.string().regex(/^ev_[0-9a-f]{24}$/)

export const evidenceLocationSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("file"),
    path: relativePathSchema,
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    endColumn: z.number().int().positive().optional()
  }),
  z.strictObject({
    type: z.literal("document"),
    documentId: z.string().min(1),
    title: z.string().min(1).optional(),
    section: z.string().min(1).optional(),
    url: z.url().optional()
  }),
  z.strictObject({ type: z.literal("url"), url: z.url(), pointer: z.string().optional() }),
  z.strictObject({
    type: z.literal("design-node"),
    fileKey: z.string().min(1),
    nodeId: z.string().min(1).optional(),
    variableKey: z.string().min(1).optional()
  })
])
export type EvidenceLocation = z.infer<typeof evidenceLocationSchema>

/** How a fact was obtained. `llm-assisted` evidence is never allowed in adapter IR. */
export const EXTRACTION_METHODS = [
  "ast",
  "compiler-api",
  "metadata-parse",
  "structured-parse",
  "document-parse",
  "llm-assisted",
  "manual"
] as const
export const extractionMethodSchema = z.enum(EXTRACTION_METHODS)
export type ExtractionMethod = z.infer<typeof extractionMethodSchema>

export const verificationStatusSchema = z.enum(["unverified", "verified", "contradicted"])

export const evidenceSchema = z.strictObject({
  id: evidenceIdSchema,
  sourceId: sourceIdSchema,
  /** Source-native reference, for example `src/Button.tsx#Button` or a zeroheight page slug. */
  sourceRef: z.string().min(1),
  location: evidenceLocationSchema,
  method: extractionMethodSchema,
  extractor: z.strictObject({ name: z.string().min(1), version: z.string().min(1) }),
  /** Bounded excerpt of the original source text. */
  original: z.string().max(2000).optional(),
  confidence: confidenceSchema.optional(),
  verificationStatus: verificationStatusSchema,
  capturedAt: isoTimestampSchema
})
export type Evidence = z.infer<typeof evidenceSchema>

export const evidenceFileSchema = z.strictObject({
  evidenceVersion: z.literal(EVIDENCE_VERSION),
  /** Content hash of the contract these evidence entries belong to. */
  contractContentHash: sha256HexSchema,
  evidence: z.array(evidenceSchema)
})
export type EvidenceFile = z.infer<typeof evidenceFileSchema>

/**
 * Evidence ids are content-addressed over the immutable parts of an observation. Confidence,
 * verification status and capture time are mutable and deliberately excluded.
 */
export function computeEvidenceId(
  evidence: Omit<Evidence, "id" | "confidence" | "verificationStatus" | "capturedAt">
): string {
  const digest = hashJson({
    sourceId: evidence.sourceId,
    sourceRef: evidence.sourceRef,
    location: evidence.location,
    method: evidence.method,
    extractor: evidence.extractor,
    original: evidence.original ?? null
  })
  return `ev_${digest.slice(0, 24)}`
}

export function createEvidenceFile(contractContentHash: string, evidence: readonly Evidence[]): EvidenceFile {
  return {
    evidenceVersion: EVIDENCE_VERSION,
    contractContentHash,
    evidence: [...evidence].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }
}
