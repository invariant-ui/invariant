import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { run } from "@invariant/cli"
import { FIXED_CLOCK } from "@invariant/compiler-core/testing"
import { PLAN_RULES, RULES } from "@invariant/validation"
import { afterAll, describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("..", import.meta.url))
const fixtures = path.join(root, "fixtures/validation")
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

async function project(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "invariant-p10-"))
  made.push(dir)
  cpSync(path.join(root, "fixtures/storybook/acme-ui"), dir, {
    recursive: true,
    filter: (s) => !s.includes("storybook-static")
  })
  cpSync(path.join(fixtures, "app"), path.join(dir, "app"), { recursive: true })
  cpSync(path.join(fixtures, "invariant.policies.json"), path.join(dir, "invariant.policies.json"))
  mkdirSync(path.join(dir, "src/styles"), { recursive: true })
  cpSync(path.join(fixtures, "tokens.css"), path.join(dir, "src/styles/tokens.css"))
  // A deprecated component, declared the way a library would.
  const icon = readFileSync(path.join(dir, "src/Icon.tsx"), "utf8")
  writeFileSync(
    path.join(dir, "src/Icon.tsx"),
    icon.replace(/export (const|function) Icon/, "/** @deprecated Use Glyph. */\nexport $1 Icon")
  )
  expect((await cli(dir, "init")).code).toBe(0)
  const compiled = await cli(dir, "compile")
  expect(compiled.code).toBe(0)
  return dir
}

interface V {
  file: string
  line: number
  column: number
  code: string
  severity: string
  message: string
  suggestion?: string
  source?: string
  policy?: string
  basis: string
  subject?: string
}

describe("Phase 10 exit criterion: invariant validate gives actionable, evidence-backed diagnostics", () => {
  it("covers all eleven initial rules on one realistic file", async () => {
    const dir = await project()
    const r = await cli(dir, "validate", "app/Screen.tsx", "--format", "json")
    expect(r.code).toBe(1)
    const violations = JSON.parse(r.out).violations as V[]
    const planRules = new Set(violations.map((v) => RULES.find((x) => x.code === v.code)?.plan))
    for (const rule of PLAN_RULES)
      expect(planRules.has(rule), `no violation for plan rule "${rule}"`).toBe(true)
  })

  it("every violation says where, which rule, why, and how to fix; every contract-based one cites its evidence", async () => {
    const dir = await project()
    const violations = JSON.parse((await cli(dir, "validate", "app", "--format", "json")).out)
      .violations as V[]
    expect(violations.length).toBeGreaterThan(10)
    const absence = new Set([
      "component-unknown",
      "unknown-css-variable",
      "color-not-in-tokens",
      "unknown-prop",
      "unverifiable-prop",
      "component-ambiguous",
      "native-element-has-equivalent",
      "framework-not-implemented"
    ])
    for (const v of violations) {
      expect(v.file).toMatch(/^app\//)
      expect(v.line).toBeGreaterThan(0)
      expect(v.column).toBeGreaterThan(0)
      expect(v.message.length).toBeGreaterThan(10)
      if (v.severity !== "info") expect(v.suggestion, `${v.code} has no suggestion`).toBeTruthy()
      if (!absence.has(v.code))
        expect(Boolean(v.source || v.policy), `${v.code} cites neither evidence nor a policy`).toBe(true)
      if (v.policy) expect(v.basis).toBe("approved")
    }
    const evidence = violations.find((v) => v.code === "prop-value-not-allowed")
    expect(evidence?.source).toMatch(/^src\/Button\.tsx:\d+$/)
    const policy = violations.find((v) => v.code === "accessibility-requirement-missing")
    expect(policy).toMatchObject({
      policy: "policy:icon-buttons-need-labels",
      source: "invariant.policies.json",
      severity: "error"
    })
  })

  it("passes clean code, so CI can gate on it", async () => {
    const dir = await project()
    const r = await cli(dir, "validate", "app/Clean.tsx", "--fail-on", "warning")
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/0 errors, 0 warnings/)
  })

  it("is reproducible and matches the committed golden report", async () => {
    const a = await project()
    const b = await project()
    const one = (await cli(a, "validate", "app", "--format", "json")).out
    expect((await cli(b, "validate", "app", "--format", "json")).out).toBe(one)
    const golden = path.join(fixtures, "expected/violations.json")
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(golden)) {
      mkdirSync(path.dirname(golden), { recursive: true })
      writeFileSync(golden, one)
    }
    expect(one).toBe(readFileSync(golden, "utf8"))
  })

  it("produces CI formats from the same run: github annotations and sarif", async () => {
    const dir = await project()
    const gh = (await cli(dir, "validate", "app/Screen.tsx", "--format", "github")).out
      .split("\n")
      .filter((l) => l.startsWith("::"))
    expect(gh.length).toBeGreaterThan(10)
    expect(gh.some((l) => l.startsWith("::error file=app/Screen.tsx,line=5,"))).toBe(true)
    const sarif = JSON.parse((await cli(dir, "validate", "app/Screen.tsx", "--format", "sarif")).out)
    expect(sarif.runs[0].results.every((x: { locations: unknown[] }) => x.locations.length === 1)).toBe(true)
    expect(sarif.runs[0].tool.driver.rules.length).toBeGreaterThan(8)
  })

  it("governance changes what the next validate says: a rejected link and an accepted conflict do not change code rules, an approved policy does", async () => {
    const dir = await project()
    const before = JSON.parse((await cli(dir, "validate", "app/Clean.tsx", "--format", "json")).out)
      .violations.length
    const doc = JSON.parse(readFileSync(path.join(dir, "invariant.policies.json"), "utf8"))
    doc.policies.push({
      id: "no-ghost",
      name: "No ghost buttons",
      statement: "Ghost buttons are retired.",
      severity: "error",
      approval: { approvedBy: "Jane Doe", approvedAt: "2026-02-01T00:00:00.000Z" },
      rule: { kind: "forbid-prop-value", component: "Button", prop: "variant", values: ["ghost"] }
    })
    writeFileSync(path.join(dir, "invariant.policies.json"), JSON.stringify(doc))
    expect((await cli(dir, "compile")).code).toBe(0)
    const after = JSON.parse((await cli(dir, "validate", "app/Clean.tsx", "--format", "json")).out)
      .violations as V[]
    expect(after.length).toBe(before + 1)
    expect(after.find((v) => v.code === "prop-value-forbidden")).toMatchObject({
      policy: "policy:no-ghost",
      file: "app/Clean.tsx",
      line: 7
    })
  })
})
