import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("..", import.meta.url))
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter((f) => /\.(md|html|json|ts|mjs|yml)$/.test(f) && f !== "pnpm-lock.yaml")

// Built from parts so this file does not contain the strings it forbids.
const OLD = new RegExp([`mcarl${"ucci"}`, `invariantui${"\\"}.com`].join("|"))

describe("where the project lives", () => {
  it("links to the invariant-ui organization and invariant-ui.com, never to the old personal or domain addresses", () => {
    const stale = tracked.filter((f) => OLD.test(readFileSync(path.join(root, f), "utf8")))
    expect(stale).toEqual([])
  })
})
