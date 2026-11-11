import { rmSync } from "node:fs"
import { afterAll, describe, expect, it } from "vitest"
import { playLoop, prepare } from "./demo-loop.ts"

let dir = ""
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe("the enforcement loop (what `pnpm demo` shows)", () => {
  it("blocks three different violations, then confirms the fixed page, and the report agrees", async () => {
    dir = await prepare()
    const { steps, report } = await playLoop(dir)

    expect(steps.map((s) => s.blocked)).toEqual([true, true, true, false])
    expect(steps[0]?.card).toContain("prop-value-not-allowed")
    expect(steps[0]?.card).toContain('Use one of "primary", "secondary", "ghost"')
    expect(steps[1]?.card).toContain("color-not-in-tokens")
    expect(steps[2]?.card).toContain("pattern-required-child-missing")
    expect(steps[3]?.card).toMatch(/^invariant ✓ app\/pages\/Settings\.tsx follows the @acme\/ui contract/)

    expect(report).toContain("4 writes checked · 3 violations caught · 3 fixed · 0 outstanding")
  }, 60_000)

  it("is deterministic: a second run tells the same story", async () => {
    const strip = (t: string): string => t.replace(/^\d{4}-\d{2}-\d{2}T\S+\s+/gm, "")
    const a = await playLoop(await prepare())
    const b = await playLoop(await prepare())
    expect(b.steps).toEqual(a.steps)
    expect(strip(b.report)).toBe(strip(a.report))
    rmSync(a.dir, { recursive: true, force: true })
    rmSync(b.dir, { recursive: true, force: true })
  }, 120_000)
})
