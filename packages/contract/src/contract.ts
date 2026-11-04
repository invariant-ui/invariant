import { z } from "zod"
import { componentSchema } from "./components.js"
import { conflictSchema } from "./conflicts.js"
import { constraintSchema, guidelineSchema, patternSchema, policySchema } from "./knowledge.js"
import { frameworkSchema, isoTimestampSchema, sha256HexSchema, slugSchema } from "./primitives.js"
import { sourceSchema } from "./sources.js"
import { themeSchema, tokenSchema } from "./tokens.js"

/**
 * 1.1.0 added pattern contracts. Every new field is optional, so a 1.0.0 document is also a valid 1.1.0 document:
 * nothing is rewritten when one is read, and its content hash stays valid. Writers emit the current version.
 */
export const SUPPORTED_CONTRACT_VERSIONS = ["1.0.0", "1.1.0"] as const
export const CONTRACT_VERSION = "1.1.0"

export const contractMetadataSchema = z.strictObject({
  /** Stable identity of the design system across contract versions. */
  contractId: slugSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  compilerVersion: z.string().min(1),
  frameworks: z.array(frameworkSchema),
  /** Excluded from the content hash. */
  compiledAt: isoTimestampSchema
})

export const integritySchema = z.strictObject({
  algorithm: z.literal("sha256"),
  contentHash: sha256HexSchema
})

/**
 * Canonical design-system contract. Collections are sorted by id; per-source versions live in
 * `sources[].version`. Evidence is stored in a separate evidence file and referenced by id.
 */
export const contractSchema = z.strictObject({
  contractVersion: z.enum(SUPPORTED_CONTRACT_VERSIONS),
  metadata: contractMetadataSchema,
  sources: z.array(sourceSchema),
  themes: z.array(themeSchema),
  components: z.array(componentSchema),
  tokens: z.array(tokenSchema),
  patterns: z.array(patternSchema),
  guidelines: z.array(guidelineSchema),
  constraints: z.array(constraintSchema),
  policies: z.array(policySchema),
  conflicts: z.array(conflictSchema),
  integrity: integritySchema
})
export type Contract = z.infer<typeof contractSchema>
export type ContractDraft = Omit<Contract, "integrity">
