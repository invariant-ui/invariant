import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { renderArtifacts } from "@invariant/artifact-generator"
import { angularAdapter } from "@invariant/compiler-angular"
import { compile, memoryFs, nodeFs, type SourceAdapter, toArtifactEntries } from "@invariant/compiler-core"
import { checkCompileDeterminism, FIXED_CLOCK } from "@invariant/compiler-core/testing"
import type { IrDocument } from "@invariant/compiler-ir"
import { reactAdapter } from "@invariant/compiler-react"
import { storybookAdapter } from "@invariant/compiler-storybook"
import { vueAdapter } from "@invariant/compiler-vue"
import { reconcileStorybook } from "@invariant/reconciliation"
import { describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("..", import.meta.url))
const fixture = join(root, "fixtures/cross-framework/demo")
const expectedDir = join(root, "fixtures/cross-framework/expected")
const adapters = [reactAdapter, angularAdapter, vueAdapter] as SourceAdapter[]
const FRAMEWORKS = ["react", "angular", "vue"] as const

async function build() {
  return compile({ fs: nodeFs(fixture), adapters, clock: FIXED_CLOCK })
}

const factsOf = (doc: IrDocument): Record<string, unknown> => {
  const ref = doc.entities.find((e) => e.kind === "component")?.ref
  return Object.fromEntries(doc.facts.filter((f) => f.subject === ref).map((f) => [f.path, f.value]))
}

describe("Phase 6 exit criterion: equivalent components in React, Angular and Vue are represented consistently", () => {
  it("compiles one conceptual Button from each framework, completely and without errors", async () => {
    const result = await build()
    expect(result.ok).toBe(true)
    expect(result.irDocuments.map((d) => [d.source.type, d.completeness]).sort()).toEqual([
      ["angular", "complete"],
      ["react", "complete"],
      ["vue", "complete"]
    ])
  })

  it("uses identical neutral facts for the same props, variants, slots, accessibility and styling", async () => {
    const result = await build()
    const by = Object.fromEntries(result.irDocuments.map((d) => [d.source.type, factsOf(d)]))
    const tuple = (fw: string, prop: string) => [
      by[fw]?.[`props.${prop}.type.kind`],
      by[fw]?.[`props.${prop}.required`],
      by[fw]?.[`props.${prop}.default`],
      by[fw]?.[`props.${prop}.allowedValues`]
    ]
    for (const fw of FRAMEWORKS) {
      expect(tuple(fw, "variant")).toEqual(["enum", false, "primary", ["primary", "secondary", "ghost"]])
      expect(tuple(fw, "size")).toEqual(["enum", false, "md", ["sm", "md", "lg"]])
      expect(tuple(fw, "disabled")).toEqual(["boolean", false, false, undefined])
      expect(tuple(fw, "label")).toEqual(["string", true, undefined, undefined])
      expect(by[fw]?.["variants.variant.values"]).toEqual(["primary", "secondary", "ghost"])
      expect(by[fw]?.["variants.variant.default"]).toBe("primary")
      expect(by[fw]?.["variants.size.values"]).toEqual(["sm", "md", "lg"])
      expect(by[fw]?.["slots.default.declared"]).toBe(true)
      expect(by[fw]?.["slots.icon.declared"]).toBe(true)
      expect(by[fw]?.["accessibility.role"]).toBe("button")
      expect(by[fw]?.["styling.cssVariables"]).toEqual(["--color-action"])
    }
  })

  it("maps events as the frameworks allow, and keeps the difference explicit", async () => {
    const result = await build()
    const by = Object.fromEntries(result.irDocuments.map((d) => [d.source.type, factsOf(d)]))
    // Angular outputs and Vue emits are events; the payload carries the type.
    expect(String(by.angular?.["events.press.payload.text"])).toContain("MouseEvent")
    expect(String(by.vue?.["events.press.payload.text"])).toContain("MouseEvent")
    expect(by.angular?.["events.press.extensions.angular.kind"]).toBe("signal-output")
    expect(by.vue?.["events.press.extensions.vue.kind"]).toBe("emit")
    // React has no event declaration: a handler is an ordinary prop, labelled as such.
    expect(Object.keys(by.react ?? {}).some((k) => k.startsWith("events."))).toBe(false)
    expect(by.react?.["props.onPress.extensions.react.role"]).toBe("event-handler")
  })

  it("keeps framework-specific detail out of the neutral model", async () => {
    const result = await build()
    for (const doc of result.irDocuments) {
      for (const fact of doc.facts) {
        const segments = fact.path.split(".")
        if (!segments.some((s) => (FRAMEWORKS as readonly string[]).includes(s))) continue
        expect(fact.path).toMatch(
          /^implementations\.(react|angular|vue)\.|\.extensions\.(react|angular|vue)\./
        )
      }
    }
  })

  it("publishes the same link key in every framework", async () => {
    const result = await build()
    const expected = {
      react: ["packages/react-ui/src/Button.tsx", "Button"],
      angular: ["packages/angular-ui/src/lib/button.component.ts", "DemoButton"],
      vue: ["packages/vue-ui/src/Button.vue", "Button"]
    }
    for (const doc of result.irDocuments) {
      const fw = doc.source.type as (typeof FRAMEWORKS)[number]
      const f = factsOf(doc)
      expect([
        f[`implementations.${fw}.extensions.${fw}.file`],
        f[`implementations.${fw}.extensions.${fw}.localName`]
      ]).toEqual(expected[fw])
      expect(f[`implementations.${fw}.framework`]).toBe(fw)
    }
  })

  it("is reproducible across runs", async () => {
    expect(await checkCompileDeterminism({ fs: nodeFs(fixture), adapters })).toEqual([])
  })

  it("matches the committed golden artifacts", async () => {
    const result = await build()
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

describe("Storybook reconciliation is framework-neutral", () => {
  const config = `export default { stories: ["../src/**/*.stories.@(ts|tsx)"] }`
  const story = (component: string, importLine: string) =>
    `${importLine}\nexport default { title: "B", component: ${component} }\nexport const Danger = { args: { variant: "danger" } }\nexport const Fine = { args: { variant: "ghost" } }`

  async function reconcile(files: Record<string, string>, adapter: SourceAdapter) {
    const result = await compile({
      fs: memoryFs(files),
      adapters: [adapter, storybookAdapter as SourceAdapter],
      clock: FIXED_CLOCK
    })
    return { result, rec: reconcileStorybook(result.irDocuments) }
  }

  it("links a Vue single-file component by file and PascalCase name and checks its stories", async () => {
    const { rec } = await reconcile(
      {
        "package.json": JSON.stringify({
          name: "v",
          version: "1.0.0",
          exports: "./src/index.ts",
          peerDependencies: { vue: "^3.5" },
          devDependencies: { storybook: "^8" }
        }),
        "src/index.ts": `export { default as Button } from "./Button.vue"`,
        "src/Button.vue": `<script setup lang="ts">\ndefineProps<{ variant?: "primary" | "ghost" }>()\n</script>\n<template><button /></template>`,
        ".storybook/main.ts": config,
        "src/Button.stories.ts": story("Button", `import Button from "./Button.vue"`)
      },
      vueAdapter as SourceAdapter
    )
    expect(rec.links.map((l) => [l.component, l.matchedBy])).toEqual([
      ["vue:src/Button.vue#Button", "file+localName"]
    ])
    const bad = rec.discrepancies.filter((d) => d.code.endsWith("arg-value-not-allowed"))
    expect(bad.map((d) => [d.entityId, d.prop])).toEqual([
      ["storybook:src/Button.stories.ts#Danger", "variant"]
    ])
  })

  it("links an Angular component class and checks its stories", async () => {
    const { rec } = await reconcile(
      {
        "package.json": JSON.stringify({
          name: "a",
          version: "1.0.0",
          peerDependencies: { "@angular/core": "^18" },
          devDependencies: { storybook: "^8" }
        }),
        "src/public-api.ts": `export * from "./lib/button.component"`,
        "src/lib/button.component.ts": `import { Component, input } from "@angular/core"\n@Component({ selector: "x-b", standalone: true, template: "" })\nexport class XButton { variant = input<"primary" | "ghost">("primary") }`,
        ".storybook/main.ts": config,
        "src/Button.stories.ts": story("XButton", `import { XButton } from "./lib/button.component"`)
      },
      angularAdapter as SourceAdapter
    )
    expect(rec.links.map((l) => l.component)).toEqual(["angular:src/lib/button.component.ts#XButton"])
    expect(
      rec.discrepancies.filter((d) => d.code.endsWith("arg-value-not-allowed")).map((d) => d.prop)
    ).toEqual(["variant"])
  })
})
