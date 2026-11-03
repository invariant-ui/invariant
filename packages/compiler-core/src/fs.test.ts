import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { memoryFs, nodeFs } from "./fs.js"
import { walk } from "./walk.js"

describe("memoryFs + walk", () => {
  const fs = memoryFs({
    "package.json": "{}",
    "src/a.ts": "",
    "src/deep/b.ts": "",
    "node_modules/x/index.js": "",
    "dist/out.js": "",
    ".storybook/main.ts": ""
  })

  it("walks sorted, skips ignored directories, includes dot directories", async () => {
    const result = await walk(fs, { ignoreDirs: new Set(["node_modules", "dist"]), maxFiles: 100 })
    expect(result.files).toEqual([".storybook/main.ts", "package.json", "src/a.ts", "src/deep/b.ts"])
    expect(result.truncated).toBe(false)
  })

  it("reports truncation instead of silently truncating", async () => {
    const result = await walk(fs, { ignoreDirs: new Set(["node_modules", "dist"]), maxFiles: 2 })
    expect(result.files).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })

  it("answers exists for files and directories", async () => {
    expect(await fs.exists("src")).toBe(true)
    expect(await fs.exists("src/a.ts")).toBe(true)
    expect(await fs.exists("nope")).toBe(false)
  })
})

describe("nodeFs", () => {
  const root = mkdtempSync(join(tmpdir(), "invariant-fs-"))
  const outside = mkdtempSync(join(tmpdir(), "invariant-outside-"))
  mkdirSync(join(root, "src"))
  writeFileSync(join(root, "src/a.ts"), "export const a = 1")
  writeFileSync(join(outside, "secret.txt"), "secret")
  symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"))
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it("reads files, lists symlinks without following them, and walks only real files", async () => {
    const fs = nodeFs(root)
    expect(await fs.readFile("src/a.ts")).toBe("export const a = 1")
    expect((await fs.readDir(".")).map((e) => `${e.name}:${e.kind}`)).toEqual(["link.txt:symlink", "src:dir"])
    expect((await walk(fs, { ignoreDirs: new Set(), maxFiles: 10 })).files).toEqual(["src/a.ts"])
  })

  it("refuses paths and symlinks that escape the root", async () => {
    const fs = nodeFs(root)
    await expect(fs.readFile("../secret.txt")).rejects.toThrow(/escapes/)
    await expect(fs.readFile("link.txt")).rejects.toThrow(/escapes/)
  })
})
