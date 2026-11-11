import { pluginRules, pluginSkills, SKILL_NAMES } from "@invariant/agent-kit"
import { run } from "@invariant/cli"
import { FIXED_CLOCK } from "@invariant/compiler-core/testing"
import { describe, expect, it } from "vitest"

const skill = (client: "claude-code" | "cursor", name: string): string =>
  pluginSkills(client).find((f) => f.path === `skills/${name}/SKILL.md`)?.content as string

describe("plugin skills", () => {
  it("ship the setup skill and generic copies of every other skill, for both clients", () => {
    for (const client of ["claude-code", "cursor"] as const) {
      const paths = pluginSkills(client).map((f) => f.path)
      expect(paths).toEqual([...SKILL_NAMES.map((n) => `skills/${n}/SKILL.md`), "skills/setup/SKILL.md"])
    }
  })

  it("name no contract, component or pattern, and no hash: they are installed before a contract exists", () => {
    for (const f of [...pluginSkills("claude-code"), ...pluginSkills("cursor"), ...pluginRules()]) {
      expect(f.content, f.path).not.toMatch(/contract [0-9a-f]{12}/)
      expect(f.content, f.path).not.toContain("run `invariant compile` first")
      expect(f.content, f.path).not.toContain("Components in the contract:")
      expect(f.content, f.path).not.toContain("Approved page archetypes:")
    }
    expect(skill("claude-code", "invariant-build-ui")).toContain(
      "Find components with `search_design_system`"
    )
  })

  it("use each client's own tool names and launcher", () => {
    const claude = skill("claude-code", "invariant-build-ui")
    expect(claude).toContain("mcp__plugin_invariant_invariant__get_component")
    expect(claude).not.toContain("mcp__invariant__")
    expect(skill("claude-code", "setup")).toContain(`node "\${CLAUDE_PLUGIN_ROOT}/bin/invariant-launch.mjs"`)

    const cursor = skill("cursor", "invariant-build-ui")
    expect(cursor).not.toContain("allowed-tools")
    expect(skill("cursor", "setup")).toContain(`node "\${CURSOR_PLUGIN_ROOT}/scripts/invariant-launch.mjs"`)
    expect(pluginRules()[0]?.content).toContain("alwaysApply: true")
  })

  it("the setup skill only uses CLI commands and flags that exist", async () => {
    let help = ""
    await run(["--help"], {
      cwd: process.cwd(),
      stdout: (t) => (help += t),
      stderr: () => {},
      clock: FIXED_CLOCK,
      env: {}
    })
    const text = skill("claude-code", "setup")
    const flags = new Set(text.match(/--[a-z][a-z-]+/g))
    expect(flags.size).toBeGreaterThan(8)
    // `--ensure` belongs to the launcher; every other flag must be one the CLI documents.
    for (const flag of flags) {
      if (flag === "--ensure") continue
      expect(help, flag).toContain(flag)
    }
    for (const command of ["compile", "setup", "enforcement report", "source add", "source remove"])
      expect(help, command).toContain(command)
  })
})
