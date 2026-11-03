import { z } from "zod"
import { contractSchema } from "./contract.js"
import { evidenceFileSchema } from "./evidence.js"

/** Serialized-contract JSON Schemas, derived from the Zod definitions (the single source of truth). */
export function contractJsonSchemas(): Record<string, unknown> {
  return {
    "contract-v1.schema.json": { title: "Invariant contract v1", ...z.toJSONSchema(contractSchema) },
    "evidence-v1.schema.json": { title: "Invariant evidence file v1", ...z.toJSONSchema(evidenceFileSchema) }
  }
}
