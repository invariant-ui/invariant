import { hashJson, type JsonValue } from "@invariant/shared"
import { z } from "zod"
import { evidenceIdSchema } from "./evidence.js"
import { confidenceSchema, isoTimestampSchema, sha256HexSchema } from "./primitives.js"

/**
 * Epistemic status of a fact. Never collapsed into a confidence number:
 * - discovered: parsed from an implementation artifact.
 * - documented: stated by a person in documentation or a design tool.
 * - inferred: derived by a named rule or model from other evidence.
 * - approved: accepted by an authorized owner. Layers over `approval.priorStatus`, which is retained.
 */
export const factStatusSchema = z.enum(["discovered", "documented", "inferred", "approved"])
export type FactStatus = z.infer<typeof factStatusSchema>

export const priorStatusSchema = z.enum(["discovered", "documented", "inferred"])

export const approvalSchema = z.strictObject({
  approvedBy: z.string().min(1),
  approvedAt: isoTimestampSchema,
  role: z.string().min(1).optional(),
  reference: z.string().min(1).optional(),
  /** Hash of (entity id, path, value) at approval time. A mismatch means the approval is stale. */
  fingerprint: sha256HexSchema,
  priorStatus: priorStatusSchema
})
export type Approval = z.infer<typeof approvalSchema>

export const derivationSchema = z.strictObject({
  rule: z.string().min(1),
  reasoning: z.string().min(1),
  inputs: z.array(z.string().min(1)),
  model: z.strictObject({ id: z.string().min(1), promptHash: sha256HexSchema }).optional()
})

export const factRecordSchema = z
  .strictObject({
    status: factStatusSchema,
    evidenceIds: z.array(evidenceIdSchema),
    confidence: confidenceSchema.optional(),
    derivation: derivationSchema.optional(),
    approval: approvalSchema.optional()
  })
  .superRefine((fact, ctx) => {
    const issue = (message: string, path: string[]): void => ctx.addIssue({ code: "custom", message, path })
    if (fact.evidenceIds.length === 0) issue("every fact needs at least one evidence id", ["evidenceIds"])
    if (fact.status === "approved") {
      if (!fact.approval) issue("approved facts require approval metadata", ["approval"])
    } else if (fact.approval) {
      issue("approval metadata is only valid when status is 'approved'", ["approval"])
    }
    if (fact.status === "inferred") {
      if (!fact.derivation) issue("inferred facts require a derivation", ["derivation"])
      if (fact.confidence === undefined) issue("inferred facts require a confidence", ["confidence"])
    } else if (fact.derivation && fact.status !== "approved") {
      issue("derivation is only valid on inferred or approved facts", ["derivation"])
    }
  })
export type FactRecord = z.infer<typeof factRecordSchema>

export const factsSchema = z.record(z.string(), factRecordSchema)

export function computeFactFingerprint(input: { entityId: string; path: string; value: JsonValue }): string {
  return hashJson(input)
}
