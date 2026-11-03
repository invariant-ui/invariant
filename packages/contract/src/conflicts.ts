import { z } from "zod"
import { evidenceIdSchema } from "./evidence.js"
import { factStatusSchema } from "./facts.js"
import {
  conflictIdSchema,
  entityIdSchema,
  factPathSchema,
  isoTimestampSchema,
  jsonValueSchema,
  sourceIdSchema
} from "./primitives.js"

export const claimSchema = z.strictObject({
  sourceId: sourceIdSchema,
  /** Absent means the source asserts the field does not exist or has no value, which is distinct from null. */
  value: jsonValueSchema.optional(),
  status: factStatusSchema,
  evidenceIds: z.array(evidenceIdSchema).min(1)
})

export const conflictSchema = z.strictObject({
  id: conflictIdSchema,
  type: z.enum([
    "value-mismatch",
    "existence-mismatch",
    "deprecation-mismatch",
    "identity-ambiguity",
    "token-value-mismatch",
    "documentation-gap"
  ]),
  severity: z.enum(["error", "warning", "info"]),
  subject: entityIdSchema,
  path: factPathSchema.optional(),
  claims: z.array(claimSchema).min(2),
  suggestedResolution: z.string().min(1).optional(),
  resolution: z.discriminatedUnion("state", [
    z.strictObject({ state: z.literal("open") }),
    z.strictObject({
      state: z.enum(["resolved", "accepted", "dismissed"]),
      /** The chosen source, when the resolution selects one claim. Losing claims are never deleted. */
      chosenSourceId: sourceIdSchema.optional(),
      decidedBy: z.string().min(1),
      decidedAt: isoTimestampSchema,
      note: z.string().min(1).optional()
    })
  ])
})
export type Conflict = z.infer<typeof conflictSchema>
