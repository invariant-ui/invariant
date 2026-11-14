import { execFileSync } from "node:child_process"
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { run } from "@invariant/cli"
import { FIXED_CLOCK } from "@invariant/compiler-core/testing"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { buildNpmPackage, NPM_NAME } from "./build-npm.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
const made: string[] = []
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

function* files(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const f = path.join(dir, e)
    if (statSync(f).isDirectory()) yield* files(f)
    else yield f
  }
}

let pkg = ""
beforeAll(() => {
  execFileSync(path.join(root, "node_modules/.bin/tsc"), ["-b"], { cwd: root })
  const dir = mkdtempSync(path.join(tmpdir(), "invariant-npm-"))
  made.push(dir)
  pkg = path.join(dir, "pkg")
  buildNpmPackage(pkg)
  // Stand in for `npm install`: the three runtime dependencies, from this workspace's own install.
  const nm = path.join(pkg, "node_modules")
  mkdirSync(path.join(nm, "@vue"), { recursive: true })
  symlinkSync(
    realpathSync(path.join(root, "packages/validation/node_modules/typescript")),
    path.join(nm, "typescript")
  )
  symlinkSync(realpathSync(path.join(root, "packages/validation/node_modules/zod")), path.join(nm, "zod"))
  symlinkSync(
    realpathSync(path.join(root, "packages/compiler-vue/node_modules/@vue/compiler-sfc")),
    path.join(nm, "@vue/compiler-sfc")
  )
}, 120_000)

describe("the published package", () => {
  it("is one package with a bin and only the runtime dependencies", () => {
    const manifest = JSON.parse(readFileSync(path.join(pkg, "package.json"), "utf8"))
    expect(manifest.name).toBe(NPM_NAME)
    expect(manifest.name).not.toBe("invariant")
    expect(manifest.bin).toEqual({ invariant: "dist/cli/main.js" })
    expect(Object.keys(manifest.dependencies)).toEqual(["@vue/compiler-sfc", "typescript", "zod"])
    expect(manifest.files).toEqual(["dist", "README.md", "LICENSE"])
    expect(readFileSync(path.join(pkg, "dist/cli/main.js"), "utf8").startsWith("#!/usr/bin/env node")).toBe(
      true
    )
    expect(statSync(path.join(pkg, "dist/cli/main.js")).mode & 0o111).not.toBe(0)
  })

  it("has no workspace imports left, and every relative import resolves inside it", () => {
    for (const f of files(path.join(pkg, "dist"))) {
      const code = readFileSync(f, "utf8")
      expect(code, f).not.toMatch(/["']@invariant\//)
      for (const m of code.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s*["'](\.[^"']+)["']/gm)) {
        const target = path.resolve(path.dirname(f), m[1] as string)
        expect(statSync(target, { throwIfNoEntry: false })?.isFile(), `${f} -> ${m[1]}`).toBe(true)
      }
    }
  })

  it("carries no tests, source maps or type files", () => {
    for (const f of files(pkg).filter((x) => !x.includes("node_modules")))
      expect(f).not.toMatch(/\.(test\.js|map|d\.ts)$/)
  })

  it("points the README at the repository, since its images and links are relative", () => {
    const readme = readFileSync(path.join(pkg, "README.md"), "utf8")
    expect(readme).not.toMatch(/(src|srcset)="site\//)
    expect(readme).toContain("raw.githubusercontent.com/invariant-ui/cli/main/site/assets/")
  })

  it("runs as a real process: version, then compile a project", () => {
    const main = path.join(pkg, "dist/cli/main.js")
    expect(execFileSync(process.execPath, [main, "--version"], { encoding: "utf8" }).trim()).toBe(
      JSON.parse(readFileSync(path.join(root, "apps/cli/package.json"), "utf8")).version
    )
    const work = mkdtempSync(path.join(tmpdir(), "invariant-npm-run-"))
    made.push(work)
    cpSync(path.join(root, "fixtures/storybook/acme-ui"), work, {
      recursive: true,
      filter: (s) => !s.includes("storybook-static")
    })
    execFileSync(process.execPath, [main, "init"], { cwd: work })
    const out = execFileSync(process.execPath, [main, "compile"], { cwd: work, encoding: "utf8" })
    expect(out).toMatch(/components 14/)
    expect(readFileSync(path.join(work, "invariant/invariant.contract.json"), "utf8")).toContain(
      "component:button"
    )
  }, 60_000)
})

describe("agent init without a global install", () => {
  const compiled = async (): Promise<string> => {
    const dir = mkdtempSync(path.join(tmpdir(), "invariant-npx-"))
    made.push(dir)
    cpSync(path.join(root, "fixtures/storybook/acme-ui"), dir, {
      recursive: true,
      filter: (s) => !s.includes("storybook-static")
    })
    const io = (env: Record<string, string>) => ({
      cwd: dir,
      stdout: () => undefined,
      stderr: () => undefined,
      clock: FIXED_CLOCK,
      env
    })
    await run(["init"], io({}))
    await run(["compile"], io({}))
    return dir
  }
  const entry = (dir: string) =>
    JSON.parse(readFileSync(path.join(dir, ".mcp.json"), "utf8")).mcpServers.invariant as {
      command: string
      args: string[]
    }

  it("starts the server through npx when invariant is not on PATH", async () => {
    const dir = await compiled()
    let out = ""
    await run(["agent", "init", "claude-code"], {
      cwd: dir,
      stdout: (t) => (out += t),
      stderr: () => undefined,
      clock: FIXED_CLOCK,
      env: { PATH: "/nonexistent" }
    })
    expect(entry(dir)).toEqual({ command: "npx", args: ["-y", NPM_NAME, "mcp", "--dir", "invariant"] })
    expect(out).toMatch(/not on your PATH/)
  })

  it("keeps the plain command when it is installed, and when --command is given", async () => {
    const dir = await compiled()
    const bin = mkdtempSync(path.join(tmpdir(), "invariant-bin-"))
    made.push(bin)
    writeFileSync(path.join(bin, "invariant"), "")
    await run(["agent", "init", "claude-code"], {
      cwd: dir,
      stdout: () => undefined,
      stderr: () => undefined,
      clock: FIXED_CLOCK,
      env: { PATH: bin }
    })
    expect(entry(dir)).toEqual({ command: "invariant", args: ["mcp", "--dir", "invariant"] })
    const dir2 = await compiled()
    await run(["agent", "init", "claude-code", "--command", "node", "--command-arg", "x.js"], {
      cwd: dir2,
      stdout: () => undefined,
      stderr: () => undefined,
      clock: FIXED_CLOCK,
      env: { PATH: "/nonexistent" }
    })
    expect(entry(dir2)).toEqual({ command: "node", args: ["x.js", "mcp", "--dir", "invariant"] })
  })
})
