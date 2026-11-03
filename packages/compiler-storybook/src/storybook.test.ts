import { compile, createAnalysis, evaluate, memoryFs, type SourceAdapter } from "@invariant/compiler-core"
import {
  checkAdapterConformance,
  checkCompileDeterminism,
  FIXED_CLOCK
} from "@invariant/compiler-core/testing"
import { verifyIrDocument } from "@invariant/compiler-ir"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import { extractCsf, parseBuiltIndex, parseMdx, storybookAdapter } from "./index.js"

const adapter = storybookAdapter as SourceAdapter

function program(files: Record<string, string>, paths?: Record<string, string[]>) {
  return createAnalysis(new Map(Object.entries(files)), paths ? { paths } : {})
}

function evalOf(code: string) {
  const analysis = program({ "a.tsx": code })
  const sf = analysis.sourceFile("a.tsx") as ts.SourceFile
  let init: ts.Expression | undefined
  sf.forEachChild((n) => {
    if (ts.isVariableStatement(n))
      for (const d of n.declarationList.declarations) if (d.name.getText() === "x") init = d.initializer
  })
  return evaluate(analysis.checker, init as ts.Expression)
}

describe("static evaluator", () => {
  it("resolves literals, nested objects, arrays, negative numbers and const identifiers", () => {
    const r = evalOf(
      `const base = { a: 1 }\nconst x = { s: "t", n: -2, b: true, z: null, arr: [1, "x"], nested: { deep: base } }`
    )
    expect(r.value).toEqual({ s: "t", n: -2, b: true, z: null, arr: [1, "x"], nested: { deep: { a: 1 } } })
    expect(r.unresolved).toEqual([])
  })

  it("lists what it cannot resolve instead of guessing, with key paths", () => {
    const r = evalOf(
      `const x = { ok: 1, fn: () => 1, jsx: <div />, tpl: \`a\${b}\`, call: make(), nested: { bad: other, good: 2 } }
declare const b: string
declare const other: unknown
declare function make(): number`
    )
    expect(r.value).toEqual({ ok: 1, nested: { good: 2 } })
    expect(r.unresolved.sort()).toEqual(["call", "fn", "jsx", "nested.bad", "tpl"])
  })

  it("does not trust an array with an unresolvable element", () => {
    const r = evalOf("const x = { list: [1, compute()] }\ndeclare function compute(): number")
    expect(r.value).toEqual({})
    expect(r.unresolved).toEqual(["list"])
  })

  it("records spies from fn() and action() as unresolved with a spy marker", () => {
    const r = evalOf(
      `const x = { onClick: fn(), onHover: action("hover"), label: "x" }\ndeclare function fn(): void\ndeclare function action(n: string): void`
    )
    expect(r.value).toEqual({ label: "x" })
    expect(r.spies.sort()).toEqual(["onClick", "onHover"])
  })

  it("merges spreads of resolvable objects, flags unresolvable spreads, and lists keys with undefined values", () => {
    const r = evalOf(
      `const shared = { a: 1, b: 2 }\nconst x = { ...shared, b: 3, gone: undefined, ...dynamic() }\ndeclare function dynamic(): object`
    )
    expect(r.value).toEqual({ a: 1, b: 3 })
    expect(r.unresolved).toContain("...")
    expect(r.keys).toEqual(["a", "b", "gone"])
  })

  it("lets a later spread override an earlier key, and a later key override a spread", () => {
    expect(
      evalOf(`const base = { a: "spread", b: "spread" }\nconst x = { a: "own", ...base, b: "own" }`).value
    ).toEqual({ a: "spread", b: "own" })
  })

  it("follows property access into resolvable objects and gives up on cycles", () => {
    expect(evalOf(`const story = { args: { v: "x" } }\nconst x = story.args`).value).toEqual({ v: "x" })
    expect(evalOf("const x = x2\nconst x2 = x").unresolved.length).toBeGreaterThan(0)
  })
})

describe("CSF extraction", () => {
  const csf = (files: Record<string, string>, file = "a.stories.tsx", paths?: Record<string, string[]>) => {
    const analysis = program(files, paths)
    return extractCsf(analysis, analysis.sourceFile(file) as ts.SourceFile)
  }
  const Button = `export const Button = (p: { size?: "sm" | "lg"; label?: string }) => <button />`

  it("reads meta in every common shape and resolves the component to a file and declaration", () => {
    const shapes = [
      `export default { title: "T", component: Button }`,
      `const meta = { title: "T", component: Button }\nexport default meta`,
      `export default { title: "T", component: Button } satisfies Meta`,
      `const meta: Meta<typeof Button> = { title: "T", component: Button }\nexport default meta`,
      `export default ({ title: "T", component: Button } as Meta)`
    ]
    for (const shape of shapes) {
      const file = csf({
        "Button.tsx": Button,
        "a.stories.tsx": `import { Button } from "./Button"\ndeclare type Meta<T = unknown> = object\n${shape}\nexport const A = {}`
      })
      expect(file?.group?.title).toBe("T")
      expect(file?.group?.component).toMatchObject({ file: "Button.tsx", name: "Button", via: "component" })
    }
  })

  it("falls back to Meta<typeof X> when meta has no component", () => {
    const file = csf({
      "Button.tsx": Button,
      "a.stories.tsx": `import { Button } from "./Button"\ndeclare type Meta<T> = object\nexport default { title: "T" } satisfies Meta<typeof Button>\nexport const A = {}`
    })
    expect(file?.group?.component).toMatchObject({ file: "Button.tsx", name: "Button", via: "type-argument" })
  })

  it("resolves through barrels and compound children, and reports external and missing modules", () => {
    const barrel = csf({
      "ui/index.ts": `export { Card } from "./Card"`,
      "ui/Card.tsx": `function CardRoot() { return <div /> }\nfunction CardHeader() { return <i /> }\nexport const Card = Object.assign(CardRoot, { Header: CardHeader })`,
      "a.stories.tsx": `import { Card } from "./ui"\nexport default { component: Card }\nexport const A = {}`
    })
    expect(barrel?.group?.component).toMatchObject({ file: "ui/Card.tsx", name: "Card" })
    const child = csf({
      "ui/Card.tsx": `function CardRoot() { return <div /> }\nfunction CardHeader() { return <i /> }\nexport const Card = Object.assign(CardRoot, { Header: CardHeader })`,
      "a.stories.tsx": `import { Card } from "./ui/Card"\nexport default { component: Card.Header }\nexport const A = {}`
    })
    expect(child?.group?.component).toMatchObject({ file: "ui/Card.tsx", name: "CardHeader" })
    expect(
      csf({
        "a.stories.tsx": `import { X } from "antd"\nexport default { component: X }\nexport const A = {}`
      })?.group?.component
    ).toEqual({ text: "X", via: "component", external: "antd" })
    expect(
      csf({
        "a.stories.tsx": `import { X } from "./Missing"\nexport default { component: X }\nexport const A = {}`
      })?.group?.component
    ).toEqual({ text: "X", via: "component", unresolvedModule: "./Missing" })
  })

  it("resolves workspace package imports through the supplied path map", () => {
    const file = csf(
      {
        "packages/ui/src/index.ts": `export { Button } from "./Button"`,
        "packages/ui/src/Button.tsx": Button,
        "apps/sb/a.stories.tsx": `import { Button } from "@x/ui"\nexport default { component: Button }\nexport const A = {}`
      },
      "apps/sb/a.stories.tsx",
      { "@x/ui": ["packages/ui/src/index.ts"] }
    )
    expect(file?.group?.component).toMatchObject({ file: "packages/ui/src/Button.tsx", name: "Button" })
  })

  it("recognizes object, function, template-bind and function-declaration stories, and ignores type exports and __namedExportsOrder", () => {
    const file = csf({
      "a.stories.tsx": `
        export default { title: "T" }
        export const Obj = { args: {} }
        export const Fn = () => <div />
        const Template = (a: object) => <div />
        export const Bound = Template.bind({})
        export function Decl() { return <div /> }
        export type Props = { a: 1 }
        export const __namedExportsOrder = ["Obj"]
      `
    })
    expect(file?.stories.map((s) => [s.exportName, s.shape])).toEqual([
      ["Obj", "object"],
      ["Fn", "function"],
      ["Bound", "template"],
      ["Decl", "function"]
    ])
  })

  it("honors includeStories and excludeStories as regex, string and array, and flags what it cannot evaluate", () => {
    const run = (selection: string) =>
      csf({
        "a.stories.tsx": `export default { ${selection} }\nexport const A = {}\nexport const B = {}\nexport const HiddenC = {}`
      })
    expect(run("excludeStories: /^Hidden/")?.stories.map((s) => s.exportName)).toEqual(["A", "B"])
    expect(run('includeStories: ["A"]')?.stories.map((s) => s.exportName)).toEqual(["A"])
    expect(run("includeStories: /^[AB]$/, excludeStories: ['B']")?.stories.map((s) => s.exportName)).toEqual([
      "A"
    ])
    const uncertain = run("excludeStories: computeList()")
    expect(uncertain?.selectionUncertain).toBe(true)
    expect(uncertain?.stories).toHaveLength(3)
  })

  it("reads args, merging spreads of other stories and shared objects, with unresolved names and spies", () => {
    const file = csf({
      "shared.ts": `export const base = { label: "L", size: "sm" }`,
      "a.stories.tsx": `
        import { base } from "./shared"
        export default { args: { onClick: fn(), kind: "meta" } }
        export const A = { args: { ...base, size: "lg", render: () => 1 } }
        export const B = { args: { ...A.args, label: "B" } }
        declare function fn(): void
      `
    })
    const [a, b] = file?.stories ?? []
    expect(a?.args.value).toEqual({ label: "L", size: "lg" })
    expect(a?.args.unresolved).toEqual(["render"])
    expect(b?.args.value).toEqual({ label: "B", size: "lg" })
    expect(file?.group?.args.value).toEqual({ kind: "meta" })
    expect(file?.group?.args.spies).toEqual(["onClick"])
  })

  it("reads argTypes: control forms, options, descriptions, defaults, hidden rows and mapping keys", () => {
    const file = csf({
      "a.stories.tsx": `
        const sizes = ["s", "m"] as const
        export default {
          argTypes: {
            a: { control: "select", options: ["x", "y"], description: "D", table: { defaultValue: { summary: "x" }, category: "Cat" } },
            b: { control: { type: "radio" }, options: sizes },
            c: { control: false, table: { disable: true } },
            d: { options: Object.keys(sizes) },
            e: { mapping: { one: 1, two: undefined, three: <i /> }, options: ["one", "two", "three"] },
            f: { action: "clicked" }
          }
        }
        export const A = {}
      `
    })
    const t = file?.group?.argTypes ?? {}
    expect(t.a).toEqual({
      control: "select",
      options: ["x", "y"],
      description: "D",
      defaultSummary: "x",
      category: "Cat"
    })
    expect(t.b).toEqual({ control: "radio", options: ["s", "m"] })
    expect(t.c).toEqual({ control: false, hidden: true })
    expect(t.d?.optionsUnresolved).toBe(true)
    expect(t.d?.options).toBeUndefined()
    expect(t.e?.mappingKeys).toEqual(["one", "three", "two"])
    expect(t.f).toEqual({ action: "clicked" })
  })

  it("reads parameters, tags, play structure, JSDoc, docs descriptions and composed components", () => {
    const file = csf({
      "ui.tsx": `export const Card = () => <div />\nexport const Title = () => <h1 />`,
      "a.stories.tsx": `
        import { Card, Title } from "./ui"
        export default { tags: ["autodocs"], parameters: { layout: "centered", a11y: { disable: true }, docs: { description: { component: "Group doc" } }, other: 1 } }
        /** JSDoc description. */
        export const A = {
          tags: ["!dev"],
          render: () => <Card><Title /><Title /></Card>,
          play: async ({ step }) => {
            await step("first", async () => { await userEvent.click(x) })
            await expect(y).toBeTruthy()
          }
        }
        export const B = { parameters: { docs: { description: { story: "From parameters" } } } }
        declare const userEvent: any, x: any, expect: any, y: any
      `
    })
    expect(file?.group?.parameters).toMatchObject({
      layout: "centered",
      a11y: { disable: true },
      docsDescription: { component: "Group doc" },
      keys: ["a11y", "docs", "layout", "other"]
    })
    expect(file?.group?.tags).toEqual(["autodocs"])
    const [a, b] = file?.stories ?? []
    expect(a?.description).toBe("JSDoc description.")
    expect(a?.tags).toEqual(["!dev"])
    expect(a?.play).toEqual({
      calls: ["expect", "expect().toBeTruthy", "step", "userEvent.click"],
      steps: ["first"]
    })
    expect(a?.composes).toEqual([
      { file: "ui.tsx", name: "Card", count: 1 },
      { file: "ui.tsx", name: "Title", count: 2 }
    ])
    expect(b?.description).toBe("From parameters")
  })

  it("reads CSF 2 assignment-style annotations", () => {
    const file = csf({
      "a.stories.tsx": `
        export default { title: "T" }
        const Template = (a: object) => <div />
        export const Basic = Template.bind({})
        Basic.args = { n: 1 }
        Basic.storyName = "A basic one"
        Basic.parameters = { layout: "fullscreen" }
        Basic.play = async () => { await run() }
        declare function run(): Promise<void>
      `
    })
    const story = file?.stories[0]
    expect(story?.name).toBe("A basic one")
    expect(story?.args.value).toEqual({ n: 1 })
    expect(story?.parameters.layout).toBe("fullscreen")
    expect(story?.play?.calls).toEqual(["run"])
  })

  it("returns nothing for a file that is not a module", () => {
    expect(csf({ "a.stories.tsx": `const x = 1` })).toBeUndefined()
  })
})

describe("MDX pages", () => {
  const files = new Set(["src/Button.stories.tsx", "src/Other.stories.ts"])
  const mdx = `import { Meta, Canvas, Controls } from "@storybook/blocks"
import * as ButtonStories from "./Button.stories"
import { Alt } from "./Other.stories"

<Meta of={ButtonStories} />

# Title here

Intro paragraph.

\`\`\`tsx
# not a heading
<Canvas of={Fake.Story} />
\`\`\`

## Section

<Canvas of={ButtonStories.Primary} />
<Story of={Alt.Special} />
<Source of={Unknown.X} />
`

  it("records meta binding, blocks, referenced stories and the prose outline, ignoring fenced code", () => {
    const doc = parseMdx("src/Button.mdx", mdx, files)
    expect(doc.metaOf).toEqual({ identifier: "ButtonStories", file: "src/Button.stories.tsx", line: 5 })
    expect(doc.blocks).toEqual(["Canvas", "Meta", "Source", "Story"])
    expect(doc.storyRefs).toEqual([
      { block: "Canvas", exportName: "Primary", file: "src/Button.stories.tsx", line: 18 },
      { block: "Story", exportName: "Special", file: "src/Other.stories.ts", line: 19 },
      { block: "Source", exportName: "X", line: 20 }
    ])
    expect(doc.sections.map((s) => [s.heading, s.level, s.text])).toEqual([
      ["Title here", 1, "Intro paragraph."],
      ["Section", 2, ""]
    ])
    expect(doc.title).toBe("Title here")
  })

  it("prefers an explicit Meta title", () => {
    const doc = parseMdx("a.mdx", `<Meta title="Docs/Intro" />\n# Heading`, new Set())
    expect(doc.metaTitle).toBe("Docs/Intro")
    expect(doc.title).toBe("Docs/Intro")
  })
})

describe("built index", () => {
  it("reads the entries format, the older stories format, and tolerates junk", () => {
    const entries = parseBuiltIndex(
      JSON.stringify({
        v: 5,
        entries: {
          b: { id: "b", type: "docs", importPath: "./b.mdx" },
          a: { id: "a", type: "story", title: "T", name: "N", importPath: "./a.stories.ts", tags: ["x", 1] },
          bad: { id: "c" },
          worse: 3
        }
      })
    )
    expect(entries?.format).toBe("entries")
    expect(entries?.entries.map((e) => [e.id, e.type, e.tags])).toEqual([
      ["a", "story", ["x"]],
      ["b", "docs", []]
    ])
    expect(
      parseBuiltIndex(JSON.stringify({ stories: { s: { id: "s", importPath: "./s.stories.ts" } } }))?.format
    ).toBe("stories")
    expect(parseBuiltIndex("not json")).toBeUndefined()
    expect(parseBuiltIndex("{}")).toBeUndefined()
  })
})

describe("adapter", () => {
  const config = `export default { stories: ["../src/**/*.stories.@(ts|tsx)", "../src/**/*.mdx"] }`
  const base = {
    "package.json": '{"name":"app","version":"1.0.0","devDependencies":{"storybook":"^8"}}',
    ".storybook/main.ts": config
  }
  const run = async (files: Record<string, string>) => {
    const result = await compile({
      fs: memoryFs({ ...base, ...files }),
      adapters: [adapter],
      clock: FIXED_CLOCK
    })
    return { result, ir: result.irDocuments[0], codes: result.diagnostics.map((d) => d.code) }
  }
  const facts = (ir: Awaited<ReturnType<typeof run>>["ir"], ref: string) =>
    Object.fromEntries((ir?.facts ?? []).filter((f) => f.subject === ref).map((f) => [f.path, f.value]))

  it("emits groups, stories and doc pages with evidence and no synthesized identity", async () => {
    const { ir, result } = await run({
      "src/B.tsx": `export const B = () => <button />`,
      "src/B.stories.tsx": `import { B } from "./B"\nexport default { title: "Comp/B", component: B }\nexport const Primary = { args: { x: 1 } }`,
      "src/B.mdx": `<Meta title="Docs/B" />\n# B docs`
    })
    expect(result.ok).toBe(true)
    expect(ir?.source).toMatchObject({ type: "storybook", id: "stories-root" })
    expect(ir?.entities.map((e) => `${e.kind}:${e.ref}`).sort()).toEqual([
      "doc-page:storybook:src/B.mdx",
      "story-group:storybook:src/B.stories.tsx",
      "story:storybook:src/B.stories.tsx#Primary"
    ])
    const story = facts(ir, "storybook:src/B.stories.tsx#Primary")
    expect(story["story.exportName"]).toBe("Primary")
    expect(Object.keys(story).some((k) => k === "story.id")).toBe(false)
    const ids = new Set(ir?.evidence.map((e) => e.id))
    expect(ir?.facts.every((f) => f.evidenceIds.length > 0 && f.evidenceIds.every((id) => ids.has(id)))).toBe(
      true
    )
    expect(ir?.evidence.every((e) => e.location.type === "file" && e.location.path.length > 0)).toBe(true)
    expect(verifyIrDocument(ir as never)).toEqual([])
  })

  it("marks authored prose and keeps structure extracted", async () => {
    const { ir } = await run({
      "src/B.tsx": `export const B = () => <button />`,
      "src/B.stories.tsx": `export default { component: B, argTypes: { x: { description: "Explains x" } }, parameters: { docs: { description: { component: "Group" } } } }\nimport { B } from "./B"\n/** Story doc */\nexport const S = {}`
    })
    const origin = (path: string) => ir?.facts.find((f) => f.path === path)?.origin
    expect(origin("group.argTypes.x.description")).toBe("authored")
    expect(origin("group.docs.description")).toBe("authored")
    expect(origin("story.description")).toBe("authored")
    expect(origin("group.component")).toBe("extracted")
  })

  it("reports missing metas, automatic titles, unresolved components, dynamic args and stale built indexes", async () => {
    const { codes, ir } = await run({
      "src/A.stories.tsx": `export const OnlyStory = {}`,
      "src/B.stories.tsx": `import { X } from "ext-lib"\nexport default { component: X }\nexport const S = { args: { f: () => 1 } }`,
      "storybook-static/index.json": JSON.stringify({
        entries: { gone: { id: "gone", type: "story", importPath: "./src/Removed.stories.tsx" } }
      })
    })
    expect(codes).toEqual(
      expect.arrayContaining([
        "storybook.no-meta",
        "storybook.title-auto",
        "storybook.component-unresolved",
        "storybook.dynamic-args",
        "storybook.index-stale",
        "storybook.not-in-built-index"
      ])
    )
    expect(ir?.completeness).toBe("complete")
  })

  it("is partial when the Storybook config is dynamic or story selection is uncertain", async () => {
    const dynamic = await compile({
      fs: memoryFs({
        ...base,
        ".storybook/main.ts": `export default { stories: ["../src/*.stories.tsx"], addons: load() }\ndeclare function load(): string[]`,
        "src/A.stories.tsx": `export default {}\nexport const S = {}`
      }),
      adapters: [adapter],
      clock: FIXED_CLOCK
    })
    expect(dynamic.irDocuments[0]?.completeness).toBe("partial")
    const uncertain = await run({
      "src/A.stories.tsx": `export default { excludeStories: pick() }\nexport const S = {}\ndeclare function pick(): string[]`
    })
    expect(uncertain.ir?.completeness).toBe("partial")
  })

  it("emits CSF 2 assignment-style parameters, tags and play without error", async () => {
    const { ir, result } = await run({
      "src/A.stories.tsx": `
        export default { title: "T" }
        const Template = (a: object) => <div />
        export const Basic = Template.bind({})
        Basic.args = { n: 1 }
        Basic.parameters = { layout: "fullscreen", docs: { description: { story: "Doc" } } }
        Basic.tags = ["x"]
        Basic.decorators = [(S: any) => S]
      `
    })
    expect(result.ok).toBe(true)
    const story = facts(ir, "storybook:src/A.stories.tsx#Basic")
    expect(story["story.parameters.layout"]).toBe("fullscreen")
    expect(story["story.tags"]).toEqual(["x"])
    expect(story["story.hasDecorators"]).toBe(true)
    expect(story["story.description"]).toBe("Doc")
    expect(ir?.evidence.every((e) => e.location.type === "file" && (e.location.line ?? 1) > 0)).toBe(true)
  })

  it("never executes story files or the Storybook config", async () => {
    const { ir } = await run({
      "src/A.stories.tsx": `throw new Error("executed")\nprocess.exit(1)\nexport default { title: "T" }\nexport const S = {}`
    })
    expect(ir?.entities.some((e) => e.kind === "story")).toBe(true)
  })

  it("resolves a component imported from a workspace package by name", async () => {
    const files = {
      "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*", "apps/*"] }),
      "packages/ui/package.json": JSON.stringify({ name: "@x/ui", exports: "./src/index.ts" }),
      "packages/ui/src/index.ts": `export { Button } from "./Button"`,
      "packages/ui/src/Button.tsx": `export const Button = () => <button />`,
      "apps/sb/package.json": JSON.stringify({ name: "sb", dependencies: { "@x/ui": "workspace:*" } }),
      "apps/sb/.storybook/main.ts": config,
      "apps/sb/src/a.stories.tsx": `import { Button } from "@x/ui"\nexport default { title: "B", component: Button }\nexport const S = {}`
    }
    const result = await compile({ fs: memoryFs(files), adapters: [adapter], clock: FIXED_CLOCK })
    const ir = result.irDocuments[0]
    expect(facts(ir, "storybook:apps/sb/src/a.stories.tsx")["group.component"]).toMatchObject({
      file: "packages/ui/src/Button.tsx",
      name: "Button"
    })
  })

  it("links a story that imports a single-file component by file and PascalCase name", async () => {
    const { ir } = await run({
      "src/button-group.vue": "<template><div /></template>",
      "src/A.stories.ts": `import Group from "./button-group.vue"\nexport default { title: "G", component: Group }\nexport const S = {}`
    })
    expect(facts(ir, "storybook:src/A.stories.ts")["group.component"]).toEqual({
      text: "Group",
      via: "component",
      file: "src/button-group.vue",
      name: "ButtonGroup"
    })
  })

  it("passes conformance, is deterministic, and attributes IR to the storybook source", async () => {
    const files = {
      ...base,
      "src/B.tsx": `export const B = () => <button />`,
      "src/B.stories.tsx": `import { B } from "./B"\nexport default { title: "B", component: B }\nexport const S = {}`
    }
    expect(await checkAdapterConformance(adapter, { fs: memoryFs(files) })).toEqual([])
    expect(await checkCompileDeterminism({ fs: memoryFs(files), adapters: [adapter] })).toEqual([])
  })
})
