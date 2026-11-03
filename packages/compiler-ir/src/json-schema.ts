import { z } from "zod"
import { irDocumentSchema } from "./ir.js"

export function irJsonSchemas(): Record<string, unknown> {
  return { "ir-v1.schema.json": { title: "Invariant IR document v1", ...z.toJSONSchema(irDocumentSchema) } }
}
