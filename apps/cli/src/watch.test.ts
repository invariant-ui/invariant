import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { FIXED_CLOCK } from "@invariant/compiler-core/testing"
import { afterAll, describe, expect, it } from "vitest"
import { run } from "./cli.js"
import { isIgnored } from "./watch.js"

const root = fileURLToPath(new URL("../../..", import.meta.url))
const made: string[] = []
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

async function until(check: () => boolean, ms = 15000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting for the watcher")
    await new Promise((r) => setTimeout(r, 40))
  }
}

describe("isIgnored", () => {
  it("ignores the output directory and tool directories, not sources", () => {
    expect(isIgnored(path.join("invariant", "invariant.contract.json"), "invariant")).toBe(true)
    expect(isIgnored("invariant", "invariant")).toBe(true)
    expect(isIgnored(path.join("node_modules", "x", "index.js"), "invariant")).toBe(true)
    expect(isIgnored(path.join("packages", "ui", "node_modules", "x.js"), "invariant")).toBe(true)
    expect(isIgnored(path.join(".git", "HEAD"), "invariant")).toBe(true)
    expect(isIgnored(path.join("src", "Button.tsx"), "invariant")).toBe(false)
    expect(isIgnored(path.join("invariant-ui", "Button.tsx"), "invariant")).toBe(false)
    expect(isIgnored(path.join("src", "invariant", "x.ts"), "invariant")).toBe(false)
  })

  it("handles a nested output directory", () => {
    expect(isIgnored(path.join("build", "contract", "a.json"), path.join("build", "contract"))).toBe(true)
    expect(isIgnored(path.join("build", "other.ts"), path.join("build", "contract"))).toBe(false)
  })
})

describe("compile --watch", () => {
  it("compiles once, recompiles after a change, ignores its own output, and stops on abort", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "invariant-watch-"))
    made.push(dir)
    cpSync(path.join(root, "fixtures/storybook/acme-ui"), dir, {
      recursive: true,
      filter: (src) => !src.includes("storybook-static")
    })
    let out = ""
    const io = (signal?: AbortSignal) => ({
      cwd: dir,
      stdout: (t: string) => {
        out += t
      },
      stderr: (t: string) => {
        out += t
      },
      clock: () => FIXED_CLOCK(),
      ...(signal ? { signal } : {})
    })
    await run(["init"], io())
    out = ""

    const stop = new AbortController()
    const running = run(["compile", "--watch"], io(stop.signal))
    await until(() => out.includes("watching"))
    expect(out).toMatch(/compiled /)
    expect(out).toMatch(/\] ok in \d+ ms/)

    const before = readFileSync(path.join(dir, "invariant/invariant.contract.json"), "utf8")
    const marker = out.length
    const file = path.join(dir, "src/Button.tsx")
    writeFileSync(file, readFileSync(file, "utf8").replace("Triggers an action.", "Changed while watching."))
    await until(() => out.slice(marker).includes("changed: src/Button.tsx"))
    await until(() => /\] ok in \d+ ms/.test(out.slice(marker)))
    expect(readFileSync(path.join(dir, "invariant/invariant.contract.json"), "utf8")).not.toBe(before)
    expect(readFileSync(path.join(dir, "invariant/invariant.contract.json"), "utf8")).toContain(
      "Changed while watching."
    )

    // Writing the artifacts must not have triggered another cycle.
    const settled = out.length
    await new Promise((r) => setTimeout(r, 900))
    expect(out.length).toBe(settled)

    stop.abort()
    expect(await running).toBe(0)
    expect(out).toMatch(/stopped watching/)
  }, 40000)

  it("keeps watching after a broken configuration and recovers when it is fixed", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "invariant-watch-"))
    made.push(dir)
    cpSync(path.join(root, "fixtures/storybook/acme-ui"), dir, {
      recursive: true,
      filter: (src) => !src.includes("storybook-static")
    })
    let out = ""
    const io = (signal?: AbortSignal) => ({
      cwd: dir,
      stdout: (t: string) => {
        out += t
      },
      stderr: (t: string) => {
        out += t
      },
      clock: () => FIXED_CLOCK(),
      ...(signal ? { signal } : {})
    })
    await run(["init"], io())
    const good = readFileSync(path.join(dir, "invariant.config.json"), "utf8")
    out = ""
    const stop = new AbortController()
    const running = run(["compile", "--watch"], io(stop.signal))
    await until(() => out.includes("watching"))

    const mark = out.length
    writeFileSync(path.join(dir, "invariant.config.json"), "{ not json")
    await until(() => /invalid|JSON|parse/i.test(out.slice(mark)))
    expect(out.slice(mark)).not.toMatch(/stopped watching/)

    const mark2 = out.length
    writeFileSync(path.join(dir, "invariant.config.json"), good)
    await until(() => /\] ok in \d+ ms/.test(out.slice(mark2)))

    stop.abort()
    expect(await running).toBe(0)
  }, 40000)
})
