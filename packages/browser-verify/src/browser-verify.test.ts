import { describe, expect, it } from "vitest"
import {
  allowedOrigins,
  type BrowserDriver,
  type BrowserSpec,
  checkOrigins,
  type OpenOptions,
  type PageHandle,
  parseSpec,
  runBrowserChecks,
  summarizeBrowser
} from "./index.js"

interface Dom {
  visible: Set<string>
  text: Record<string, string>
  tabOrder: string[]
  inside: Array<[string, string]>
  onClick: Record<string, (d: Dom) => void>
  missing?: Set<string>
}

function fake(make: () => Dom, log: string[] = []): BrowserDriver {
  return {
    browser: "chromium",
    version: () => "999.0",
    async open(options: OpenOptions) {
      log.push(
        `open ${options.viewport.width}x${options.viewport.height} ${options.allowedOrigins.join(",")}`
      )
      const d = make()
      let focus = -1
      const need = (s: string): void => {
        if (d.missing?.has(s)) throw new Error(`no element matches ${s}`)
      }
      const page: PageHandle = {
        goto: async (url) => {
          log.push(`goto ${url}`)
          if (url.includes("down")) throw new Error("connection refused")
        },
        click: async (s) => {
          need(s)
          d.onClick[s]?.(d)
        },
        fill: async (s) => need(s),
        press: async (k) => {
          if (k === "Tab") focus = Math.min(focus + 1, d.tabOrder.length)
        },
        waitFor: async (s) => need(s),
        isVisible: async (s) => d.visible.has(s),
        count: async (s) => (d.visible.has(s) ? 1 : 0),
        text: async (s) => d.text[s] ?? null,
        isFocused: async (s) => d.tabOrder[focus] === s,
        activeElement: async () => d.tabOrder[focus] ?? "nothing",
        contains: async (o, i) => d.inside.some(([a, b]) => a === o && b === i),
        close: async () => void log.push("close")
      }
      return page
    },
    close: async () => undefined
  }
}

const dom = (): Dom => ({
  visible: new Set(["#form", "#save"]),
  text: { "#form": "Edit account" },
  tabOrder: ["#name", "#save"],
  inside: [["#form", "#save"]],
  onClick: { "#save": (d) => d.visible.add("#saved") }
})

const spec = (scenarios: BrowserSpec["scenarios"]): BrowserSpec => ({
  version: 1,
  baseUrl: "http://localhost:3000",
  scenarios
})

describe("running browser checks", () => {
  it("records pass and fail per expectation, with the browser context and runtime level", async () => {
    const results = await runBrowserChecks(
      fake(dom),
      spec([
        {
          id: "edit-form",
          pattern: "pattern:page.edit-form",
          constraint: "constraint:form.shows-saved",
          path: "/accounts/1",
          steps: [{ action: "click", selector: "#save" }],
          expect: [
            { kind: "visible", selector: "#saved" },
            { kind: "hidden", selector: "#error" },
            { kind: "text", selector: "#form", equals: "Edit account" },
            { kind: "tab-order", selectors: ["#name", "#save"] },
            { kind: "contains", outer: "#form", inner: "#save" },
            { kind: "visible", selector: "#toast" }
          ]
        }
      ])
    )
    expect(results.map((r) => r.status)).toEqual(["pass", "pass", "pass", "pass", "pass", "fail"])
    for (const r of results) {
      expect(r.level).toBe("runtime-verified")
      expect(r.context).toEqual({
        browser: "chromium",
        browserVersion: "999.0",
        viewport: { width: 1280, height: 800 },
        url: "http://localhost:3000/accounts/1"
      })
      expect(r).toMatchObject({
        pattern: "pattern:page.edit-form",
        constraint: "constraint:form.shows-saved"
      })
    }
    expect(results[5]?.reason).toBe("#toast is not visible")
    expect(summarizeBrowser(results)).toEqual({ pass: 5, fail: 1, error: 0 })
  })

  it("names where focus went when the order is wrong", async () => {
    const [r] = await runBrowserChecks(
      fake(dom),
      spec([{ id: "tabs", path: "/", steps: [], expect: [{ kind: "tab-order", selectors: ["#save"] }] }])
    )
    expect(r?.status).toBe("fail")
    expect(r?.reason).toBe("Tab 1 should reach #save, but focus is on #name")
    expect(r?.suggestion).toMatch(/tabindex/)
  })

  it("reports a failed step as an error and does not check, or pass, what follows", async () => {
    const results = await runBrowserChecks(
      fake(() => ({ ...dom(), missing: new Set(["#nope"]) })),
      spec([
        {
          id: "bad-step",
          path: "/",
          steps: [{ action: "click", selector: "#nope" }],
          expect: [{ kind: "visible", selector: "#form" }]
        }
      ])
    )
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ status: "error", check: "step 1" })
    expect(results[0]?.reason).toMatch(/step 1 \(click #nope\) failed: no element matches #nope/)
    expect(summarizeBrowser(results).pass).toBe(0)
  })

  it("reports an unreachable page as an error", async () => {
    const [r] = await runBrowserChecks(
      fake(dom),
      spec([{ id: "down", path: "/down", steps: [], expect: [{ kind: "visible", selector: "#form" }] }])
    )
    expect(r).toMatchObject({ status: "error", check: "goto" })
    expect(r?.reason).toMatch(/could not load http:\/\/localhost:3000\/down: connection refused/)
    expect(r?.suggestion).toMatch(/running/)
  })

  it("runs each viewport in a fresh page, and closes every page", async () => {
    const log: string[] = []
    const results = await runBrowserChecks(
      fake(dom, log),
      spec([
        {
          id: "responsive",
          path: "/",
          viewports: [
            { width: 375, height: 700 },
            { width: 1280, height: 800 }
          ],
          steps: [],
          expect: [{ kind: "visible", selector: "#form" }]
        }
      ])
    )
    expect(results.map((r) => r.context.viewport.width)).toEqual([375, 1280])
    expect(log.filter((l) => l.startsWith("open"))).toEqual([
      "open 375x700 http://localhost:3000",
      "open 1280x800 http://localhost:3000"
    ])
    expect(log.filter((l) => l === "close")).toHaveLength(2)
  })

  it("gives the same results for the same page", async () => {
    const s = spec([{ id: "a", path: "/", steps: [], expect: [{ kind: "visible", selector: "#form" }] }])
    expect(JSON.stringify(await runBrowserChecks(fake(dom), s))).toBe(
      JSON.stringify(await runBrowserChecks(fake(dom), s))
    )
  })
})

describe("the spec", () => {
  const ok = {
    version: 1,
    baseUrl: "http://localhost:3000",
    scenarios: [{ id: "a", path: "/", expect: [{ kind: "visible", selector: "#x" }] }]
  }

  it("accepts data and nothing that could carry code", () => {
    expect(parseSpec(JSON.stringify(ok)).ok).toBe(true)
    const withCode = structuredClone(ok) as Record<string, unknown>
    ;(withCode.scenarios as Array<Record<string, unknown>>)[0]!.steps = [
      { action: "evaluate", script: "alert(1)" }
    ]
    expect(parseSpec(JSON.stringify(withCode)).ok).toBe(false)
    const extra = { ...ok, hooks: ["x"] }
    expect(parseSpec(JSON.stringify(extra)).ok).toBe(false)
  })

  it("rejects a repeated scenario id, a bad path and bad JSON", () => {
    const twice = { ...ok, scenarios: [ok.scenarios[0], ok.scenarios[0]] }
    expect(parseSpec(JSON.stringify(twice))).toEqual({
      ok: false,
      message: expect.stringMatching(/used twice/)
    })
    expect(
      parseSpec(JSON.stringify({ ...ok, scenarios: [{ ...ok.scenarios[0], path: "http://evil" }] })).ok
    ).toBe(false)
    expect(parseSpec("{").ok).toBe(false)
  })

  it("refuses a remote base URL unless the spec lists its origin, and limits requests to listed origins", () => {
    const remote = { ...ok, baseUrl: "https://staging.example.com" } as BrowserSpec
    expect(checkOrigins(remote)).toMatch(/not local/)
    expect(checkOrigins({ ...remote, allowOrigins: ["https://staging.example.com"] })).toBeUndefined()
    expect(checkOrigins(ok as BrowserSpec)).toBeUndefined()
    expect(allowedOrigins({ ...(ok as BrowserSpec), allowOrigins: ["https://cdn.example.com/x"] })).toEqual([
      "http://localhost:3000",
      "https://cdn.example.com"
    ])
  })
})

describe("loading Playwright", () => {
  it("finds the browsers on a CommonJS module whose exports Node cannot see", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { playwrightDriver } = await import("./playwright.js")
    const root = mkdtempSync(join(tmpdir(), "invariant-pw-"))
    mkdirSync(join(root, "node_modules", "playwright"), { recursive: true })
    writeFileSync(
      join(root, "node_modules", "playwright", "package.json"),
      '{"name":"playwright","main":"index.js"}'
    )
    // Assembled at run time, like Playwright's own index: no static named exports for Node to find.
    writeFileSync(
      join(root, "node_modules", "playwright", "index.js"),
      'module.exports = Object.assign({}, { chromium: { launch: async () => { throw new Error("fake launch") } } })\n'
    )
    await expect(playwrightDriver("chromium", root)).rejects.toThrow(/could not start chromium: fake launch/)
    await expect(playwrightDriver("firefox", root)).rejects.toThrow(/has no firefox/)
  })
})
