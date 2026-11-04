import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { run } from "@invariant/cli"
import { FIXED_CLOCK } from "@invariant/compiler-core/testing"
import { afterAll, describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("..", import.meta.url))
const made: string[] = []
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

function project(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "invariant-setup-"))
  made.push(dir)
  cpSync(path.join(root, "fixtures/storybook/acme-ui"), dir, {
    recursive: true,
    filter: (s) => !s.includes("storybook-static")
  })
  cpSync(path.join(root, "fixtures/pattern-discovery/app"), path.join(dir, "app"), { recursive: true })
  return dir
}

async function cli(cwd: string, argv: string[], answers?: string[]) {
  let out = ""
  let err = ""
  const asked: string[] = []
  const code = await run(argv, {
    cwd,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    clock: FIXED_CLOCK,
    env: {},
    ...(answers
      ? {
          prompt: async (q: string) => {
            asked.push(q)
            return answers.shift()
          }
        }
      : {})
  })
  return { code, out, err, asked }
}
const patterns = (dir: string) =>
  JSON.parse(readFileSync(path.join(dir, "invariant.patterns.json"), "utf8")) as {
    patterns: Array<{ id: string; approval?: { approvedBy: string; reference?: string } }>
  }

describe("invariant setup", () => {
  it("without a confirmed contract, adds proposals and approves nothing", async () => {
    const dir = project()
    const r = await cli(dir, ["setup", "--yes", "--as", "ana"])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/compiled: \d+ components/)
    expect(r.out).toMatch(/contract not confirmed, so nothing will be approved/)
    expect(r.out).toMatch(/added as proposals \(not approved\)/)
    const list = patterns(dir).patterns
    expect(list.length).toBeGreaterThan(0)
    expect(list.every((p) => p.approval === undefined)).toBe(true)
    expect(existsSync(path.join(dir, "invariant.candidate-reviews.json"))).toBe(true)
    expect(r.out).toMatch(/Add this to CI/)
  })

  it("approves discovered patterns only after the contract is confirmed, and records who and why", async () => {
    const dir = project()
    const r = await cli(dir, ["setup", "--yes", "--confirm-contract", "--as", "ana"])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/contract confirmed by ana/)
    expect(r.out).toMatch(/pattern\(s\) approved by ana/)
    for (const p of patterns(dir).patterns) {
      expect(p.approval?.approvedBy).toBe("ana")
      expect(p.approval?.reference).toMatch(/contract confirmed by ana/)
    }
    const list = await cli(dir, ["patterns", "list", "--json"])
    expect(list.code).toBe(0)
    const inspected = await cli(dir, ["patterns", "inspect", patterns(dir).patterns[0]?.id as string])
    expect(inspected.out).not.toMatch(/NOT APPROVED/)
  })

  it("asks first: a 'no' on the contract keeps everything unapproved, and numbers skip candidates", async () => {
    const dir = project()
    const r = await cli(dir, ["setup", "--as", "ana"], ["n", "1", "y"])
    expect(r.code).toBe(0)
    expect(r.asked[0]).toMatch(/Does this look like your design system/)
    expect(r.out).toMatch(/contract not confirmed/)
    expect(patterns(dir).patterns.every((p) => p.approval === undefined)).toBe(true)
    expect(r.asked.some((q) => /Approve \d+ pattern/.test(q))).toBe(false)
  })

  it("approves when a person says yes to both questions", async () => {
    const dir = project()
    const r = await cli(dir, ["setup", "--as", "ana"], ["y", "", "y", "y"])
    expect(r.asked.some((q) => /Approve \d+ pattern/.test(q))).toBe(true)
    expect(patterns(dir).patterns.every((p) => p.approval?.approvedBy === "ana")).toBe(true)
  })

  it("does not ask or add anything when there is no terminal and no --yes", async () => {
    const dir = project()
    const r = await cli(dir, ["setup", "--as", "ana"])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/not asking \(no terminal\)/)
    expect(existsSync(path.join(dir, "invariant.patterns.json"))).toBe(false)
  })

  it("connects the AI tools it finds, and skips with --no-agent", async () => {
    const dir = project()
    mkdirSync(path.join(dir, ".cursor"))
    const r = await cli(dir, ["setup", "--yes", "--as", "ana"])
    expect(r.out).toMatch(/connected cursor/)
    expect(existsSync(path.join(dir, ".cursor/mcp.json"))).toBe(true)
    const dir2 = project()
    mkdirSync(path.join(dir2, ".cursor"))
    expect((await cli(dir2, ["setup", "--yes", "--as", "ana", "--no-agent"])).out).toMatch(
      /skipped agent setup/
    )
    expect(existsSync(path.join(dir2, ".cursor/mcp.json"))).toBe(false)
  })

  it("says so when it finds no application folder", async () => {
    const dir = project()
    rmSync(path.join(dir, "app"), { recursive: true })
    const r = await cli(dir, ["setup", "--yes", "--as", "ana"])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/skipped src: it holds the design system's own components/)
    expect(r.out).toMatch(/no application folder found/)
    expect(existsSync(path.join(dir, "invariant.baseline.json"))).toBe(false)
  })
})

describe("setup: GitHub Action", () => {
  const wf = ".github/workflows/invariant.yml"

  it("writes a workflow that checks every pull request commit, pinned to this version", async () => {
    const dir = project()
    const r = await cli(dir, ["setup", "--yes", "--as", "ana", "--ci"])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/wrote \.github\/workflows\/invariant\.yml/)
    expect(r.out).toMatch(/CI: \.github\/workflows\/invariant\.yml checks every pull request commit/)
    expect(r.out).not.toMatch(/Add this to CI/)
    const yaml = readFileSync(path.join(dir, wf), "utf8")
    expect(yaml).toMatch(/pull_request:\n\s+types: \[opened, synchronize, reopened\]/)
    expect(yaml).toContain("npx invariant-ui@0.1.0 verify --fresh")
    expect(yaml).toContain("npx invariant-ui@0.1.0 validate 'app' --format github")
    expect(yaml).toMatch(/permissions:\n\s+contents: read/)
    expect(yaml).not.toMatch(/secrets\.|pull_request_target|write/)
    expect(yaml).not.toContain("\t")
  })

  it("asks first in a git project, and writes nothing on a no", async () => {
    const yes = project()
    mkdirSync(path.join(yes, ".git"))
    const a = await cli(yes, ["setup", "--as", "ana"], ["n", "", "y", "y"])
    expect(a.asked.some((q) => /GitHub Action/.test(q))).toBe(true)
    expect(existsSync(path.join(yes, wf))).toBe(true)
    const no = project()
    mkdirSync(path.join(no, ".git"))
    const b = await cli(no, ["setup", "--as", "ana"], ["n", "", "y", "n"])
    expect(b.asked.some((q) => /GitHub Action/.test(q))).toBe(true)
    expect(existsSync(path.join(no, wf))).toBe(false)
    expect(b.out).toMatch(/no workflow added/)
  })

  it("does not ask outside a git project, or with --no-ci", async () => {
    const plain = project()
    const a = await cli(plain, ["setup", "--yes", "--as", "ana"])
    expect(existsSync(path.join(plain, ".github"))).toBe(false)
    expect(a.out).toMatch(/Add this to CI/)
    const git = project()
    mkdirSync(path.join(git, ".git"))
    const b = await cli(git, ["setup", "--yes", "--as", "ana", "--no-ci"])
    expect(existsSync(path.join(git, wf))).toBe(false)
    expect(b.out).not.toMatch(/GitHub Action|7\./)
  })

  it("leaves an existing workflow alone", async () => {
    const dir = project()
    mkdirSync(path.join(dir, ".github/workflows"), { recursive: true })
    writeFileSync(path.join(dir, wf), "name: mine\n")
    const r = await cli(dir, ["setup", "--yes", "--as", "ana", "--ci"])
    expect(r.out).toMatch(/already exists, so it was left alone/)
    expect(readFileSync(path.join(dir, wf), "utf8")).toBe("name: mine\n")
  })

  it("quotes the paths it checks", async () => {
    const { workflowYaml } = await import("../apps/cli/src/workflow.ts")
    expect(workflowYaml(["src", "apps/web's"])).toContain("validate 'src' 'apps/web''s' --format github")
    expect(workflowYaml([])).toContain("validate 'src' --format github")
  })
})

describe("validate baseline", () => {
  it("hides existing violations, still fails on new ones, and can show everything", async () => {
    const dir = project()
    await cli(dir, ["init"])
    await cli(dir, ["compile"])
    const file = path.join(dir, "app/pages/Old.tsx")
    writeFileSync(file, 'import { Card } from "@acme/ui"\nexport const Old = () => <Card tone="loud" />\n')
    expect((await cli(dir, ["validate", "app/pages", "--fail-on", "warning"])).code).toBe(1)

    const w = await cli(dir, ["validate", "app/pages", "--update-baseline"])
    expect(w.code).toBe(0)
    expect(w.out).toMatch(/now hidden/)
    const clean = await cli(dir, ["validate", "app/pages", "--fail-on", "warning"])
    expect(clean.code).toBe(0)
    expect(clean.err).toMatch(/hidden by invariant\.baseline\.json/)

    // Moving the code does not bring it back.
    writeFileSync(
      file,
      'import { Card } from "@acme/ui"\n\n\nexport const Old = () => <Card tone="loud" />\n'
    )
    expect((await cli(dir, ["validate", "app/pages", "--fail-on", "warning"])).code).toBe(0)

    // A second one is new and fails.
    writeFileSync(
      file,
      'import { Card } from "@acme/ui"\nexport const Old = () => <><Card tone="loud" /><Card tone="loud" /></>\n'
    )
    expect((await cli(dir, ["validate", "app/pages", "--fail-on", "warning"])).code).toBe(1)
    expect((await cli(dir, ["validate", "app/pages", "--no-baseline", "--fail-on", "warning"])).code).toBe(1)
  })
})
