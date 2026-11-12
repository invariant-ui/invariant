// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the plugin files hold ${..._PLUGIN_ROOT} literally
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { buildPlugins, bumped, CLI_VERSION, contentHash, readPluginVersion } from "./build-plugins.ts"

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

  it("install the package the build publishes", () => {
    const published = /NPM_PACKAGE = "([^"]+)"/.exec(
      readFileSync(path.join(root, "apps/cli/src/version.ts"), "utf8")
    )?.[1]
    expect(published).toBe("@invariant-ui/cli")
    expect(text(`${CLAUDE}/bin/invariant-launch.mjs`)).toContain(`const PACKAGE = "${published}"`)
  })

  it("are downloadable from the website at the links the docs use, and those links exist", () => {
    for (const file of ["invariant-claude-code.zip", "invariant-cursor.zip"]) {
      expect(existsSync(path.join(root, "site/downloads", file)), file).toBe(true)
      expect(readFileSync(path.join(root, "site/docs/index.html"), "utf8")).toContain(`../downloads/${file}`)
    }
  })

  it("carry the plugin's own version, and pin the CLI version it was recorded with", () => {
    const { version, cliVersion } = readPluginVersion()
    expect(parsed(`${CLAUDE}/.claude-plugin/plugin.json`).version).toBe(version)
    expect(parsed(`${CURSOR}/.cursor-plugin/plugin.json`).version).toBe(version)
    expect(parsed(".claude-plugin/marketplace.json").plugins[0].version).toBe(version)
    for (const launcher of [`${CLAUDE}/bin/invariant-launch.mjs`, `${CURSOR}/scripts/invariant-launch.mjs`]) {
      expect(text(launcher)).toContain(`const PINNED_VERSION = "${cliVersion}"`)
      expect(text(launcher)).not.toContain("__INVARIANT_VERSION__")
    }
  })

  it("never pin a CLI version newer than the one in this checkout (it might not be on npm yet)", () => {
    const parts = (v: string): number[] => v.split(".").map(Number)
    const [pin, current] = [parts(readPluginVersion().cliVersion), parts(CLI_VERSION)]
    const at = pin.findIndex((n, i) => n !== current[i])
    const newer = at >= 0 && (pin[at] as number) > (current[at] as number)
    expect(newer, `plugin pins CLI ${readPluginVersion().cliVersion} but the CLI is ${CLI_VERSION}`).toBe(
      false
    )
  })

  it("change version whenever their content changes: run `pnpm plugin:bump patch` after editing a skill, hook or the launcher", () => {
    expect(
      contentHash(),
      "the plugins' content changed but the plugin version did not. Claude Code updates by comparing versions, so installed copies would never receive this change. Run: pnpm plugin:bump patch"
    ).toBe(readPluginVersion().contentHash)
  })

  it("bump versions the usual way", () => {
    expect(bumped("0.1.9", "patch")).toBe("0.1.10")
    expect(bumped("0.1.9", "minor")).toBe("0.2.0")
    expect(bumped("0.9.9", "major")).toBe("1.0.0")
    expect(() => bumped("0.1.0", "huge")).toThrow()
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
