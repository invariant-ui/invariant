import {
  evidenceIdSchema,
  evidenceSchema,
  factPathSchema,
  jsonValueSchema,
  sourceIdSchema,
  sourceTypeSchema,
  sourceVersionSchema
} from "@invariant/contract"
import { diagnosticSchema } from "@invariant/shared"
import { z } from "zod"

export const IR_VERSION = "1.3.0"

/**
 * Kinds up to `story` model design-system content. `package`, `export`, `config` and `token-file` were
 * added in IR 1.1.0 so project discovery can be represented honestly without calling an export a component.
 * `story-group` (a CSF `meta`: title, component, shared args and argTypes) was added in IR 1.2.0.
 * `module` (a unit that declares, imports and exports other entities, such as an Angular NgModule) was added in IR 1.3.0.
 */
export const irEntityKindSchema = z.enum([
  "component",
  "token",
  "theme",
  "pattern",
  "guideline",
  "constraint",
  "doc-page",
  "story",
  "package",
  "export",
  "config",
  "token-file",
  "story-group",
  "module"
])

/** Something a source can talk about. `ref` is local to one IR document, never a contract id. */
export const irEntitySchema = z.strictObject({
  ref: z.string().min(1),
  kind: irEntityKindSchema,
  name: z.string().min(1)
})
export type IrEntity = z.infer<typeof irEntitySchema>

/**
 * One claim by one source: (subject, path) has `value`. Paths use the contract's fact-path grammar,
 * for example `props.size.default`; framework-specific detail goes under `extensions.<namespace>`.
 * `origin` is only what an adapter can honestly say. Adapters cannot emit `inferred` or `approved`.
 */
export const irFactSchema = z.strictObject({
  subject: z.string().min(1),
  path: factPathSchema,
  value: jsonValueSchema,
  origin: z.enum(["extracted", "authored"]),
  evidenceIds: z.array(evidenceIdSchema).min(1),
  completeness: z.enum(["complete", "partial", "unknown"]).optional()
})
export type IrFact = z.infer<typeof irFactSchema>

export const irSourceSchema = z.strictObject({
  id: sourceIdSchema,
  type: sourceTypeSchema.exclude(["patterns"]),
  location: z.string().min(1),
  version: sourceVersionSchema.optional(),
  /** Hash of the source inputs read, so an unchanged source can be skipped on recompile. */
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  adapter: z.strictObject({ name: z.string().min(1), version: z.string().min(1) })
})

export const irDocumentSchema = z.strictObject({
  irVersion: z.literal(IR_VERSION),
  source: irSourceSchema,
  /** Fact-path patterns this adapter can supply; `*` matches exactly one path segment. */
  capabilities: z.array(z.string().min(1)),
  /** `partial` and `failed` mean absent facts are not evidence that something does not exist. */
  completeness: z.enum(["complete", "partial", "failed"]),
  entities: z.array(irEntitySchema),
  facts: z.array(irFactSchema),
  evidence: z.array(evidenceSchema),
  diagnostics: z.array(diagnosticSchema)
})
export type IrDocument = z.infer<typeof irDocumentSchema>
