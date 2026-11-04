import { cpSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { run } from "@invariant/cli"
import { FIXED_CLOCK } from "@invariant/compiler-core/testing"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("..", import.meta.url))
const fixtures = path.join(root, "fixtures/pattern-inheritance")
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

interface Evaluation {
  rule: string
  status: string
  reason: string
  file: string
  policy: string
  inheritedFrom?: string
}
interface Violation {
  code: string
  file: string
  message: string
}

let dir = ""
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "invariant-pattern-inheritance-"))
  made.push(dir)
  cpSync(path.join(root, "fixtures/storybook/acme-ui"), dir, {
    recursive: true,
    filter: (s) => !s.includes("storybook-static")
  })
  cpSync(path.join(fixtures, "app"), path.join(dir, "app"), { recursive: true })
  cpSync(path.join(fixtures, "invariant.patterns.json"), path.join(dir, "invariant.patterns.json"))
  expect((await cli(dir, "init")).code).toBe(0)
  expect((await cli(dir, "compile")).code).toBe(0)
})

const validate = async (file: string) => {
  const r = await cli(dir, "validate", file, "--format", "json")
  return JSON.parse(r.out) as { violations: Violation[]; evaluations: Evaluation[] }
}
const summary = (list: Evaluation[]): string[] =>
  list.map((e) => `${e.rule.replace("pattern-", "")} ${e.status} ${e.inheritedFrom ?? "own"}`).sort()

describe("constraint inheritance through an approved page pattern", () => {
  it("holds a page file to the constraints of what the page composes", async () => {
    const r = await validate("app/pages/Bad.tsx")
    expect(summary(r.evaluations)).toEqual([
      "cardinality-violated fail pattern:page.reports",
      "required-child-missing fail pattern:page.reports",
      "required-child-missing fail pattern:page.reports"
    ])
    expect(r.violations.map((v) => v.message).join("\n")).toMatch(/inherited through pattern:page\.reports/)
  })

  it("records a pass for a page that follows them", async () => {
    const r = await validate("app/pages/Good.tsx")
    expect(summary(r.evaluations)).toEqual([
      "cardinality-violated pass pattern:page.reports",
      "required-child-missing pass pattern:page.reports"
    ])
    expect(r.violations).toEqual([])
  })

  it("evaluates a rule once when the file is in both the policy's paths and the page's, keeping the policy's own route", async () => {
    const r = await validate("app/pages/ConfirmDialog.tsx")
    expect(summary(r.evaluations)).toEqual([
      "cardinality-violated pass own",
      "required-child-missing fail own"
    ])
  })

  it("leaves a file the policy already covers as it was", async () => {
    const r = await validate("app/dialogs/Direct.tsx")
    expect(summary(r.evaluations)).toEqual([
      "cardinality-violated fail own",
      "required-child-missing fail own",
      "required-child-missing fail own"
    ])
  })

  it("inherits nothing from a page nobody approved", async () => {
    const r = await validate("app/drafts/Draft.tsx")
    expect(r.evaluations).toEqual([])
  })

  it("inherits nothing unless the page opts in", async () => {
    const r = await validate("app/other/Plain.tsx")
    expect(r.evaluations).toEqual([])
  })
})
