// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the clients substitute ${..._PLUGIN_ROOT} in plugin files
// Builds the Claude Code and Cursor plugins from the same sources `agent init` uses.
//   pnpm build && node scripts/build-plugins.ts [--zip]
// Writes plugins/claude/invariant, plugins/cursor/invariant and .claude-plugin/marketplace.json (committed, so a
// GitHub marketplace serves them), and with --zip one archive per client under dist-plugins/.
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Loaded from the build output (`pnpm build` first), typed from the workspace package, so typecheck needs no build.
const { pluginRules, pluginSkills } = (await import(
  new URL("../packages/agent-kit/dist/index.js", import.meta.url).href
)) as typeof import("@invariant/agent-kit")

const root = fileURLToPath(new URL("..", import.meta.url))
const read = (rel: string): string => readFileSync(path.join(root, rel), "utf8")

export const CLI_VERSION = /CLI_VERSION = "([^"]+)"/.exec(read("apps/cli/src/version.ts"))?.[1] as string
const REPO = "https://github.com/invariant-ui/invariant"
const DESCRIPTION =
  "Make AI tools generate UI that follows your design system. Checks every file the agent writes against your design system's contract."
const STATUS = "invariant: checking the design system contract"
const KEYWORDS = ["design-system", "ai", "mcp", "ui", "enforcement"]

const asset = (rel: string): Buffer => readFileSync(path.join(root, rel))
const AUTHOR = { name: "Invariant", url: REPO }

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`
const launcher = (): string =>
  read("plugin-src/invariant-launch.mjs").replace("__INVARIANT_VERSION__", CLI_VERSION)

export type Tree = Map<string, string | Buffer>

function claude(): Tree {
  const run = (args: string[]) => ({
    type: "command",
    command: "node",
    args: ["${CLAUDE_PLUGIN_ROOT}/bin/invariant-launch.mjs", ...args]
  })
  const check = { ...run(["hook", "--quiet"]), timeout: 30, statusMessage: STATUS }
  const tree: Tree = new Map<string, string | Buffer>([
    [
      ".claude-plugin/plugin.json",
      json({
        name: "invariant",
        version: CLI_VERSION,
        description: DESCRIPTION,
        author: AUTHOR,
        homepage: "https://invariant-ui.com/",
        repository: REPO,
        license: "FSL-1.1-ALv2",
        keywords: KEYWORDS,
        icon: "./.claude-plugin/icon.png"
      })
    ],
    [
      "hooks/hooks.json",
      json({
        description: "Checks every file the agent writes against the design system contract.",
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  ...run(["--ensure", "--if-configured"]),
                  timeout: 300,
                  statusMessage: "invariant: preparing the checker"
                }
              ]
            }
          ],
          PreToolUse: [{ matcher: "Write|Edit", hooks: [check] }],
          PostToolUse: [{ matcher: "Write|Edit", hooks: [check] }]
        }
      })
    ],
    [
      ".mcp.json",
      json({
        mcpServers: {
          invariant: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/bin/invariant-launch.mjs", "mcp"] }
        }
      })
    ],
    [".claude-plugin/icon.png", asset("site/assets/logo-icon-512.png")],
    ["bin/invariant-launch.mjs", launcher()],
    ["LICENSE", read("LICENSE")],
    ["README.md", readme("Claude Code")]
  ])
  for (const f of pluginSkills("claude-code")) tree.set(f.path, f.content)
  return tree
}

function cursor(): Tree {
  const command = 'node "${CURSOR_PLUGIN_ROOT}/scripts/invariant-launch.mjs"'
  const tree: Tree = new Map<string, string | Buffer>([
    [
      ".cursor-plugin/plugin.json",
      json({
        name: "invariant",
        version: CLI_VERSION,
        description: DESCRIPTION,
        author: AUTHOR,
        keywords: KEYWORDS,
        logo: "assets/logo.svg"
      })
    ],
    [
      "hooks/hooks.json",
      json({ version: 1, hooks: { afterFileEdit: [{ command: `${command} hook --quiet --client cursor` }] } })
    ],
    [
      "mcp.json",
      json({
        mcpServers: {
          invariant: { command: "node", args: ["${CURSOR_PLUGIN_ROOT}/scripts/invariant-launch.mjs", "mcp"] }
        }
      })
    ],
    ["scripts/invariant-launch.mjs", launcher()],
    ["assets/logo.svg", asset("site/assets/logo-icon.svg")],
    ["LICENSE", read("LICENSE")],
    ["README.md", readme("Cursor")]
  ])
  for (const f of [...pluginSkills("cursor"), ...pluginRules()]) tree.set(f.path, f.content)
  return tree
}

function readme(client: string): string {
  return `# Invariant for ${client}

${DESCRIPTION}

Install:

${client === "Claude Code" ? "```\n/plugin install invariant --marketplace invariant-ui/invariant\n```" : "Download the Cursor zip from the website, unzip it into `~/.cursor/plugins/local/invariant`, and reload the window."}

After installing, ask your AI tool to run \`/invariant:setup\` (or say "set up Invariant"). It finds your design system, shows you what it found, asks you to approve it, and turns on the checks. Nothing is approved without your yes.

Needs Node.js 20 or newer. The first time it runs, it installs the Invariant command line tool into \`~/.invariant/\`. If you already have \`invariant\` on your PATH, that one is used.

Source and documentation: ${REPO}
`
}

/** Every file the generator owns, by path relative to the repository root. */
export function buildPlugins(): Tree {
  const out: Tree = new Map()
  for (const [rel, text] of claude()) out.set(`plugins/claude/invariant/${rel}`, text)
  for (const [rel, text] of cursor()) out.set(`plugins/cursor/invariant/${rel}`, text)
  out.set(
    ".claude-plugin/marketplace.json",
    json({
      name: "invariant",
      description: "Invariant: AI tools that follow your design system.",
      owner: { name: "invariant-ui" },
      plugins: [
        {
          name: "invariant",
          source: "./plugins/claude/invariant",
          author: AUTHOR,
          description: DESCRIPTION,
          version: CLI_VERSION
        }
      ]
    })
  )
  return out
}

export function writeTree(base: string, tree: Tree): void {
  for (const [rel, text] of tree) {
    const file = path.join(base, rel)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const dir of ["plugins", ".claude-plugin"])
    rmSync(path.join(root, dir), { recursive: true, force: true })
  writeTree(root, buildPlugins())
  console.log(`wrote plugins/ and .claude-plugin/marketplace.json (version ${CLI_VERSION})`)
  if (process.argv.includes("--zip")) {
    const dist = path.join(root, "dist-plugins")
    rmSync(dist, { recursive: true, force: true })
    mkdirSync(dist, { recursive: true })
    for (const client of ["claude", "cursor"]) {
      const zip = path.join(dist, `invariant-${client}-${CLI_VERSION}.zip`)
      const r = spawnSync("zip", ["-qr", zip, "."], { cwd: path.join(root, "plugins", client, "invariant") })
      if (r.status !== 0) throw new Error(`zip failed for ${client}: ${String(r.stderr)}`)
      console.log(`wrote ${path.relative(root, zip)}`)
      // The website links these fixed names, so the links survive a version bump.
      const served = path.join(
        root,
        "site/downloads",
        `invariant-${client === "claude" ? "claude-code" : client}.zip`
      )
      mkdirSync(path.dirname(served), { recursive: true })
      copyFileSync(zip, served)
      console.log(`wrote ${path.relative(root, served)}`)
    }
  }
}

export const scratch = (): string => mkdtempSync(path.join(tmpdir(), "invariant-plugins-"))
