import {
  canonicalizeIrDocument,
  computeIrContentHash,
  IR_VERSION,
  type IrDocument,
  irDocumentSchema,
  verifyIrDocument
} from "@invariant/compiler-ir"
import {
  canonicalStringify,
  DIAGNOSTICS_FILE_VERSION,
  type Diagnostic,
  DiagnosticCollector,
  hasErrors,
  type JsonValue,
  sortDiagnostics
} from "@invariant/shared"
import type { DiscoveredSource, SourceAdapter } from "./adapter.js"
import { INVENTORY_ADAPTERS } from "./adapters/inventory.js"
import { type DiscoverOptions, discoverProject, type ProjectDiscovery } from "./discovery/index.js"
import type { ReadonlyFs } from "./fs.js"

export interface CompileOptions {
  fs: ReadonlyFs
  /** Defaults to the framework-neutral inventory adapters. */
  adapters?: ReadonlyArray<SourceAdapter>
  /** ISO timestamp provider; inject a fixed one for reproducible artifacts. */
  clock?: () => string
  signal?: AbortSignal
  discovery?: Omit<DiscoverOptions, "fs">
  /** Restrict to these adapter ids. */
  only?: readonly string[]
}

export interface CompiledSource {
  id: string
  type: string
  adapterId: string
  adapterVersion: string
  inputHash: string
  /** Hash of the IR excluding capture times: equal across runs when inputs are unchanged. */
  irContentHash: string
  completeness: IrDocument["completeness"]
}

export interface CompileResult {
  project: ProjectDiscovery
  sources: CompiledSource[]
  irDocuments: IrDocument[]
  diagnostics: Diagnostic[]
  /** False when any error-severity diagnostic was produced. */
  ok: boolean
}

/**
 * Orchestrates discover, extract and validate for every adapter, in a fixed order (adapter id, then
 * source id). A failing adapter never aborts the run: it yields a `failed` IR document and an error
 * diagnostic, because a missing source must not be read as proof that its facts do not exist.
 * Stops at IR; reconciliation and contract generation belong to later phases.
 */
export async function compile(options: CompileOptions): Promise<CompileResult> {
  const clock = options.clock ?? (() => new Date().toISOString())
  const signal = options.signal
  const collector = new DiagnosticCollector()

  signal?.throwIfAborted()
  const project = await discoverProject({ fs: options.fs, ...options.discovery })
  collector.addAll(project.diagnostics)

  const adapters = [...(options.adapters ?? (INVENTORY_ADAPTERS as ReadonlyArray<SourceAdapter>))]
    .filter((a) => !options.only || options.only.includes(a.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const planned: Array<{ adapter: SourceAdapter; source: DiscoveredSource }> = []
  const seen = new Set<string>()
  for (const adapter of adapters) {
    signal?.throwIfAborted()
    try {
      const found = await adapter.discover({
        fs: options.fs,
        project,
        ...(signal ? { signal } : {})
      })
      collector.addAll(found.diagnostics)
      for (const source of [...found.sources].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
        if (seen.has(source.id)) {
          collector.error(
            "compile.duplicate-source-id",
            `Source id ${source.id} from adapter ${adapter.id} is already in use; skipped`,
            { sourceId: source.id }
          )
          continue
        }
        seen.add(source.id)
        planned.push({ adapter, source })
      }
    } catch (error) {
      collector.error(
        "compile.adapter-failed",
        `Adapter ${adapter.id} failed during discovery: ${messageOf(error)}`
      )
    }
  }

  const irDocuments: IrDocument[] = []
  const sources: CompiledSource[] = []
  for (const { adapter, source } of planned) {
    signal?.throwIfAborted()
    const ir = await extractOne({ adapter, source, options, project, clock, collector })
    irDocuments.push(ir)
    sources.push({
      id: source.id,
      type: source.type,
      adapterId: adapter.id,
      adapterVersion: adapter.version,
      inputHash: source.inputHash,
      irContentHash: computeIrContentHash(ir),
      completeness: ir.completeness
    })
  }

  const diagnostics = dedupe(collector.toArray())
  return { project, sources, irDocuments, diagnostics, ok: !hasErrors(diagnostics) }
}

/** Entries for the artifact generator: project discovery, one IR file per source, and diagnostics. */
export function toArtifactEntries(result: CompileResult): Array<{ path: string; value: JsonValue }> {
  return [
    { path: "invariant.project.json", value: result.project as unknown as JsonValue },
    ...result.irDocuments.map((ir) => ({
      path: `ir/${ir.source.id}.ir.json`,
      value: ir as unknown as JsonValue
    })),
    {
      path: "invariant.diagnostics.json",
      value: {
        diagnosticsVersion: DIAGNOSTICS_FILE_VERSION,
        diagnostics: result.diagnostics
      } as unknown as JsonValue
    }
  ]
}

async function extractOne(input: {
  adapter: SourceAdapter
  source: DiscoveredSource
  options: CompileOptions
  project: ProjectDiscovery
  clock: () => string
  collector: DiagnosticCollector
}): Promise<IrDocument> {
  const { adapter, source, options, project, clock, collector } = input
  const failed = (message: string): IrDocument => failedDocument({ adapter, source, clock, message })
  let ir: IrDocument
  try {
    const result = await adapter.extract(
      { fs: options.fs, project, source, clock, ...(options.signal ? { signal: options.signal } : {}) },
      source.config
    )
    const parsed = irDocumentSchema.safeParse(result.ir)
    if (!parsed.success) {
      collector.error(
        "compile.invalid-ir",
        `Adapter ${adapter.id} produced an invalid IR document for ${source.id}: ${parsed.error.issues[0]?.message ?? "schema error"}`,
        { sourceId: source.id }
      )
      return failed("invalid IR")
    }
    ir = canonicalizeIrDocument(parsed.data)
  } catch (error) {
    if (options.signal?.aborted) throw error
    collector.error(
      "compile.adapter-failed",
      `Adapter ${adapter.id} failed extracting ${source.id}: ${messageOf(error)}`,
      { sourceId: source.id }
    )
    return failed(messageOf(error))
  }
  collector.addAll(verifyIrDocument(ir))
  collector.addAll(ir.diagnostics)
  try {
    collector.addAll(await adapter.validate({ project, source, ir }))
  } catch (error) {
    collector.error(
      "compile.adapter-failed",
      `Adapter ${adapter.id} failed validating ${source.id}: ${messageOf(error)}`,
      { sourceId: source.id }
    )
  }
  return ir
}

function failedDocument(input: {
  adapter: SourceAdapter
  source: DiscoveredSource
  clock: () => string
  message: string
}): IrDocument {
  const { adapter, source, message } = input
  return {
    irVersion: IR_VERSION,
    source: {
      id: source.id,
      type: source.type,
      location: source.location,
      ...(source.version ? { version: source.version } : {}),
      inputHash: source.inputHash,
      adapter: { name: adapter.id, version: adapter.version }
    },
    capabilities: [],
    completeness: "failed",
    entities: [],
    facts: [],
    evidence: [],
    diagnostics: [{ code: "compile.adapter-failed", severity: "error", message, sourceId: source.id }]
  }
}

/**
 * Drops duplicate diagnostics. The same finding is often reported once by discovery and again, with a
 * `sourceId`, when an adapter forwards it into its IR; those are merged, keeping the attributed copy.
 */
function dedupe(diagnostics: Diagnostic[]): Diagnostic[] {
  const byKey = new Map<string, Diagnostic>()
  for (const d of diagnostics) {
    const { sourceId: _sourceId, ...rest } = d
    const key = canonicalStringify(rest)
    const existing = byKey.get(key)
    if (!existing || (existing.sourceId === undefined && d.sourceId !== undefined)) byKey.set(key, d)
  }
  return sortDiagnostics([...byKey.values()])
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
