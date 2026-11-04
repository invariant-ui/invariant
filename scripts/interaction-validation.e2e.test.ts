import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { run } from "@invariant/cli"
import { FIXED_CLOCK } from "@invariant/compiler-core/testing"
import { ContractSource, McpServer } from "@invariant/mcp"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("..", import.meta.url))
const fixtures = path.join(root, "fixtures/interaction-validation")
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
  level?: string
  evidence?: string[]
  constraint: string
}
interface Violation {
  code: string
  severity: string
  file: string
  line: number
  suggestion?: string
}

let dir = ""
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "invariant-interaction-"))
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
  expect(compiled.out).toMatch(/patterns 3, policies 11/)
})

const validate = async (...paths: string[]) => {
  const r = await cli(dir, "validate", ...paths, "--format", "json")
  return JSON.parse(r.out) as {
    summary: Record<string, any>
    violations: Violation[]
    evaluations: Evaluation[]
  }
}
const states = (list: Evaluation[], file: string): Record<string, string> =>
  Object.fromEntries(
    list
      .filter((e) => e.file === file)
      .map((e) => [e.constraint.split(".").pop() as string, e.level ? `${e.status}/${e.level}` : e.status])
      .sort()
  )
const findings = (list: Violation[], file: string): string[] =>
  list
    .filter((v) => v.file === file && v.code === "pattern-state-missing")
    .map((v) => `${v.line} ${v.severity}`)

describe("forms", () => {
  it("passes a form that shows every state, saying how each was established", async () => {
    const r = await validate("app/forms/Good.tsx")
    expect(states(r.evaluations, "app/forms/Good.tsx")).toEqual({
      "guards-duplicates": "pass/static-inferred",
      "shows-error": "pass/static-inferred",
      "shows-submitting": "pass/static-inferred",
      "shows-success": "pass/static-inferred"
    })
    expect(findings(r.violations, "app/forms/Good.tsx")).toEqual([])
  })

  it("fails a form that shows nothing, with the policy's severity and a fix", async () => {
    const r = await validate("app/forms/Bad.tsx")
    expect(states(r.evaluations, "app/forms/Bad.tsx")).toEqual({
      "guards-duplicates": "fail",
      "shows-error": "fail",
      "shows-submitting": "fail",
      "shows-success": "fail"
    })
    expect(findings(r.violations, "app/forms/Bad.tsx").sort()).toEqual([
      "7 error",
      "7 error",
      "7 error",
      "7 warning"
    ])
    expect(
      r.violations.find((v) => v.code === "pattern-state-missing" && v.suggestion?.includes("error message"))
    ).toBeDefined()
  })

  it("does not judge a form whose handler comes from outside", async () => {
    const r = await validate("app/forms/Open.tsx")
    expect(states(r.evaluations, "app/forms/Open.tsx")).toEqual({
      "guards-duplicates": "not-verifiable",
      "shows-error": "not-verifiable",
      "shows-submitting": "not-verifiable",
      "shows-success": "not-verifiable"
    })
    expect(findings(r.violations, "app/forms/Open.tsx")).toEqual([])
  })
})

describe("destructive actions", () => {
  it("passes a delete that goes through a cancellable dialog", async () => {
    const r = await validate("app/delete/Good.tsx")
    expect(states(r.evaluations, "app/delete/Good.tsx")).toEqual({
      cancellable: "pass/static-inferred",
      confirms: "pass/static-inferred"
    })
  })

  it("fails a delete with no confirmation", async () => {
    const r = await validate("app/delete/Bad.tsx")
    expect(states(r.evaluations, "app/delete/Bad.tsx")).toEqual({ cancellable: "fail", confirms: "fail" })
    expect(r.evaluations.find((e) => e.constraint.endsWith(".confirms"))?.reason).toMatch(
      /calls removeTeam \(line 3\) directly, with no confirmation step/
    )
  })

  it("does not judge a delete whose handler is passed in", async () => {
    const r = await validate("app/delete/Open.tsx")
    expect(states(r.evaluations, "app/delete/Open.tsx")).toEqual({
      cancellable: "not-verifiable",
      confirms: "not-verifiable"
    })
  })
})

describe("search", () => {
  it("passes a search that shows every state", async () => {
    const r = await validate("app/search/Good.tsx")
    const s = states(r.evaluations, "app/search/Good.tsx")
    expect(s).toEqual({
      clearable: "pass/static-inferred",
      connected: "pass/static-inferred",
      empty: "pass/static-inferred",
      error: "pass/static-inferred",
      loading: "pass/static-inferred"
    })
  })

  it("fails a bare search box on every state it lacks", async () => {
    const r = await validate("app/search/Bad.tsx")
    expect(states(r.evaluations, "app/search/Bad.tsx")).toEqual({
      clearable: "fail",
      connected: "fail",
      empty: "fail",
      error: "fail",
      loading: "fail"
    })
  })

  it("does not judge a search whose results come from a custom hook", async () => {
    const r = await validate("app/search/Open.tsx")
    const s = states(r.evaluations, "app/search/Open.tsx")
    expect(s).toMatchObject({ empty: "not-verifiable", error: "not-verifiable", loading: "not-verifiable" })
    expect(Object.values(s)).not.toContain("fail")
    expect(r.evaluations.find((e) => e.constraint.endsWith(".empty"))?.reason).toMatch(
      /useResults may supply it/
    )
  })
})

describe("reporting", () => {
  it("applies nothing outside the policies' paths", async () => {
    const r = await validate("app/other/Elsewhere.tsx")
    expect(r.evaluations).toEqual([])
  })

  it("says in text how much each result establishes, and that none is runtime verification", async () => {
    const r = await cli(dir, "validate", "app/forms/Good.tsx", "app/forms/Bad.tsx", "app/forms/Open.tsx")
    expect(r.out).toMatch(/interaction evidence: 4 structural or better/)
    expect(r.out).toMatch(/4 statically inferred, 0 structural only, 0 runtime verified/)
    expect(r.out).toMatch(/static analysis does not run the code/)
    expect(r.out).toMatch(
      /not verifiable app\/forms\/Open\.tsx:3 pattern-state-missing: form <form> at line 3: cannot tell whether/
    )
  })

  it("carries the level and the evidence in the JSON, and a tally in the summary", async () => {
    const r = await validate("app/forms")
    const e = r.evaluations.find(
      (x) => x.file === "app/forms/Good.tsx" && x.constraint.endsWith("shows-submitting")
    )
    expect(e).toMatchObject({ status: "pass", level: "static-inferred" })
    expect(e?.evidence?.join(" ")).toMatch(/sets submitting to true before its await/)
    expect(r.summary.interactionEvidence).toEqual({ structural: 0, staticInferred: 4, runtimeVerified: 0 })
  })

  it("keeps CI annotations to real findings", async () => {
    const r = await cli(dir, "validate", "app/forms/Open.tsx", "--format", "github")
    expect(r.out).not.toMatch(/title=pattern-state-missing/)
    const bad = await cli(dir, "validate", "app/forms/Bad.tsx", "--format", "github")
    expect(bad.out).toMatch(/::error file=app\/forms\/Bad\.tsx,line=7,col=\d+,title=pattern-state-missing::/)
  })

  it("is reproducible and matches the committed golden report", async () => {
    const a = (await cli(dir, "validate", "app", "--format", "json")).out
    expect((await cli(dir, "validate", "app", "--format", "json")).out).toBe(a)
    const r = await validate("app")
    const out = `${JSON.stringify({ summary: r.summary, violations: r.violations.filter((v) => v.code === "pattern-state-missing"), evaluations: r.evaluations }, null, 2)}\n`
    const golden = path.join(fixtures, "expected/interaction-validation.json")
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(golden)) {
      mkdirSync(path.dirname(golden), { recursive: true })
      writeFileSync(golden, out)
    }
    expect(readFileSync(golden, "utf8")).toBe(out)
  })

  it("returns the same through MCP", async () => {
    const server = new McpServer({
      source: new ContractSource(path.join(dir, "invariant")),
      version: "0.0.0"
    })
    const reply = await server.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "validate_design_system_compliance",
          arguments: {
            code: readFileSync(path.join(dir, "app/forms/Bad.tsx"), "utf8"),
            filename: "app/forms/Bad.tsx"
          }
        }
      })
    )
    const data = JSON.parse(reply as string).result.structuredContent
    expect(data.summary.patternRules).toEqual({ pass: 0, fail: 4, warning: 0, notVerifiable: 0, skipped: 0 })
    expect(data.evaluations.every((e: Evaluation) => e.level === undefined)).toBe(true)
  })
})
