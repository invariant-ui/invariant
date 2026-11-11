// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the plugin files hold ${..._PLUGIN_ROOT} literally
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { buildPlugins, CLI_VERSION } from "./build-plugins.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
const tree = buildPlugins()
const text = (rel: string): string => String(tree.get(rel))
const parsed = (rel: string) => JSON.parse(text(rel))
const CLAUDE = "plugins/claude/invariant"
const CURSOR = "plugins/cursor/invariant"

describe("generated plugins", () => {
  it("match the committed files: run `pnpm build:plugins` after changing a skill, hook or the launcher", () => {
    for (const [rel, expected] of tree) {
      const file = path.join(root, rel)
      expect(existsSync(file), `${rel} is missing`).toBe(true)
      expect(readFileSync(file).equals(Buffer.from(expected)), `${rel} is stale`).toBe(true)
    }
  })

  it("carry the CLI version everywhere and no unfilled placeholder", () => {
    expect(parsed(`${CLAUDE}/.claude-plugin/plugin.json`).version).toBe(CLI_VERSION)
    expect(parsed(`${CURSOR}/.cursor-plugin/plugin.json`).version).toBe(CLI_VERSION)
    expect(parsed(".claude-plugin/marketplace.json").plugins[0].version).toBe(CLI_VERSION)
    for (const launcher of [`${CLAUDE}/bin/invariant-launch.mjs`, `${CURSOR}/scripts/invariant-launch.mjs`]) {
      expect(text(launcher)).toContain(`const PINNED_VERSION = "${CLI_VERSION}"`)
      expect(text(launcher)).not.toContain("__INVARIANT_VERSION__")
    }
  })

  it("wire the hook, the MCP server and the early install through the launcher, with fixed commands", () => {
    const hooks = parsed(`${CLAUDE}/hooks/hooks.json`).hooks
    for (const event of ["PreToolUse", "PostToolUse"]) {
      expect(hooks[event][0].matcher).toBe("Write|Edit")
      expect(hooks[event][0].hooks[0]).toMatchObject({
        type: "command",
        command: "node",
        args: ["${CLAUDE_PLUGIN_ROOT}/bin/invariant-launch.mjs", "hook", "--quiet"],
        timeout: 30
      })
    }
    expect(hooks.SessionStart[0].hooks[0].args).toEqual([
      "${CLAUDE_PLUGIN_ROOT}/bin/invariant-launch.mjs",
      "--ensure",
      "--if-configured"
    ])
    const server = parsed(`${CLAUDE}/.mcp.json`).mcpServers.invariant
    expect(server).toEqual({
      command: "node",
      args: ["${CLAUDE_PLUGIN_ROOT}/bin/invariant-launch.mjs", "mcp"]
    })

    expect(parsed(`${CURSOR}/hooks/hooks.json`).hooks.afterFileEdit[0].command).toBe(
      'node "${CURSOR_PLUGIN_ROOT}/scripts/invariant-launch.mjs" hook --quiet --client cursor'
    )
  })

  it("contain no contract-derived text, and the marketplace points at the Claude plugin", () => {
    for (const [rel, content] of tree) {
      if (typeof content === "string") expect(content, rel).not.toMatch(/contract [0-9a-f]{12}/)
    }
    expect(parsed(".claude-plugin/marketplace.json").plugins[0].source).toBe("./plugins/claude/invariant")
  })

  const claude = spawnSync("claude", ["--version"], { encoding: "utf8" })
  it.skipIf(claude.status !== 0)(
    "pass `claude plugin validate --strict` (plugin and marketplace)",
    () => {
      for (const target of [path.join(root, CLAUDE), root]) {
        const r = spawnSync("claude", ["plugin", "validate", target, "--strict"], { encoding: "utf8" })
        expect(r.status, r.stdout + r.stderr).toBe(0)
      }
    },
    60_000
  )
})
