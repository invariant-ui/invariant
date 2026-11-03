import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { type ArtifactEntry, type RenderedArtifact, renderArtifacts } from "@invariant/artifact-generator"
import { angularAdapter } from "@invariant/compiler-angular"
import {
  type CompileResult,
  compile,
  INVENTORY_ADAPTERS,
  nodeFs,
  type SourceAdapter,
  toArtifactEntries
} from "@invariant/compiler-core"
import { reactAdapter } from "@invariant/compiler-react"
import { storybookAdapter } from "@invariant/compiler-storybook"
import { designTokensAdapter } from "@invariant/compiler-tokens"
import { vueAdapter } from "@invariant/compiler-vue"
import type { ContractDraft } from "@invariant/contract"
import {
  DIAGNOSTICS_FILE_VERSION,
  type Diagnostic,
  DiagnosticCollector,
  hasErrors
} from "@invariant/diagnostics"
import {
  applyDecisions,
  compilePolicies,
  DECISIONS_FILE,
  POLICIES_FILE,
  parseDecisions,
  parsePolicies
} from "@invariant/governance"
import type { FinalizedContract } from "@invariant/reconciliation"
import {
  buildReviewQueue,
  finalizeAndVerify,
  type ReconcileResult,
  type ReviewItem,
  reconcile
} from "@invariant/reconciliation"
import { enrich } from "@invariant/semantic-engine"
import type { JsonValue } from "@invariant/shared"
import type { InvariantConfig } from "./config.js"
import { renderReport } from "./report.js"
import { CLI_NAME, CLI_VERSION } from "./version.js"

const ADAPTERS: Record<InvariantConfig["sources"][number]["type"], SourceAdapter> = {
  react: reactAdapter as SourceAdapter,
  vue: vueAdapter as SourceAdapter,
  angular: angularAdapter as SourceAdapter,
  storybook: storybookAdapter as SourceAdapter,
  tokens: designTokensAdapter as SourceAdapter
}

export const REVIEW_VERSION = "1.0.0"

const within = (location: string, dir: string): boolean =>
  dir === "." || location === dir || location.startsWith(`${dir}/`)

/** Limits an adapter to the directories the configuration names for its type. No path means everything. */
function scoped(adapter: SourceAdapter, paths: readonly string[] | undefined): SourceAdapter {
  if (!paths) return adapter
  return {
    ...adapter,
    discover: async (context) => {
      const found = await adapter.discover(context)
      return { ...found, sources: found.sources.filter((s) => paths.some((p) => within(s.location, p))) }
    }
  } as SourceAdapter
}

export function adaptersFor(config: InvariantConfig): SourceAdapter[] {
  const adapters: SourceAdapter[] = [...(INVENTORY_ADAPTERS as ReadonlyArray<SourceAdapter>)]
  for (const type of Object.keys(ADAPTERS) as Array<keyof typeof ADAPTERS>) {
    const entries = config.sources.filter((s) => s.type === type)
    if (entries.length === 0) continue
    const unrestricted = entries.some((e) => e.path === undefined)
    adapters.push(
      scoped(
        ADAPTERS[type],
        unrestricted ? undefined : entries.flatMap((e) => (e.path === undefined ? [] : [e.path]))
      )
    )
  }
  return adapters
}

export interface SourceMapping {
  configId: string
  type: string
  path?: string
  /** Ids of the compiled sources this entry produced. */
  sources: string[]
}

export interface PipelineResult {
  compiled: CompileResult
  reconciled: ReconcileResult
  final: FinalizedContract
  review: ReviewItem[]
  diagnostics: Diagnostic[]
  mapping: SourceMapping[]
  governance: GovernanceSummary
  ok: boolean
  artifacts: RenderedArtifact[]
}

export interface GovernanceSummary {
  policies: number
  decisionsApplied: number
  decisionsStale: number
}

interface Governed {
  contract: ContractDraft
  diagnostics: Diagnostic[]
  summary: GovernanceSummary
}

/** Adds approved policies, then applies people's decisions, from the two human-written files in the project. */
function applyGovernance(cwd: string, config: InvariantConfig, draft: ContractDraft): Governed {
  const diagnostics: Diagnostic[] = []
  const summary: GovernanceSummary = { policies: 0, decisionsApplied: 0, decisionsStale: 0 }
  const read = (rel: string): string | undefined => {
    const file = path.resolve(cwd, rel)
    return existsSync(file) ? readFileSync(file, "utf8") : undefined
  }
  const bad = (message: string): void => {
    diagnostics.push({ code: "governance.invalid-file", severity: "error", message })
  }
  let contract = draft
  const policiesFile = config.governance?.policiesFile ?? POLICIES_FILE
  const policiesText = read(policiesFile)
  if (policiesText !== undefined) {
    const parsed = parsePolicies(policiesText)
    if (parsed.ok) {
      const compiled = compilePolicies(contract, parsed.value, policiesFile)
      contract = compiled.contract
      diagnostics.push(...compiled.diagnostics)
      summary.policies = contract.policies.length - draft.policies.length
    } else bad(parsed.message)
  }
  const decisionsText = read(config.governance?.decisionsFile ?? DECISIONS_FILE)
  if (decisionsText !== undefined) {
    const parsed = parseDecisions(decisionsText)
    if (parsed.ok) {
      const result = applyDecisions(contract, parsed.value, { approvers: config.governance?.approvers })
      contract = result.contract
      diagnostics.push(...result.diagnostics)
      summary.decisionsApplied = result.applied.length
      summary.decisionsStale = result.stale.length
    } else bad(parsed.message)
  }
  return { contract, diagnostics, summary }
}

export interface PipelineInput {
  cwd: string
  config: InvariantConfig
  clock: () => string
  /** Also write the per-source IR documents under `ir/`. */
  keepIr?: boolean
}

function mapSources(config: InvariantConfig, compiled: CompileResult): SourceMapping[] {
  return config.sources.map((entry) => {
    const sources = compiled.irDocuments
      .filter((d) => d.source.type === entry.type || (entry.type === "tokens" && d.source.type === "tokens"))
      .filter((d) => entry.path === undefined || within(d.source.location, entry.path))
      .map((d) => d.source.id)
      .sort()
    return { configId: entry.id, type: entry.type, ...(entry.path ? { path: entry.path } : {}), sources }
  })
}

/** discover, extract, reconcile, enrich, verify and render. Reads the project; writes nothing. */
export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const { config, clock } = input
  const compiled = await compile({ fs: nodeFs(input.cwd), adapters: adaptersFor(config), clock })
  const reconciled = reconcile(compiled.irDocuments, {
    name: config.name,
    ...(config.contractId ? { contractId: config.contractId } : {}),
    ...(config.description ? { description: config.description } : {}),
    compilerVersion: CLI_VERSION,
    clock
  })
  const enriched = enrich({
    contract: reconciled.contract,
    evidence: reconciled.evidence,
    docs: compiled.irDocuments
  })
  const governed = applyGovernance(input.cwd, config, enriched.contract)
  const final = finalizeAndVerify(governed.contract, enriched.evidence)
  const review = buildReviewQueue(governed.contract)
  const mapping = mapSources(config, compiled)

  const collector = new DiagnosticCollector()
  collector.addAll(compiled.diagnostics)
  collector.addAll(reconciled.diagnostics)
  collector.addAll(enriched.diagnostics)
  collector.addAll(governed.diagnostics)
  collector.addAll(final.diagnostics)
  for (const m of mapping)
    if (m.sources.length === 0)
      collector.warning(
        "cli.source-matched-nothing",
        `configured source "${m.configId}" (${m.type}${m.path ? ` at ${m.path}` : ""}) matched no source`
      )
  const diagnostics = collector.toArray()

  const entries: ArtifactEntry[] = [
    { path: "invariant.contract.json", value: final.contract as unknown as JsonValue },
    { path: "invariant.evidence.json", value: final.evidenceFile as unknown as JsonValue },
    {
      path: "invariant.diagnostics.json",
      value: { diagnosticsVersion: DIAGNOSTICS_FILE_VERSION, diagnostics } as unknown as JsonValue
    },
    {
      path: "invariant.review.json",
      value: { reviewVersion: REVIEW_VERSION, items: review } as unknown as JsonValue
    },
    { path: "invariant.report.html", text: renderReport({ contract: final.contract, review, diagnostics }) }
  ]
  if (input.keepIr)
    entries.push(
      ...toArtifactEntries(compiled).filter(
        (e) => e.path.startsWith("ir/") || e.path === "invariant.project.json"
      )
    )
  const artifacts = renderArtifacts(entries, {
    tool: { name: CLI_NAME, version: CLI_VERSION },
    generatedAt: clock(),
    sources: compiled.sources
  })
  return {
    compiled,
    reconciled,
    final,
    review,
    diagnostics,
    mapping,
    governance: governed.summary,
    ok: !hasErrors(diagnostics),
    artifacts
  }
}
