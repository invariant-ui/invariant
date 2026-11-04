import {
  behaviorSchema,
  compositionPartSchema,
  frameworkSchema,
  layoutRegionSchema,
  PATTERN_CATEGORIES,
  PATTERN_CONSTRAINT_KINDS,
  PATTERN_RELATIONSHIP_TYPES,
  partNameSchema,
  patternAccessibilitySchema
} from "@invariant/contract"
import { z } from "zod"

export const PATTERNS_FILE = "invariant.patterns.json"
export const PATTERNS_FILE_VERSION = 1

/**
 * What a person writes. References to components, patterns, tokens and guidelines are names or ids here
 * (`DataTable`, `component:data-table`, `page.data-management`); compiling resolves them to ids or says why
 * it cannot. Everything else has the same shape as in the contract, so a definition reads like the entity it
 * becomes.
 */
const reference = z.string().min(1).max(200)

const part = compositionPartSchema.extend({ ref: reference })

const region = layoutRegionSchema
  .omit({ accepts: true, grid: true, spacing: true, responsive: true })
  .extend({
    accepts: z.array(reference).optional(),
    grid: z
      .strictObject({
        columns: layoutRegionSchema.shape.grid.unwrap().shape.columns,
        gap: reference.optional()
      })
      .optional(),
    spacing: reference.optional(),
    responsive: z
      .array(
        z.strictObject({
          breakpoint: reference,
          behavior: layoutRegionSchema.shape.responsive.unwrap().element.shape.behavior
        })
      )
      .optional()
  })

const constraintName = z
  .string()
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/)

const constraint = z.strictObject({
  /** Local to the pattern. The contract id is `constraint:<pattern>.<id>`. */
  id: constraintName,
  name: z.string().min(1).max(200).optional(),
  kind: z.enum(PATTERN_CONSTRAINT_KINDS),
  description: z.string().min(1).max(2000),
  /** Checked against the kind's schema after references are resolved. */
  details: z.record(z.string().max(100), z.unknown()),
  /** Makes the constraint enforceable. It becomes a policy, which needs the pattern's approval. */
  enforce: z
    .strictObject({
      severity: z.enum(["error", "warning", "info"]),
      enforcement: z.enum(["block", "warn", "report-only"]).default("block")
    })
    .optional()
})

/** A named way the composition may differ. Its added parts are written with the same references as any part. */
const variation = z
  .strictObject({
    name: partNameSchema,
    description: z.string().min(1).max(500).optional(),
    when: z.string().min(1).max(500).optional(),
    roles: z
      .array(z.strictObject({ part: partNameSchema, role: z.enum(["required", "optional", "prohibited"]) }))
      .optional(),
    parts: z.array(part).optional()
  })
  .refine((v) => (v.roles?.length ?? 0) + (v.parts?.length ?? 0) > 0, {
    message: "a variation changes at least one part's role or adds a part"
  })

const relationship = z.strictObject({
  id: partNameSchema,
  type: z.enum(PATTERN_RELATIONSHIP_TYPES),
  target: reference,
  description: z.string().min(1).max(500).optional()
})

export const patternDefinitionSchema = z.strictObject({
  id: z
    .string()
    .max(120)
    .regex(/^(?:pattern:)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/),
  name: z.string().min(1).max(200),
  category: z.enum(PATTERN_CATEGORIES),
  description: z.string().min(1).max(2000),
  intent: z.string().min(1).max(500).optional(),
  composition: z.strictObject({ parts: z.array(part).min(1) }).optional(),
  layout: z.strictObject({ regions: z.array(region).min(1) }).optional(),
  behavior: behaviorSchema.optional(),
  accessibility: patternAccessibilitySchema.optional(),
  variations: z.array(variation).optional(),
  relationships: z.array(relationship).optional(),
  constraints: z.array(constraint).optional(),
  guidelines: z.array(reference).optional(),
  /** Where the pattern applies. Carried into the policies it generates; enforcement scoping arrives with validation. */
  appliesTo: z
    .strictObject({
      paths: z.array(z.string().min(1).max(300)).min(1).max(50).optional(),
      frameworks: z.array(frameworkSchema).min(1).optional()
    })
    .optional(),
  /**
   * Where a definition came from when `invariant candidates promote` wrote it: the discovered candidate, how it was
   * found, and who accepted it. Provenance only. It is kept on the pattern as `extensions.discovery` and grants nothing.
   */
  origin: z
    .strictObject({
      candidate: z.string().min(1).max(100),
      method: z.string().min(1).max(100),
      support: z.number().int().positive(),
      files: z.number().int().positive(),
      acceptedBy: z.string().min(1).max(200).optional(),
      acceptedAt: z.iso.datetime().optional(),
      reference: z.string().min(1).max(500).optional()
    })
    .optional(),
  /**
   * Opt in: files matching `appliesTo.paths` are also held to the constraints of every pattern this one composes.
   * Needs `appliesTo.paths` and an approval; without them nothing is inherited.
   */
  inheritsConstraints: z.boolean().optional(),
  /**
   * Who approved this definition. With it, the pattern's facts are `approved`; without it they stay `documented`
   * until someone approves them with `invariant review`. A file in the repository is not an approval by itself.
   */
  approval: z
    .strictObject({
      approvedBy: z.string().min(1).max(200),
      approvedAt: z.iso.datetime(),
      role: z.string().min(1).max(200).optional(),
      reference: z.string().min(1).max(500).optional()
    })
    .optional()
})
export type PatternDefinition = z.infer<typeof patternDefinitionSchema>

export const patternsFileSchema = z.strictObject({
  /** Lets an editor validate the file against the exported JSON Schema. Ignored by the compiler. */
  $schema: z.string().max(500).optional(),
  version: z.literal(PATTERNS_FILE_VERSION),
  patterns: z.array(patternDefinitionSchema)
})
export type PatternsFile = z.infer<typeof patternsFileSchema>

export type ParsePatterns = { ok: true; value: PatternsFile } | { ok: false; message: string }

export function parsePatterns(text: string, name: string = PATTERNS_FILE): ParsePatterns {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ok: false, message: `${name} is not valid JSON: ${(error as Error).message}` }
  }
  const parsed = patternsFileSchema.safeParse(raw)
  if (!parsed.success) {
    const i = parsed.error.issues[0]
    return {
      ok: false,
      message: `${name} is invalid at ${i?.path.join(".") || "(root)"}: ${i?.message ?? "schema error"}`
    }
  }
  return { ok: true, value: parsed.data }
}

/** JSON Schema for editors and CI, generated from the same definition. Refinements are not representable. */
export function patternsFileJsonSchema(): Record<string, unknown> {
  return { title: "Invariant pattern definitions v1", ...z.toJSONSchema(patternsFileSchema) }
}
