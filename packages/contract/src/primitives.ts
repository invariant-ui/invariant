import type { JsonValue } from "@invariant/shared"
import { z } from "zod"

export const SEGMENT = "[A-Za-z0-9_:-]+"

/** Source ids are plain slugs: `ui-library`, `storybook`. */
export const sourceIdSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/)
export const slugSchema = sourceIdSchema

export const ENTITY_KINDS = [
  "component",
  "token",
  "theme",
  "pattern",
  "guideline",
  "constraint",
  "policy",
  "conflict"
] as const
export type EntityKind = (typeof ENTITY_KINDS)[number]

const NAME_BODY = "[a-z0-9][a-z0-9._-]*(?:/[a-z0-9][a-z0-9._-]*)*"
// Theme ids carry no dots or slashes: they appear as keys inside dotted fact paths.
const THEME_BODY = "[a-z0-9][a-z0-9_-]*"

/** Stable entity ids are `<kind>:<canonical-name>`, for example `component:button`. */
export function entityIdSchemaFor<K extends EntityKind>(kind: K): z.ZodType<`${K}:${string}`> {
  const body = kind === "theme" ? THEME_BODY : NAME_BODY
  return z.string().regex(new RegExp(`^${kind}:${body}$`)) as unknown as z.ZodType<`${K}:${string}`>
}

export const entityIdSchema = z.string().regex(new RegExp(`^(?:${ENTITY_KINDS.join("|")}):${NAME_BODY}$`))

export const componentIdSchema = entityIdSchemaFor("component")
export const tokenIdSchema = entityIdSchemaFor("token")
export const themeIdSchema = entityIdSchemaFor("theme")
export const patternIdSchema = entityIdSchemaFor("pattern")
export const guidelineIdSchema = entityIdSchemaFor("guideline")
export const constraintIdSchema = entityIdSchemaFor("constraint")
export const policyIdSchema = entityIdSchemaFor("policy")
export const conflictIdSchema = entityIdSchemaFor("conflict")

/**
 * Dotted path to a field inside an entity, for example `props.size.allowedValues`.
 * Items of keyed arrays (props, events, slots, ...) are addressed by name or id.
 */
export const factPathSchema = z.string().regex(new RegExp(`^${SEGMENT}(?:\\.${SEGMENT})*$`))

export const isoTimestampSchema = z.iso.datetime()
export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/)
export const confidenceSchema = z.number().min(0).max(1)

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
)
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema)

/**
 * Framework-specific data lives here, namespaced by framework or tool (`react`, `angular`, `vue`, ...).
 * The core model never interprets it.
 */
export const extensionsSchema = z.record(slugSchema, jsonObjectSchema)

export const FRAMEWORKS = ["react", "angular", "vue", "other"] as const
export const frameworkSchema = z.enum(FRAMEWORKS)
export type Framework = z.infer<typeof frameworkSchema>

export const SOURCE_TYPES = [
  "react",
  "angular",
  "vue",
  "storybook",
  "figma",
  "zeroheight",
  "tokens",
  "markdown",
  "git",
  "npm",
  /** A human-authored pattern definition file. Adapters never emit it, so it is not an IR source type. */
  "patterns"
] as const
export const sourceTypeSchema = z.enum(SOURCE_TYPES)
export type SourceType = z.infer<typeof sourceTypeSchema>

export const relativePathSchema = z
  .string()
  .min(1)
  .refine(
    (p) => !p.startsWith("/") && !/^[A-Za-z]:/.test(p) && !p.includes("\\") && !p.split("/").includes(".."),
    {
      message: "must be a POSIX path relative to the source root, with no '..' segments"
    }
  )
