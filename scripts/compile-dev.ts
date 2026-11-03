// Developer utility until the CLI exists (Phase 8):
//   node scripts/compile-dev.ts <projectDir> [outDir] [--react] [--vue] [--angular] [--tokens] [--stories] [--contract]
import path from "node:path"

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith("--")))
const [projectArg, outArg] = args.filter((a) => !a.startsWith("--"))
if (!projectArg) {
  console.error(
    "usage: node scripts/compile-dev.ts <projectDir> [outDir] [--react] [--vue] [--angular] [--tokens] [--stories] [--contract]"
  )
  process.exit(2)
}
const load = async <T>(pkg: string): Promise<T> =>
  (await import(new URL(`../packages/${pkg}/dist/index.js`, import.meta.url).href)) as T
const core = await load<typeof import("@invariant/compiler-core")>("compiler-core")
const artifacts = await load<typeof import("@invariant/artifact-generator")>("artifact-generator")
const adapters: Array<import("@invariant/compiler-core").SourceAdapter> = [...core.INVENTORY_ADAPTERS]
if (flags.has("--react"))
  adapters.push(
    (await load<typeof import("@invariant/compiler-react")>("compiler-react")).reactAdapter as never
  )
if (flags.has("--vue"))
  adapters.push((await load<typeof import("@invariant/compiler-vue")>("compiler-vue")).vueAdapter as never)
if (flags.has("--angular"))
  adapters.push(
    (await load<typeof import("@invariant/compiler-angular")>("compiler-angular")).angularAdapter as never
  )
if (flags.has("--stories"))
  adapters.push(
    (await load<typeof import("@invariant/compiler-storybook")>("compiler-storybook"))
      .storybookAdapter as never
  )
if (flags.has("--tokens"))
  adapters.push(
    (await load<typeof import("@invariant/compiler-tokens")>("compiler-tokens")).designTokensAdapter as never
  )

const projectDir = path.resolve(projectArg)
const started = Date.now()
const result = await core.compile({ fs: core.nodeFs(projectDir), adapters })
const reconciliation = flags.has("--stories")
  ? (await load<typeof import("@invariant/reconciliation")>("reconciliation")).reconcileStorybook(
      result.irDocuments
    )
  : undefined
const entries: Array<{ path: string; value: import("@invariant/shared").JsonValue }> =
  core.toArtifactEntries(result)
if (reconciliation) entries.push({ path: "invariant.reconciliation.json", value: reconciliation as never })
const rendered = artifacts.renderArtifacts(entries, {
  tool: { name: "invariant", version: "0.0.0" },
  generatedAt: new Date().toISOString(),
  sources: result.sources
})
if (outArg) await artifacts.writeArtifacts(path.resolve(outArg), rendered)

const counts: Record<string, number> = {}
for (const d of result.diagnostics) counts[d.severity] = (counts[d.severity] ?? 0) + 1
const entities: Record<string, number> = {}
for (const ir of result.irDocuments)
  for (const e of ir.entities) entities[e.kind] = (entities[e.kind] ?? 0) + 1
console.log(`project: ${projectDir}`)
console.log(
  `packages: ${result.project.packages.length}, storybooks: ${result.project.storybooks.length}, token files: ${result.project.tokenFiles.length}, docs: ${result.project.docFiles.length}`
)
console.log(`sources: ${result.sources.length}, entities: ${JSON.stringify(entities)}`)
console.log(`diagnostics: ${JSON.stringify(counts)}, ok: ${result.ok}, ${Date.now() - started} ms`)
if (reconciliation) {
  const byCode: Record<string, number> = {}
  for (const d of reconciliation.discrepancies)
    byCode[d.code.replace("reconcile.storybook.", "")] =
      (byCode[d.code.replace("reconcile.storybook.", "")] ?? 0) + 1
  console.log(
    `stories linked to components: ${reconciliation.links.length}; discrepancies: ${JSON.stringify(byCode)}`
  )
}
if (flags.has("--contract")) {
  const rec = await load<typeof import("@invariant/reconciliation")>("reconciliation")
  const contractPkg = await load<typeof import("@invariant/contract")>("contract")
  const fs = await import("node:fs/promises")
  const reconciled = rec.reconcile(result.irDocuments, {
    name: path.basename(projectDir),
    compilerVersion: "0.0.0"
  })
  const semantic = await load<typeof import("@invariant/semantic-engine")>("semantic-engine")
  const enriched = semantic.enrich({
    contract: reconciled.contract,
    evidence: reconciled.evidence,
    docs: result.irDocuments
  })
  const final = rec.finalizeAndVerify(enriched.contract, enriched.evidence)
  const review = rec.buildReviewQueue(enriched.contract)
  const c = final.contract
  console.log(
    `contract: ${c.components.length} components, ${c.tokens.length} tokens, ${c.themes.length} themes, ${c.conflicts.length} conflicts, ${review.length} review items`
  )
  const byType: Record<string, number> = {}
  for (const x of c.conflicts) byType[x.type] = (byType[x.type] ?? 0) + 1
  console.log(`conflicts by type: ${JSON.stringify(byType)}`)
  console.log(
    `contract diagnostics: ${final.diagnostics.length} verify, ${reconciled.diagnostics.length} reconcile, ${enriched.diagnostics.length} semantic; guidelines: ${c.guidelines.length}`
  )
  for (const d of [...final.diagnostics, ...enriched.diagnostics.filter((x) => x.severity === "error")].slice(
    0,
    8
  ))
    console.log(`  ${d.severity} ${d.code}: ${d.message}`)
  if (outArg) {
    const dir = path.resolve(outArg)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "invariant.contract.json"), contractPkg.serializeContract(c))
    await fs.writeFile(
      path.join(dir, "invariant.evidence.json"),
      contractPkg.serializeEvidenceFile(final.evidenceFile)
    )
    await fs.writeFile(path.join(dir, "invariant.review.json"), `${JSON.stringify(review, null, 2)}\n`)
  }
}
if (outArg) console.log(`artifacts written to ${path.resolve(outArg)} (${rendered.length} files)`)
