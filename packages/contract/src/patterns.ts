import { z } from "zod"
import { componentIdSchema, patternIdSchema, tokenIdSchema } from "./primitives.js"

/*
 * Pattern contracts (contract 1.1.0). Every field here is optional on a pattern, so a 1.0.0 document is also a
 * valid 1.1.0 document. Nothing in this file refers to a frontend framework or to how a rule is evaluated.
 */

/**
 * Names of regions, parts, states, transitions and relationships inside one pattern. They are fact-path
 * segments (`layout.regions.header.required`), so unlike entity names they cannot contain dots.
 */
export const partNameSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/)

/** How a requirement can be verified at best. A validator may never claim more than the method it used. */
export const verifiableBySchema = z.enum(["static", "runtime", "manual"])

/** What a part or a relationship can point at. */
export const patternTargetSchema = z.union([componentIdSchema, patternIdSchema])
/** A named region of the pattern that owns the constraint, written `region:<name>`. */
export const regionRefSchema = z.string().regex(/^region:[a-z0-9][a-z0-9_-]*$/)
/** What a structural constraint can talk about: a component, a pattern, or a region of the owning pattern. */
export const elementRefSchema = z.union([componentIdSchema, patternIdSchema, regionRefSchema])

const lengthSchema = z.strictObject({
  value: z.number().positive().finite(),
  unit: z.enum(["px", "rem", "em", "%", "ch", "vw"])
})

export const layoutRegionSchema = z.strictObject({
  name: partNameSchema,
  description: z.string().min(1).optional(),
  required: z.boolean(),
  /** The enclosing region, which gives the layout its hierarchy. */
  parent: partNameSchema.optional(),
  /** Components and patterns that may fill the region. Absent means no restriction is stated. */
  accepts: z.array(patternTargetSchema).optional(),
  width: z.strictObject({ min: lengthSchema.optional(), max: lengthSchema.optional() }).optional(),
  align: z.enum(["start", "center", "end", "stretch"]).optional(),
  grid: z
    .strictObject({ columns: z.number().int().min(1).max(24), gap: tokenIdSchema.optional() })
    .optional(),
  spacing: tokenIdSchema.optional(),
  responsive: z
    .array(
      z.strictObject({
        breakpoint: tokenIdSchema,
        behavior: z.enum(["unchanged", "stack", "collapse", "hide", "reflow"])
      })
    )
    .optional()
})

export const layoutSchema = z.strictObject({ regions: z.array(layoutRegionSchema).min(1) })

export const compositionPartSchema = z.strictObject({
  name: partNameSchema,
  ref: patternTargetSchema,
  role: z.enum(["required", "optional", "prohibited"]),
  /** The layout region the part belongs in. */
  region: partNameSchema.optional(),
  description: z.string().min(1).optional()
})

export const compositionSchema = z.strictObject({ parts: z.array(compositionPartSchema).min(1) })

/**
 * A named, approved way a pattern may differ: some parts change role (a required part becomes optional or
 * prohibited) and some parts exist only here. Everything else is the pattern's base composition. A variation
 * is how an archetype says "this is allowed" without becoming a second pattern.
 */
export const patternVariationSchema = z
  .strictObject({
    /** Names the variation; evidence for it is addressed as `variations.<name>`. */
    name: partNameSchema,
    description: z.string().min(1).optional(),
    /** When this variation is the right one, in words. */
    when: z.string().min(1).optional(),
    /** Parts of the base composition whose role differs in this variation. */
    roles: z
      .array(z.strictObject({ part: partNameSchema, role: z.enum(["required", "optional", "prohibited"]) }))
      .optional(),
    /** Parts that exist only in this variation. */
    parts: z.array(compositionPartSchema).optional()
  })
  .refine((v) => (v.roles?.length ?? 0) + (v.parts?.length ?? 0) > 0, {
    message: "a variation changes at least one part's role or adds a part"
  })

export const behaviorStateSchema = z.strictObject({
  name: partNameSchema,
  description: z.string().min(1).optional(),
  /** Feedback a user must be given while in this state. */
  feedback: z.string().min(1).optional(),
  terminal: z.boolean().optional(),
  verifiableBy: verifiableBySchema.optional()
})

export const behaviorTransitionSchema = z.strictObject({
  id: partNameSchema,
  from: partNameSchema,
  to: partNameSchema,
  trigger: z.string().min(1).optional(),
  verifiableBy: verifiableBySchema.optional()
})

/** An explicit state machine, enough to describe common interface interactions. It is data, not a workflow engine. */
export const behaviorSchema = z.strictObject({
  initial: partNameSchema,
  states: z.array(behaviorStateSchema).min(1),
  transitions: z.array(behaviorTransitionSchema)
})

export const patternAccessibilitySchema = z.strictObject({
  requirements: z
    .array(
      z.strictObject({
        id: partNameSchema,
        statement: z.string().min(1),
        verifiableBy: verifiableBySchema.optional()
      })
    )
    .min(1)
})

export const PATTERN_RELATIONSHIP_TYPES = [
  "contains",
  "requires",
  "uses",
  "extends",
  "composes",
  "alternative-to",
  "prohibited-with",
  "supersedes"
] as const
export type PatternRelationshipType = (typeof PATTERN_RELATIONSHIP_TYPES)[number]

/** Relationship types whose target must be another pattern. `contains` and `uses` may also name a component. */
export const PATTERN_ONLY_RELATIONSHIPS: readonly PatternRelationshipType[] = [
  "requires",
  "extends",
  "composes",
  "alternative-to",
  "prohibited-with",
  "supersedes"
]

/** Relationship types that must not form a cycle. `uses`, `alternative-to` and `prohibited-with` may. */
export const ACYCLIC_RELATIONSHIPS: readonly PatternRelationshipType[] = [
  "contains",
  "requires",
  "extends",
  "composes",
  "supersedes"
]

export const patternRelationshipSchema = z.strictObject({
  /** Stable within the pattern; evidence for the edge is addressed as `relationships.<id>`. */
  id: partNameSchema,
  type: z.enum(PATTERN_RELATIONSHIP_TYPES),
  target: patternTargetSchema,
  description: z.string().min(1).optional()
})

/** Constraint kinds added for patterns. They carry a typed `details` object, validated by `verifyContract`. */
export const PATTERN_CONSTRAINT_KINDS = [
  "required-child",
  "forbidden-child",
  "requires-parent",
  "required-region",
  "ordering",
  "cardinality",
  "required-state"
] as const
export type PatternConstraintKind = (typeof PATTERN_CONSTRAINT_KINDS)[number]

const count = z.number().int().min(0)

/**
 * The interactions Invariant knows how to look for in code, and the states each can be required to represent.
 * A state here means "the code represents this", not "this works at runtime"; see `evidenceLevelSchema`.
 */
export const INTERACTION_STATES = {
  "form-submission": ["submitting", "error", "success", "guarded"],
  "destructive-confirmation": ["confirming", "cancellable"],
  "search-results": ["connected", "loading", "empty", "error", "clearable"]
} as const satisfies Record<string, readonly string[]>
export type InteractionWorkflow = keyof typeof INTERACTION_STATES
export const interactionWorkflowSchema = z.enum(
  Object.keys(INTERACTION_STATES) as [InteractionWorkflow, ...InteractionWorkflow[]]
)

/**
 * How much a check established. Static analysis reaches `structural` (the code has the piece and shows it in the
 * interface) and `static-inferred` (a handler's code shows it happening, such as a pending flag set around an
 * await). `runtime-verified` is reserved for results that come from running the code, which static analysis
 * never produces.
 */
export const EVIDENCE_LEVELS = ["structural", "static-inferred", "runtime-verified"] as const
export const evidenceLevelSchema = z.enum(EVIDENCE_LEVELS)
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number]

export const constraintDetailsSchemas = {
  "required-child": z.strictObject({
    parent: elementRefSchema,
    child: elementRefSchema,
    min: z.number().int().min(1).optional()
  }),
  "forbidden-child": z.strictObject({ parent: elementRefSchema, child: elementRefSchema }),
  "requires-parent": z.strictObject({ child: elementRefSchema, parents: z.array(elementRefSchema).min(1) }),
  "required-region": z.strictObject({ region: regionRefSchema }),
  ordering: z.strictObject({
    before: elementRefSchema,
    after: elementRefSchema,
    within: elementRefSchema.optional()
  }),
  cardinality: z
    .strictObject({
      target: elementRefSchema,
      within: elementRefSchema.optional(),
      min: count.optional(),
      max: count.optional()
    })
    .refine((d) => d.min !== undefined || d.max !== undefined, { message: "state min, max or both" })
    .refine((d) => d.min === undefined || d.max === undefined || d.max >= d.min, {
      message: "max must not be below min"
    }),
  "required-state": z
    .strictObject({
      workflow: interactionWorkflowSchema,
      state: z.string().min(1).max(40),
      /** The weakest evidence that satisfies the rule. Default `structural`. */
      minimum: z.enum(["structural", "static-inferred"]).optional()
    })
    .refine((d) => (INTERACTION_STATES[d.workflow] as readonly string[]).includes(d.state), {
      message: "state is not one of the workflow's states",
      path: ["state"]
    })
} as const satisfies Record<PatternConstraintKind, z.ZodType>

export type ConstraintDetails = {
  [K in PatternConstraintKind]: z.infer<(typeof constraintDetailsSchemas)[K]>
}

export const isPatternConstraintKind = (kind: string): kind is PatternConstraintKind =>
  (PATTERN_CONSTRAINT_KINDS as readonly string[]).includes(kind)

/** Pattern categories introduced in 1.1.0. */
export const PATTERN_CATEGORIES_1_1 = ["interaction", "page"] as const

export const PATTERN_CATEGORIES = [
  "layout",
  "navigation",
  "form",
  "data-table",
  "card",
  "dialog",
  "workflow",
  "composition",
  "other",
  ...PATTERN_CATEGORIES_1_1
] as const
