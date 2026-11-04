import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  type ArtifactEntry,
  MANIFEST_PATH,
  manifestSchema,
  renderArtifacts,
  writeArtifacts
} from "@invariant/artifact-generator"
import { compile, nodeFs, toArtifactEntries } from "@invariant/compiler-core"
import { checkCompileDeterminism, FIXED_CLOCK } from "@invariant/compiler-core/testing"
import { parseIrDocument, verifyIrDocument } from "@invariant/compiler-ir"
import { diagnosticsFileSchema } from "@invariant/shared"
import { afterAll, describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("..", import.meta.url))
const fixtureRoot = join(root, "fixtures/monorepo/acme")
const expectedDir = join(root, "fixtures/monorepo/expected")

async function build(clock = FIXED_CLOCK) {
  const result = await compile({ fs: nodeFs(fixtureRoot), clock })
  const entries: ArtifactEntry[] = toArtifactEntries(result)
  const artifacts = renderArtifacts(entries, {
    tool: { name: "invariant", version: "0.0.0" },
    generatedAt: clock(),
    sources: result.sources
  })
  return { result, artifacts }
}

describe("Phase 2 exit criterion: a project is discovered, analyzed and represented in IR with no framework adapter", () => {
  it("compiles the multi-framework monorepo into valid IR using only framework-neutral adapters", async () => {
    const { result } = await build()
    expect(result.ok).toBe(true)
    // Findings reported by discovery and forwarded by an adapter appear once, attributed to the source.
    expect(result.diagnostics.map((d) => [d.code, d.sourceId])).toEqual([
      ["discovery.storybook-dynamic-config", "storybook-packages-ui-react"],
      ["discovery.entry-pattern-unsupported", "npm-acme-ui-react"]
    ])
    expect(result.project.packages.flatMap((p) => p.frameworks.map((f) => f.name)).sort()).toEqual([
      "angular",
      "react",
      "vue"
    ])
    // Every IR document passes schema and semantic validation.
    for (const ir of result.irDocuments) {
      expect(parseIrDocument(JSON.parse(JSON.stringify(ir))).ok).toBe(true)
      expect(verifyIrDocument(ir).filter((d) => d.severity === "error")).toEqual([])
    }
    expect(new Set(result.irDocuments.map((d) => d.source.type))).toEqual(
      new Set(["npm", "storybook", "tokens", "markdown"])
    )
    // The Storybook IR is partial because the config has a dynamic property: absence is not asserted.
    expect(result.irDocuments.find((d) => d.source.type === "storybook")?.completeness).toBe("partial")
    // Every fact in every document cites evidence that exists with a source location.
    for (const ir of result.irDocuments) {
      const ids = new Set(ir.evidence.map((e) => e.id))
      expect(
        ir.facts.every((f) => f.evidenceIds.length > 0 && f.evidenceIds.every((id) => ids.has(id)))
      ).toBe(true)
      expect(ir.evidence.every((e) => (e.location.type === "file" ? e.location.path.length > 0 : true))).toBe(
        true
      )
    }
    // No export is promoted to a component by the inventory.
    expect(result.irDocuments.flatMap((d) => d.entities).some((e) => e.kind === "component")).toBe(false)
  })

  it("is reproducible: two runs with different clocks agree except capture times and the manifest", async () => {
    expect(await checkCompileDeterminism({ fs: nodeFs(fixtureRoot) })).toEqual([])
    const a = await build(() => "2026-01-01T00:00:00.000Z")
    const b = await build(() => "2031-01-01T00:00:00.000Z")
    const strip = (text: string): string => text.replace(/"capturedAt": "[^"]+"/g, '"capturedAt": "-"')
    const comparable = (artifacts: typeof a.artifacts) =>
      artifacts.filter((x) => x.path !== MANIFEST_PATH).map((x) => [x.path, strip(x.text)])
    expect(comparable(a.artifacts)).toEqual(comparable(b.artifacts))
    expect(a.artifacts.find((x) => x.path === "invariant.project.json")?.text).toBe(
      b.artifacts.find((x) => x.path === "invariant.project.json")?.text
    )
    expect(a.result.sources.map((s) => s.irContentHash)).toEqual(b.result.sources.map((s) => s.irContentHash))
  })

  it("matches the committed golden artifacts", async () => {
    const { artifacts } = await build()
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(expectedDir)) {
      rmSync(expectedDir, { recursive: true, force: true })
      for (const artifact of artifacts) {
        mkdirSync(dirname(join(expectedDir, artifact.path)), { recursive: true })
        writeFileSync(join(expectedDir, artifact.path), artifact.text)
      }
    }
    const onDisk = (dir: string, prefix = ""): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? onDisk(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]
      )
    expect(onDisk(expectedDir).sort()).toEqual(artifacts.map((a) => a.path).sort())
    for (const artifact of artifacts)
      expect(readFileSync(join(expectedDir, artifact.path), "utf8")).toBe(artifact.text)
  })

  it("writes artifacts to disk and the manifest hashes match the files", async () => {
    const { artifacts } = await build()
    const out = mkdtempSync(join(tmpdir(), "invariant-e2e-"))
    cleanup.push(out)
    await writeArtifacts(out, artifacts)
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(out, MANIFEST_PATH), "utf8")))
    expect(manifest.artifacts.map((a) => a.path)).toEqual(
      artifacts.filter((a) => a.path !== MANIFEST_PATH).map((a) => a.path)
    )
    const diagnostics = diagnosticsFileSchema.parse(
      JSON.parse(readFileSync(join(out, "invariant.diagnostics.json"), "utf8"))
    )
    expect(diagnostics.diagnostics.map((d) => d.code)).toContain("discovery.storybook-dynamic-config")
    expect(manifest.sources.map((s) => s.id)).toEqual(
      [
        "docs-acme-docs",
        "docs-acme-design-system",
        "docs-acme-tokens",
        "docs-acme-ui-react",
        "npm-acme-design-system",
        "npm-acme-docs",
        "npm-acme-tokens",
        "npm-acme-ui-angular",
        "npm-acme-ui-react",
        "npm-acme-ui-vue",
        "storybook-packages-ui-react",
        "tokens-acme-tokens",
        "tokens-acme-ui-react"
      ].sort()
    )
  })
})

const cleanup: string[] = []
afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})
