import { execSync } from "node:child_process"
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

/** Gives the package a name and some fields, keeping what it already declares (React, peer dependencies). */
const writeMeta = (dir: string, extra: Record<string, unknown>) => {
  const file = path.join(dir, "package.json")
  const existing = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}
  writeFileSync(file, JSON.stringify({ ...existing, name: "@acme/ui", version: "1.0.0", ...extra }, null, 2))
}

describe("invariant setup", () => {
  it("without a confirmed contract, adds proposals and approves nothing", async () => {
    const dir = project()
    const r = await cli(dir, ["setup", "--yes", "--as", "ana"])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/compiled: \d+ components/)
    expect(r.out).toMatch(/contract not confirmed, so nothing is approved and no rule is turned on/)
    expect(r.out).toMatch(/patterns {3}3 added as proposals \(not approved\)/)
    const list = patterns(dir).patterns
    expect(list.length).toBeGreaterThan(0)
    expect(list.every((p) => p.approval === undefined)).toBe(true)
    expect(JSON.stringify(list)).not.toContain('"constraints"')
    expect(r.out).not.toMatch(/rules /)
    expect(existsSync(path.join(dir, "invariant.candidate-reviews.json"))).toBe(true)
  })

  it("approves patterns and turns on starter rules only after the contract is confirmed", async () => {
    const dir = project()
    const r = await cli(dir, ["setup", "--confirm-contract", "--as", "ana"])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/contract confirmed by ana/)
    expect(r.out).toMatch(/patterns {3}3 approved by ana/)
    expect(r.out).toMatch(/rules {6}\d+ starter rule\(s\), as warnings/)
    expect(r.out).toMatch(/See it work/)
    for (const p of patterns(dir).patterns) {
      expect(p.approval?.approvedBy).toBe("ana")
      expect(p.approval?.reference).toMatch(/contract confirmed by ana/)
    }
    const defs = patterns(dir).patterns as Array<{
      id: string
      constraints?: Array<{ enforce: object; kind: string }>
      appliesTo?: { paths: string[] }
    }>
    const withRules = defs.filter((d) => d.constraints)
    expect(withRules.length).toBeGreaterThan(0)
    for (const d of withRules) {
      expect(d.appliesTo?.paths).toEqual(["app/**"])
      for (const k of d.constraints ?? [])
        expect(k.enforce).toEqual({ severity: "warning", enforcement: "warn" })
    }
    const inspected = await cli(dir, ["patterns", "inspect", defs[0]?.id as string])
    expect(inspected.out).not.toMatch(/NOT APPROVED/)
  })

  it("--only adds just the numbered patterns, --posture writes the enforcement setting, and bad values are refused", async () => {
    const dir = project()
    const r = await cli(dir, [
      "setup",
      "--confirm-contract",
      "--as",
      "ana",
      "--only",
      "1,3",
      "--posture",
      "warn",
      "--no-ci",
      "--no-agent"
    ])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/patterns {3}2 approved by ana/)
    expect(patterns(dir).patterns).toHaveLength(2)
    expect(r.out).toMatch(/enforcement.*never blocked.*enforcement\.hooks = warn/)
    const config = JSON.parse(readFileSync(path.join(dir, "invariant.config.json"), "utf8"))
    expect(config.enforcement).toEqual({ hooks: "warn" })
    expect(config.sources.length).toBeGreaterThan(0)

    const none = project()
    const n = await cli(none, [
      "setup",
      "--confirm-contract",
      "--as",
      "ana",
      "--only",
      "none",
      "--no-ci",
      "--no-agent"
    ])
    expect(n.out).not.toMatch(/patterns {3}/)
    expect(existsSync(path.join(none, "invariant.patterns.json"))).toBe(false)

    expect((await cli(project(), ["setup", "--posture", "loud"])).code).toBe(2)
    expect((await cli(project(), ["setup", "--only", "one"])).code).toBe(2)
  })

  it("a starter rule flags new code and, as a warning, does not fail the build", async () => {
    const dir = project()
    await cli(dir, ["setup", "--confirm-contract", "--as", "ana", "--no-ci", "--no-agent"])
    writeFileSync(
      path.join(dir, "app/pages/NewModal.tsx"),
      'import { Modal } from "@acme/ui"\nexport const N = () => <Modal open title="x" />\n'
    )
    const r = await cli(dir, ["validate", "app", "--format", "json"])
    const out = JSON.parse(r.out) as { violations: Array<{ code: string; file: string; severity: string }> }
    const hit = out.violations.filter((v) => v.file === "app/pages/NewModal.tsx")
    expect(hit.map((v) => v.code)).toContain("pattern-required-child-missing")
    expect(hit.every((v) => v.severity === "warning")).toBe(true)
    expect(r.code).toBe(0)
    // The same rule on the code that was already there is hidden by the baseline.
    expect(out.violations.filter((v) => v.file !== "app/pages/NewModal.tsx")).toEqual([])
  })

  it("--no-rules approves patterns without turning on any rule", async () => {
    const dir = project()
    const r = await cli(dir, ["setup", "--confirm-contract", "--as", "ana", "--no-rules"])
    expect(r.out).toMatch(/patterns {3}3 approved by ana/)
    expect(r.out).not.toMatch(/starter rule/)
    expect(JSON.stringify(patterns(dir).patterns)).not.toContain('"constraints"')
  })

  it("asks once. Yes confirms the contract and does the whole plan", async () => {
    const dir = project()
    const r = await cli(dir, ["setup", "--as", "ana"], ["y"])
    expect(r.asked).toHaveLength(1)
    expect(r.asked[0]).toMatch(/Looks right\?/)
    expect(r.out).toMatch(/Plan\. Yes confirms the contract above is right/)
    expect(r.out).toMatch(/approved by ana/)
    expect(r.out).toMatch(/starter rule\(s\) as warnings/)
    expect(patterns(dir).patterns.every((p) => p.approval?.approvedBy === "ana")).toBe(true)
  })

  it("asking and answering just Enter means yes", async () => {
    const dir = project()
    const r = await cli(dir, ["setup", "--as", "ana"], [""])
    expect(patterns(dir).patterns.every((p) => p.approval?.approvedBy === "ana")).toBe(true)
    expect(r.asked).toHaveLength(1)
  })

  it("no stops: nothing is approved, added or written", async () => {
    const dir = project()
    const r = await cli(dir, ["setup", "--as", "ana"], ["n"])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/Stopped\. Nothing was approved or added/)
    expect(existsSync(path.join(dir, "invariant.patterns.json"))).toBe(false)
    expect(existsSync(path.join(dir, "invariant.baseline.json"))).toBe(false)
    expect(existsSync(path.join(dir, "invariant"))).toBe(true)
  })

  it("c asks about each step, and a no on the contract keeps patterns unapproved", async () => {
    const dir = project()
    // contract? no. which patterns? skip 1. baseline: yes (the rest default to yes).
    const r = await cli(dir, ["setup", "--as", "ana"], ["c", "n", "1", "y"])
    expect(r.asked[0]).toMatch(/Looks right\?/)
    expect(r.asked.some((q) => /Does this look like your design system/.test(q))).toBe(true)
    expect(r.asked.some((q) => /Approve \d+ pattern/.test(q))).toBe(false)
    expect(r.out).toMatch(/contract not confirmed/)
    const list = patterns(dir).patterns
    expect(list).toHaveLength(2)
    expect(list.every((p) => p.approval === undefined)).toBe(true)
  })

  it("does not ask or add anything when there is no terminal and no --yes", async () => {
    const dir = project()
    const r = await cli(dir, ["setup", "--as", "ana"])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/not asking \(no terminal\)\. Nothing was added/)
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
    await cli(dir2, ["setup", "--yes", "--as", "ana", "--no-agent"])
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

describe("setup in a design system repository: publishing the contract", () => {
  it("adds a prepack script, and says what apps do next", async () => {
    const dir = project()
    writeMeta(dir, { files: ["src"] })
    const r = await cli(dir, ["setup", "--yes", "--as", "ana", "--no-ci"])
    expect(r.out).toMatch(/publish {4}@acme\/ui: added "invariant" to files and added a prepack script/)
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"))
    expect(pkg.files).toEqual(["src", "invariant"])
    expect(pkg.scripts.prepack).toBe("npx @invariant-ui/cli@0.1.0 compile")
    expect(readFileSync(path.join(dir, "package.json"), "utf8").endsWith("\n")).toBe(false)
  })

  it("is idempotent, and leaves an existing prepack alone", async () => {
    const dir = project()
    writeMeta(dir, { files: ["invariant"], scripts: { prepack: "tsc" } })
    const r = await cli(dir, ["setup", "--yes", "--as", "ana", "--no-ci"])
    expect(r.out).not.toMatch(/publish {4}/)
    expect(JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).scripts.prepack).toBe("tsc")
  })

  it("skips a private package, and --no-publish", async () => {
    const dir = project()
    writeMeta(dir, { private: true })
    const r = await cli(dir, ["setup", "--yes", "--as", "ana", "--no-ci"])
    expect(r.out).toMatch(/not wiring publishing: @acme\/ui is private/)
    expect(JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).scripts).toBeUndefined()
    const other = project()
    writeMeta(other, {})
    await cli(other, ["setup", "--yes", "--as", "ana", "--no-ci", "--no-publish"])
    expect(JSON.parse(readFileSync(path.join(other, "package.json"), "utf8")).scripts).toBeUndefined()
  })

  it("warns when the folder is ignored, since it would not be published", async () => {
    const dir = project()
    writeMeta(dir, {})
    writeFileSync(path.join(dir, ".npmignore"), "invariant/\n")
    const r = await cli(dir, ["setup", "--yes", "--as", "ana", "--no-ci"])
    expect(r.out).toMatch(/Warning: \.npmignore ignores invariant\//)
  })

  it("in a monorepo, compiles from the root and exports into the package", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "invariant-setup-"))
    made.push(dir)
    mkdirSync(path.join(dir, "packages"), { recursive: true })
    cpSync(path.join(root, "fixtures/storybook/acme-ui"), path.join(dir, "packages/ui"), {
      recursive: true,
      filter: (s) => !s.includes("storybook-static")
    })
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "mono", private: true, workspaces: ["packages/*"] })
    )
    writeMeta(path.join(dir, "packages/ui"), { files: ["src"] })
    const r = await cli(dir, ["setup", "--yes", "--as", "ana", "--no-ci"])
    expect(r.code).toBe(0)
    const pkg = JSON.parse(readFileSync(path.join(dir, "packages/ui/package.json"), "utf8"))
    expect(pkg.scripts.prepack).toBe(
      "npx @invariant-ui/cli@0.1.0 compile --cwd ../.. && npx @invariant-ui/cli@0.1.0 export --to packages/ui/invariant --force --cwd ../.."
    )
    expect(pkg.files).toContain("invariant")
  })
})

describe("the publishing wiring actually works", () => {
  const main = path.join(root, "apps/cli/dist/main.js")
  const runPrepack = (dir: string, cmd: string) =>
    execSync(cmd.replaceAll("npx @invariant-ui/cli@0.1.0", `node ${main}`), { cwd: dir, stdio: "pipe" })
  const tarball = (dir: string): string[] =>
    (
      JSON.parse(
        execSync("npm pack --dry-run --json --ignore-scripts", { cwd: dir, stdio: "pipe" }).toString()
      ) as Array<{
        files: Array<{ path: string }>
      }>
    )[0]?.files.map((f) => f.path) ?? []

  it("a single package: the compiled contract is in the tarball after prepack", async () => {
    const dir = project()
    writeMeta(dir, { files: ["src"] })
    await cli(dir, ["setup", "--yes", "--as", "ana", "--no-ci"])
    rmSync(path.join(dir, "invariant"), { recursive: true })
    const prepack = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).scripts.prepack as string
    runPrepack(dir, prepack)
    const files = tarball(dir)
    expect(files).toContain("invariant/invariant.contract.json")
    expect(files).toContain("invariant/invariant.evidence.json")
  }, 60_000)

  it("a monorepo package: prepack compiles at the root and exports into the package folder", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "invariant-setup-"))
    made.push(dir)
    cpSync(path.join(root, "fixtures/storybook/acme-ui"), path.join(dir, "packages/ui"), {
      recursive: true,
      filter: (s) => !s.includes("storybook-static")
    })
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "mono", private: true, workspaces: ["packages/*"] })
    )
    writeMeta(path.join(dir, "packages/ui"), { files: ["src"] })
    await cli(dir, ["setup", "--yes", "--as", "ana", "--no-ci"])
    const pkgDir = path.join(dir, "packages/ui")
    const prepack = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")).scripts
      .prepack as string
    runPrepack(pkgDir, prepack)
    expect(existsSync(path.join(pkgDir, "invariant/invariant.contract.json"))).toBe(true)
    expect(tarball(pkgDir)).toContain("invariant/invariant.contract.json")
  }, 60_000)
})

describe("setup: GitHub Action", () => {
  const wf = ".github/workflows/invariant.yml"

  it("writes a workflow that checks every pull request commit, pinned to this version", async () => {
    const dir = project()
    const r = await cli(dir, ["setup", "--yes", "--as", "ana", "--ci"])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/CI {9}wrote \.github\/workflows\/invariant\.yml/)
    expect(r.out).not.toMatch(/Add this to CI/)
    const yaml = readFileSync(path.join(dir, wf), "utf8")
    expect(yaml).toMatch(/pull_request:\n\s+types: \[opened, synchronize, reopened\]/)
    expect(yaml).toContain("npx @invariant-ui/cli@0.1.0 verify --fresh")
    expect(yaml).toContain("npx @invariant-ui/cli@0.1.0 validate 'app' --format github")
    expect(yaml).toMatch(/permissions:\n\s+contents: read/)
    expect(yaml).not.toMatch(/secrets\.|pull_request_target|write/)
    expect(yaml).not.toContain("\t")
  })

  it("is part of the one plan in a git project", async () => {
    const dir = project()
    mkdirSync(path.join(dir, ".git"))
    const r = await cli(dir, ["setup", "--as", "ana"], ["y"])
    expect(r.asked).toHaveLength(1)
    expect(r.out).toContain(`add ${wf}, which checks every pull request commit`)
    expect(existsSync(path.join(dir, wf))).toBe(true)
  })

  it("can be declined in the step-by-step mode", async () => {
    const dir = project()
    mkdirSync(path.join(dir, ".git"))
    // c, contract yes, patterns all, approve yes, rules yes, baseline yes, CI no.
    const r = await cli(dir, ["setup", "--as", "ana"], ["c", "y", "", "y", "y", "y", "n"])
    expect(r.asked.some((q) => /GitHub Action/.test(q))).toBe(true)
    expect(existsSync(path.join(dir, wf))).toBe(false)
    expect(r.out).toMatch(/Add this to CI/)
  })

  it("is not offered outside a git project, or with --no-ci", async () => {
    const plain = project()
    const a = await cli(plain, ["setup", "--yes", "--as", "ana"])
    expect(existsSync(path.join(plain, ".github"))).toBe(false)
    expect(a.out).toMatch(/Add this to CI/)
    const git = project()
    mkdirSync(path.join(git, ".git"))
    const b = await cli(git, ["setup", "--yes", "--as", "ana", "--no-ci"])
    expect(existsSync(path.join(git, wf))).toBe(false)
    expect(b.out).not.toMatch(/GitHub Action/)
  })

  it("leaves an existing workflow alone", async () => {
    const dir = project()
    mkdirSync(path.join(dir, ".github/workflows"), { recursive: true })
    writeFileSync(path.join(dir, wf), "name: mine\n")
    const r = await cli(dir, ["setup", "--yes", "--as", "ana", "--ci"])
    expect(r.out).toMatch(/already exists, so it will be left alone/)
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
