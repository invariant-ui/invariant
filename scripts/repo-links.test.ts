import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("..", import.meta.url))
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter((f) => /\.(md|html|json|ts|mjs|yml)$/.test(f) && f !== "pnpm-lock.yaml")

describe("where the project lives", () => {
  it("links to the invariant-ui organization and invariantui.com, never to the old personal address", () => {
    const stale = tracked.filter((f) => /mcarlucci/.test(readFileSync(path.join(root, f), "utf8")))
    expect(stale).toEqual([])
  })
})
