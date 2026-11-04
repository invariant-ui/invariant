import { describe, expect, it } from "vitest"
import { globToRegExp } from "./glob.js"

const m = (glob: string, path: string): boolean => globToRegExp(glob).test(path)

describe("globToRegExp", () => {
  it("handles * and ** like a path glob", () => {
    expect(m("packages/*", "packages/ui")).toBe(true)
    expect(m("packages/*", "packages/ui/src")).toBe(false)
    expect(m("packages/**", "packages/ui/src")).toBe(true)
    expect(m("**/*.md", "README.md")).toBe(true)
    expect(m("**/*.md", "docs/a/b.md")).toBe(true)
    expect(m("src/**/*.tsx", "src/Button.tsx")).toBe(true)
    expect(m("src/**/*.tsx", "src/a/b/Button.tsx")).toBe(true)
    expect(m("src/*.tsx", "src/a/Button.tsx")).toBe(false)
  })

  it("handles braces, ?, classes and Storybook's @(a|b) extglob", () => {
    expect(m("*.{ts,tsx}", "a.tsx")).toBe(true)
    expect(m("*.{ts,tsx}", "a.js")).toBe(false)
    expect(m("a?.ts", "ab.ts")).toBe(true)
    expect(m("[ab].ts", "b.ts")).toBe(true)
    expect(m("src/**/*.stories.@(js|jsx|ts|tsx)", "src/x/Button.stories.tsx")).toBe(true)
    expect(m("src/**/*.stories.@(js|jsx|ts|tsx)", "src/x/Button.stories.mdx")).toBe(false)
  })

  it("escapes regex metacharacters and ignores a leading ./", () => {
    expect(m("a.b", "a.b")).toBe(true)
    expect(m("a.b", "axb")).toBe(false)
    expect(m("./src/*.ts", "src/a.ts")).toBe(true)
    expect(m("a+b(c).ts", "a+b(c).ts")).toBe(true)
  })
})
