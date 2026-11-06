import { describe, expect, it } from "vitest"
import { memoryFs } from "../fs.js"
import {
  type DiscoverOptions,
  discoverProject,
  parseCssCustomProperties,
  parsePnpmWorkspacePackages
} from "./index.js"

const pkg = (fields: Record<string, unknown>): string => JSON.stringify(fields, null, 2)
const discover = (files: Record<string, string>, options: Partial<DiscoverOptions> = {}) =>
  discoverProject({ fs: memoryFs(files), ...options })
const codes = (d: Awaited<ReturnType<typeof discover>>): string[] => d.diagnostics.map((x) => x.code)

describe("workspaces and packages", () => {
  it("parses pnpm-workspace.yaml block lists, quotes, comments and negations", () => {
    const yaml = `# c\npackages:\n  - "packages/*"  # trailing\n  - 'apps/*'\n  - '!packages/legacy'\ncatalog:\n  - nope\n`
    expect(parsePnpmWorkspacePackages(yaml)).toEqual(["packages/*", "apps/*", "!packages/legacy"])
  })

  it("selects only workspace packages and excludes negated ones", async () => {
    const d = await discover({
      "package.json": pkg({ name: "root" }),
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n  - '!packages/old'\n",
      "packages/a/package.json": pkg({ name: "a" }),
      "packages/old/package.json": pkg({ name: "old" }),
      "examples/x/package.json": pkg({ name: "x" })
    })
    expect(d.packages.map((p) => p.name)).toEqual(["root", "a"])
    expect(d.workspaces.kind).toBe("pnpm-workspace")
  })

  it("reads workspaces from package.json in array and object form", async () => {
    for (const workspaces of [["packages/*"], { packages: ["packages/*"] }]) {
      const d = await discover({
        "package.json": pkg({ name: "r", workspaces }),
        "packages/a/package.json": pkg({ name: "a" })
      })
      expect(d.workspaces).toMatchObject({ kind: "package-json", patterns: ["packages/*"] })
      expect(d.packages.map((p) => p.name)).toEqual(["r", "a"])
    }
  })

  it("treats a lone root manifest as the only package and falls back to all manifests when there is no root", async () => {
    expect(
      (
        await discover({ "package.json": pkg({ name: "solo" }), "sub/package.json": pkg({ name: "sub" }) })
      ).packages.map((p) => p.name)
    ).toEqual(["solo"])
    const noRoot = await discover({
      "a/package.json": pkg({ name: "a" }),
      "b/package.json": pkg({ name: "b" })
    })
    expect(noRoot.packages.map((p) => p.name)).toEqual(["a", "b"])
  })

  it("reports invalid manifests and keeps going; reports an empty project", async () => {
    const d = await discover({
      "package.json": pkg({ name: "r", workspaces: ["p/*"] }),
      "p/a/package.json": "{ not json",
      "p/b/package.json": pkg({ name: "b" })
    })
    expect(codes(d)).toContain("discovery.invalid-manifest")
    expect(d.packages.map((p) => p.name)).toEqual(["r", "b"])
    expect(codes(await discover({ "README.md": "# x" }))).toContain("discovery.no-package")
  })

  it("never lists ignored directories' manifests", async () => {
    const d = await discover({
      "package.json": pkg({ name: "r" }),
      "node_modules/dep/package.json": pkg({ name: "dep" })
    })
    expect(d.packages.map((p) => p.name)).toEqual(["r"])
  })
})

describe("package manager", () => {
  const root = pkg({ name: "r" })
  it("prefers the packageManager field and records evidence", async () => {
    const d = await discover({
      "package.json": pkg({ name: "r", packageManager: "pnpm@10.1.0+sha512.x" }),
      "pnpm-lock.yaml": ""
    })
    expect(d.packageManager).toEqual({
      name: "pnpm",
      version: "10.1.0",
      evidence: ["package.json#packageManager", "lockfile:pnpm-lock.yaml"]
    })
  })
  it("warns when the field and lockfiles disagree", async () => {
    const d = await discover({
      "package.json": pkg({ name: "r", packageManager: "npm@10.0.0" }),
      "yarn.lock": ""
    })
    expect(d.packageManager.name).toBe("npm")
    expect(codes(d)).toContain("discovery.package-manager-mismatch")
  })
  it("detects one lockfile, refuses to guess with several, and reports unknown with none", async () => {
    expect((await discover({ "package.json": root, "bun.lock": "" })).packageManager.name).toBe("bun")
    const ambiguous = await discover({ "package.json": root, "yarn.lock": "", "package-lock.json": "" })
    expect(ambiguous.packageManager.name).toBe("unknown")
    expect(codes(ambiguous)).toContain("discovery.ambiguous-lockfiles")
    expect((await discover({ "package.json": root })).packageManager).toEqual({
      name: "unknown",
      evidence: []
    })
  })
})

describe("frameworks and build tools", () => {
  it("records declared range, dependency kind, line, and the installed version found in an ancestor node_modules", async () => {
    const d = await discover({
      "package.json": pkg({ name: "r" }),
      "node_modules/react/package.json": pkg({ version: "18.3.1" }),
      "packages/ui/package.json": pkg({
        name: "ui",
        peerDependencies: { react: "^18.2.0" },
        devDependencies: { react: "^18.3.0" }
      })
    })
    // package.json is not workspace-listed, so use the single-package path:
    expect(d.packages).toHaveLength(1)
    const d2 = await discover({
      "package.json": pkg({ name: "r", workspaces: ["packages/*"] }),
      "node_modules/react/package.json": pkg({ version: "18.3.1" }),
      "packages/ui/package.json": pkg({
        name: "ui",
        peerDependencies: { react: "^18.2.0" },
        devDependencies: { react: "^18.3.0" }
      })
    })
    const ui = d2.packages.find((p) => p.name === "ui")
    expect(ui?.frameworks).toEqual([
      {
        name: "react",
        package: "react",
        dependencyKind: "peerDependencies",
        declaredRange: "^18.2.0",
        installedVersion: "18.3.1",
        line: 4
      }
    ])
  })

  it("leaves installedVersion absent rather than guessing, and detects angular and vue", async () => {
    const d = await discover({
      "package.json": pkg({ name: "a", dependencies: { "@angular/core": "^18.0.0", vue: "^3.4.0" } })
    })
    expect(d.packages[0]?.frameworks.map((f) => [f.name, f.installedVersion])).toEqual([
      ["angular", undefined],
      ["vue", undefined]
    ])
  })

  it("detects build tools from dependencies and config files with evidence", async () => {
    const d = await discover({
      "package.json": pkg({ name: "a", devDependencies: { vite: "^5", typescript: "^5" } }),
      "vite.config.ts": "",
      "tsconfig.json": "{}",
      "angular.json": "{}"
    })
    expect(d.packages[0]?.buildTools).toEqual([
      { name: "angular-cli", evidence: [{ type: "config-file", ref: "angular.json" }] },
      {
        name: "typescript",
        evidence: [
          { type: "config-file", ref: "tsconfig.json" },
          { type: "dependency", ref: "typescript" }
        ]
      },
      {
        name: "vite",
        evidence: [
          { type: "config-file", ref: "vite.config.ts" },
          { type: "dependency", ref: "vite" }
        ]
      }
    ])
  })
})

describe("entry points", () => {
  const base = (extra: Record<string, unknown>) => pkg({ name: "lib", ...extra })

  it("maps built targets back to source through tsconfig outDir/rootDir", async () => {
    const d = await discover({
      "package.json": base({ exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } } }),
      "tsconfig.json": '{ "compilerOptions": { "outDir": "dist", "rootDir": "src" } } // comment',
      "src/index.ts": "export const a = 1"
    })
    expect(d.packages[0]?.entryPoints[0]).toMatchObject({
      subpath: ".",
      condition: "types",
      resolution: "mapped",
      file: "src/index.ts"
    })
  })

  it("uses a declared source file directly, and a built file in an ignored directory when no source maps", async () => {
    const source = await discover({
      "package.json": base({ exports: "./src/main.ts" }),
      "src/main.ts": "export const m = 1"
    })
    expect(source.packages[0]?.entryPoints[0]).toMatchObject({ resolution: "declared", file: "src/main.ts" })
    const built = await discover({
      "package.json": base({ main: "dist/index.js" }),
      "dist/index.js": "export const b = 1"
    })
    expect(built.packages[0]?.entryPoints[0]).toMatchObject({
      condition: "main",
      resolution: "declared",
      file: "dist/index.js"
    })
    expect(built.packages[0]?.entryPoints[0]?.exports.map((e) => e.name)).toEqual(["b"])
  })

  it("falls back to conventional roots and flags unresolved entries without inventing exports", async () => {
    const conv = await discover({
      "package.json": base({ module: "fesm/lib.mjs" }),
      "src/public-api.ts": "export const x = 1"
    })
    expect(conv.packages[0]?.entryPoints[0]).toMatchObject({
      resolution: "conventional",
      file: "src/public-api.ts"
    })
    const none = await discover({ "package.json": base({ main: "dist/index.js" }) })
    expect(none.packages[0]?.entryPoints[0]).toMatchObject({
      resolution: "unresolved",
      exports: [],
      exportsComplete: false
    })
    expect(codes(none)).toContain("discovery.entry-unresolved")
  })

  it("finds an ng-packagr library entry from ng-package.json, then from the public-api convention", async () => {
    const viaConfig = await discover({
      "package.json": base({}),
      "ng-package.json": '{ "lib": { "entryFile": "src/main.ts" } }',
      "src/main.ts": "export const a = 1"
    })
    expect(viaConfig.packages[0]?.entryPoints[0]).toMatchObject({
      subpath: ".",
      condition: "ng-package",
      file: "src/main.ts",
      resolution: "declared"
    })
    const viaConvention = await discover({
      "package.json": base({}),
      "src/public-api.ts": "export const b = 1"
    })
    expect(viaConvention.packages[0]?.entryPoints[0]).toMatchObject({
      condition: "conventional",
      file: "src/public-api.ts"
    })
    // Without any of these, a package with no declared entry still has none: nothing is guessed.
    expect(
      (await discover({ "package.json": base({}), "src/index.ts": "export const c = 1" })).packages[0]
        ?.entryPoints
    ).toEqual([])
  })

  it("does not expand wildcard subpaths but says so", async () => {
    const d = await discover({ "package.json": base({ exports: { "./icons/*": "./dist/icons/*.js" } }) })
    expect(d.packages[0]?.entryPoints).toEqual([])
    expect(codes(d)).toContain("discovery.entry-pattern-unsupported")
  })

  it("does not confuse differently-cased files on case-insensitive filesystems", async () => {
    const d = await discover({
      "package.json": base({ exports: "./src/index.ts" }),
      "src/index.ts": 'export { Button } from "./Button"',
      "src/button.ts": "export const Lower = 1",
      "src/Button.tsx": "export const Button = () => null"
    })
    const entry = d.packages[0]?.entryPoints[0]
    expect(entry?.exports.map((e) => [e.name, e.kind])).toEqual([["Button", "value"]])
    expect(entry?.parsedFiles.map((f) => f.path)).toContain("src/Button.tsx")
  })
})

describe("export enumeration", () => {
  const entry = async (files: Record<string, string>, options: Partial<DiscoverOptions> = {}) => {
    const d = await discover(
      { "package.json": pkg({ name: "lib", exports: "./src/index.ts" }), ...files },
      options
    )
    return { entry: d.packages[0]?.entryPoints[0], d }
  }
  const names = (e?: { exports: Array<{ name: string; kind: string; typeOnly: boolean }> }) =>
    e?.exports.map((x) => `${x.name}:${x.kind}${x.typeOnly ? ":type-only" : ""}`)

  it("covers declarations, defaults, namespaces, local re-export lists and type-only exports", async () => {
    const { entry: e } = await entry({
      "src/index.ts": `
        export const a = 1, b = 2
        export function f() {}
        export class C {}
        export enum E { X }
        export interface I {}
        export type T = string
        export namespace N { export const n = 1 }
        const local = 1
        interface LocalI {}
        export { local as renamed, type LocalI }
        export * as ns from "./other"
        export type { Foreign } from "./other"
        export default function () {}
      `,
      "src/other.ts": "export const o = 1; export interface Foreign {}"
    })
    expect(names(e)).toEqual(
      [
        "C:value",
        "E:value",
        "I:type:type-only",
        "LocalI:type:type-only",
        "N:namespace",
        "T:type:type-only",
        "a:value",
        "b:value",
        "default:default",
        "f:value",
        "ns:namespace",
        "renamed:value"
      ]
        .concat(["Foreign:type:type-only"])
        .sort()
    )
    expect(e?.exportsComplete).toBe(true)
  })

  it("follows export-star chains, honours .js specifiers and index files, survives cycles, and lets explicit exports win", async () => {
    const { entry: e } = await entry({
      "src/index.ts": 'export * from "./a.js"\nexport * from "./dir"\nexport const shared = "explicit"',
      "src/a.ts": 'export const fromA = 1\nexport const shared = "star"\nexport * from "./b"',
      "src/b.ts": 'export const fromB = 1\nexport * from "./a"',
      "src/dir/index.ts": "export const fromDir = 1"
    })
    expect(e?.exports.map((x) => x.name)).toEqual(["fromA", "fromB", "fromDir", "shared"])
    expect(e?.exports.find((x) => x.name === "shared")?.file).toBe("src/index.ts")
    expect(e?.exportsComplete).toBe(true)
  })

  it("marks the listing incomplete for external stars, unresolved modules, export =, and syntax errors", async () => {
    const external = await entry({ "src/index.ts": 'export * from "some-lib"\nexport const a = 1' })
    expect(external.entry?.exportsComplete).toBe(false)
    expect(codes(external.d)).toContain("discovery.external-reexport")
    const missing = await entry({ "src/index.ts": 'export * from "./nope"' })
    expect(missing.entry?.exportsComplete).toBe(false)
    expect(codes(missing.d)).toContain("discovery.unresolved-module")
    const assign = await entry({ "src/index.ts": "export = {}" })
    expect(assign.entry?.exportsComplete).toBe(false)
    expect(codes(assign.d)).toContain("discovery.unsupported-export-assignment")
    const broken = await entry({ "src/index.ts": "export const a = (" })
    expect(broken.entry?.exportsComplete).toBe(false)
    expect(codes(broken.d)).toContain("discovery.parse-error")
  })

  it("records locations, bounds how many files it follows, and treats .vue targets as leaves", async () => {
    const located = await entry({ "src/index.ts": "\n\nexport const third = 1" })
    expect(located.entry?.exports[0]).toMatchObject({ name: "third", file: "src/index.ts", line: 3 })
    const limited = await entry(
      {
        "src/index.ts": 'export * from "./a"',
        "src/a.ts": 'export * from "./b"',
        "src/b.ts": "export const z = 1"
      },
      { limits: { maxParsedFilesPerEntry: 2 } }
    )
    expect(limited.entry?.exportsComplete).toBe(false)
    expect(codes(limited.d)).toContain("discovery.export-limit")
    const vue = await entry({
      "src/index.ts": 'export { default as Button } from "./Button.vue"',
      "src/Button.vue": "<template/>"
    })
    expect(names(vue.entry)).toEqual(["Button:default"])
  })
})

describe("Storybook configuration", () => {
  const sb = async (
    config: string,
    extra: Record<string, string> = {},
    options: Partial<DiscoverOptions> = {}
  ) => {
    const d = await discover(
      {
        "package.json": pkg({ name: "ui", devDependencies: { storybook: "^8.0.0" } }),
        ".storybook/main.ts": config,
        "src/A.stories.tsx": "",
        "src/B.stories.ts": "",
        "src/C.mdx": "# c",
        ...extra
      },
      options
    )
    return { story: d.storybooks[0], d }
  }

  it("statically reads stories, addons, framework, staticDirs through common wrappers", async () => {
    const wrappers = [
      `export default { stories: ["../src/**/*.stories.@(ts|tsx)"], addons: ["a", {name:"b"}], framework: "@sb/react", staticDirs: ["../public"] }`,
      `module.exports = { stories: ["../src/**/*.stories.@(ts|tsx)"], addons: ["a", {name:"b"}], framework: {name: "@sb/react"}, staticDirs: ["../public"] }`,
      `const config = { stories: ["../src/**/*.stories.@(ts|tsx)"], addons: [getAbsolutePath("a"), "b"], framework: "@sb/react", staticDirs: ["../public"] } satisfies X\nexport default defineMain(config)`
    ]
    for (const w of wrappers) {
      const { story } = await sb(w)
      expect(story).toMatchObject({
        framework: "@sb/react",
        addons: ["a", "b"],
        staticDirs: ["../public"],
        dynamicProperties: [],
        package: "package:ui"
      })
      expect(story?.storyFiles).toEqual(["src/A.stories.tsx", "src/B.stories.ts"])
    }
  })

  it("expands directory/files/titlePrefix story objects", async () => {
    const { story } = await sb(
      `export default { stories: [{ directory: "../src", files: "*.mdx", titlePrefix: "Docs" }] }`
    )
    expect(story?.stories).toEqual([{ directory: "../src", files: "*.mdx", titlePrefix: "Docs" }])
    expect(story?.storyFiles).toEqual(["src/C.mdx"])
  })

  it("flags anything not statically determinable and never executes the config", async () => {
    const { story, d } = await sb(`
      throw new Error("config was executed")
      process.exit(1)
      const extra = compute()
      export default { stories: [...extra], addons: ["ok"], viteFinal: async (c) => c, ...rest }
    `)
    expect(story?.addons).toEqual(["ok"])
    expect(story?.dynamicProperties).toEqual(expect.arrayContaining(["stories", "viteFinal"]))
    expect(codes(d)).toContain("discovery.storybook-dynamic-config")
  })

  it("warns when no static config object exists", async () => {
    const { story, d } = await sb("export default makeConfig()")
    expect(story?.dynamicProperties).toEqual(["<config>"])
    expect(codes(d)).toContain("discovery.storybook-unparsed")
  })

  it("detects built output, installed version, and bounds story file lists", async () => {
    const { story } = await sb(
      `export default { stories: ["../src/**/*.stories.*"] }`,
      {
        "storybook-static/index.json": "{}",
        "node_modules/storybook/package.json": pkg({ version: "8.4.7" })
      },
      { limits: { maxStoryFiles: 1 } }
    )
    expect(story?.builtOutput).toEqual({ path: "storybook-static", hasIndexJson: true })
    expect(story?.version).toEqual({
      package: "storybook",
      declaredRange: "^8.0.0",
      installedVersion: "8.4.7"
    })
    expect(story).toMatchObject({ storyFileCount: 2, storyFilesTruncated: true })
    expect(story?.storyFiles).toHaveLength(1)
  })

  it("ignores story globs that escape the project", async () => {
    const { story } = await sb(`export default { stories: ["../../outside/**/*.stories.ts"] }`)
    expect(story?.storyFileCount).toBe(0)
  })
})

describe("token files", () => {
  it("scans CSS custom properties with scope, line, alias, comments, strings and url(;)", () => {
    const css = `/* header */
:root {
  --a: 1px; /* trailing; } */
  --b: var(--a);
  --c: "x;y}z"
}
@media (min-width: 1px) { .x { --d: url(data:image/png;base64,AAA); color: red } }
.not-a-var { color: red; }
`
    expect(parseCssCustomProperties(css)).toEqual([
      { name: "--a", scope: ":root", line: 3, value: "1px" },
      { name: "--b", scope: ":root", line: 4, value: "var(--a)", aliasOf: "--a" },
      { name: "--c", scope: ":root", line: 5, value: '"x;y}z"' },
      { name: "--d", scope: "@media (min-width: 1px) .x", line: 7, value: "url(data:image/png;base64,AAA)" }
    ])
  })

  it("ignores custom properties outside rule blocks and tolerates unbalanced input", () => {
    expect(parseCssCustomProperties("--top: 1;")).toEqual([])
    expect(() => parseCssCustomProperties(":root { --a: 1; ")).not.toThrow()
  })

  it("classifies token files by shape and skips look-alikes", async () => {
    const d = await discover({
      "package.json": pkg({ name: "t" }),
      "tokens/package.json": pkg({ name: "nested" }),
      "tokens/core.json": pkg({ color: { a: { $value: "#fff" }, b: { $value: "#000" } } }),
      "tokens/legacy.json": pkg({ color: { a: { value: "#fff" } } }),
      "tokens/unrelated.json": pkg({ hello: "world" }),
      "design.tokens.json": pkg({}),
      "style-dictionary.config.json": "{}",
      "tailwind.config.ts": "export default {}",
      "bad.tokens.json": "{ nope",
      "app.min.css": ":root{--x:1}",
      "plain.css": "body { color: red }"
    })
    expect(d.tokenFiles.map((f) => [f.path, f.kind, f.format, f.tokenCount])).toEqual([
      ["design.tokens.json", "json-tokens", "unknown", 0],
      ["style-dictionary.config.json", "style-dictionary-config", undefined, undefined],
      ["tailwind.config.ts", "tailwind-config", undefined, undefined],
      ["tokens/core.json", "json-tokens", "dtcg-like", 2],
      ["tokens/legacy.json", "json-tokens", "style-dictionary-like", 1]
    ])
    expect(codes(d)).toContain("discovery.token-json-invalid")
  })

  it("bounds CSS variables per file and skips oversized files with a diagnostic", async () => {
    const many = `:root{${Array.from({ length: 5 }, (_, i) => `--v${i}:${i};`).join("")}}`
    const d = await discover(
      { "package.json": pkg({ name: "t" }), "a.css": many, "big.css": `:root{--x:${"1".repeat(100)}}` },
      { limits: { maxCssVariablesPerFile: 2, maxFileBytes: 50 } }
    )
    // a.css (>50 bytes?) is checked below; both oversized files are reported rather than silently dropped.
    expect(codes(d)).toContain("discovery.file-too-large")
    const bounded = await discover(
      { "package.json": pkg({ name: "t" }), "a.css": many },
      { limits: { maxCssVariablesPerFile: 2 } }
    )
    expect(bounded.tokenFiles[0]).toMatchObject({ cssVariablesTruncated: true })
    expect(bounded.tokenFiles[0]?.cssVariables).toHaveLength(2)
  })
})

describe("documentation files", () => {
  it("extracts title (frontmatter first), heading outline ignoring code fences, and kinds", async () => {
    const d = await discover({
      "package.json": pkg({ name: "p" }),
      "README.md": "# Readme\n\n```sh\n# not heading\n```\n\n## Usage ##\n",
      "docs/a.md": '---\ntitle: "From FM"\n---\n# Different H1\n',
      "docs/b.mdx": "intro\n\n### Deep\n",
      "CHANGELOG.md": "# Changes",
      "docs/empty.md": ""
    })
    const by = Object.fromEntries(d.docFiles.map((f) => [f.path, f]))
    expect(by["README.md"]).toMatchObject({
      kind: "readme",
      title: "Readme",
      headings: [
        { level: 1, text: "Readme", line: 1 },
        { level: 2, text: "Usage", line: 7 }
      ]
    })
    expect(by["docs/a.md"]).toMatchObject({ title: "From FM", kind: "markdown" })
    expect(by["docs/b.mdx"]).toMatchObject({ kind: "mdx", headings: [{ level: 3, text: "Deep", line: 3 }] })
    expect(by["docs/b.mdx"]?.title).toBeUndefined()
    expect(by["CHANGELOG.md"]?.kind).toBe("changelog")
    expect(by["docs/empty.md"]?.lineCount).toBe(0)
  })

  it("caps headings", async () => {
    const text = Array.from({ length: 10 }, (_, i) => `# H${i}`).join("\n")
    const d = await discover(
      { "package.json": pkg({ name: "p" }), "a.md": text },
      { limits: { maxHeadings: 3 } }
    )
    expect(d.docFiles[0]?.headings).toHaveLength(3)
  })
})

describe("relationship graph", () => {
  it("links workspace dependencies, frameworks, tools, storybook, token and doc files", async () => {
    const d = await discover({
      "package.json": pkg({ name: "root", workspaces: ["packages/*"] }),
      "packages/ui/package.json": pkg({
        name: "@x/ui",
        dependencies: { "@x/tokens": "workspace:*", lodash: "1" },
        peerDependencies: { react: "^18" },
        devDependencies: { vite: "5" }
      }),
      "packages/ui/.storybook/main.ts":
        'export default { stories: ["../src/*.stories.ts", "../../tokens/src/*.stories.ts"] }',
      "packages/ui/src/a.stories.ts": "",
      "packages/tokens/package.json": pkg({ name: "@x/tokens" }),
      "packages/tokens/src/t.css": ":root{--a:1}",
      "packages/tokens/src/b.stories.ts": "",
      "packages/ui/README.md": "# ui"
    })
    const edges = d.graph.edges.map((e) => `${e.from} -${e.type}${e.weight ? `(${e.weight})` : ""}-> ${e.to}`)
    expect(edges).toEqual(
      expect.arrayContaining([
        "package:@x/ui -depends-on-> package:@x/tokens",
        "package:@x/ui -uses-framework-> framework:react",
        "package:@x/ui -built-with-> tool:vite",
        "package:@x/ui -configured-by-> storybook:packages/ui",
        "storybook:packages/ui -documents(1)-> package:@x/ui",
        "storybook:packages/ui -documents(1)-> package:@x/tokens",
        "package:@x/tokens -contains-> tokens:packages/tokens/src/t.css",
        "package:@x/ui -contains-> doc:packages/ui/README.md"
      ])
    )
    expect(edges.some((e) => e.includes("lodash"))).toBe(false)
    const ids = d.graph.nodes.map((n) => n.id)
    expect(ids).toEqual([...ids].sort())
  })
})

describe("limits and determinism", () => {
  it("reports walk truncation", async () => {
    const d = await discover(
      { "package.json": pkg({ name: "r" }), "a.md": "", "b.md": "" },
      { limits: { maxFiles: 2 } }
    )
    expect(d.stats).toEqual({ filesScanned: 2, truncated: true })
    expect(codes(d)).toContain("discovery.walk-truncated")
  })

  it("produces identical output regardless of filesystem insertion order", async () => {
    const files = {
      "package.json": pkg({ name: "r", workspaces: ["p/*"] }),
      "p/a/package.json": pkg({ name: "a", peerDependencies: { react: "18" } }),
      "p/b/package.json": pkg({ name: "b", dependencies: { a: "1" } }),
      "p/a/README.md": "# a",
      "p/b/t.css": ":root{--x:1}"
    }
    const reversed = Object.fromEntries(Object.entries(files).reverse())
    expect(await discover(reversed)).toEqual(await discover(files))
  })
})

describe("declaration roots", () => {
  const files = {
    "package.json": pkg({ name: "app", dependencies: { "@acme/ui": "1.0.0" } }),
    "node_modules/@acme/ui/package.json": pkg({
      name: "@acme/ui",
      version: "1.0.0",
      types: "dist/index.d.ts",
      peerDependencies: { react: "*" }
    }),
    "node_modules/@acme/ui/dist/index.d.ts": "export declare const x: number;",
    "node_modules/@acme/ui/node_modules/dep/package.json": pkg({ name: "dep" }),
    "node_modules/other/package.json": pkg({ name: "other" })
  }

  it("ignores installed packages by default", async () => {
    const d = await discover(files)
    expect(d.packages.map((p) => p.name)).toEqual(["app"])
  })

  it("reads only the opted-in package, including its build output, and not its own dependencies", async () => {
    const d = await discover(files, { declarationRoots: ["node_modules/@acme/ui"] })
    expect(d.packages.map((p) => p.name)).toEqual(["app", "@acme/ui"])
    const ui = d.packages.find((p) => p.name === "@acme/ui")
    expect(ui?.dir).toBe("node_modules/@acme/ui")
    expect(ui?.entryPoints[0]).toMatchObject({
      resolution: expect.not.stringMatching(/unresolved/),
      file: "node_modules/@acme/ui/dist/index.d.ts"
    })
    expect(d.packages.some((p) => p.name === "dep" || p.name === "other")).toBe(false)
  })

  it("warns when the root is missing", async () => {
    const d = await discover(
      { "package.json": pkg({ name: "app" }) },
      { declarationRoots: ["node_modules/nope"] }
    )
    expect(codes(d)).toContain("discovery.declaration-root-missing")
  })
})
