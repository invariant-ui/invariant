import type { IrDocument } from "@invariant/compiler-ir"
import type { Source, SourceType } from "@invariant/contract"
import type { Diagnostic } from "@invariant/diagnostics"
import type { ProjectDiscovery } from "./discovery/index.js"
import type { ReadonlyFs } from "./fs.js"

export type SourceVersion = NonNullable<Source["version"]>

export interface DiscoveryContext {
  fs: ReadonlyFs
  /** Framework-neutral facts about the whole project, computed once and shared by every adapter. */
  project: ProjectDiscovery
  signal?: AbortSignal
}

/** One source an adapter found and can extract. `config` is adapter-private and must be JSON-serializable. */
export interface DiscoveredSource<TConfig = unknown> {
  /** Unique across the whole compilation. Slug: `[a-z0-9][a-z0-9._-]*`. */
  id: string
  type: SourceType
  /** Project-relative location. */
  location: string
  config: TConfig
  /** Absent when the source exposes no version; adapters must not invent one. */
  version?: SourceVersion
  /** Hash of every input the extraction will read, so unchanged sources can be recognized. */
  inputHash: string
}

export interface DiscoveryResult<TConfig = unknown> {
  sources: DiscoveredSource<TConfig>[]
  diagnostics: Diagnostic[]
}

export interface ExtractionContext {
  fs: ReadonlyFs
  project: ProjectDiscovery
  source: DiscoveredSource
  /** ISO timestamp provider. Injected so output can be made reproducible. */
  clock: () => string
  signal?: AbortSignal
}

export interface ExtractionResult {
  ir: IrDocument
}

export interface ValidationContext {
  project: ProjectDiscovery
  source: DiscoveredSource
  ir: IrDocument
}

/**
 * Lifecycle every source adapter implements: discover what can be extracted, extract it into IR, then
 * validate the result. Adapters only read (`ReadonlyFs`), never execute customer code, and never build
 * the contract: they stop at IR.
 */
export interface SourceAdapter<TConfig = unknown> {
  id: string
  version: string
  type: SourceType
  discover(context: DiscoveryContext): Promise<DiscoveryResult<TConfig>>
  extract(context: ExtractionContext, config: TConfig): Promise<ExtractionResult>
  validate(context: ValidationContext): Promise<Diagnostic[]>
}
