import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { run } from "@invariant/cli"
import { FIXED_CLOCK } from "@invariant/compiler-core/testing"
import { ContractSource, McpServer } from "@invariant/mcp"
import { afterAll, describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("..", import.meta.url))
const fixtures = path.join(root, "fixtures/page-archetypes")
const made: string[] = []
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

async function cli(cwd: string, ...argv: string[]) {
  let out = ""
  let err = ""
  const code = await run(argv, {
    cwd,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    clock: FIXED_CLOCK,
    env: {}
  })
  return { code, out, err }
}

type Definitions = { patterns: Array<Record<string, any>> }
const valid = (): Definitions =>
  JSON.parse(readFileSync(path.join(fixtures, "invariant.patterns.json"), "utf8"))
const byId = (d: Definitions, id: string) => {
  const p = d.patterns.find((x) => x.id === id)
  if (!p) throw new Error(`no ${id}`)
  return p
}

async function project(definitions: Definitions = valid()): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "invariant-archetypes-e2e-"))
  made.push(dir)
  cpSync(path.join(root, "fixtures/storybook/acme-ui"), dir, {
    recursive: true,
    filter: (s) => !s.includes("storybook-static")
  })
  writeFileSync(path.join(dir, "invariant.patterns.json"), JSON.stringify(definitions))
  expect((await cli(dir, "init")).code).toBe(0)
  return dir
}
const diagnostics = (dir: string): Array<{ code: string; severity: string; message: string }> =>
  JSON.parse(readFileSync(path.join(dir, "invariant/invariant.diagnostics.json"), "utf8")).diagnostics
const contractOf = (dir: string) =>
  JSON.parse(readFileSync(path.join(dir, "invariant/invariant.contract.json"), "utf8"))
const patternDiagnostics = (dir: string) =>
  diagnostics(dir).filter((d) => d.code.startsWith("contract.pattern-"))

describe("defining page archetypes", () => {
  it("compiles three archetypes that compose shared patterns, with variations, into a valid contract", async () => {
    const dir = await project()
    const r = await cli(dir, "compile")
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/patterns 8, 5 awaiting approval/)
    expect(patternDiagnostics(dir)).toEqual([])
    const c = contractOf(dir)
    const pages = c.patterns
      .filter((p: { category: string }) => p.category === "page")
      .map((p: { id: string }) => p.id)
    expect(pages).toEqual(["pattern:page.data-management", "pattern:page.detail", "pattern:page.edit-form"])
    const dm = c.patterns.find((p: { id: string }) => p.id === "pattern:page.data-management")
    expect(dm.variations.map((v: { name: string }) => v.name)).toEqual(["bulk-actions", "minimal"])
    expect(dm.facts["variations.bulk-actions"]).toMatchObject({ status: "approved" })
    expect((await cli(dir, "verify")).code).toBe(0)
  })

  it("resolves an archetype through the CLI, to any depth, with its variations", async () => {
    const dir = await project()
    await cli(dir, "compile")
    const r = await cli(dir, "patterns", "resolve", "data-management")
    expect(r.code).toBe(0)
    expect(r.out).toMatch(
      /header {2}required, region header {2}Page header \(pattern\)\n\s+Page header {2}\[documented \*\]\n\s+title {2}required {2}Text/
    )
    expect(r.out).toMatch(/composes {2}Application shell\n\s+Application shell {2}\[documented \*\]/)
    expect(r.out).toMatch(/bulk-actions\s+The collection supports acting on many/)
    expect(r.out).toMatch(
      /note: This archetype is approved, but 3 pattern\(s\) it builds on are not: pattern:composition\.page-header, pattern:composition\.table-toolbar, pattern:layout\.app-shell/
    )
    const minimal = await cli(dir, "patterns", "resolve", "data-management", "--variation", "minimal")
    expect(minimal.out).toMatch(/toolbar {2}optional, region toolbar/)
  })

  it("resolves the same through MCP, and reports an unknown variation", async () => {
    const dir = await project()
    await cli(dir, "compile")
    const server = new McpServer({
      source: new ContractSource(path.join(dir, "invariant")),
      version: "0.0.0"
    })
    const call = async (args: Record<string, unknown>) =>
      JSON.parse(
        (await server.handleLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "get_design_patterns", arguments: args }
          })
        )) as string
      ).result
    const ok = (await call({ name: "page.edit-form", resolve: true })).structuredContent
    expect(ok.requiredStates.map((s: { state: string }) => s.state)).toEqual(["error", "submitting"])
    expect(ok.requiredStates.every((s: { enforced: boolean }) => s.enforced === false)).toBe(true)
    expect(ok.approved).toBe(false)
    const create = (await call({ name: "page.edit-form", variation: "create" })).structuredContent
    expect(create.prohibited.parts.map((p: { name: string }) => p.name)).toEqual(["remove"])
    const bad = await call({ name: "page.detail", variation: "nope" })
    expect(bad.isError).toBe(true)
    expect(bad.structuredContent.variations).toEqual(["read-only"])
  })

  it("shows which required interaction states are enforced: the approved ones are, the documented ones are not", async () => {
    const dir = await project()
    await cli(dir, "compile")
    const dm = JSON.parse((await cli(dir, "patterns", "resolve", "page.data-management", "--json")).out)
    expect(dm.requiredStates).toEqual([
      expect.objectContaining({
        pattern: "pattern:interaction.destructive-confirmation",
        state: "confirming",
        minimum: "static-inferred",
        enforced: true
      })
    ])
    const edit = JSON.parse((await cli(dir, "patterns", "resolve", "page.edit-form", "--json")).out)
    expect(edit.notes.join(" ")).toMatch(
      /2 constraint\(s\) have no approved policy, so `validate` does not enforce them/
    )
  })

  it("is reproducible, and matches the committed golden resolved views", async () => {
    const a = await project()
    const b = await project()
    await cli(a, "compile")
    await cli(b, "compile")
    const view = async (d: string, id: string) => (await cli(d, "patterns", "resolve", id, "--json")).out
    for (const id of ["page.data-management", "page.detail", "page.edit-form"])
      expect(await view(a, id)).toBe(await view(b, id))
    const out = JSON.stringify(
      Object.fromEntries(
        await Promise.all(
          ["page.data-management", "page.detail", "page.edit-form"].map(
            async (id) => [id, JSON.parse(await view(a, id))] as const
          )
        )
      ),
      null,
      2
    )
    const golden = path.join(fixtures, "expected/archetypes.json")
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(golden)) {
      mkdirSync(path.dirname(golden), { recursive: true })
      writeFileSync(golden, `${out}\n`)
    }
    expect(readFileSync(golden, "utf8")).toBe(`${out}\n`)
  })
})

describe("what is not allowed in a blueprint", () => {
  const compileWith = async (change: (d: Definitions) => void) => {
    const d = valid()
    change(d)
    const dir = await project(d)
    const r = await cli(dir, "compile")
    return { dir, code: r.code, diagnostics: patternDiagnostics(dir) }
  }

  it("rejects a circular reference that closes through a nested pattern", async () => {
    const r = await compileWith((d) => {
      byId(d, "composition.page-header").composition.parts.push({
        name: "back",
        ref: "page.detail",
        role: "optional"
      })
    })
    expect(r.code).toBe(1)
    const cycle = r.diagnostics.find((d) => d.code === "contract.pattern-cycle")
    expect(cycle?.message).toBe(
      "Patterns form a cycle: pattern:composition.page-header -> pattern:page.detail -> pattern:composition.page-header"
    )
  })

  it("rejects two patterns declared prohibited together that an archetype composes", async () => {
    const r = await compileWith((d) => {
      byId(d, "layout.app-shell").relationships = [
        { id: "never", type: "prohibited-with", target: "composition.page-header" }
      ]
    })
    expect(r.code).toBe(1)
    const found = r.diagnostics.filter((d) => d.code === "contract.pattern-prohibited-combination")
    expect(found.map((d) => d.message.split(" composes")[0]).sort()).toEqual([
      "pattern:page.data-management",
      "pattern:page.detail",
      "pattern:page.edit-form"
    ])
    expect(found[0]?.message).toMatch(
      /which are prohibited together \(pattern:layout\.app-shell prohibited-with pattern:composition\.page-header\)/
    )
  })

  it("rejects a prohibition that a composed pattern defeats, for the blueprint and for a variation", async () => {
    const base = await compileWith((d) => {
      byId(d, "page.detail").composition.parts.push({ name: "no-text", ref: "Text", role: "prohibited" })
    })
    expect(base.code).toBe(1)
    expect(base.diagnostics.find((d) => d.code === "contract.pattern-prohibited-conflict")?.message).toMatch(
      /pattern:page\.detail prohibits component:text \(part "no-text"\), but pattern:page\.detail -> pattern:composition\.page-header brings it in/
    )
    const variation = await compileWith((d) => {
      byId(d, "page.detail").variations.push({
        name: "plain",
        roles: [],
        parts: [{ name: "no-text", ref: "Text", role: "prohibited" }]
      })
    })
    expect(
      variation.diagnostics.find((d) => d.code === "contract.pattern-prohibited-conflict")?.message
    ).toMatch(/in variation "plain" prohibits component:text/)
  })

  it("lets a variation prohibit a part the base composition has", async () => {
    const r = await compileWith(() => {})
    expect(r.code).toBe(0)
    expect(r.diagnostics).toEqual([])
  })

  it("reports a variation that changes a part that does not exist", async () => {
    const r = await compileWith((d) => {
      byId(d, "page.detail").variations[0].roles.push({ part: "ghost", role: "optional" })
    })
    expect(r.code).toBe(1)
    expect(r.diagnostics.map((d) => d.code)).toContain("contract.pattern-variation-unknown-part")
  })

  it("warns, without failing, about a blueprint built on a superseded pattern", async () => {
    const r = await compileWith((d) => {
      d.patterns.push({
        id: "composition.page-header-v2",
        name: "Page header v2",
        category: "composition",
        description: "The newer header.",
        relationships: [{ id: "replaces", type: "supersedes", target: "composition.page-header" }]
      })
    })
    expect(r.code).toBe(0)
    const warnings = r.diagnostics.filter((d) => d.code === "contract.pattern-superseded-reference")
    expect(warnings.length).toBe(3)
    expect(warnings.every((w) => w.severity === "warning")).toBe(true)
    expect(warnings[0]?.message).toMatch(
      /builds on pattern:composition\.page-header, which pattern:composition\.page-header-v2 supersedes/
    )
  })

  it("warns about a required region no part fills", async () => {
    const r = await compileWith((d) => {
      const p = byId(d, "page.edit-form")
      p.composition.parts = p.composition.parts.filter((x: { region?: string }) => x.region !== "form")
      p.variations = undefined
    })
    expect(r.code).toBe(0)
    expect(r.diagnostics).toEqual([
      expect.objectContaining({ code: "contract.pattern-region-unfilled", severity: "warning" })
    ])
  })
})
