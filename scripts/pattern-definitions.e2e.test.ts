import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { run } from "@invariant/cli"
import { FIXED_CLOCK } from "@invariant/compiler-core/testing"
import { ContractSource, McpServer } from "@invariant/mcp"
import { afterAll, describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("..", import.meta.url))
const fixtures = path.join(root, "fixtures/pattern-definitions")
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

async function project(definitions: string): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "invariant-patterns-e2e-"))
  made.push(dir)
  cpSync(path.join(root, "fixtures/storybook/acme-ui"), dir, {
    recursive: true,
    filter: (s) => !s.includes("storybook-static")
  })
  cpSync(definitions, path.join(dir, "invariant.patterns.json"))
  expect((await cli(dir, "init")).code).toBe(0)
  return dir
}

const read = (dir: string, rel: string): string => readFileSync(path.join(dir, rel), "utf8")
const contractOf = (dir: string) => JSON.parse(read(dir, "invariant/invariant.contract.json"))
const diagnosticsOf = (dir: string): Array<{ code: string; severity: string; message: string }> =>
  JSON.parse(read(dir, "invariant/invariant.diagnostics.json")).diagnostics

describe("pattern definitions: define, compile, query", () => {
  it("compiles a definitions file into patterns, constraints, policies and evidence", async () => {
    const dir = await project(path.join(fixtures, "invariant.patterns.json"))
    const r = await cli(dir, "compile")
    expect(r.out).toMatch(/patterns 3, 1 awaiting approval, policies 2/)
    expect(r.code).toBe(0)
    const c = contractOf(dir)
    expect(c.patterns.map((p: { id: string }) => p.id)).toEqual([
      "pattern:composition.card-with-actions",
      "pattern:interaction.destructive-confirmation",
      "pattern:page.settings"
    ])
    expect(c.constraints.map((k: { id: string }) => k.id)).toEqual([
      "constraint:composition.card-with-actions.header-first",
      "constraint:interaction.destructive-confirmation.dialog-has-confirm",
      "constraint:page.settings.content-required"
    ])
    expect(c.policies.map((p: { id: string }) => p.id)).toEqual([
      "policy:interaction.destructive-confirmation.dialog-has-confirm",
      "policy:page.settings.content-required"
    ])
    expect(c.sources.find((s: { id: string }) => s.id === "patterns")).toMatchObject({
      type: "patterns",
      location: "invariant.patterns.json",
      health: { status: "ok", diagnosticCount: 0 }
    })
    expect((await cli(dir, "verify")).code).toBe(0)
  })

  it("resolves names to ids and derives the component list", async () => {
    const dir = await project(path.join(fixtures, "invariant.patterns.json"))
    await cli(dir, "compile")
    const c = contractOf(dir)
    const card = c.patterns.find((p: { id: string }) => p.id === "pattern:composition.card-with-actions")
    expect(card.composition.parts.map((p: { ref: string }) => p.ref)).toEqual([
      "component:card",
      "component:card.header",
      "component:card.body",
      "component:button"
    ])
    expect(card.components).toEqual([
      "component:button",
      "component:card",
      "component:card.body",
      "component:card.header"
    ])
    const settings = c.patterns.find((p: { id: string }) => p.id === "pattern:page.settings")
    expect(settings.relationships.map((r: { target: string }) => r.target)).toEqual([
      "pattern:composition.card-with-actions",
      "pattern:interaction.destructive-confirmation"
    ])
    const ordering = c.constraints.find((k: { id: string }) => k.id.endsWith("header-first"))
    expect(ordering.details).toEqual({
      after: "component:card.body",
      before: "component:card.header",
      within: "component:card"
    })
  })

  it("keeps documented and approved definitions apart, with evidence for every fact", async () => {
    const dir = await project(path.join(fixtures, "invariant.patterns.json"))
    await cli(dir, "compile")
    const c = contractOf(dir)
    const evidence = JSON.parse(read(dir, "invariant/invariant.evidence.json")).evidence
    const ids = new Set(evidence.map((e: { id: string }) => e.id))
    const statuses = (id: string): string[] => [
      ...new Set(
        Object.values(
          c.patterns.find((p: { id: string }) => p.id === id).facts as Record<string, { status: string }>
        ).map((f) => f.status)
      )
    ]
    expect(statuses("pattern:composition.card-with-actions")).toEqual(["documented"])
    expect(statuses("pattern:interaction.destructive-confirmation")).toEqual(["approved"])
    expect(statuses("pattern:page.settings")).toEqual(["approved"])
    for (const p of c.patterns)
      for (const f of Object.values(p.facts) as Array<{
        evidenceIds: string[]
        approval?: { priorStatus: string }
      }>) {
        expect(f.evidenceIds.length).toBeGreaterThan(0)
        for (const e of f.evidenceIds) expect(ids.has(e)).toBe(true)
        if (f.approval) expect(f.approval.priorStatus).toBe("documented")
      }
    expect(evidence.find((e: { sourceId: string }) => e.sourceId === "patterns")).toMatchObject({
      method: "manual",
      location: { type: "file", path: "invariant.patterns.json" }
    })
  })

  it("generates policies only for approved patterns, scoped to the pattern and its paths", async () => {
    const dir = await project(path.join(fixtures, "invariant.patterns.json"))
    await cli(dir, "compile")
    const policy = contractOf(dir).policies.find(
      (p: { id: string }) => p.id === "policy:interaction.destructive-confirmation.dialog-has-confirm"
    )
    expect(policy).toMatchObject({
      severity: "error",
      enforcement: "block",
      scope: {
        entities: ["pattern:interaction.destructive-confirmation"],
        frameworks: ["react"],
        paths: ["src/**"]
      },
      basedOn: ["constraint:interaction.destructive-confirmation.dialog-has-confirm"],
      approval: { approvedBy: "design-system-owners", reference: "DS-210" }
    })
    const raw = JSON.parse(read(dir, "invariant.patterns.json"))
    delete raw.patterns[1].approval
    writeFileSync(path.join(dir, "invariant.patterns.json"), JSON.stringify(raw))
    const again = await cli(dir, "compile")
    expect(again.code).toBe(0)
    expect(diagnosticsOf(dir).map((d) => d.code)).toContain("governance.pattern-policy-needs-approval")
    expect(contractOf(dir).policies.map((p: { id: string }) => p.id)).toEqual([
      "policy:page.settings.content-required"
    ])
  })

  it("lists unapproved definition facts for review and lets a person approve one", async () => {
    const dir = await project(path.join(fixtures, "invariant.patterns.json"))
    await cli(dir, "compile")
    const queue = JSON.parse((await cli(dir, "review", "list", "--kind", "pattern-fact", "--json")).out)
    expect(new Set(queue.map((i: { subject: string }) => i.subject))).toEqual(
      new Set([
        "pattern:composition.card-with-actions",
        "constraint:composition.card-with-actions.header-first"
      ])
    )
    const intent = queue.find(
      (i: { subject: string; path: string }) =>
        i.subject === "pattern:composition.card-with-actions" && i.path === "intent"
    )
    expect(intent).toMatchObject({ kind: "pattern-fact", priority: "low", state: "pending" })

    const approved = await cli(dir, "review", "approve", intent.id, "--as", "Jane Doe", "--role", "owner")
    expect(approved.code).toBe(0)
    expect((await cli(dir, "compile")).code).toBe(0)
    const card = contractOf(dir).patterns.find(
      (p: { id: string }) => p.id === "pattern:composition.card-with-actions"
    )
    expect(card.facts.intent).toMatchObject({
      status: "approved",
      approval: { approvedBy: "Jane Doe", priorStatus: "documented" }
    })
    expect(card.facts.description.status).toBe("documented")
    const rejected = await cli(dir, "review", "reject", queue[0].id, "--as", "Jane Doe")
    expect(rejected.code).toBe(2)
    expect(rejected.err).toMatch(/part of a pattern you wrote/)
  })

  it("marks a decision stale when the definition changes after it was approved", async () => {
    const dir = await project(path.join(fixtures, "invariant.patterns.json"))
    await cli(dir, "compile")
    const queue = JSON.parse((await cli(dir, "review", "list", "--kind", "pattern-fact", "--json")).out)
    const intent = queue.find(
      (i: { subject: string; path: string }) =>
        i.subject === "pattern:composition.card-with-actions" && i.path === "intent"
    )
    await cli(dir, "review", "approve", intent.id, "--as", "Jane Doe")
    const raw = JSON.parse(read(dir, "invariant.patterns.json"))
    raw.patterns[0].intent = "Something else entirely."
    writeFileSync(path.join(dir, "invariant.patterns.json"), JSON.stringify(raw))
    await cli(dir, "compile")
    expect(diagnosticsOf(dir).map((d) => d.code)).toContain("governance.decision-stale")
    const card = contractOf(dir).patterns.find(
      (p: { id: string }) => p.id === "pattern:composition.card-with-actions"
    )
    expect(card.facts.intent.status).toBe("documented")
  })

  it("is reproducible: the same files compile to the same bytes", async () => {
    const a = await project(path.join(fixtures, "invariant.patterns.json"))
    const b = await project(path.join(fixtures, "invariant.patterns.json"))
    await cli(a, "compile")
    await cli(b, "compile")
    for (const f of ["contract", "evidence", "diagnostics", "review"])
      expect(read(a, `invariant/invariant.${f}.json`), f).toBe(read(b, `invariant/invariant.${f}.json`))
  })

  it("exposes the compiled patterns to an agent and to the CLI", async () => {
    const dir = await project(path.join(fixtures, "invariant.patterns.json"))
    await cli(dir, "compile")
    const list = await cli(dir, "patterns", "list")
    expect(list.out).toMatch(/pattern:page\.settings\s+Settings page\s+page\s+approved/)
    expect(list.out).toMatch(
      /pattern:composition\.card-with-actions\s+Card with actions\s+composition\s+documented \*/
    )
    const server = new McpServer({
      source: new ContractSource(path.join(dir, "invariant")),
      version: "0.0.0"
    })
    const line = await server.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_design_patterns", arguments: { name: "settings" } }
      })
    )
    const data = JSON.parse(line as string).result.structuredContent
    expect(data).toMatchObject({ id: "pattern:page.settings", approved: true })
    expect(data.enforcedBy.map((e: { policy: string }) => e.policy)).toEqual([
      "policy:page.settings.content-required"
    ])
    const rel = await server.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "get_pattern_relationships",
          arguments: { name: "settings", direction: "out", types: ["composes"] }
        }
      })
    )
    expect(JSON.parse(rel as string).result.structuredContent.edges.map((e: { to: string }) => e.to)).toEqual(
      ["pattern:composition.card-with-actions"]
    )
  })

  it("matches the committed golden pattern entities", async () => {
    const dir = await project(path.join(fixtures, "invariant.patterns.json"))
    await cli(dir, "compile")
    const c = contractOf(dir)
    const out = `${JSON.stringify({ patterns: c.patterns, constraints: c.constraints, policies: c.policies }, null, 2)}\n`
    const golden = path.join(fixtures, "expected/patterns.json")
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(golden)) {
      mkdirSync(path.dirname(golden), { recursive: true })
      writeFileSync(golden, out)
    }
    expect(readFileSync(golden, "utf8")).toBe(out)
  })
})

describe("pattern definitions: problems are reported, never guessed", () => {
  it("leaves out a pattern with a bad reference, says why, and still adds the valid ones", async () => {
    const dir = await project(path.join(fixtures, "invalid/invariant.patterns.json"))
    const r = await cli(dir, "compile")
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/patterns 1 \(2 skipped\)/)
    const diagnostics = diagnosticsOf(dir)
    const codes = diagnostics.map((d) => d.code)
    expect(codes).toEqual(
      expect.arrayContaining([
        "governance.pattern-unknown-component",
        "governance.pattern-unknown-token",
        "governance.pattern-unknown-pattern",
        "governance.pattern-unknown-region",
        "governance.pattern-constraint-invalid",
        "governance.pattern-skipped",
        "governance.pattern-duplicate-id"
      ])
    )
    const text = diagnostics.map((d) => d.message).join("\n")
    expect(text).toMatch(/there is no component or pattern "Txet"; did you mean Text\?/)
    expect(text).toMatch(/there is no component or pattern "DataTable"/)
    expect(text).toMatch(/there is no token "spacing\.huge"/)
    expect(text).toMatch(/there is no pattern "layout\.nowhere"/)
    expect(text).toMatch(/region:footer is not a region of this pattern/)
    expect(text).toMatch(/details do not fit a cardinality constraint.*state min, max or both/)
    expect(text).toMatch(/pattern:page\.broken was not added to the contract because of the 6 problem/)
    const c = contractOf(dir)
    expect(c.patterns.map((p: { id: string }) => p.id)).toEqual(["pattern:composition.fine"])
    expect(c.sources.find((s: { id: string }) => s.id === "patterns").health).toMatchObject({
      status: "degraded"
    })
    expect(c.patterns.some((p: { id: string }) => p.id === "pattern:page.broken")).toBe(false)
  })

  it("rejects a file that does not fit the schema and says where", async () => {
    const dir = await project(path.join(fixtures, "invariant.patterns.json"))
    writeFileSync(
      path.join(dir, "invariant.patterns.json"),
      JSON.stringify({
        version: 1,
        patterns: [{ id: "page.x", name: "X", category: "dashboard", description: "d" }]
      })
    )
    const r = await cli(dir, "compile")
    expect(r.code).toBe(1)
    expect(diagnosticsOf(dir).find((d) => d.code === "governance.invalid-file")?.message).toMatch(
      /invariant\.patterns\.json is invalid at patterns\.0\.category/
    )
    writeFileSync(path.join(dir, "invariant.patterns.json"), "{ nope")
    await cli(dir, "compile")
    expect(diagnosticsOf(dir).find((d) => d.code === "governance.invalid-file")?.message).toMatch(
      /not valid JSON/
    )
  })

  it("does nothing when there is no definitions file", async () => {
    const dir = await project(path.join(fixtures, "invariant.patterns.json"))
    rmSync(path.join(dir, "invariant.patterns.json"))
    const r = await cli(dir, "compile")
    expect(r.code).toBe(0)
    expect(contractOf(dir).patterns).toEqual([])
    expect(contractOf(dir).sources.some((s: { id: string }) => s.id === "patterns")).toBe(false)
  })
})
