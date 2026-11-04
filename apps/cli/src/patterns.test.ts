import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { FIXED_CLOCK } from "@invariant/compiler-core/testing"
import { afterAll, describe, expect, it } from "vitest"
import { run } from "./cli.js"

const fixture = fileURLToPath(new URL("../../../packages/contract/fixtures/patterns", import.meta.url))
const made: string[] = []
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

/** A project directory whose `invariant/` output is the sample pattern contract. */
function project(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "invariant-patterns-"))
  made.push(dir)
  mkdirSync(path.join(dir, "invariant"))
  cpSync(fixture, path.join(dir, "invariant"), { recursive: true })
  return dir
}

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

describe("patterns list", () => {
  it("lists every pattern with its derived status and marks the ones that are not approved", async () => {
    const r = await cli(project(), "patterns", "list")
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/pattern:page\.data-management\s+Data management page\s+page\s+mixed \*/)
    expect(r.out).toMatch(/pattern:form\.login\s+Login form\s+form\s+none \*/)
    expect(r.out).toMatch(/\* not approved: treat as a proposal/)
  })

  it("filters by category and status", async () => {
    const dir = project()
    const byCategory = await cli(dir, "patterns", "list", "--category", "interaction")
    expect(byCategory.out).toMatch(/destructive-confirmation/)
    expect(byCategory.out).not.toMatch(/data-management/)
    const byStatus = await cli(dir, "patterns", "list", "--status", "documented")
    expect(byStatus.out).toMatch(/application-shell/)
    expect(byStatus.out).not.toMatch(/form\.login/)
    expect((await cli(dir, "patterns", "list", "--category", "dialog")).out).toMatch(
      /no pattern matches these filters \(5 in the contract\)/
    )
  })

  it("keeps --json as the patterns written in the contract", async () => {
    const dir = project()
    const all = JSON.parse((await cli(dir, "patterns", "list", "--json")).out)
    expect(all).toHaveLength(5)
    expect(all[0]).toHaveProperty("facts")
    const one = JSON.parse((await cli(dir, "patterns", "list", "--category", "page", "--json")).out)
    expect(one.map((p: { id: string }) => p.id)).toEqual(["pattern:page.data-management"])
  })

  it("rejects a bad filter with exit code 2", async () => {
    const dir = project()
    for (const argv of [
      ["--category", "bogus"],
      ["--status", "bogus"]
    ]) {
      const r = await cli(dir, "patterns", "list", ...argv)
      expect(r.code).toBe(2)
      expect(r.err).toMatch(/must be one of/)
    }
  })

  it("says when there are no patterns at all", async () => {
    // A project compiled before patterns existed: the same command still works and says so.
    const none = await cli(await emptyProject(), "patterns", "list")
    expect(none.code).toBe(0)
    expect(none.out).toMatch(/^no patterns\./)
  })
})

async function emptyProject(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "invariant-patterns-"))
  made.push(dir)
  mkdirSync(path.join(dir, "invariant"))
  cpSync(
    fileURLToPath(new URL("../../../fixtures/cli-golden/cross-framework", import.meta.url)),
    path.join(dir, "invariant"),
    { recursive: true }
  )
  return dir
}

describe("patterns inspect", () => {
  it("shows parts, regions, behavior, constraints, relationships and that the pattern is not approved", async () => {
    const r = await cli(project(), "patterns", "inspect", "data-management")
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/Data management page {2}\(pattern:page\.data-management\)/)
    expect(r.out).toMatch(/NOT APPROVED/)
    expect(r.out).toMatch(/status: mixed \(/)
    expect(r.out).toMatch(/toolbar\s+required\s+Table toolbar\s+results/)
    expect(r.out).toMatch(/behavior \(initial state: loading\)/)
    expect(r.out).toMatch(/constraint:data-management\.single-table\s+cardinality/)
    expect(r.out).toMatch(/delete\s+uses\s+Destructive confirmation\s+inferred/)
    expect(r.out).toMatch(/enforced by: no approved policy/)
    expect(r.out).toMatch(/note: .*not fully approved/)
  })

  it("adds the source of every fact with --evidence", async () => {
    const r = await cli(project(), "patterns", "inspect", "page.data-management", "--evidence")
    expect(r.out).toMatch(
      /relationships\.delete\s+inferred 0\.6\s+packages\/ui-react\/src\/CustomerList\.tsx:52 \[ast\]/
    )
    expect(r.out).toMatch(/intent\s+documented\s+page\/data-management \[document-parse\]/)
    expect((await cli(project(), "patterns", "inspect", "page.data-management")).out).not.toMatch(
      /\nevidence\n/
    )
  })

  it("prints the full view as JSON", async () => {
    const view = JSON.parse((await cli(project(), "patterns", "inspect", "data-management", "--json")).out)
    expect(view).toMatchObject({ id: "pattern:page.data-management", approved: false })
    expect(view.facts.length).toBeGreaterThan(0)
  })

  it("reports an unknown pattern with candidates, and a missing name as usage", async () => {
    const dir = project()
    const unknown = await cli(dir, "patterns", "inspect", "toolba")
    expect(unknown.code).toBe(2)
    expect(unknown.err).toMatch(/no pattern matches "toolba"/)
    expect((await cli(dir, "patterns", "inspect")).err).toMatch(/usage: invariant patterns/)
    expect((await cli(dir, "patterns", "inspect", "xyzzy")).err).not.toMatch(/Did you mean/)
  })
})

describe("patterns relationships and search", () => {
  it("shows relationships with names, roles and the status of each edge", async () => {
    const r = await cli(project(), "patterns", "relationships", "data-management", "--direction", "out")
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/Data management page\s+composes\s+Application shell/)
    expect(r.out).toMatch(/Data management page\s+part \(required\)\s+DataTable/)
    expect(r.out).toMatch(/Data management page\s+uses\s+Destructive confirmation\s+inferred/)
  })

  it("walks incoming edges and deeper on request", async () => {
    const dir = project()
    const incoming = await cli(dir, "patterns", "relationships", "table-toolbar", "--direction", "in")
    expect(incoming.out).toMatch(/Data management page\s+composes\s+Table toolbar/)
    const deep = await cli(
      dir,
      "patterns",
      "relationships",
      "data-management",
      "--direction",
      "out",
      "--depth",
      "2"
    )
    expect(deep.out).toMatch(/Table toolbar\s+part \(required\)\s+SearchField/)
    const json = JSON.parse((await cli(dir, "patterns", "relationships", "data-management", "--json")).out)
    expect(json).toMatchObject({ direction: "both", depth: 1 })
  })

  it("rejects a bad direction or depth, and says when there is nothing to show", async () => {
    const dir = project()
    expect((await cli(dir, "patterns", "relationships", "data-management", "--direction", "up")).code).toBe(2)
    for (const depth of ["0", "6", "x", "1.5"])
      expect(
        (await cli(dir, "patterns", "relationships", "data-management", "--depth", depth)).err,
        depth
      ).toMatch(/--depth must be/)
    expect((await cli(dir, "patterns", "relationships", "login")).out).toMatch(
      /no relationships in this direction/
    )
  })

  it("searches patterns by words, with typo tolerance", async () => {
    const dir = project()
    const r = await cli(dir, "patterns", "search", "toolbar")
    expect(r.out).toMatch(/pattern:composition\.table-toolbar\s+Table toolbar\s+\d+\s+name/)
    expect((await cli(dir, "patterns", "search", "toolbarr")).out).toMatch(/table-toolbar/)
    expect((await cli(dir, "patterns", "search", "zzzzzz")).out).toMatch(/no pattern matches "zzzzzz"/)
    expect((await cli(dir, "patterns", "search")).code).toBe(2)
    expect(JSON.parse((await cli(dir, "patterns", "search", "toolbar", "--json")).out)[0].kind).toBe(
      "pattern"
    )
  })

  it("rejects an unknown subcommand and prints usage", async () => {
    const r = await cli(project(), "patterns", "validate", "src")
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/usage: invariant patterns/)
  })
})

describe("patterns resolve", () => {
  const archetypes = fileURLToPath(new URL("../../../packages/contract/fixtures/archetypes", import.meta.url))
  function archetypeProject(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "invariant-archetypes-"))
    made.push(dir)
    mkdirSync(path.join(dir, "invariant"))
    cpSync(archetypes, path.join(dir, "invariant"), { recursive: true })
    return dir
  }

  it("shows the blueprint: regions, composition to any depth, variations and what it builds on", async () => {
    const r = await cli(archetypeProject(), "patterns", "resolve", "data-management")
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/Data management page {2}\(pattern:page\.data-management\)/)
    expect(r.out).toMatch(/results\s+yes\s+table, empty, toolbar|results\s+yes\s+toolbar, table/)
    expect(r.out).toMatch(
      /toolbar {2}required, region results {2}Table toolbar \(pattern\)\n\s+Table toolbar {2}\[documented \*\]\n\s+search {2}required {2}SearchField/
    )
    expect(r.out).toMatch(/variations\n.*\n.*\nbulk\s+People select several rows/)
    expect(r.out).toMatch(/note: This archetype is not fully approved/)
  })

  it("applies a variation, and says so", async () => {
    const r = await cli(archetypeProject(), "patterns", "resolve", "page.detail", "--variation", "read-only")
    expect(r.out).toMatch(/Detail page {2}\(pattern:page\.detail\) {2}variation: read-only/)
    expect(r.out).toMatch(/prohibited parts: actions/)
    expect(r.out).toMatch(/Showing the "read-only" variation/)
  })

  it("is honest about an approved archetype that builds on patterns that are not", async () => {
    const r = await cli(archetypeProject(), "patterns", "resolve", "page.detail")
    expect(r.out).toMatch(/status: approved/)
    expect(r.out).toMatch(/Approval of the archetype does not approve them/)
    expect(r.out).toMatch(/Application shell {2}\[documented \*\]/)
  })

  it("lists required interaction states and whether they are enforced", async () => {
    const r = await cli(archetypeProject(), "patterns", "resolve", "edit-form")
    expect(r.out).toMatch(/required interaction states/)
    expect(r.out).toMatch(/pattern:interaction\.form-workflow\s+form-submission\s+error\s+structural\s+no/)
    expect(r.out).toMatch(
      /pattern:interaction\.form-workflow\s+form-submission\s+submitting\s+static-inferred\s+no/
    )
  })

  it("prints the whole view as JSON", async () => {
    const view = JSON.parse((await cli(archetypeProject(), "patterns", "resolve", "detail", "--json")).out)
    expect(view).toMatchObject({ id: "pattern:page.detail", approved: true })
    expect(view.patterns.length).toBe(3)
  })

  it("rejects an unknown variation and an unknown pattern with exit code 2", async () => {
    const dir = archetypeProject()
    const bad = await cli(dir, "patterns", "resolve", "detail", "--variation", "nope")
    expect(bad.code).toBe(2)
    expect(bad.err).toMatch(/has no variation "nope"; its variations are read-only, with-history/)
    expect((await cli(dir, "patterns", "resolve", "nope")).code).toBe(2)
    expect((await cli(dir, "patterns", "resolve")).err).toMatch(/usage: invariant patterns/)
  })
})
