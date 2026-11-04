import { z } from "zod"
import { approvalSchema, factsSchema } from "./facts.js"
import {
  behaviorSchema,
  compositionSchema,
  layoutSchema,
  PATTERN_CATEGORIES,
  PATTERN_CONSTRAINT_KINDS,
  patternAccessibilitySchema,
  patternRelationshipSchema,
  patternVariationSchema
} from "./patterns.js"
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
  category: z.enum(PATTERN_CATEGORIES),
  description: z.string().min(1),
  /** What the pattern is for, in one sentence (1.1.0). */
  intent: z.string().min(1).optional(),
  components: z.array(componentIdSchema),
  guidelines: z.array(guidelineIdSchema),
  /** The named parts a pattern is made of (1.1.0). */
  composition: compositionSchema.optional(),
  /** Named, approved ways the composition may differ (1.1.0). */
  variations: z.array(patternVariationSchema).optional(),
  /** Regions and their structure (1.1.0). */
  layout: layoutSchema.optional(),
  /** States and transitions (1.1.0). */
  behavior: behaviorSchema.optional(),
  accessibility: patternAccessibilitySchema.optional(),
  /** Typed edges to other patterns and components (1.1.0). */
  relationships: z.array(patternRelationshipSchema).optional(),
  /** Constraints this pattern owns. Policies make them enforceable (1.1.0). */
  constraints: z.array(constraintIdSchema).optional(),
  /** Where the pattern applies: the files and frameworks that are instances of it (1.1.0). */
  appliesTo: z
    .strictObject({
      paths: z.array(z.string().min(1)).min(1).optional(),
      frameworks: z.array(frameworkSchema).min(1).optional()
    })
    .optional(),
  /**
   * Opt in: files in `appliesTo.paths` are also held to the constraints of every pattern this one composes (1.1.0).
   * It has effect only while both this flag and `appliesTo` are approved.
   */
  inheritsConstraints: z.boolean().optional(),
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
    "framework-restriction",
    ...PATTERN_CONSTRAINT_KINDS
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
