import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { BrowserDriver, PageHandle } from "@invariant/browser-verify"
import { run } from "@invariant/cli"
import { FIXED_CLOCK } from "@invariant/compiler-core/testing"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const made: string[] = []
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

const page = (visible: string[]): PageHandle => ({
  goto: async () => undefined,
  click: async () => undefined,
  fill: async () => undefined,
  press: async () => undefined,
  waitFor: async () => undefined,
  isVisible: async (s) => visible.includes(s),
  count: async (s) => (visible.includes(s) ? 1 : 0),
  text: async () => null,
  isFocused: async () => false,
  activeElement: async () => "nothing",
  contains: async () => false,
  close: async () => undefined
})
const fakeDriver = (visible: string[]): BrowserDriver => ({
  browser: "chromium",
  version: () => "1.2.3",
  open: async () => page(visible),
  close: async () => undefined
})

let dir = ""
async function cli(argv: string[], driver?: BrowserDriver) {
  let out = ""
  let err = ""
  const code = await run(argv, {
    cwd: dir,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    clock: FIXED_CLOCK,
    env: {},
    ...(driver ? { browserDriver: async () => driver } : {})
  })
  return { code, out, err }
}
const spec = (extra: Record<string, unknown> = {}) =>
  writeFileSync(
    path.join(dir, "invariant.browser.json"),
    JSON.stringify({
      version: 1,
      baseUrl: "http://localhost:4000",
      scenarios: [
        {
          id: "saves",
          pattern: "pattern:page.edit-form",
          path: "/edit",
          expect: [
            { kind: "visible", selector: "#form" },
            { kind: "visible", selector: "#saved" }
          ]
        }
      ],
      ...extra
    })
  )

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "invariant-browser-"))
  made.push(dir)
})

describe("invariant browser run", () => {
  it("writes runtime results with the browser context, apart from static output", async () => {
    spec()
    const r = await cli(["browser", "run"], fakeDriver(["#form"]))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/chromium 1\.2\.3: 1 passed, 1 failed, 0 could not run/)
    expect(r.out).toMatch(/#saved is not visible/)
    const file = JSON.parse(readFileSync(path.join(dir, "invariant/invariant.browser-results.json"), "utf8"))
    expect(file.kind).toBe("runtime")
    expect(file.browser).toEqual({ name: "chromium", version: "1.2.3" })
    expect(file.results.map((x: { status: string }) => x.status)).toEqual(["pass", "fail"])
    expect(file.results[0]).toMatchObject({
      level: "runtime-verified",
      pattern: "pattern:page.edit-form",
      context: { viewport: { width: 1280, height: 800 }, url: "http://localhost:4000/edit" }
    })
  })

  it("exits 0 when everything passes", async () => {
    spec()
    expect((await cli(["browser", "run"], fakeDriver(["#form", "#saved"]))).code).toBe(0)
  })

  it("says how to install Playwright when the project has none, and starts nothing", async () => {
    spec()
    const r = await cli(["browser", "run"])
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/opt-in and needs Playwright/)
    expect(r.err).toMatch(/npx playwright install chromium/)
  })

  it("refuses a remote base URL that the spec does not list", async () => {
    spec({ baseUrl: "https://staging.example.com" })
    const r = await cli(["browser", "run"], fakeDriver([]))
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/not local/)
    expect(
      (await cli(["browser", "run", "--url", "http://localhost:9"], fakeDriver(["#form", "#saved"]))).code
    ).toBe(0)
  })

  it("needs a spec, and a known browser", async () => {
    rmSync(path.join(dir, "invariant.browser.json"))
    expect((await cli(["browser", "run"], fakeDriver([]))).err).toMatch(/no invariant\.browser\.json/)
    spec()
    expect((await cli(["browser", "run", "--browser", "ie"], fakeDriver([]))).code).toBe(2)
    expect((await cli(["browser"], fakeDriver([]))).code).toBe(2)
  })
})
