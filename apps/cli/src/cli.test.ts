import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { FIXED_CLOCK } from "@invariant/compiler-core/testing"
import { afterAll, describe, expect, it } from "vitest"
import { loadConfig, run, runPipeline, validateConfig } from "./index.js"
import { esc, renderReport } from "./report.js"

const root = fileURLToPath(new URL("../../..", import.meta.url))
const fixture = (name: string): string => path.join(root, "fixtures", name)
const made: string[] = []

function project(from: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "invariant-cli-"))
  made.push(dir)
  cpSync(fixture(from), dir, { recursive: true, filter: (src) => !src.includes("storybook-static") })
  return dir
}
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

async function cli(cwd: string, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = ""
  let err = ""
  const code = await run(argv, {
    cwd,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    clock: FIXED_CLOCK
  })
  return { code, out, err }
}
const read = (dir: string, file: string): string => readFileSync(path.join(dir, file), "utf8")

describe("configuration", () => {
  const ok = { name: "DS", sources: [{ id: "ui", type: "react", path: "packages/ui" }] }

  it("accepts a valid configuration and defaults nothing silently", () => {
    expect(validateConfig(ok)).toEqual(ok)
  })

  it("explains that zeroheight and Figma are not supported yet instead of failing obscurely", () => {
    expect(() => validateConfig({ name: "DS", sources: [{ id: "z", type: "zeroheight" }] })).toThrow(
      /not supported yet/
    )
    expect(() => validateConfig({ name: "DS", sources: [{ id: "f", type: "figma" }] })).toThrow(
      /not supported yet/
    )
  })

  it("rejects paths that leave the project, unknown keys, bad ids and duplicate ids", () => {
    for (const p of ["../x", "/abs", "a/../b", "a\\b", "C:/x"])
      expect(() => validateConfig({ ...ok, sources: [{ id: "ui", type: "react", path: p }] })).toThrow(
        /relative path/
      )
    expect(() => validateConfig({ ...ok, output: { directory: "../out" } })).toThrow(/relative path/)
    expect(() => validateConfig({ ...ok, extra: 1 })).toThrow(/invalid configuration/)
    expect(() => validateConfig({ name: "DS", sources: [{ id: "Bad Id", type: "react" }] })).toThrow(
      /invalid configuration/
    )
    expect(() => validateConfig({ name: "DS", sources: [ok.sources[0], ok.sources[0]] })).toThrow(
      /duplicate source id/
    )
  })

  it("loads JSON as data, and refuses to run a code config without --trust-config", async () => {
    const dir = project("storybook/acme-ui")
    writeFileSync(
      path.join(dir, "invariant.config.ts"),
      `export default { name: "From code", sources: [] }\n`
    )
    await expect(loadConfig({ cwd: dir, trustConfig: false })).rejects.toThrow(/runs it/)
    const loaded = await loadConfig({ cwd: dir, trustConfig: true })
    expect(loaded?.config.name).toBe("From code")
    expect(loaded?.editable).toBe(false)
    writeFileSync(path.join(dir, "invariant.config.json"), JSON.stringify({ name: "From json", sources: [] }))
    expect((await loadConfig({ cwd: dir, trustConfig: false }))?.config.name).toBe("From json")
  })

  it("reports invalid JSON and a missing explicit file", async () => {
    const dir = project("storybook/acme-ui")
    writeFileSync(path.join(dir, "invariant.config.json"), "{ nope")
    await expect(loadConfig({ cwd: dir, trustConfig: false })).rejects.toThrow(/not valid JSON/)
    await expect(loadConfig({ cwd: dir, file: "missing.json", trustConfig: false })).rejects.toThrow(
      /not found/
    )
  })
})

describe("workflow: init, compile, inspect, validate, export", () => {
  it("runs the whole local flow without any account or network", async () => {
    const dir = project("storybook/acme-ui")
    expect((await cli(dir, "compile")).err).toMatch(/no invariant.config.json/)

    const init = await cli(dir, "init")
    expect(init.code).toBe(0)
    expect(init.out).toMatch(/acme-ui-react {2}react/)
    expect(
      JSON.parse(read(dir, "invariant.config.json")).sources.map((s: { type: string }) => s.type)
    ).toEqual(["react", "storybook", "tokens"])
    expect((await cli(dir, "init")).err).toMatch(/already exists/)
    expect((await cli(dir, "init", "--force")).code).toBe(0)

    expect((await cli(dir, "components", "list")).err).toMatch(/Run `invariant compile` first/)

    const compiled = await cli(dir, "compile")
    expect(compiled.code).toBe(0)
    expect(compiled.out).toMatch(/components 14/)
    expect(readdirSync(path.join(dir, "invariant")).sort()).toEqual([
      "invariant.contract.json",
      "invariant.diagnostics.json",
      "invariant.evidence.json",
      "invariant.manifest.json",
      "invariant.report.html",
      "invariant.review.json"
    ])

    const list = await cli(dir, "components", "list")
    expect(list.out).toMatch(/component:button\s+Button\s+react/)
    const listJson = JSON.parse((await cli(dir, "components", "list", "--json")).out)
    expect(listJson.find((c: { id: string }) => c.id === "component:button").frameworks).toEqual(["react"])

    const inspect = await cli(dir, "components", "inspect", "button", "--evidence")
    expect(inspect.code).toBe(0)
    expect(inspect.out).toMatch(/props\.variant\.default/)
    expect(inspect.out).toMatch(/src\/Button\.tsx:\d+/)
    expect((await cli(dir, "components", "inspect", "Nope")).code).toBe(1)

    const conflicts = await cli(dir, "conflicts", "list", "--severity", "warning", "--subject", "button")
    expect(conflicts.out.split("\n").filter((l) => l.includes("component:button")).length).toBe(3)
    expect((await cli(dir, "conflicts", "list", "--severity", "error")).out).toMatch(/no conflicts/)
    expect((await cli(dir, "patterns", "list")).out).toMatch(/no patterns/)
    expect((await cli(dir, "tokens", "list")).code).toBe(0)

    const valid = await cli(dir, "verify", "--fresh")
    expect(valid.code).toBe(0)
    expect(valid.out).toMatch(/^valid:/)

    const exported = await cli(dir, "export", "--to", "bundle")
    expect(exported.code).toBe(0)
    expect(existsSync(path.join(dir, "bundle/schema/contract-v1.schema.json"))).toBe(true)
    expect(read(dir, "bundle/invariant.contract.json")).toBe(read(dir, "invariant/invariant.contract.json"))
    expect((await cli(dir, "export", "--to", "bundle")).err).toMatch(/not empty/)
    expect((await cli(dir, "export", "--to", "../outside")).code).toBe(2)
    expect((await cli(dir, "export", "--to", "invariant")).err).toMatch(/must differ/)
  })

  it("compiles reproducibly: two runs and a fresh copy produce identical files", async () => {
    const a = project("storybook/acme-ui")
    const b = project("storybook/acme-ui")
    for (const d of [a, b]) {
      await cli(d, "init")
      await cli(d, "compile")
    }
    await cli(a, "compile")
    for (const f of readdirSync(path.join(a, "invariant")))
      expect(read(b, `invariant/${f}`)).toBe(read(a, `invariant/${f}`))
  })

  it("analyze reports sources and writes IR under analysis/", async () => {
    const dir = project("storybook/acme-ui")
    await cli(dir, "init")
    const r = await cli(dir, "analyze")
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/react-acme-ui {2}react {2}partial/)
    expect(existsSync(path.join(dir, "invariant/analysis/invariant.project.json"))).toBe(true)
    expect(existsSync(path.join(dir, "invariant/invariant.contract.json"))).toBe(false)
  })
})

describe("verify detects a tampered or stale output", () => {
  async function compiled() {
    const dir = project("storybook/acme-ui")
    await cli(dir, "init")
    await cli(dir, "compile")
    return dir
  }

  it("catches an edited contract by manifest hash and by contract hash", async () => {
    const dir = await compiled()
    const file = path.join(dir, "invariant/invariant.contract.json")
    writeFileSync(file, read(dir, "invariant/invariant.contract.json").replace('"Button"', '"Buttons"'))
    const r = await cli(dir, "verify")
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/verify\.artifact-modified/)
    expect(r.out).toMatch(/contract\.hash-mismatch/)
    const asJson = JSON.parse((await cli(dir, "verify", "--json")).out)
    expect(asJson.ok).toBe(false)
  })

  it("catches a deleted artifact and a missing manifest", async () => {
    const dir = await compiled()
    rmSync(path.join(dir, "invariant/invariant.report.html"))
    expect((await cli(dir, "verify")).out).toMatch(/verify\.artifact-missing/)
    rmSync(path.join(dir, "invariant/invariant.manifest.json"))
    const r = await cli(dir, "verify")
    expect(r.out).toMatch(/verify\.manifest-missing/)
    expect(r.code).toBe(0)
  })

  it("--fresh reports a contract that no longer matches the sources", async () => {
    const dir = await compiled()
    const file = path.join(dir, "src/Button.tsx")
    writeFileSync(
      file,
      `${read(dir, "src/Button.tsx")}\nexport const extra = 1\n`.replace("Triggers an action.", "Changed.")
    )
    writeFileSync(path.join(dir, "src/Badge.tsx"), read(dir, "src/Badge.tsx").replace("info", "notice"))
    const r = await cli(dir, "verify", "--fresh")
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/verify\.stale/)
  })

  it("--fresh says what changed, by collection and entity", async () => {
    const dir = await compiled()
    writeFileSync(
      path.join(dir, "src/Button.tsx"),
      read(dir, "src/Button.tsx").replace("Triggers an action.", "Changed.")
    )
    const r = await cli(dir, "verify", "--fresh")
    expect(r.out).toMatch(/components: \+0 -0 ~1/)
    expect(r.out).toMatch(/~ component:button \(.*description.*\)/)
    const j = JSON.parse((await cli(dir, "verify", "--fresh", "--json")).out)
    expect(j.ok).toBe(false)
    expect(j.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          collection: "components",
          changed: [expect.objectContaining({ id: "component:button" })]
        })
      ])
    )
  })

  it("--fresh on unchanged sources reports no changes", async () => {
    const dir = await compiled()
    const r = await cli(dir, "verify", "--fresh", "--json")
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out).changes).toBeUndefined()
  })

  it("export refuses an invalid output unless forced", async () => {
    const dir = await compiled()
    writeFileSync(
      path.join(dir, "invariant/invariant.contract.json"),
      read(dir, "invariant/invariant.contract.json").replace('"Button"', '"Buttons"')
    )
    expect((await cli(dir, "export", "--to", "bundle")).code).toBe(1)
    expect((await cli(dir, "export", "--to", "bundle", "--force")).code).toBe(0)
  })
})

describe("source management", () => {
  it("adds sources to JSON configuration with validation", async () => {
    const dir = project("monorepo/acme")
    await cli(dir, "init")
    const before = JSON.parse(read(dir, "invariant.config.json")).sources.length
    expect((await cli(dir, "source", "add", "react", "packages/ui-react", "--id", "extra")).code).toBe(0)
    const sources = JSON.parse(read(dir, "invariant.config.json")).sources
    expect(sources).toHaveLength(before + 1)
    expect(sources.at(-1)).toEqual({ id: "extra", type: "react", path: "packages/ui-react" })
    expect((await cli(dir, "source", "add", "react", "packages/ui-react", "--id", "extra")).err).toMatch(
      /already exists/
    )
    expect((await cli(dir, "source", "add", "react", "nope")).err).toMatch(/not a directory/)
    expect((await cli(dir, "source", "add", "react", "../x")).err).toMatch(/inside the project/)
    expect((await cli(dir, "source", "add", "zeroheight")).code).toBe(2)
    expect((await cli(dir, "source", "list", "--json")).out).toContain('"extra"')
  })

  it("refuses to edit a code configuration and says how to move to JSON", async () => {
    const dir = project("monorepo/acme")
    writeFileSync(path.join(dir, "invariant.config.mjs"), `export default { name: "x", sources: [] }\n`)
    for (const argv of [
      ["source", "add", "react", "packages/ui-react", "--trust-config"],
      ["source", "remove", "ui", "--trust-config"]
    ]) {
      const r = await cli(dir, ...argv)
      expect(r.code).toBe(2)
      expect(r.err).toMatch(/this configuration is code/)
      expect(r.err).toMatch(/invariant init/)
    }
  })

  it("removes a source from JSON configuration and rejects unknown ids", async () => {
    const dir = project("monorepo/acme")
    await cli(dir, "init")
    await cli(dir, "source", "add", "react", "packages/ui-react", "--id", "extra")
    const before = JSON.parse(read(dir, "invariant.config.json")).sources
    const r = await cli(dir, "source", "remove", "extra")
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/removed extra/)
    const after = JSON.parse(read(dir, "invariant.config.json")).sources
    expect(after).toHaveLength(before.length - 1)
    expect(after.map((x: { id: string }) => x.id)).not.toContain("extra")
    const missing = await cli(dir, "source", "remove", "nope")
    expect(missing.code).toBe(2)
    expect(missing.err).toMatch(/no source with id "nope"/)
    expect((await cli(dir, "source", "remove")).err).toMatch(/usage/)
  })
})

describe("init on a large repository", () => {
  it("writes one whole-project entry per framework when there are many packages", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "invariant-cli-"))
    made.push(dir)
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "big", private: true, workspaces: ["pkgs/*"] })
    )
    for (let i = 0; i < 7; i++) {
      mkdirSync(path.join(dir, `pkgs/p${i}/src`), { recursive: true })
      writeFileSync(
        path.join(dir, `pkgs/p${i}/package.json`),
        JSON.stringify({ name: `@big/p${i}`, version: "1.0.0", peerDependencies: { react: "^18" } })
      )
    }
    expect((await cli(dir, "init")).code).toBe(0)
    expect(JSON.parse(read(dir, "invariant.config.json")).sources).toEqual([{ id: "react", type: "react" }])
  })
})

describe("source scoping", () => {
  it("compiles only what a configured path covers and says when an entry matches nothing", async () => {
    const dir = project("monorepo/acme")
    const config = {
      name: "Acme",
      sources: [
        { id: "react-only", type: "react", path: "packages/ui-react" },
        { id: "vue-nowhere", type: "vue", path: "packages/tokens" }
      ]
    } as const
    const result = await runPipeline({ cwd: dir, config: validateConfig(config), clock: FIXED_CLOCK })
    const byId = Object.fromEntries(result.mapping.map((m) => [m.configId, m.sources]))
    expect(byId["react-only"]?.length).toBeGreaterThan(0)
    expect(byId["vue-nowhere"]).toEqual([])
    expect(result.diagnostics.map((d) => d.code)).toContain("cli.source-matched-nothing")
    expect(
      result.final.contract.components.every((c) => c.implementations.every((i) => i.framework === "react"))
    ).toBe(true)
    expect(result.compiled.irDocuments.some((d) => d.source.type === "vue")).toBe(false)
  })

  it("a type with no configured entry is not run", async () => {
    const dir = project("monorepo/acme")
    const result = await runPipeline({
      cwd: dir,
      config: validateConfig({ name: "Acme", sources: [] }),
      clock: FIXED_CLOCK
    })
    expect(result.final.contract.components).toEqual([])
    expect(
      result.compiled.irDocuments
        .map((d) => d.source.type)
        .sort()
        .every((t) => ["npm", "markdown", "storybook", "tokens"].includes(t))
    ).toBe(true)
  })
})

describe("usage and exit codes", () => {
  it("prints help, version, and returns 2 for misuse", async () => {
    const dir = project("storybook/acme-ui")
    expect((await cli(dir, "--help")).out).toMatch(/usage: invariant/)
    expect((await cli(dir, "help")).code).toBe(0)
    expect((await cli(dir)).code).toBe(2)
    expect((await cli(dir, "--version")).out.trim()).toBe("0.0.0")
    const unknownFlag = await cli(dir, "compile", "--nope")
    expect(unknownFlag.code).toBe(2)
    expect(unknownFlag.err).toMatch(/Unknown option/)
    expect((await cli(dir, "components")).code).toBe(2)
    expect((await cli(dir, "--cwd", "missing-dir", "init")).code).not.toBe(0)
  })
})

describe("html report", () => {
  it("escapes everything that comes from customer source", () => {
    expect(esc(`<script>alert("x")</script>&'`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;"
    )
    const evil = `<img src=x onerror=alert(1)>`
    const contract = {
      contractVersion: "1.0.0",
      metadata: {
        contractId: "x",
        name: evil,
        compilerVersion: "1",
        frameworks: [],
        compiledAt: "2026-01-01T00:00:00.000Z"
      },
      sources: [
        {
          id: "s",
          type: "react",
          location: evil,
          capabilities: [],
          health: { status: "ok", diagnosticCount: 0 }
        }
      ],
      themes: [],
      components: [
        {
          id: "component:x",
          name: evil,
          implementations: [{ id: "react", framework: "react", sourceId: "s" }],
          props: [],
          events: [],
          slots: [],
          variants: [],
          states: [],
          examples: [],
          composition: [],
          facts: {}
        }
      ],
      tokens: [],
      patterns: [],
      guidelines: [],
      constraints: [],
      policies: [],
      conflicts: [
        {
          id: "conflict:value-mismatch/x",
          type: "value-mismatch",
          severity: "warning",
          subject: "component:x",
          path: "props.a",
          claims: [
            { sourceId: "s", value: evil, status: "discovered", evidenceIds: [] },
            { sourceId: "t", status: "discovered", evidenceIds: [] }
          ],
          resolution: { state: "open" }
        }
      ],
      integrity: { algorithm: "sha256", contentHash: "0".repeat(64) }
    }
    const html = renderReport({
      contract: contract as never,
      review: [],
      diagnostics: [{ code: "a.b", severity: "error", message: evil }]
    })
    expect(html).not.toContain("<img")
    expect(html).not.toMatch(/<script/i)
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;")
    expect(html).toContain("Content-Security-Policy")
  })

  it("lists every review item and diagnostic, folding rows past 200 into details", async () => {
    const dir = project("storybook/acme-ui")
    await cli(dir, "init")
    await cli(dir, "compile")
    const { parseContract } = await import("@invariant/contract")
    const parsed = parseContract(JSON.parse(read(dir, "invariant/invariant.contract.json")))
    if (!parsed.ok) throw new Error("contract invalid")
    const review = Array.from({ length: 250 }, (_, i) => ({
      priority: 1,
      kind: "inferred-fact",
      subject: `component:c${i}`,
      reason: `reason ${i}`,
      approvalRequired: true,
      evidenceIds: []
    }))
    const diagnostics = Array.from({ length: 205 }, (_, i) => ({
      code: "x.y",
      severity: "info" as const,
      message: `message ${i}`
    }))
    const html = renderReport({ contract: parsed.value, review: review as never, diagnostics })
    expect(html).toContain("component:c0")
    expect(html).toContain("component:c249")
    expect(html).toContain("message 204")
    expect(html).toContain("<details><summary>Show the remaining 50 rows</summary>")
    expect(html).toContain("<details><summary>Show the remaining 5 rows</summary>")
    expect(html).not.toMatch(/more in invariant\./)
    expect(html).not.toMatch(/<script/i)
  })

  it("is produced by compile, self-contained, and reproducible", async () => {
    const dir = project("storybook/acme-ui")
    await cli(dir, "init")
    await cli(dir, "compile")
    const html = read(dir, "invariant/invariant.report.html")
    expect(html).toContain("component:button")
    expect(html).not.toMatch(/<script|https?:\/\//i)
  })
})

describe("golden output", () => {
  it("matches the committed artifacts for the cross-framework fixture", async () => {
    const dir = project("cross-framework/demo")
    writeFileSync(
      path.join(dir, "invariant.config.json"),
      JSON.stringify({
        name: "Fixture DS",
        sources: [
          { id: "react", type: "react" },
          { id: "vue", type: "vue" },
          { id: "angular", type: "angular" }
        ]
      })
    )
    expect((await cli(dir, "compile")).code).toBe(0)
    const golden = path.join(root, "fixtures/cli-golden/cross-framework")
    const out = path.join(dir, "invariant")
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(golden)) {
      rmSync(golden, { recursive: true, force: true })
      mkdirSync(golden, { recursive: true })
      for (const f of readdirSync(out)) writeFileSync(path.join(golden, f), read(out, f))
    }
    expect(readdirSync(out).sort()).toEqual(readdirSync(golden).sort())
    for (const f of readdirSync(golden)) expect(read(out, f), f).toBe(read(golden, f))
  })
})
