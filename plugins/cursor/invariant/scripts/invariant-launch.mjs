#!/usr/bin/env node
// Runs the Invariant CLI for an agent plugin. One dependency-free file, shared by the Claude Code and Cursor
// plugins (docs/decisions/0005-agent-plugins.md).
//
//   node invariant-launch.mjs hook [--quiet ...]   a write-time hook: payload on stdin
//   node invariant-launch.mjs mcp  [...]           the MCP server over stdio
//   node invariant-launch.mjs --ensure [--if-configured]
//                                                  install the pinned CLI if it is missing, then exit;
//                                                  with --if-configured, only in a project that uses Invariant
//   node invariant-launch.mjs <any invariant args> everything else is passed straight through
//
// Which CLI runs, in order: $INVARIANT_CLI (an explicit path), `invariant` on PATH, then a pinned copy in
// $INVARIANT_HOME (default ~/.invariant). The pinned copy is installed with `npm install --ignore-scripts`
// from $INVARIANT_INSTALL_SPEC (default @invariant-ui/cli@<pinned version>; a tarball path or URL also works).
// Only `--ensure` and `mcp` wait for an install. A hook never does: it starts the install in the background
// and lets the write through, because a hook that waits would blow its time budget.
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** Replaced with the CLI version this plugin was built for. */
const PINNED_VERSION = "0.1.0"
const PACKAGE = "@invariant-ui/cli"
const STALE_LOCK_MS = 5 * 60_000
const WAIT_MS = 180_000
const env = process.env
const win = process.platform === "win32"

const note = (text) => process.stderr.write(`invariant launcher: ${text}\n`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const version = env.INVARIANT_CLI_VERSION ?? PINNED_VERSION
const spec = env.INVARIANT_INSTALL_SPEC ?? `${PACKAGE}@${version}`
const home = env.INVARIANT_HOME ?? path.join(homedir(), ".invariant")
const slot = path.join(
  home,
  "cli",
  version.replace(/[^\w.-]/g, "_") +
    (env.INVARIANT_INSTALL_SPEC ? `-${createHash("sha256").update(spec).digest("hex").slice(0, 8)}` : "")
)

/** The installed package's entry file, or undefined if nothing usable is installed. */
function installedEntry() {
  try {
    const dir = path.join(slot, "node_modules", PACKAGE)
    const bin = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).bin
    const rel = typeof bin === "string" ? bin : (bin?.invariant ?? Object.values(bin ?? {})[0])
    const entry = rel ? path.join(dir, rel) : undefined
    return entry && existsSync(entry) ? entry : undefined
  } catch {
    return undefined
  }
}

function onPath() {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue
    for (const name of win ? ["invariant.cmd", "invariant.exe"] : ["invariant"]) {
      const file = path.join(dir, name)
      if (existsSync(file)) return file
    }
  }
  return undefined
}

/** How to start the CLI: a command and the leading arguments, or undefined if there is none yet. */
function resolveCli() {
  if (env.INVARIANT_CLI) return { command: env.INVARIANT_CLI, args: [], shell: win }
  const found = onPath()
  if (found) return { command: found, args: [], shell: win }
  const entry = installedEntry()
  return entry ? { command: process.execPath, args: [entry], shell: false } : undefined
}

/** Installs the pinned CLI under an exclusive lock, so concurrent hooks wait for one install instead of racing. */
async function ensure() {
  if (installedEntry()) return true
  mkdirSync(path.join(home, "cli"), { recursive: true })
  const lock = `${slot}.lock`
  const started = Date.now()
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch {
      if (installedEntry()) return true
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS)
          rmSync(lock, { recursive: true, force: true })
      } catch {}
      if (Date.now() - started > WAIT_MS) return false
      await sleep(250)
    }
  }
  try {
    if (installedEntry()) return true
    mkdirSync(slot, { recursive: true })
    const run = spawnSync(
      win ? "npm.cmd" : "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", "--prefix", slot, spec],
      { encoding: "utf8", shell: win }
    )
    if (run.status !== 0) {
      note(
        `could not install ${spec}: ${(run.stderr || run.error?.message || "npm failed").trim().split("\n")[0]}`
      )
      return false
    }
    return installedEntry() !== undefined
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks)
}

/** The directory the agent is working in, from the environment or the payload either client sends. */
function projectDir(payload) {
  if (env.CLAUDE_PROJECT_DIR) return env.CLAUDE_PROJECT_DIR
  try {
    const json = JSON.parse(payload.toString("utf8"))
    return json.cwd ?? json.workspace_roots?.[0] ?? process.cwd()
  } catch {
    return process.cwd()
  }
}

function configured(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (existsSync(path.join(d, "invariant.config.json"))) return true
    if (path.dirname(d) === d) return false
  }
}

function run(cli, args, input) {
  const child = spawn(cli.command, [...cli.args, ...args], {
    stdio: [input ? "pipe" : "inherit", "inherit", "inherit"],
    shell: cli.shell
  })
  if (input) child.stdin.end(input)
  for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => child.kill(s))
  child.on("error", (e) => {
    note(e.message)
    process.exit(args[0] === "hook" ? 0 : 1)
  })
  child.on("close", (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
}

const args = process.argv.slice(2)

if (args[0] === "--ensure") {
  if (args.includes("--if-configured") && !configured(projectDir(Buffer.alloc(0)))) process.exit(0)
  process.exit((await ensure()) ? 0 : 1)
} else if (args[0] === "hook") {
  // Fail open in every way: a launcher problem must never stop an agent from writing a file.
  const payload = await readStdin()
  if (!configured(projectDir(payload))) process.exit(0)
  const cli = resolveCli()
  if (!cli) {
    const self = fileURLToPath(import.meta.url)
    spawn(process.execPath, [self, "--ensure"], { detached: true, stdio: "ignore", env }).unref()
    note(`installing ${spec} in the background; writes are unchecked until it finishes`)
    process.exit(0)
  }
  run(cli, args, payload)
} else {
  let cli = resolveCli()
  if (!cli && (await ensure())) cli = resolveCli()
  if (!cli) {
    note(`no invariant CLI is available (tried PATH and ${slot}); install it with: npm install -g ${PACKAGE}`)
    process.exit(1)
  }
  run(cli, args)
}
