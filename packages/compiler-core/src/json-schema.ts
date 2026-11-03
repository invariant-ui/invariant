import { z } from "zod"
import { projectDiscoverySchema } from "./discovery/schema.js"

export function discoveryJsonSchemas(): Record<string, unknown> {
  return {
    "project-discovery-v1.schema.json": {
      title: "Invariant project discovery v1",
      ...z.toJSONSchema(projectDiscoverySchema)
    }
  }
}
