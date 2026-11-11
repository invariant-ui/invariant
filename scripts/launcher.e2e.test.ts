import { spawn, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("..", import.meta.url))
const launcher = path.join(root, "plugin-src/invariant-launch.mjs")
const made: string[] = []
const tmp = (name: string): string => {
  const d = mkdtempSync(path.join(tmpdir(), `invariant-${name}-`))
  made.push(d)
  return d
}
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

/** A stand-in for the published package: a `bin` that prints its arguments and what arrived on stdin. */
let tarball = ""
beforeAll(() => {
  const pkg = tmp("fakepkg")
  writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: "invariant-ui", version: "9.9.9", bin: { invariant: "bin.js" } })
  )
  writeFileSync(
    path.join(pkg, "bin.js"),
    `let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>console.log(JSON.stringify({argv:process.argv.slice(2),stdin:s})))\nif(process.argv[2]==="mcp")console.log("mcp up")`
  )
  const out = tmp("tarball")
  const packed = spawnSync("npm", ["pack", pkg, "--pack-destination", out, "--silent"], { encoding: "utf8" })
  expect(packed.status).toBe(0)
  tarball = path.join(out, packed.stdout.trim().split("\n").at(-1) as string)
})

interface Out {
  code: number | null
  out: string
  err: string
  ms: number
}

function launch(
  args: string[],
  opts: { stdin?: string; env: Record<string, string>; cwd?: string }
): Promise<Out> {
  return new Promise((resolve) => {
    const t = Date.now()
    const child = spawn("node", [launcher, ...args], {
      cwd: opts.cwd,
      env: { PATH: process.env.PATH ?? "", ...opts.env }
    })
    let out = ""
    let err = ""
    child.stdout.on("data", (c) => (out += c))
    child.stderr.on("data", (c) => (err += c))
    child.on("close", (code) => resolve({ code, out, err, ms: Date.now() - t }))
    child.stdin.end(opts.stdin ?? "")
  })
}

const sandbox = (): { home: string; project: string; env: Record<string, string> } => {
  const home = tmp("home")
  const project = tmp("project")
  return {
    home,
    project,
    env: {
      INVARIANT_HOME: home,
      INVARIANT_INSTALL_SPEC: tarball,
      INVARIANT_CLI_VERSION: "9.9.9",
      CLAUDE_PROJECT_DIR: project
    }
  }
}
const configure = (project: string): void => writeFileSync(path.join(project, "invariant.config.json"), "{}")
const installed = (home: string): boolean =>
  existsSync(path.join(home, "cli")) &&
  spawnSync("find", [path.join(home, "cli"), "-path", "*node_modules/invariant-ui/package.json"], {
    encoding: "utf8"
  }).stdout.trim() !== ""

describe("plugin launcher", () => {
  it("exits quietly and installs nothing in a project without an Invariant config", async () => {
    const s = sandbox()
    const r = await launch(["hook"], { stdin: "{}", env: s.env })
    expect(r).toMatchObject({ code: 0, out: "", err: "" })
    expect(existsSync(path.join(s.home, "cli"))).toBe(false)
  })

  it("--ensure installs the pinned CLI once, even when four run at the same time", async () => {
    const s = sandbox()
    const runs = await Promise.all([1, 2, 3, 4].map(() => launch(["--ensure"], { env: s.env })))
    expect(runs.map((r) => r.code)).toEqual([0, 0, 0, 0])
    expect(installed(s.home)).toBe(true)
    expect(existsSync(path.join(s.home, "cli/9.9.9.lock"))).toBe(false)
  }, 60_000)

  it("--ensure --if-configured installs only in a project that uses Invariant", async () => {
    const plain = sandbox()
    expect((await launch(["--ensure", "--if-configured"], { env: plain.env })).code).toBe(0)
    expect(existsSync(path.join(plain.home, "cli"))).toBe(false)

    const used = sandbox()
    configure(used.project)
    expect((await launch(["--ensure", "--if-configured"], { env: used.env })).code).toBe(0)
    expect(installed(used.home)).toBe(true)
  }, 60_000)

  it("passes a hook's stdin and arguments straight to the installed CLI", async () => {
    const s = sandbox()
    configure(s.project)
    await launch(["--ensure"], { env: s.env })
    const r = await launch(["hook", "--quiet"], { stdin: '{"a":1}', env: s.env })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out)).toEqual({ argv: ["hook", "--quiet"], stdin: '{"a":1}' })
  }, 60_000)

  it("never makes a hook wait for an install: it lets the write through and installs in the background", async () => {
    const s = sandbox()
    configure(s.project)
    const r = await launch(["hook"], { stdin: "{}", env: s.env })
    expect(r.code).toBe(0)
    expect(r.out).toBe("")
    expect(r.err).toContain("installing")
    for (let i = 0; i < 100 && !installed(s.home); i++) await new Promise((x) => setTimeout(x, 200))
    expect(installed(s.home)).toBe(true)
  }, 60_000)

  it("finds the project from a Cursor payload when the environment says nothing", async () => {
    const s = sandbox()
    configure(s.project)
    await launch(["--ensure"], { env: s.env })
    const { CLAUDE_PROJECT_DIR: _drop, ...env } = s.env
    const payload = JSON.stringify({ workspace_roots: [s.project], file_path: path.join(s.project, "a.tsx") })
    const r = await launch(["hook", "--client", "cursor"], { stdin: payload, env })
    expect(JSON.parse(r.out).argv).toEqual(["hook", "--client", "cursor"])
  }, 60_000)

  it("prefers an invariant on PATH over the pinned copy", async () => {
    const s = sandbox()
    configure(s.project)
    const bin = tmp("bin")
    writeFileSync(path.join(bin, "invariant"), "#!/bin/sh\necho on-path\n")
    chmodSync(path.join(bin, "invariant"), 0o755)
    const r = await launch(["hook"], {
      stdin: "{}",
      env: { ...s.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }
    })
    expect(r.out.trim()).toBe("on-path")
    expect(existsSync(path.join(s.home, "cli"))).toBe(false)
  })

  it("installs on demand for the MCP server, and fails with advice when the install cannot happen", async () => {
    const s = sandbox()
    const ok = await launch(["mcp"], { env: s.env })
    expect(ok.out).toContain("mcp up")

    const bad = sandbox()
    const failed = await launch(["mcp"], {
      env: { ...bad.env, INVARIANT_INSTALL_SPEC: path.join(bad.home, "missing.tgz") }
    })
    expect(failed.code).toBe(1)
    expect(failed.err).toContain("no invariant CLI is available")

    // The same failure inside a hook still lets the write through.
    configure(bad.project)
    mkdirSync(bad.home, { recursive: true })
    const hook = await launch(["hook"], {
      stdin: "{}",
      env: { ...bad.env, INVARIANT_INSTALL_SPEC: path.join(bad.home, "missing.tgz") }
    })
    expect(hook.code).toBe(0)
  }, 60_000)
})
