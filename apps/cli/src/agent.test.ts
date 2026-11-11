import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"
import { FIXED_CLOCK } from "@invariant/compiler-core/testing"
import { afterAll, describe, expect, it } from "vitest"
import { run } from "./index.js"

const root = fileURLToPath(new URL("../../..", import.meta.url))
const made: string[] = []
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

async function compiled(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "invariant-agent-"))
  made.push(dir)
  cpSync(path.join(root, "fixtures/storybook/acme-ui"), dir, {
    recursive: true,
    filter: (s) => !s.includes("storybook-static")
  })
  await cli(dir, "init")
  await cli(dir, "compile")
  return dir
}

async function cli(cwd: string, ...argv: string[]) {
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
const read = (dir: string, rel: string): string => readFileSync(path.join(dir, rel), "utf8")

describe("agent init", () => {
  it("writes configuration and skills for every client, and is idempotent", async () => {
    const dir = await compiled()
    const first = await cli(dir, "agent", "init", "all")
    expect(first.code).toBe(0)
    for (const f of [
      ".mcp.json",
      ".claude/skills/invariant-build-ui/SKILL.md",
      ".claude/skills/invariant-refactor-ui/SKILL.md",
      ".cursor/mcp.json",
      ".cursor/rules/invariant.mdc",
      ".codex/config.toml",
      "AGENTS.md",
      ".windsurf/rules/invariant.md"
    ])
      expect(existsSync(path.join(dir, f)), f).toBe(true)
    expect(JSON.parse(read(dir, ".mcp.json")).mcpServers.invariant).toEqual({
      command: "invariant",
      args: ["mcp", "--dir", "invariant"]
    })
    expect(JSON.parse(read(dir, ".cursor/mcp.json")).mcpServers.invariant.type).toBe("stdio")
    expect(read(dir, ".codex/config.toml")).toContain('args = ["mcp", "--dir", "invariant"]')
    expect(first.out).toMatch(/Windsurf's MCP settings/)
    expect(first.out).toMatch(/"mcpServers"/)
    const second = await cli(dir, "agent", "init", "all")
    expect(second.out).not.toMatch(/created|updated/)
    expect(second.out).toMatch(/unchanged/)
  })

  it("supports a custom launch command and a dry run that writes nothing", async () => {
    const dir = await compiled()
    const dry = await cli(
      dir,
      "agent",
      "init",
      "claude-code",
      "--dry-run",
      "--command",
      "node",
      "--command-arg",
      "/opt/invariant/main.js"
    )
    expect(dry.out).toMatch(/dry run/)
    expect(existsSync(path.join(dir, ".mcp.json"))).toBe(false)
    await cli(
      dir,
      "agent",
      "init",
      "claude-code",
      "--command",
      "node",
      "--command-arg",
      "/opt/invariant/main.js"
    )
    expect(JSON.parse(read(dir, ".mcp.json")).mcpServers.invariant).toEqual({
      command: "node",
      args: ["/opt/invariant/main.js", "mcp", "--dir", "invariant"]
    })
  })

  it("follows a custom output directory", async () => {
    const dir = await compiled()
    await cli(dir, "compile", "--dir", "out/contract")
    await cli(dir, "agent", "init", "cursor", "--dir", "out/contract")
    expect(JSON.parse(read(dir, ".cursor/mcp.json")).mcpServers.invariant.args).toEqual([
      "mcp",
      "--dir",
      "out/contract"
    ])
  })

  it("needs a compiled contract, rejects unknown clients and bad commands", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "invariant-agent-"))
    made.push(dir)
    expect((await cli(dir, "agent", "init", "cursor")).err).toMatch(/invariant compile/)
    const ready = await compiled()
    expect((await cli(ready, "agent", "init", "emacs")).code).toBe(2)
    expect((await cli(ready, "agent", "init")).code).toBe(2)
    expect((await cli(ready, "agent", "init", "cursor", "--command", "a\nb")).code).toBe(2)
    expect((await cli(ready, "agent", "list")).out.split("\n")).toEqual([
      "claude-code",
      "cursor",
      "codex",
      "windsurf",
      ""
    ])
    expect((await cli(ready, "agent", "init", "cursor", "--dir", "../x")).code).toBe(2)
  })

  it("leaves user files alone and says why", async () => {
    const dir = await compiled()
    await cli(dir, "agent", "init", "claude-code")
    const file = path.join(dir, ".mcp.json")
    const mine = JSON.stringify({ mcpServers: { invariant: { command: "mine" } } })
    writeFileSync(file, mine)
    const r = await cli(dir, "agent", "init", "claude-code")
    expect(r.out).toMatch(/skipped\s+\.mcp\.json.*use --force/)
    expect(read(dir, ".mcp.json")).toBe(mine)
    expect(r.out).toMatch(/1 file\(s\) were left alone/)
  })
})

describe("agent init: enforcement hooks", () => {
  const settings = (dir: string): Record<string, unknown> => JSON.parse(read(dir, ".claude/settings.json"))
  const hookEntries = (dir: string, event: string): unknown[] =>
    (settings(dir).hooks as Record<string, unknown[]>)[event] ?? []

  it("writes PreToolUse and PostToolUse hook entries for claude-code only", async () => {
    const dir = await compiled()
    const r = await cli(dir, "agent", "init", "all")
    expect(r.code).toBe(0)
    const expected = [
      {
        matcher: "Write|Edit",
        hooks: [
          {
            type: "command",
            command: "invariant",
            args: ["hook"],
            timeout: 30,
            statusMessage: "invariant: checking the design system contract"
          }
        ]
      }
    ]
    expect(hookEntries(dir, "PreToolUse")).toEqual(expected)
    expect(hookEntries(dir, "PostToolUse")).toEqual(expected)
    // Only Claude Code has hook entries in the plan; other clients keep their own shape.
    await cli(dir, "agent", "init", "cursor")
    expect(JSON.parse(read(dir, ".cursor/mcp.json")).hooks).toBeUndefined()
  })

  it("mentions the hooks and their fail-open behavior in the notes", async () => {
    const dir = await compiled()
    const r = await cli(dir, "agent", "init", "claude-code")
    expect(r.out).toMatch(/run `invariant hook` before and after every Write and Edit/)
    expect(r.out).toMatch(/fail open/)
    expect(r.out).toMatch(/enforcement\.hooks/)
  })

  it("is idempotent, and reflects a custom launch command", async () => {
    const dir = await compiled()
    await cli(dir, "agent", "init", "claude-code")
    const again = await cli(dir, "agent", "init", "claude-code")
    expect(again.out).toMatch(/unchanged\s+\.claude\/settings\.json/)
    await cli(
      dir,
      "agent",
      "init",
      "claude-code",
      "--command",
      "node",
      "--command-arg",
      "/opt/invariant/main.js",
      "--force"
    )
    const hooks = hookEntries(dir, "PreToolUse")[0] as { hooks: Array<Record<string, unknown>> }
    expect(hooks.hooks[0]).toMatchObject({
      command: "node",
      args: ["/opt/invariant/main.js", "hook"]
    })
  })

  it("keeps hooks the user configured and appends ours", async () => {
    const dir = await compiled()
    const user = {
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo", args: ["hi"] }] }]
      }
    }
    mkdirSync(path.join(dir, ".claude"), { recursive: true })
    writeFileSync(path.join(dir, ".claude/settings.json"), JSON.stringify(user, null, 2))
    const r = await cli(dir, "agent", "init", "claude-code")
    expect(r.code).toBe(0)
    const pre = hookEntries(dir, "PreToolUse")
    expect(pre).toHaveLength(2)
    expect(pre[0]).toEqual(user.hooks.PreToolUse[0])
    expect((pre[1] as { matcher: string }).matcher).toBe("Write|Edit")
    expect(hookEntries(dir, "PostToolUse")).toHaveLength(1)
  })

  it("replaces an entry it owns only when forced", async () => {
    const dir = await compiled()
    await cli(dir, "agent", "init", "claude-code")
    const tweaked = settings(dir) as {
      hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>
    }
    for (const event of ["PreToolUse", "PostToolUse"])
      for (const group of tweaked.hooks[event] ?? []) for (const hook of group.hooks) hook.timeout = 10
    writeFileSync(path.join(dir, ".claude/settings.json"), JSON.stringify(tweaked, null, 2))
    const r = await cli(dir, "agent", "init", "claude-code")
    expect(r.out).toMatch(/skipped\s+\.claude\/settings\.json.*use --force/)
    const forced = await cli(dir, "agent", "init", "claude-code", "--force")
    expect(forced.code).toBe(0)
    const groups = hookEntries(dir, "PreToolUse")
    const hooks = groups[0] as { hooks: Array<Record<string, unknown>> }
    expect(hooks.hooks[0]?.timeout).toBe(30)
  })

  it("leaves a settings.json that is not plain JSON alone", async () => {
    const dir = await compiled()
    mkdirSync(path.join(dir, ".claude"), { recursive: true })
    writeFileSync(path.join(dir, ".claude/settings.json"), '{ "$schema": … } // hand-edited')
    const r = await cli(dir, "agent", "init", "claude-code")
    expect(r.out).toMatch(/skipped\s+\.claude\/settings\.json.*not plain JSON/)
    expect(read(dir, ".claude/settings.json")).toBe('{ "$schema": … } // hand-edited')
  })
})

describe("mcp", () => {
  it("serves the compiled contract over the given streams, writing only protocol messages to the output", async () => {
    const dir = await compiled()
    const input = new PassThrough()
    const output = new PassThrough()
    const chunks: string[] = []
    output.on("data", (c) => chunks.push(String(c)))
    let err = ""
    const done = run(["mcp"], {
      cwd: dir,
      stdout: () => {},
      stderr: (t) => (err += t),
      clock: FIXED_CLOCK,
      input,
      output
    })
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`
    )
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_component", arguments: { name: "button" } } })}\n`
    )
    input.end()
    expect(await done).toBe(0)
    const lines = chunks
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    expect(lines.map((l) => l.id)).toEqual([1, 2])
    expect(lines[1].result.structuredContent.id).toBe("component:button")
    expect(err).toMatch(/read-only, stdio/)
  })

  it("starts without a compiled contract and tells the model how to fix it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "invariant-agent-"))
    made.push(dir)
    const input = new PassThrough()
    const output = new PassThrough()
    const chunks: string[] = []
    output.on("data", (c) => chunks.push(String(c)))
    const done = run(["mcp"], {
      cwd: dir,
      stdout: () => {},
      stderr: () => {},
      clock: FIXED_CLOCK,
      input,
      output
    })
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_design_system_overview" } })}\n`
    )
    input.end()
    expect(await done).toBe(0)
    expect(JSON.parse(chunks.join("").trim()).result.content[0].text).toMatch(/invariant compile/)
  })

  it("refuses to run without streams", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "invariant-agent-"))
    made.push(dir)
    expect((await cli(dir, "mcp")).code).toBe(2)
  })
})
