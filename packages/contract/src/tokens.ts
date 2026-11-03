import { z } from "zod"
import { deprecationSchema } from "./components.js"
import { factsSchema } from "./facts.js"
import { extensionsSchema, jsonValueSchema, themeIdSchema, tokenIdSchema } from "./primitives.js"

export const TOKEN_CATEGORIES = [
  "color",
  "typography",
  "spacing",
  "sizing",
  "border",
  "shadow",
  "breakpoint",
  "motion",
  "other"
] as const
export const tokenCategorySchema = z.enum(TOKEN_CATEGORIES)

/** A token value is either a literal or a reference to another token (a semantic alias), never both. */
export const tokenValueSchema = z
  .strictObject({ value: jsonValueSchema.optional(), aliasOf: tokenIdSchema.optional() })
  .refine((v) => (v.value === undefined) !== (v.aliasOf === undefined), {
    message: "exactly one of 'value' or 'aliasOf' is required"
  })
export type TokenValue = z.infer<typeof tokenValueSchema>

export const themeSchema = z.strictObject({
  id: themeIdSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  default: z.boolean().optional()
})
export type Theme = z.infer<typeof themeSchema>

export const tokenSchema = z.strictObject({
  id: tokenIdSchema,
  name: z.string().min(1),
  category: tokenCategorySchema,
  description: z.string().optional(),
  value: tokenValueSchema,
  /** Per-theme values keyed by theme id. */
  modes: z.record(themeIdSchema, tokenValueSchema).optional(),
  deprecated: deprecationSchema.optional(),
  facts: factsSchema,
  extensions: extensionsSchema.optional()
})
export type Token = z.infer<typeof tokenSchema>
