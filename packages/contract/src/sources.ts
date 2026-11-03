import { z } from "zod"
import { isoTimestampSchema, sourceIdSchema, sourceTypeSchema } from "./primitives.js"

/**
 * Authentication metadata only. `credentialRef` names where a credential lives (for example an
 * environment variable name); the credential itself can never be represented here.
 */
export const authenticationSchema = z.strictObject({
  method: z.enum(["none", "token", "oauth", "ssh"]),
  credentialRef: z.string().min(1).optional()
})

export const sourceVersionSchema = z.strictObject({
  kind: z.enum(["git-commit", "package-version", "tool-version", "file-version", "content-hash"]),
  value: z.string().min(1)
})

export const sourceSchema = z.strictObject({
  id: sourceIdSchema,
  type: sourceTypeSchema,
  location: z.string().min(1),
  /** Absent when the source exposes no version. The compiler must not invent one. */
  version: sourceVersionSchema.optional(),
  authentication: authenticationSchema.optional(),
  lastSyncedAt: isoTimestampSchema.optional(),
  /** Fact-path patterns this source is able to supply, for example `props.*.required`. */
  capabilities: z.array(z.string().min(1)),
  health: z.strictObject({
    status: z.enum(["ok", "degraded", "failed"]),
    diagnosticCount: z.number().int().nonnegative()
  })
})
export type Source = z.infer<typeof sourceSchema>
