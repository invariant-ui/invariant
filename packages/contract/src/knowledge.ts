import { z } from "zod"
import { approvalSchema, factsSchema } from "./facts.js"
import {
  componentIdSchema,
  constraintIdSchema,
  entityIdSchema,
  extensionsSchema,
  frameworkSchema,
  guidelineIdSchema,
  jsonObjectSchema,
  patternIdSchema,
  policyIdSchema,
  sourceIdSchema
} from "./primitives.js"

export const documentRefSchema = z.strictObject({
  sourceId: sourceIdSchema,
  documentId: z.string().min(1),
  title: z.string().optional(),
  url: z.url().optional()
})

export const patternSchema = z.strictObject({
  id: patternIdSchema,
  name: z.string().min(1),
  category: z.enum([
    "layout",
    "navigation",
    "form",
    "data-table",
    "card",
    "dialog",
    "workflow",
    "composition",
    "other"
  ]),
  description: z.string().min(1),
  components: z.array(componentIdSchema),
  guidelines: z.array(guidelineIdSchema),
  facts: factsSchema,
  extensions: extensionsSchema.optional()
})
export type Pattern = z.infer<typeof patternSchema>

export const guidelineSchema = z.strictObject({
  id: guidelineIdSchema,
  name: z.string().min(1),
  kind: z.enum(["usage", "accessibility", "composition", "visual-principle", "do-dont", "reference"]),
  statement: z.string().min(1),
  appliesTo: z.array(entityIdSchema),
  examples: z.array(z.strictObject({ kind: z.enum(["do", "dont"]), text: z.string().min(1) })),
  references: z.array(documentRefSchema),
  facts: factsSchema,
  extensions: extensionsSchema.optional()
})
export type Guideline = z.infer<typeof guidelineSchema>

export const constraintSchema = z.strictObject({
  id: constraintIdSchema,
  name: z.string().min(1),
  kind: z.enum([
    "valid-combination",
    "invalid-combination",
    "required-prop",
    "deprecated-api",
    "approved-alternative",
    "framework-restriction"
  ]),
  description: z.string().min(1),
  subjects: z.array(entityIdSchema).min(1),
  details: jsonObjectSchema.optional(),
  facts: factsSchema,
  extensions: extensionsSchema.optional()
})
export type Constraint = z.infer<typeof constraintSchema>

/**
 * Organization-approved rule. Policies are never produced by inference: approval metadata is
 * mandatory in the schema, so an unapproved rule cannot be represented as a policy.
 */
export const policySchema = z.strictObject({
  id: policyIdSchema,
  name: z.string().min(1),
  statement: z.string().min(1),
  severity: z.enum(["error", "warning", "info"]),
  enforcement: z.enum(["block", "warn", "report-only"]),
  scope: z.strictObject({
    entities: z.array(entityIdSchema).optional(),
    frameworks: z.array(frameworkSchema).optional(),
    paths: z.array(z.string().min(1)).optional()
  }),
  basedOn: z.array(z.union([guidelineIdSchema, constraintIdSchema])),
  approval: approvalSchema.omit({ fingerprint: true, priorStatus: true })
})
export type Policy = z.infer<typeof policySchema>
