import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { checkBoundaries, loadWorkspace } from "./check-boundaries.ts"

const allowed = { "@x/a": [], "@x/b": ["@x/a"] }

describe("checkBoundaries", () => {
  it("accepts declared, allowed dependencies and imports", () => {
    expect(checkBoundaries([{ name: "@x/b", dependencies: ["@x/a"], imports: ["@x/a"] }], allowed)).toEqual(
      []
    )
  })

  it("rejects dependencies and imports that violate the rule", () => {
    const errors = checkBoundaries(
      [
        { name: "@x/a", dependencies: ["@x/b"], imports: ["@x/b"] },
        { name: "@x/b", dependencies: [], imports: ["@x/a"] }
      ],
      allowed
    )
    expect(errors).toEqual([
      "@x/a: may not depend on @x/b",
      "@x/a: may not import @x/b",
      "@x/b: imports @x/a but does not declare it"
    ])
  })

  it("requires every package to be registered", () => {
    expect(checkBoundaries([{ name: "@x/new", dependencies: [], imports: [] }], allowed)).toEqual([
      "@x/new: no boundary rule registered in scripts/check-boundaries.ts"
    ])
  })

  it("passes on the real workspace", () => {
    const root = fileURLToPath(new URL("..", import.meta.url))
    expect(checkBoundaries(loadWorkspace(root))).toEqual([])
  })
})
