// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the clients substitute ${..._PLUGIN_ROOT} in plugin files
// Builds the Claude Code and Cursor plugins from the same sources `agent init` uses.
//   pnpm build && node scripts/build-plugins.ts [--zip]
// Writes plugins/claude/invariant, plugins/cursor/invariant and .claude-plugin/marketplace.json (committed, so a
// GitHub marketplace serves them), and with --zip one archive per client under dist-plugins/.
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
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

/** The CLI this checkout is building. The plugins pin their own CLI version, below, and may lag behind it. */
export const CLI_VERSION = /CLI_VERSION = "([^"]+)"/.exec(read("apps/cli/src/version.ts"))?.[1] as string

/**
 * The plugins have their own version, independent of the CLI's, so that a skill or hook fix reaches users with a
 * plugin release and no npm publish. `cliVersion` is the CLI the launcher installs (it must already be on npm).
 * `contentHash` is a hash of everything the plugins contain apart from those two numbers; a test fails when the
 * content changes and the version does not, because Claude Code decides whether to update by comparing versions.
 */
export const VERSION_FILE = "plugin-src/plugin-version.json"
export interface PluginVersion {
  version: string
  cliVersion: string
  contentHash: string
}
export const readPluginVersion = (): PluginVersion => JSON.parse(read(VERSION_FILE))
type Versions = Pick<PluginVersion, "version" | "cliVersion">
const REPO = "https://github.com/invariant-ui/invariant"
const DESCRIPTION =
  "Make AI tools generate UI that follows your design system. Checks every file the agent writes against your design system's contract."
const STATUS = "invariant: checking the design system contract"
const KEYWORDS = ["design-system", "ai", "mcp", "ui", "enforcement"]

const asset = (rel: string): Buffer => readFileSync(path.join(root, rel))
const AUTHOR = { name: "Invariant", url: REPO }

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`
const launcher = (v: Versions): string =>
  read("plugin-src/invariant-launch.mjs").replace("__INVARIANT_VERSION__", v.cliVersion)

export type Tree = Map<string, string | Buffer>

function claude(v: Versions): Tree {
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
        version: v.version,
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
    ["bin/invariant-launch.mjs", launcher(v)],
    ["LICENSE", read("LICENSE")],
    ["README.md", readme("Claude Code")]
  ])
  for (const f of pluginSkills("claude-code")) tree.set(f.path, f.content)
  return tree
}

function cursor(v: Versions): Tree {
  const command = 'node "${CURSOR_PLUGIN_ROOT}/scripts/invariant-launch.mjs"'
  const tree: Tree = new Map<string, string | Buffer>([
    [
      ".cursor-plugin/plugin.json",
      json({
        name: "invariant",
        version: v.version,
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
    ["scripts/invariant-launch.mjs", launcher(v)],
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
export function buildPlugins(v: Versions = readPluginVersion()): Tree {
  const out: Tree = new Map()
  for (const [rel, text] of claude(v)) out.set(`plugins/claude/invariant/${rel}`, text)
  for (const [rel, text] of cursor(v)) out.set(`plugins/cursor/invariant/${rel}`, text)
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
          version: v.version
        }
      ]
    })
  )
  return out
}

/** What the plugins contain apart from their two version numbers. */
export function contentHash(): string {
  const hash = createHash("sha256")
  const tree = buildPlugins({ version: "0.0.0", cliVersion: "0.0.0" })
  for (const rel of [...tree.keys()].sort())
    hash
      .update(rel)
      .update("\0")
      .update(tree.get(rel) as string | Buffer)
      .update("\0")
  return hash.digest("hex")
}

export function bumped(version: string, kind: string): string {
  const [major, minor, patch] = version.split(".").map(Number) as [number, number, number]
  if (kind === "major") return `${major + 1}.0.0`
  if (kind === "minor") return `${major}.${minor + 1}.0`
  if (kind === "patch") return `${major}.${minor}.${patch + 1}`
  throw new Error(`--bump takes patch, minor, major or none, not "${kind}"`)
}

export function writeTree(base: string, tree: Tree): void {
  for (const [rel, text] of tree) {
    const file = path.join(base, rel)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name: string): string | undefined => {
    const i = process.argv.indexOf(name)
    return i >= 0 ? process.argv[i + 1] : undefined
  }
  let v = readPluginVersion()
  const bump = arg("--bump")
  const cli = arg("--cli")
  if (bump !== undefined || cli !== undefined) {
    // Record a plugin release: a new version (or `--bump none` to only record the hash), and optionally a new
    // pinned CLI version, which must already be published on npm.
    v = {
      ...v,
      ...(cli ? { cliVersion: cli } : {}),
      ...(bump && bump !== "none" ? { version: bumped(v.version, bump) } : {})
    }
    v.contentHash = ""
    writeFileSync(path.join(root, VERSION_FILE), `${JSON.stringify(v, null, 2)}\n`)
    v.contentHash = contentHash()
    writeFileSync(path.join(root, VERSION_FILE), `${JSON.stringify(v, null, 2)}\n`)
  }
  for (const dir of ["plugins", ".claude-plugin"])
    rmSync(path.join(root, dir), { recursive: true, force: true })
  writeTree(root, buildPlugins(v))
  console.log(
    `wrote plugins/ and .claude-plugin/marketplace.json (plugin ${v.version}, pins CLI ${v.cliVersion})`
  )
  if (process.argv.includes("--zip")) {
    const dist = path.join(root, "dist-plugins")
    rmSync(dist, { recursive: true, force: true })
    mkdirSync(dist, { recursive: true })
    for (const client of ["claude", "cursor"]) {
      const zip = path.join(dist, `invariant-${client}-${v.version}.zip`)
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
