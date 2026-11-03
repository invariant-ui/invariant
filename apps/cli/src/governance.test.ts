import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { FIXED_CLOCK } from "@invariant/compiler-core/testing"
import { afterAll, describe, expect, it } from "vitest"
import { run, validateConfig } from "./index.js"

const root = fileURLToPath(new URL("../../..", import.meta.url))
const made: string[] = []
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

async function cli(cwd: string, argv: string[], env: Record<string, string> = {}) {
  let out = ""
  let err = ""
  const code = await run(argv, {
    cwd,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    clock: FIXED_CLOCK,
    env
  })
  return { code, out, err }
}
const c = (cwd: string, ...argv: string[]) => cli(cwd, argv)
const read = (dir: string, rel: string): string => readFileSync(path.join(dir, rel), "utf8")
const write = (dir: string, rel: string, text: string): void => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  writeFileSync(path.join(dir, rel), text)
}

async function project(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "invariant-gov-"))
  made.push(dir)
  cpSync(path.join(root, "fixtures/storybook/acme-ui"), dir, {
    recursive: true,
    filter: (s) => !s.includes("storybook-static")
  })
  await c(dir, "init")
  await c(dir, "compile")
  return dir
}

const APP = `import { Button, Buttn } from "@acme/ui"
export const A = () => (
  <div style={{ color: "#123456" }}>
    <Button variant="danger" plain>Save</Button>
    <Buttn />
  </div>
)
`

describe("validate", () => {
  it("needs paths, and points at verify for the old meaning", async () => {
    const dir = await project()
    const r = await c(dir, "validate")
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/invariant verify/)
  })

  it("reports file, location, rule, evidence, explanation and fix, and fails on errors", async () => {
    const dir = await project()
    write(dir, "app/App.tsx", APP)
    const r = await c(dir, "validate", "app")
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/app\/App\.tsx:4:5 error prop-value-not-allowed/)
    expect(r.out).toMatch(/fix: Use one of "primary", "secondary", "ghost"/)
    expect(r.out).toMatch(/evidence src\/Button\.tsx:\d+ \(discovered\)/)
    expect(r.out).toMatch(/app\/App\.tsx:5:5 error component-unknown/)
    expect(r.out).toMatch(/\d+ errors, \d+ warnings, \d+ info in 1 files/)
  })

  it("exits 0 for correct code, and --fail-on changes the threshold", async () => {
    const dir = await project()
    write(
      dir,
      "app/Good.tsx",
      `import { Button } from "@acme/ui"\nexport const A = () => <Button variant="ghost">Go</Button>\n`
    )
    expect((await c(dir, "validate", "app")).code).toBe(0)
    write(
      dir,
      "app/Warn.tsx",
      `import { Button } from "@acme/ui"\nexport const A = () => <Button plain>Go</Button>\n`
    )
    expect((await c(dir, "validate", "app/Warn.tsx")).code).toBe(0)
    expect((await c(dir, "validate", "app/Warn.tsx", "--fail-on", "warning")).code).toBe(1)
    expect((await c(dir, "validate", "app/Warn.tsx", "--fail-on", "never")).code).toBe(0)
    expect((await c(dir, "validate", "app", "--fail-on", "sometimes")).code).toBe(2)
  })

  it("emits json, github annotations and sarif", async () => {
    const dir = await project()
    write(dir, "app/App.tsx", APP)
    const j = JSON.parse((await c(dir, "validate", "app", "--format", "json")).out)
    expect(j.summary.errors).toBeGreaterThan(0)
    expect(j.contractHash).toMatch(/^[0-9a-f]{64}$/)
    expect(j.violations[0]).toMatchObject({
      file: "app/App.tsx",
      code: expect.any(String),
      suggestion: expect.any(String)
    })
    const gh = (await c(dir, "validate", "app", "--format", "github")).out
    expect(gh).toMatch(/^::error file=app\/App\.tsx,line=4,col=5,title=prop-value-not-allowed::/m)
    const sarif = JSON.parse((await c(dir, "validate", "app", "--format", "sarif")).out)
    expect(sarif.version).toBe("2.1.0")
    expect(sarif.runs[0].results.length).toBe(j.violations.length)
    expect((await c(dir, "validate", "app", "--format", "xml")).code).toBe(2)
  })

  it("walks directories, skips ignored folders and configured globs, and refuses outside paths and bad types", async () => {
    const dir = await project()
    write(dir, "app/App.tsx", APP)
    write(dir, "app/node_modules/x/Bad.tsx", APP)
    write(dir, "app/legacy/Old.tsx", APP)
    write(dir, "app/readme.txt", "x")
    const cfg = JSON.parse(read(dir, "invariant.config.json"))
    write(dir, "invariant.config.json", JSON.stringify({ ...cfg, validation: { ignore: ["app/legacy/**"] } }))
    const r = await c(dir, "validate", "app", "--format", "json")
    expect(new Set(JSON.parse(r.out).violations.map((v: { file: string }) => v.file))).toEqual(
      new Set(["app/App.tsx"])
    )
    expect((await c(dir, "validate", "..")).code).toBe(2)
    expect((await c(dir, "validate", "app/readme.txt")).err).toMatch(/not a file type/)
    expect((await c(dir, "validate", "nope")).err).toMatch(/not found/)
  })

  it("applies per-rule severity from configuration, including off", async () => {
    const dir = await project()
    write(dir, "app/App.tsx", APP)
    const cfg = JSON.parse(read(dir, "invariant.config.json"))
    write(
      dir,
      "invariant.config.json",
      JSON.stringify({
        ...cfg,
        validation: {
          rules: {
            "prop-value-not-allowed": "warning",
            "component-unknown": "off",
            "prop-deprecated": "error"
          }
        }
      })
    )
    const j = JSON.parse((await c(dir, "validate", "app", "--format", "json")).out)
    const by = Object.fromEntries(
      j.violations.map((v: { code: string; severity: string }) => [v.code, v.severity])
    )
    expect(by["prop-value-not-allowed"]).toBe("warning")
    expect(by["prop-deprecated"]).toBe("error")
    expect(by["component-unknown"]).toBeUndefined()
  })

  it("rejects unknown rule codes in configuration, with a suggestion", () => {
    expect(() =>
      validateConfig({ name: "x", sources: [], validation: { rules: { "prop-value-not-alowed": "off" } } })
    ).toThrow(/Did you mean prop-value-not-allowed/)
  })

  it("infers the framework from the file name", async () => {
    const dir = await project()
    write(dir, "app/x.html", `<Badge tone="loud"></Badge>`)
    const j = JSON.parse((await c(dir, "validate", "app/x.html", "--format", "json")).out)
    expect(j.violations.map((v: { code: string }) => v.code)).toContain("prop-value-not-allowed")
  })

  it("lists the rules", async () => {
    const dir = await project()
    const r = await c(dir, "rules")
    expect(r.out).toMatch(/prop-value-not-allowed\s+error\s+contract\s+Invalid property value/)
    expect(JSON.parse((await c(dir, "rules", "--json")).out).length).toBeGreaterThan(20)
  })
})

const POLICIES = {
  version: 1,
  policies: [
    {
      id: "icon-buttons-need-labels",
      name: "Icon-only buttons need an accessible name",
      statement: "A button without text must have aria-label.",
      severity: "error",
      approval: {
        approvedBy: "Jane Doe",
        approvedAt: "2026-01-05T00:00:00.000Z",
        role: "design-system lead",
        reference: "RFC-7"
      },
      rule: {
        kind: "require-attribute",
        components: ["Button"],
        anyOf: ["aria-label", "aria-labelledby"],
        unlessChildren: true,
        category: "accessibility"
      }
    }
  ]
}

describe("policies", () => {
  it("are compiled into the contract, listed, and enforced by validate with a policy reference", async () => {
    const dir = await project()
    expect((await c(dir, "policy", "list")).out).toMatch(/no approved policies/)
    write(dir, "invariant.policies.json", JSON.stringify(POLICIES))
    const compiled = await c(dir, "compile")
    expect(compiled.out).toMatch(/policies 1/)
    expect((await c(dir, "policy", "list")).out).toMatch(
      /policy:icon-buttons-need-labels\s+error\s+block\s+require-attribute\s+Jane Doe\s+2026-01-05/
    )
    expect((await c(dir, "verify")).code).toBe(0)
    write(
      dir,
      "app/Icon.tsx",
      `import { Button } from "@acme/ui"\nexport const A = () => <Button icon={x} />\n`
    )
    const r = await c(dir, "validate", "app", "--format", "json")
    const v = JSON.parse(r.out).violations.find(
      (x: { code: string }) => x.code === "accessibility-requirement-missing"
    )
    expect(v).toMatchObject({
      severity: "error",
      policy: "policy:icon-buttons-need-labels",
      basis: "approved",
      source: "invariant.policies.json",
      file: "app/Icon.tsx"
    })
    expect(r.code).toBe(1)
    write(
      dir,
      "app/Icon.tsx",
      `import { Button } from "@acme/ui"\nexport const A = () => <Button icon={x} aria-label="Close" />\n`
    )
    expect(
      JSON.parse((await c(dir, "validate", "app", "--format", "json")).out).violations.some(
        (x: { code: string }) => x.code === "accessibility-requirement-missing"
      )
    ).toBe(false)
  })

  it("a policy file that is invalid or unapproved fails the compile with a clear error", async () => {
    const dir = await project()
    const bad = { ...POLICIES, policies: [{ ...POLICIES.policies[0], approval: undefined }] }
    write(dir, "invariant.policies.json", JSON.stringify(bad))
    const r = await c(dir, "compile")
    expect(r.code).toBe(1)
    expect(r.out).toMatch(
      /governance\.invalid-file: invariant\.policies\.json is invalid at policies\.0\.approval/
    )
  })

  it("honors custom file locations from configuration", async () => {
    const dir = await project()
    write(dir, "governance/policies.json", JSON.stringify(POLICIES))
    const cfg = JSON.parse(read(dir, "invariant.config.json"))
    write(
      dir,
      "invariant.config.json",
      JSON.stringify({ ...cfg, governance: { policiesFile: "governance/policies.json" } })
    )
    expect((await c(dir, "compile")).out).toMatch(/policies 1/)
  })
})

describe("review decisions", () => {
  const firstId = (out: string, kind: string): string => {
    const items = JSON.parse(out) as Array<{ id: string; kind: string }>
    return (items.find((i) => i.kind === kind) as { id: string }).id
  }

  it("approving an inferred fact survives recompiles, verifies, and leaves the queue", async () => {
    const dir = await project()
    const before = JSON.parse(
      (await c(dir, "review", "list", "--json", "--kind", "inferred-fact")).out
    ) as Array<{ id: string }>
    expect(before.length).toBeGreaterThan(0)
    const id = before[0]?.id as string
    expect((await c(dir, "review", "show", id)).out).toMatch(/evidence: /)
    expect((await c(dir, "review", "approve", id)).err).toMatch(/say who is deciding/)
    const ok = await cli(
      dir,
      ["review", "approve", id, "--role", "lead", "--reference", "PR-1", "--note", "looks right"],
      { INVARIANT_USER: "Jane" }
    )
    expect(ok.code).toBe(0)
    expect(ok.out).toMatch(/recorded: approve .* by Jane/)
    const decisions = JSON.parse(read(dir, "invariant.decisions.json"))
    expect(decisions.decisions[0]).toMatchObject({
      kind: "fact",
      action: "approve",
      by: "Jane",
      role: "lead",
      reference: "PR-1",
      note: "looks right",
      at: "2026-01-01T00:00:00.000Z"
    })
    const compiled = await c(dir, "compile")
    expect(compiled.out).toMatch(/decisions applied 1/)
    expect((await c(dir, "verify")).code).toBe(0)
    const after = JSON.parse(
      (await c(dir, "review", "list", "--json", "--kind", "inferred-fact")).out
    ) as Array<{ id: string }>
    expect(after.length).toBe(before.length - 1)
    const again = await c(dir, "compile")
    expect(again.out).toMatch(/decisions applied 1/)
    expect(read(dir, "invariant/invariant.contract.json")).toContain('"approvedBy": "Jane"')
  })

  it("resolving, accepting and dismissing conflicts records them in the contract", async () => {
    const dir = await project()
    const list = (await c(dir, "review", "list", "--json", "--kind", "conflict")).out
    const items = JSON.parse(list) as Array<{ id: string }>
    expect(items.length).toBe(6)
    const a = items[0] as { id: string }
    const b = items[1] as { id: string }
    const d = items[2] as { id: string }
    expect(
      (await cli(dir, ["review", "resolve", a.id, "--source", "nope"], { INVARIANT_USER: "Jane" })).err
    ).toMatch(/--source must be one of/)
    expect(
      (
        await cli(dir, ["review", "resolve", a.id, "--source", "react-acme-ui", "--note", "fix the story"], {
          INVARIANT_USER: "Jane"
        })
      ).code
    ).toBe(0)
    expect((await cli(dir, ["review", "accept", b.id], { INVARIANT_USER: "Jane" })).code).toBe(0)
    expect((await cli(dir, ["review", "dismiss", d.id, "--as", "Sam"], {})).code).toBe(0)
    await c(dir, "compile")
    const contract = JSON.parse(read(dir, "invariant/invariant.contract.json"))
    const states = contract.conflicts.map((x: { resolution: { state: string } }) => x.resolution.state).sort()
    expect(states).toEqual(["accepted", "dismissed", "open", "open", "open", "resolved"])
    expect(JSON.parse((await c(dir, "review", "list", "--json", "--kind", "conflict")).out).length).toBe(3)
    expect((await c(dir, "verify")).code).toBe(0)
  })

  it("rejecting an inferred link removes it, and the decision keeps applying", async () => {
    const dir = await project()
    const list = JSON.parse(
      (await c(dir, "review", "list", "--json", "--kind", "inferred-fact")).out
    ) as Array<{ id: string; path: string; subject: string }>
    const link = list.find((i) => i.path.startsWith("appliesTo.")) as { id: string; subject: string }
    expect((await cli(dir, ["review", "reject", link.id], { INVARIANT_USER: "Jane" })).code).toBe(0)
    await c(dir, "compile")
    const contract = JSON.parse(read(dir, "invariant/invariant.contract.json"))
    expect(contract.guidelines.find((g: { id: string }) => g.id === link.subject).appliesTo.length).toBe(0)
    expect(
      JSON.parse((await c(dir, "review", "list", "--json")).out).some((i: { id: string }) => i.id === link.id)
    ).toBe(false)
    expect((await c(dir, "compile")).code).toBe(0)
  })

  it("checks that the action fits the item, and that the approver is allowed", async () => {
    const dir = await project()
    const fact = firstId(
      (await c(dir, "review", "list", "--json", "--kind", "inferred-fact")).out,
      "inferred-fact"
    )
    const conflict = firstId((await c(dir, "review", "list", "--json", "--kind", "conflict")).out, "conflict")
    expect((await cli(dir, ["review", "resolve", fact], { INVARIANT_USER: "Jane" })).err).toMatch(
      /applies to conflicts/
    )
    expect((await cli(dir, ["review", "approve", conflict], { INVARIANT_USER: "Jane" })).err).toMatch(
      /applies to inferred facts/
    )
    expect((await c(dir, "review", "show", "rv_nothing")).code).toBe(1)
    expect((await c(dir, "review", "bogus", fact)).code).toBe(2)
    const cfg = JSON.parse(read(dir, "invariant.config.json"))
    write(dir, "invariant.config.json", JSON.stringify({ ...cfg, governance: { approvers: ["Jane"] } }))
    expect((await cli(dir, ["review", "approve", fact], { INVARIANT_USER: "Mallory" })).err).toMatch(
      /not listed in governance\.approvers/
    )
    expect((await cli(dir, ["review", "approve", fact], { INVARIANT_USER: "Jane" })).code).toBe(0)
  })

  it("a hand-edited decision by someone not on the allowlist is rejected at compile", async () => {
    const dir = await project()
    const fact = firstId(
      (await c(dir, "review", "list", "--json", "--kind", "inferred-fact")).out,
      "inferred-fact"
    )
    await cli(dir, ["review", "approve", fact], { INVARIANT_USER: "Mallory" })
    const cfg = JSON.parse(read(dir, "invariant.config.json"))
    write(dir, "invariant.config.json", JSON.stringify({ ...cfg, governance: { approvers: ["Jane"] } }))
    const r = await c(dir, "compile")
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/governance\.unauthorized/)
    expect(r.out).toMatch(/decisions applied 0/)
  })

  it("a decision about a value that changed is reported stale and not applied", async () => {
    const dir = await project()
    const items = JSON.parse(
      (await c(dir, "review", "list", "--json", "--kind", "inferred-fact")).out
    ) as Array<{ id: string; subject: string; path: string }>
    const item = items.find((i) => i.path === "kind") as { id: string }
    await cli(dir, ["review", "approve", item.id], { INVARIANT_USER: "Jane" })
    const file = JSON.parse(read(dir, "invariant.decisions.json"))
    file.decisions[0].value = "something-else"
    write(dir, "invariant.decisions.json", JSON.stringify(file))
    const r = await c(dir, "compile")
    expect(r.out).toMatch(/decisions applied 0 \(1 stale\)/)
    expect(
      JSON.parse((await c(dir, "review", "list", "--json")).out).some((i: { id: string }) => i.id === item.id)
    ).toBe(true)
  })

  it("an invalid decisions file fails the compile clearly and leaves nothing half-applied", async () => {
    const dir = await project()
    write(dir, "invariant.decisions.json", "{ nope")
    const r = await c(dir, "compile")
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/governance\.invalid-file: invariant\.decisions\.json is not valid JSON/)
    expect(existsSync(path.join(dir, "invariant/invariant.contract.json"))).toBe(true)
  })
})
