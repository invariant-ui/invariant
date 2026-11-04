import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { run } from "@invariant/cli"
import { FIXED_CLOCK } from "@invariant/compiler-core/testing"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("..", import.meta.url))
const fixtures = path.join(root, "fixtures/pattern-discovery")
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

let dir = ""
const file = (name: string): string => readFileSync(path.join(dir, name), "utf8")
const candidates = () =>
  JSON.parse(file("invariant/invariant.candidates.json")) as {
    candidates: Array<{
      id: string
      kind: string
      status: string
      structure: { key: string }
      subsumedBy?: string
    }>
    diagnostics: Array<{ code: string }>
  }

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "invariant-pattern-discovery-"))
  made.push(dir)
  cpSync(path.join(root, "fixtures/storybook/acme-ui"), dir, {
    recursive: true,
    filter: (s) => !s.includes("storybook-static")
  })
  cpSync(path.join(fixtures, "app"), path.join(dir, "app"), { recursive: true })
  expect((await cli(dir, "init")).code).toBe(0)
  expect((await cli(dir, "compile")).code).toBe(0)
})

describe("discovering patterns in application code", () => {
  it("finds recurring structures as proposed candidates and writes nothing else", async () => {
    const r = await cli(dir, "discover", "app")
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/candidates written to invariant\.candidates\.json/)
    expect(r.out).toMatch(/not approved patterns/)
    const found = candidates()
    expect(found.candidates.length).toBeGreaterThan(0)
    expect(found.candidates.every((c) => c.status === "proposed")).toBe(true)
    expect(found.candidates.map((c) => c.structure.key)).toContain("modal(button)")
    expect(found.candidates.map((c) => c.kind)).toContain("similar-files")
    expect(found.diagnostics.map((d) => d.code)).toContain("discovery-unsupported-files")
    expect(existsSync(path.join(dir, "invariant.patterns.json"))).toBe(false)
    expect(existsSync(path.join(dir, "invariant.candidate-reviews.json"))).toBe(false)
  })

  it("writes the same bytes every time", async () => {
    await cli(dir, "discover", "app")
    const first = file("invariant/invariant.candidates.json")
    await cli(dir, "discover", "app/other", "app/pages")
    expect(file("invariant/invariant.candidates.json")).toBe(first)
  })

  it("lists, hides what sits inside a larger candidate unless asked, and shows the evidence", async () => {
    const all = JSON.parse((await cli(dir, "candidates", "list", "--all", "--json")).out) as Array<{
      subsumedBy?: string
    }>
    const visible = JSON.parse((await cli(dir, "candidates", "list", "--json")).out) as unknown[]
    expect(visible.length).toBeLessThan(all.length)
    const id = candidates().candidates.find((c) => c.structure.key === "modal(button)")?.id as string
    const shown = await cli(dir, "candidates", "show", id.replace("candidate:", ""))
    expect(shown.code).toBe(0)
    expect(shown.out).toMatch(/why it was found/)
    expect(shown.out).toMatch(/app\/pages\/Accounts\.tsx:\d+:\d+/)
    expect(shown.out).toMatch(/No decision recorded/)
  })

  it("will not promote a candidate nobody accepted", async () => {
    const id = candidates().candidates[0]?.id as string
    const r = await cli(dir, "candidates", "promote", id, "--id", "composition.thing", "--as", "ana")
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/proposed\. Accept it first/)
  })

  it("needs a name for who decides", async () => {
    const id = candidates().candidates[0]?.id as string
    const r = await cli(dir, "candidates", "accept", id)
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/say who is deciding/)
  })

  it("records decisions, keeps them across a new discovery, and turns an accepted one into an unapproved definition", async () => {
    const found = candidates().candidates
    const modal = found.find((c) => c.structure.key === "modal(button)")?.id as string
    const other = found.find((c) => c.kind === "similar-files")?.id as string
    expect(
      (
        await cli(
          dir,
          "candidates",
          "accept",
          modal,
          "--as",
          "ana",
          "--note",
          "our confirm dialog",
          "--reference",
          "DS-77"
        )
      ).code
    ).toBe(0)
    expect(
      (await cli(dir, "candidates", "reject", other, "--as", "ben", "--note", "just a coincidence")).code
    ).toBe(0)
    const reviews = JSON.parse(file("invariant.candidate-reviews.json")) as {
      reviews: Array<{ decision: string }>
    }
    expect(reviews.reviews.map((r) => r.decision)).toEqual(["accepted", "rejected"])

    await cli(dir, "discover", "app")
    const after = candidates().candidates
    expect(after.find((c) => c.id === modal)?.status).toBe("accepted")
    expect(after.find((c) => c.id === other)?.status).toBe("rejected")

    const dry = await cli(
      dir,
      "candidates",
      "promote",
      modal,
      "--id",
      "composition.confirm-dialog",
      "--as",
      "ana",
      "--dry-run"
    )
    expect(dry.code).toBe(0)
    expect(existsSync(path.join(dir, "invariant.patterns.json"))).toBe(false)

    const promoted = await cli(
      dir,
      "candidates",
      "promote",
      modal,
      "--id",
      "composition.confirm-dialog",
      "--as",
      "ana"
    )
    expect(promoted.code).toBe(0)
    const patterns = JSON.parse(file("invariant.patterns.json")) as {
      patterns: Array<Record<string, unknown>>
    }
    const def = patterns.patterns[0] as Record<string, unknown>
    expect(def).not.toHaveProperty("approval")
    expect(def).not.toHaveProperty("constraints")
    expect(def.origin).toMatchObject({ candidate: modal, acceptedBy: "ana", reference: "DS-77" })

    const again = await cli(
      dir,
      "candidates",
      "promote",
      modal,
      "--id",
      "composition.confirm-dialog",
      "--as",
      "ana"
    )
    expect(again.code).toBe(2)
    expect(again.err).toMatch(/already has a pattern/)
  })

  it("compiles the promoted definition as documented, not approved, with its provenance", async () => {
    const compiled = await cli(dir, "compile")
    expect(compiled.code).toBe(0)
    expect(compiled.out).toMatch(/awaiting approval/)
    const contract = JSON.parse(file("invariant/invariant.contract.json")) as {
      patterns: Array<{
        id: string
        facts: Record<string, { status: string }>
        extensions?: Record<string, { candidate: string }>
      }>
    }
    const p = contract.patterns.find((x) => x.id === "pattern:composition.confirm-dialog")
    expect(p).toBeDefined()
    expect(Object.values(p?.facts ?? {}).every((f) => f.status === "documented")).toBe(true)
    expect(p?.extensions?.discovery?.candidate).toMatch(/^candidate:arrangement\./)
    const inspected = await cli(dir, "patterns", "inspect", "composition.confirm-dialog")
    expect(inspected.out).toMatch(/NOT APPROVED/)
  })

  it("rejects a bad option and a missing path", async () => {
    expect((await cli(dir, "discover")).code).toBe(2)
    expect((await cli(dir, "discover", "app", "--similarity", "2")).code).toBe(2)
    expect((await cli(dir, "discover", "nowhere")).code).toBe(2)
    expect((await cli(dir, "candidates", "show", "nope")).code).toBe(2)
  })
})
