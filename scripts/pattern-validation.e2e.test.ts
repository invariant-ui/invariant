import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { run } from "@invariant/cli"
import { FIXED_CLOCK } from "@invariant/compiler-core/testing"
import { ContractSource, McpServer } from "@invariant/mcp"
import { RULES } from "@invariant/validation"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("..", import.meta.url))
const fixtures = path.join(root, "fixtures/pattern-validation")
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
  line?: number
  pattern: string
  policy: string
}
interface Violation {
  code: string
  severity: string
  file: string
  line: number
  policy?: string
  basis: string
}

let dir = ""
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "invariant-pattern-validation-"))
  made.push(dir)
  cpSync(path.join(root, "fixtures/storybook/acme-ui"), dir, {
    recursive: true,
    filter: (s) => !s.includes("storybook-static")
  })
  cpSync(path.join(fixtures, "app"), path.join(dir, "app"), { recursive: true })
  cpSync(path.join(fixtures, "invariant.patterns.json"), path.join(dir, "invariant.patterns.json"))
  expect((await cli(dir, "init")).code).toBe(0)
  const compiled = await cli(dir, "compile")
  expect(compiled.code).toBe(0)
  expect(compiled.out).toMatch(/patterns 1, policies 6/)
})

const validateJson = async (...paths: string[]) => {
  const r = await cli(dir, "validate", ...paths, "--format", "json")
  return {
    code: r.code,
    ...(JSON.parse(r.out) as {
      summary: Record<string, any>
      violations: Violation[]
      evaluations: Evaluation[]
    })
  }
}
const of = (list: Evaluation[], file: string): Array<[string, string]> =>
  list
    .filter((e) => e.file === file)
    .map((e): [string, string] => [e.rule.replace("pattern-", ""), e.status])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
const patternFindings = (list: Violation[], file: string): string[] =>
  list
    .filter((v) => v.file === file && v.code.startsWith("pattern-"))
    .map((v) => `${v.line} ${v.code} ${v.severity}`)

describe("validating application code against an approved pattern", () => {
  it("passes a page that follows the pattern, with a recorded pass for every rule", async () => {
    const r = await validateJson("app/pages/Good.tsx")
    expect(patternFindings(r.violations, "app/pages/Good.tsx")).toEqual([])
    expect(of(r.evaluations, "app/pages/Good.tsx")).toEqual([
      ["cardinality-violated", "pass"],
      ["child-forbidden", "pass"],
      ["order-violated", "pass"],
      ["parent-required", "pass"],
      ["region-missing", "pass"],
      ["required-child-missing", "pass"]
    ])
  })

  it("reports each violation with the rule, location, severity, policy and basis", async () => {
    const r = await validateJson("app/pages/Bad.tsx")
    expect(patternFindings(r.violations, "app/pages/Bad.tsx").sort()).toEqual(
      [
        "9 pattern-child-forbidden warning",
        "13 pattern-cardinality-violated error",
        "12 pattern-required-child-missing error",
        "5 pattern-order-violated error",
        "6 pattern-parent-required error"
      ].sort()
    )
    const nested = r.violations.find((v) => v.code === "pattern-child-forbidden")
    expect(nested).toMatchObject({ basis: "approved", severity: "warning" })
    expect(nested?.policy).toMatch(/^policy:page\.settings\./)
    expect(r.code).toBe(1)
  })

  it("fails a page with no content region, because everything it shows is visible", async () => {
    const r = await validateJson("app/pages/Empty.tsx")
    expect(of(r.evaluations, "app/pages/Empty.tsx")).toContainEqual(["region-missing", "fail"])
    expect(patternFindings(r.violations, "app/pages/Empty.tsx")).toContain("1 pattern-region-missing error")
  })

  it("does not pass what it cannot see: other-file components and children are not verifiable", async () => {
    const r = await validateJson("app/pages/Open.tsx")
    const evals = of(r.evaluations, "app/pages/Open.tsx")
    expect(evals).toContainEqual(["region-missing", "not-verifiable"])
    expect(evals).toContainEqual(["required-child-missing", "not-verifiable"])
    expect(evals.some(([, status]) => status === "pass" || status === "fail")).toBe(false)
    expect(patternFindings(r.violations, "app/pages/Open.tsx")).toEqual([])
    const reasons = r.evaluations.map((e) => e.reason).join("\n")
    expect(reasons).toMatch(/<Actions> at line 6 comes from outside the design system/)
    expect(reasons).toMatch(/gets content from outside what this file shows/)
  })

  it("does not apply the policy to files outside its paths, and says nothing about them", async () => {
    const r = await validateJson("app/other/Elsewhere.tsx")
    expect(r.evaluations).toEqual([])
    expect(patternFindings(r.violations, "app/other/Elsewhere.tsx")).toEqual([])
  })

  it("summarizes how the checks came out across the run", async () => {
    const r = await validateJson("app")
    expect(r.summary.patternRules).toEqual({ pass: 10, fail: 6, warning: 0, notVerifiable: 4, skipped: 2 })
  })
})

describe("how it is reported", () => {
  it("says in text what was not verified, and does not count it as a pass or a failure", async () => {
    const r = await cli(dir, "validate", "app/pages/Open.tsx")
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/pattern rules: 0 passed, 0 failed, 0 warnings, 4 not verifiable, 1 skipped/)
    expect(r.out).toMatch(/not verifiable app\/pages\/Open\.tsx:\d+ pattern-required-child-missing:/)
  })

  it("keeps CI annotations to real findings, and adds the tally to the summary", async () => {
    const r = await cli(dir, "validate", "app/pages/Open.tsx", "--format", "github")
    expect(r.out).not.toMatch(/::(error|warning|notice)/)
    expect(r.out).toMatch(/pattern rules: 0 passed, 0 failed, 0 warnings, 4 not verifiable/)
    const bad = await cli(dir, "validate", "app/pages/Bad.tsx", "--format", "github")
    expect(bad.out).toMatch(/::error file=app\/pages\/Bad\.tsx,line=5,col=\d+,title=pattern-order-violated::/)
    expect(bad.out).toMatch(
      /::warning file=app\/pages\/Bad\.tsx,line=9,col=\d+,title=pattern-child-forbidden::/
    )
  })

  it("puts the tally in SARIF without turning unverified checks into results", async () => {
    const r = JSON.parse((await cli(dir, "validate", "app/pages/Open.tsx", "--format", "sarif")).out)
    expect(r.runs[0].results).toEqual([])
    expect(r.runs[0].properties.patternRules.notVerifiable).toBe(4)
  })

  it("honors --fail-on, and rule severity overrides from the config", async () => {
    expect((await cli(dir, "validate", "app/pages/Bad.tsx", "--fail-on", "never")).code).toBe(0)
    const config = JSON.parse(readFileSync(path.join(dir, "invariant.config.json"), "utf8"))
    writeFileSync(
      path.join(dir, "invariant.config.json"),
      JSON.stringify({
        ...config,
        validation: { rules: { "pattern-order-violated": "off", "pattern-cardinality-violated": "info" } }
      })
    )
    const r = await validateJson("app/pages/Bad.tsx")
    const codes = patternFindings(r.violations, "app/pages/Bad.tsx")
    expect(codes.some((c) => c.includes("pattern-order-violated"))).toBe(false)
    expect(codes).toContain("13 pattern-cardinality-violated info")
    expect(r.evaluations.some((e) => e.rule === "pattern-order-violated")).toBe(false)
    writeFileSync(path.join(dir, "invariant.config.json"), JSON.stringify(config))
  })

  it("lists the pattern rules in `invariant rules`", async () => {
    const codes = RULES.map((r) => r.code).filter((c) => c.startsWith("pattern-"))
    expect(codes).toHaveLength(7)
    const out = (await cli(dir, "rules")).out
    for (const c of codes) expect(out).toContain(c)
  })

  it("is reproducible", async () => {
    const a = (await cli(dir, "validate", "app", "--format", "json")).out
    const b = (await cli(dir, "validate", "app", "--format", "json")).out
    expect(a).toBe(b)
  })

  it("matches the committed golden report", async () => {
    const r = await validateJson("app")
    const out = `${JSON.stringify({ summary: r.summary, violations: r.violations.filter((v) => v.code.startsWith("pattern-")), evaluations: r.evaluations }, null, 2)}\n`
    const golden = path.join(fixtures, "expected/pattern-validation.json")
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(golden)) {
      mkdirSync(path.dirname(golden), { recursive: true })
      writeFileSync(golden, out)
    }
    expect(readFileSync(golden, "utf8")).toBe(out)
  })
})

describe("the same check through MCP", () => {
  it("returns evaluations from validate_design_system_compliance when a file name is given", async () => {
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
            params: { name: "validate_design_system_compliance", arguments: args }
          })
        )) as string
      ).result.structuredContent
    const code = readFileSync(path.join(dir, "app/pages/Bad.tsx"), "utf8")
    const withName = await call({ code, filename: "app/pages/Bad.tsx" })
    expect(withName.summary.patternRules.fail).toBe(5)
    const t = withName.summary.patternRules
    expect(withName.evaluations.length).toBe(t.pass + t.fail + t.warning + t.notVerifiable + t.skipped)
    const without = await call({ code })
    expect(without.evaluations).toHaveLength(6)
    expect(without.evaluations.every((e: { status: string }) => e.status === "skipped")).toBe(true)
    expect(without.evaluations[0].reason).toMatch(/no file name was given/)
    expect(without.findings.filter((f: { code: string }) => f.code.startsWith("pattern-"))).toEqual([])
  })
})
