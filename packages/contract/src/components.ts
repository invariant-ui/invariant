import { z } from "zod"
import { factsSchema } from "./facts.js"
import {
  componentIdSchema,
  entityIdSchema,
  extensionsSchema,
  frameworkSchema,
  jsonValueSchema,
  slugSchema,
  sourceIdSchema
} from "./primitives.js"

export const deprecationSchema = z.strictObject({
  reason: z.string().min(1).optional(),
  replacedBy: entityIdSchema.optional()
})

/** Framework-neutral type description. `text` is the source's own spelling. */
export const typeRefSchema = z.strictObject({
  text: z.string().min(1),
  kind: z
    .enum([
      "string",
      "number",
      "boolean",
      "enum",
      "function",
      "component",
      "object",
      "array",
      "union",
      "unknown"
    ])
    .optional()
})

export const propSchema = z.strictObject({
  name: z.string().min(1),
  type: typeRefSchema,
  required: z.boolean(),
  default: jsonValueSchema.optional(),
  allowedValues: z.array(z.union([z.string(), z.number().finite(), z.boolean()])).optional(),
  description: z.string().optional(),
  deprecated: deprecationSchema.optional(),
  extensions: extensionsSchema.optional()
})

export const eventSchema = z.strictObject({
  name: z.string().min(1),
  payload: typeRefSchema.optional(),
  description: z.string().optional(),
  deprecated: deprecationSchema.optional(),
  extensions: extensionsSchema.optional()
})

export const slotSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().optional(),
  required: z.boolean().optional(),
  accepts: z.array(componentIdSchema).optional(),
  extensions: extensionsSchema.optional()
})

export const variantSchema = z.strictObject({
  name: z.string().min(1),
  values: z.array(z.string().min(1)).min(1),
  default: z.string().min(1).optional(),
  description: z.string().optional()
})

export const stateSchema = z.strictObject({ name: z.string().min(1), description: z.string().optional() })

export const accessibilitySchema = z.strictObject({
  role: z.string().min(1).optional(),
  attributes: z.array(z.string().min(1)).optional(),
  keyboard: z.array(z.string().min(1)).optional(),
  requirements: z.array(z.string().min(1)).optional()
})

export const exampleSchema = z.strictObject({
  id: slugSchema,
  title: z.string().optional(),
  language: z.string().min(1),
  code: z.string().min(1),
  sourceId: sourceIdSchema.optional()
})

export const relationshipSchema = z.strictObject({
  type: z.enum(["contains", "requires-parent", "commonly-used-with", "extends"]),
  target: componentIdSchema
})

/** One concrete implementation of a conceptual component, in one framework, from one source. */
export const implementationSchema = z.strictObject({
  id: slugSchema,
  framework: frameworkSchema,
  sourceId: sourceIdSchema,
  packageName: z.string().min(1).optional(),
  exportName: z.string().min(1).optional(),
  importPath: z.string().min(1).optional(),
  extensions: extensionsSchema.optional()
})

export const componentSchema = z.strictObject({
  id: componentIdSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  lifecycle: z.enum(["stable", "experimental", "deprecated"]).optional(),
  deprecated: deprecationSchema.optional(),
  implementations: z.array(implementationSchema),
  props: z.array(propSchema),
  events: z.array(eventSchema),
  slots: z.array(slotSchema),
  variants: z.array(variantSchema),
  states: z.array(stateSchema),
  accessibility: accessibilitySchema.optional(),
  examples: z.array(exampleSchema),
  composition: z.array(relationshipSchema),
  facts: factsSchema,
  extensions: extensionsSchema.optional()
})
export type Component = z.infer<typeof componentSchema>
