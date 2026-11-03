import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { renderArtifacts } from "@invariant/artifact-generator"
import {
  compile,
  INVENTORY_ADAPTERS,
  nodeFs,
  type SourceAdapter,
  toArtifactEntries
} from "@invariant/compiler-core"
import { checkCompileDeterminism, FIXED_CLOCK } from "@invariant/compiler-core/testing"
import { reactAdapter } from "@invariant/compiler-react"
import { designTokensAdapter } from "@invariant/compiler-tokens"
import { describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("..", import.meta.url))
const fixture = join(root, "fixtures/react/design-system")
const expectedDir = join(root, "fixtures/react/expected")
const adapters = [...INVENTORY_ADAPTERS, reactAdapter, designTokensAdapter] as SourceAdapter[]

describe("Phase 3 exit criterion: a real React library's catalog, APIs, variants, styling and composition, with evidence", () => {
  it("compiles inventory, React and token sources together into valid IR", async () => {
    const result = await compile({ fs: nodeFs(fixture), adapters, clock: FIXED_CLOCK })
    expect(result.ok).toBe(true)
    expect(result.sources.map((s) => s.id).sort()).toEqual([
      "design-tokens-acme-ui",
      "npm-acme-ui",
      "react-acme-ui",
      "tokens-acme-ui"
    ])
    expect(result.irDocuments.filter((d) => d.completeness === "failed")).toEqual([])
  })

  it("links styling references to token definitions, and exposes the ones with no definition", async () => {
    const result = await compile({ fs: nodeFs(fixture), adapters, clock: FIXED_CLOCK })
    const react = result.irDocuments.find((d) => d.source.type === "react")
    const tokens = result.irDocuments.find((d) => d.source.adapter.name === "design-tokens")
    const referenced = new Set(
      react?.facts.filter((f) => f.path === "styling.cssVariables").flatMap((f) => f.value as string[])
    )
    const defined = new Set(
      tokens?.facts.filter((f) => f.path === "extensions.css.name").map((f) => f.value as string)
    )
    expect([...referenced].filter((name) => !defined.has(name)).sort()).toEqual(["--space-lg"])
    expect([...referenced].filter((name) => defined.has(name)).sort()).toEqual([
      "--color-action",
      "--color-brand",
      "--space-md"
    ])
  })

  it("extracts tokens with theme modes and DTCG values alongside the components", async () => {
    const result = await compile({ fs: nodeFs(fixture), adapters, clock: FIXED_CLOCK })
    const tokens = result.irDocuments.find((d) => d.source.adapter.name === "design-tokens")
    const by = (name: string) => {
      const ref = tokens?.entities.find((e) => e.name === name)?.ref
      return Object.fromEntries(
        (tokens?.facts ?? []).filter((f) => f.subject === ref).map((f) => [f.path, f.value])
      )
    }
    expect(by("color-brand")).toMatchObject({ "value.value": "#0057ff", "modes.dark.value": "#4d8dff" })
    expect(by("color-action")).toMatchObject({ "value.aliasOf": "color-brand" })
    expect(by("color.brand")).toMatchObject({ "value.value": "#0057ff", "extensions.dtcg.type": "color" })
  })

  it("is reproducible across runs", async () => {
    expect(await checkCompileDeterminism({ fs: nodeFs(fixture), adapters })).toEqual([])
  })

  it("matches the committed golden artifacts", async () => {
    const result = await compile({ fs: nodeFs(fixture), adapters, clock: FIXED_CLOCK })
    const artifacts = renderArtifacts(toArtifactEntries(result), {
      tool: { name: "invariant", version: "0.0.0" },
      generatedAt: FIXED_CLOCK(),
      sources: result.sources
    })
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(expectedDir)) {
      rmSync(expectedDir, { recursive: true, force: true })
      for (const a of artifacts) {
        mkdirSync(dirname(join(expectedDir, a.path)), { recursive: true })
        writeFileSync(join(expectedDir, a.path), a.text)
      }
    }
    const onDisk = (dir: string, prefix = ""): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? onDisk(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]
      )
    expect(onDisk(expectedDir).sort()).toEqual(artifacts.map((a) => a.path).sort())
    for (const a of artifacts) expect(readFileSync(join(expectedDir, a.path), "utf8")).toBe(a.text)
  })
})
