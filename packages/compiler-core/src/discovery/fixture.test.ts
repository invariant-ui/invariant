import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { beforeAll, describe, expect, it } from "vitest"
import { nodeFs } from "../fs.js"
import { discoveryJsonSchemas } from "../json-schema.js"
import { discoverProject, type ProjectDiscovery } from "./index.js"

type AjvInstance = { compile(schema: object): ((data: unknown) => boolean) & { errors?: unknown } }
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as new (options: object) => AjvInstance
const fixtureRoot = fileURLToPath(new URL("../../../../fixtures/monorepo/acme", import.meta.url))

let project: ProjectDiscovery
beforeAll(async () => {
  project = await discoverProject({ fs: nodeFs(fixtureRoot) })
})

describe("Acme monorepo fixture (React + Vue + Angular + tokens + Storybook + docs)", () => {
  it("detects the workspace, package manager and excludes negated packages", () => {
    expect(project.packageManager).toMatchObject({ name: "pnpm", version: "10.0.0" })
    expect(project.workspaces).toEqual({
      kind: "pnpm-workspace",
      patterns: ["packages/*", "apps/*", "!packages/legacy"],
      source: "pnpm-workspace.yaml"
    })
    expect(project.packages.map((p) => p.name)).toEqual([
      "acme-design-system",
      "@acme/docs",
      "@acme/tokens",
      "@acme/ui-angular",
      "@acme/ui-react",
      "@acme/ui-vue"
    ])
  })

  it("identifies each framework, its declared range, and build tools", () => {
    const fw = Object.fromEntries(
      project.packages.map((p) => [p.name, p.frameworks.map((f) => `${f.name}@${f.declaredRange}`)])
    )
    expect(fw["@acme/ui-react"]).toEqual(["react@^18.2.0"])
    expect(fw["@acme/ui-vue"]).toEqual(["vue@^3.4.0"])
    expect(fw["@acme/ui-angular"]).toEqual(["angular@^18.0.0"])
    const tools = Object.fromEntries(project.packages.map((p) => [p.name, p.buildTools.map((t) => t.name)]))
    expect(tools["@acme/ui-react"]).toEqual(["typescript", "vite"])
    expect(tools["@acme/ui-angular"]).toEqual(["angular-cli", "ng-packagr", "typescript"])
    expect(tools["acme-design-system"]).toEqual(["turbo", "typescript"])
  })

  it("resolves entry points three different ways and enumerates exports without deciding what is a component", () => {
    const entries = (name: string) => project.packages.find((p) => p.name === name)?.entryPoints ?? []
    const react = entries("@acme/ui-react")
    expect(react.map((e) => [e.subpath, e.resolution, e.file])).toEqual([
      [".", "mapped", "packages/ui-react/src/index.ts"],
      ["./button", "mapped", "packages/ui-react/src/button.ts"]
    ])
    expect(react[0]?.exports.map((x) => `${x.name}:${x.kind}`)).toEqual([
      "AcmeIcon:value",
      "Button:value",
      "ButtonProps:type",
      "VERSION:value",
      "default:default",
      "useMedia:value",
      "useTheme:value"
    ])
    expect(entries("@acme/ui-vue")[0]).toMatchObject({ resolution: "declared", exportsComplete: true })
    expect(entries("@acme/ui-vue")[0]?.exports.map((x) => `${x.name}:${x.kind}`)).toEqual([
      "Button:default",
      "Icon:default",
      "useToggle:value"
    ])
    expect(entries("@acme/ui-angular")[0]).toMatchObject({
      resolution: "conventional",
      file: "packages/ui-angular/src/public-api.ts"
    })
    expect(entries("@acme/ui-angular")[0]?.exports.map((x) => x.name)).toEqual(["AcmeButton"])
  })

  it("parses the Storybook config without executing it, flagging the dynamic property", () => {
    expect(project.storybooks).toHaveLength(1)
    expect(project.storybooks[0]).toMatchObject({
      package: "package:@acme/ui-react",
      framework: "@storybook/react-vite",
      addons: ["@storybook/addon-a11y", "@storybook/addon-essentials"],
      dynamicProperties: ["viteFinal"],
      storyFiles: ["packages/ui-react/src/Button.mdx", "packages/ui-react/src/Button.stories.tsx"]
    })
  })

  it("finds CSS variables with scopes and aliases, JSON tokens, and docs", () => {
    const css = project.tokenFiles.find((f) => f.path === "packages/tokens/src/tokens.css")
    expect(css?.cssVariables?.map((v) => `${v.name}@${v.scope}`)).toEqual([
      "--color-brand@:root",
      "--color-action-primary@:root",
      "--space-md@:root",
      "--font-sans@:root",
      "--shadow-card@:root",
      '--color-brand@[data-theme="dark"]',
      "--color-brand@@media (prefers-color-scheme: dark) :root"
    ])
    expect(css?.cssVariables?.find((v) => v.name === "--color-action-primary")?.aliasOf).toBe("--color-brand")
    expect(project.tokenFiles.map((f) => f.path)).not.toContain("packages/tokens/package.json")
    expect(project.tokenFiles.find((f) => f.path.endsWith("tokens.json"))).toMatchObject({
      format: "dtcg-like",
      tokenCount: 3
    })
    expect(project.docFiles.find((f) => f.path.endsWith("guidelines/buttons.md"))).toMatchObject({
      title: "Button guidelines",
      package: "package:@acme/docs"
    })
    expect(
      project.docFiles.find((f) => f.path.endsWith("getting-started.md"))?.headings.map((h) => h.text)
    ).toEqual(["Getting started", "Usage"])
  })

  it("reports exactly the expected diagnostics (warnings before infos)", () => {
    expect(project.diagnostics.map((d) => d.code)).toEqual([
      "discovery.storybook-dynamic-config",
      "discovery.entry-pattern-unmatched"
    ])
  })

  it("builds a graph with workspace dependencies and Storybook coverage", () => {
    const edges = project.graph.edges.map((e) => `${e.from} -${e.type}-> ${e.to}`)
    expect(edges).toEqual(
      expect.arrayContaining([
        "package:@acme/ui-react -depends-on-> package:@acme/tokens",
        "package:@acme/ui-vue -depends-on-> package:@acme/tokens",
        "package:@acme/docs -depends-on-> package:@acme/ui-react",
        "storybook:packages/ui-react -documents-> package:@acme/ui-react"
      ])
    )
  })

  it("validates against the committed JSON Schema and matches the golden discovery", () => {
    const [name, schema] = Object.entries(discoveryJsonSchemas())[0] ?? []
    if (!name) throw new Error("no schema")
    const schemaPath = fileURLToPath(new URL(`../../schema/${name}`, import.meta.url))
    const expectedSchema = `${JSON.stringify(schema, null, 2)}\n`
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(schemaPath))
      writeFileSync(schemaPath, expectedSchema)
    expect(readFileSync(schemaPath, "utf8")).toBe(expectedSchema)
    const validate = new Ajv2020({ strict: false }).compile(schema as object)
    expect(validate(JSON.parse(JSON.stringify(project))), JSON.stringify(validate.errors)).toBe(true)
  })

  it("is identical when discovered twice, via the real and the in-memory filesystem alike", async () => {
    expect(await discoverProject({ fs: nodeFs(fixtureRoot) })).toEqual(project)
  })
})
