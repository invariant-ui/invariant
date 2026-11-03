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
import { storybookAdapter } from "@invariant/compiler-storybook"
import { reconcileStorybook } from "@invariant/reconciliation"
import { describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("..", import.meta.url))
const fixture = join(root, "fixtures/storybook/acme-ui")
const expectedDir = join(root, "fixtures/storybook/expected")
const adapters = [...INVENTORY_ADAPTERS, reactAdapter, storybookAdapter] as SourceAdapter[]

async function build() {
  const result = await compile({ fs: nodeFs(fixture), adapters, clock: FIXED_CLOCK })
  return { result, reconciliation: reconcileStorybook(result.irDocuments) }
}

describe("Phase 4 exit criterion: stories are connected to their real implementations and used as evidence", () => {
  it("compiles stories next to the React source and links each story group to its component", async () => {
    const { result, reconciliation } = await build()
    expect(result.ok).toBe(true)
    expect(result.sources.map((s) => s.id).sort()).toEqual([
      "docs-acme-ui",
      "npm-acme-ui",
      "react-acme-ui",
      "stories-root",
      "storybook-root",
      "tokens-acme-ui"
    ])
    expect(
      reconciliation.links.map(
        (l) => `${l.group.replace("storybook:src/", "")} -> ${l.component.replace("react:src/", "")}`
      )
    ).toEqual([
      "Button.stories.tsx -> Button.tsx#Button",
      "Card.stories.tsx -> Card.tsx#Card",
      "IconButton.stories.tsx -> IconButton.tsx#IconButton",
      "Modal.stories.tsx -> Modal.tsx#Modal",
      "Select.stories.tsx -> Select.tsx#Select"
    ])
    expect(reconciliation.links.every((l) => l.matchedBy === "file+localName")).toBe(true)
    // Stories that name a component that does not resolve are reported, not silently linked.
    const codes = result.diagnostics.map((d) => d.code)
    expect(codes.filter((c) => c === "storybook.component-unresolved")).toHaveLength(2)
    expect(codes).toContain("storybook.index-stale")
    expect(codes).toContain("storybook.title-auto")
  })

  it("finds exactly the planted Storybook/code discrepancies, each citing both sides", async () => {
    const { reconciliation } = await build()
    const summary = reconciliation.discrepancies.map(
      (d) =>
        `${d.severity} ${d.code.replace("reconcile.storybook.", "")} ${d.component?.split("#")[1] ?? ""}${d.prop ? `.${d.prop}` : ""}`
    )
    expect(summary).toEqual(
      [
        "warning arg-undeclared Card.shadow",
        "warning arg-undeclared Card.shadow",
        "warning arg-value-not-allowed Button.variant",
        "warning arg-value-not-allowed Modal.size",
        "warning control-option-not-allowed Button.variant",
        "warning control-option-not-allowed Modal.size",
        "warning control-undeclared Card.shadow",
        "warning default-mismatch Button.variant",
        "warning default-mismatch Modal.size",
        "warning deprecated-demonstrated Button.plain",
        "warning deprecated-demonstrated Button.plain",
        "info prop-not-demonstrated Button",
        "info prop-not-demonstrated IconButton",
        "info prop-not-demonstrated Select",
        "info unverifiable-names Button"
      ].sort((a, b) =>
        a.startsWith("warning") === b.startsWith("warning") ? 0 : a.startsWith("warning") ? -1 : 1
      ) as string[]
    )
    const arg = reconciliation.discrepancies.find(
      (d) => d.code.endsWith("arg-value-not-allowed") && d.prop === "variant"
    )
    expect(arg?.storybookEvidence.length).toBeGreaterThan(0)
    expect(arg?.codeEvidence.length).toBeGreaterThan(0)
    expect(arg?.location).toMatchObject({ path: "src/Button.stories.tsx" })
  })

  it("does not misreport what must not be flagged", async () => {
    const { reconciliation } = await build()
    const messages = reconciliation.discrepancies.map((d) => d.message).join("\n")
    // `icon: "gear"` is a mapping key; `size` options come from a const array that matches the type.
    expect(messages).not.toContain('"gear"')
    expect(
      reconciliation.discrepancies.some((d) => d.prop === "size" && d.component?.endsWith("Button"))
    ).toBe(false)
    // Button inherits props from a type that was not enumerated, so no undeclared-prop claim is made against it.
    expect(
      reconciliation.discrepancies.some(
        (d) => d.code.endsWith("arg-undeclared") && d.component?.endsWith("Button")
      )
    ).toBe(false)
  })

  it("keeps stories as evidence: composition, play structure, authored docs, MDX links", async () => {
    const { result } = await build()
    const ir = result.irDocuments.find((d) => d.source.id === "stories-root")
    const fact = (subject: string, path: string) =>
      ir?.facts.find((f) => f.subject === subject && f.path === path)
    expect(fact("storybook:src/Card.stories.tsx#Basic", "story.composes")?.value).toEqual([
      { file: "src/Card.tsx", name: "Card", count: 1 },
      { file: "src/Card.tsx", name: "CardBody", count: 1 },
      { file: "src/Card.tsx", name: "CardHeader", count: 1 }
    ])
    expect(fact("storybook:src/Button.stories.tsx#WithIcon", "story.play.steps")?.value).toEqual([
      "press the button"
    ])
    expect(fact("storybook:src/Button.stories.tsx#Primary", "story.description")).toMatchObject({
      value: "The default call to action.",
      origin: "authored"
    })
    expect(fact("storybook:src/Button.mdx", "doc.meta.of")?.value).toEqual({
      identifier: "ButtonStories",
      file: "src/Button.stories.tsx"
    })
    expect(fact("storybook:src/Button.stories.tsx", "group.excludedExports")?.value).toEqual(["HiddenHelper"])
    expect(fact("storybook:src/Select.stories.tsx#Basic", "story.name")?.value).toBe("Basic select")
    expect(ir?.facts.some((f) => f.path === "story.id")).toBe(false)
  })

  it("is reproducible across runs", async () => {
    expect(await checkCompileDeterminism({ fs: nodeFs(fixture), adapters })).toEqual([])
    const a = await build()
    const b = await build()
    expect(b.reconciliation).toEqual(a.reconciliation)
  })

  it("matches the committed golden artifacts", async () => {
    const { result, reconciliation } = await build()
    const entries = [
      ...toArtifactEntries(result),
      { path: "invariant.reconciliation.json", value: reconciliation as never }
    ]
    const artifacts = renderArtifacts(entries, {
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
