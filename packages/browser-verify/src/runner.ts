import type { BrowserDriver, PageHandle } from "./driver.js"
import { allowedOrigins, type BrowserSpec, type Expectation, type Scenario, type Step } from "./spec.js"

export const DEFAULT_VIEWPORT = { width: 1280, height: 800 }
export const DEFAULT_TIMEOUT_MS = 5000

/**
 * `pass` and `fail` are findings about the page. `error` means the check could not be carried out (a step failed,
 * a page did not load): it says nothing about the pattern and is never counted as a pass.
 */
export type BrowserStatus = "pass" | "fail" | "error"

export interface BrowserContext {
  browser: string
  browserVersion: string
  viewport: { width: number; height: number }
  url: string
}

export interface BrowserResult {
  scenario: string
  /** `step <n>` for a step that failed, else `expect <n>`. */
  check: string
  kind: string
  status: BrowserStatus
  reason: string
  /** Always runtime-verified: this came from a rendered page. Static results are never merged with it. */
  level: "runtime-verified"
  context: BrowserContext
  pattern?: string
  constraint?: string
  suggestion?: string
}

const describeStep = (s: Step): string =>
  s.action === "press"
    ? `press ${s.key}`
    : `${s.action} ${s.selector}${s.action === "fill" ? ` with "${s.value}"` : ""}`

const message = (e: unknown): string =>
  e instanceof Error ? (e.message.split("\n")[0] ?? "failed") : String(e)

async function runStep(page: PageHandle, s: Step): Promise<void> {
  if (s.action === "click") return page.click(s.selector)
  if (s.action === "fill") return page.fill(s.selector, s.value)
  if (s.action === "press") return page.press(s.key)
  return page.waitFor(s.selector)
}

type Outcome = { status: "pass" | "fail"; reason: string; suggestion?: string }

async function evaluate(page: PageHandle, e: Expectation): Promise<Outcome> {
  switch (e.kind) {
    case "visible": {
      const ok = await page.isVisible(e.selector)
      return ok
        ? { status: "pass", reason: `${e.selector} is visible` }
        : {
            status: "fail",
            reason: `${e.selector} is not visible`,
            suggestion: "Check the selector, and that the element renders and is not hidden."
          }
    }
    case "hidden": {
      const ok = !(await page.isVisible(e.selector))
      return ok
        ? { status: "pass", reason: `${e.selector} is not visible` }
        : { status: "fail", reason: `${e.selector} is visible, and should not be` }
    }
    case "text": {
      const text = await page.text(e.selector)
      if (text === null) return { status: "fail", reason: `${e.selector} was not found` }
      const trimmed = text.replace(/\s+/g, " ").trim()
      if (e.equals !== undefined)
        return trimmed === e.equals
          ? { status: "pass", reason: `${e.selector} reads "${e.equals}"` }
          : {
              status: "fail",
              reason: `${e.selector} reads "${trimmed.slice(0, 120)}", expected "${e.equals}"`
            }
      if (e.contains !== undefined)
        return trimmed.includes(e.contains)
          ? { status: "pass", reason: `${e.selector} contains "${e.contains}"` }
          : {
              status: "fail",
              reason: `${e.selector} reads "${trimmed.slice(0, 120)}", which lacks "${e.contains}"`
            }
      return { status: "fail", reason: "a text expectation needs equals or contains" }
    }
    case "focused": {
      const ok = await page.isFocused(e.selector)
      return ok
        ? { status: "pass", reason: `focus is on ${e.selector}` }
        : {
            status: "fail",
            reason: `focus is on ${await page.activeElement()}, not ${e.selector}`,
            suggestion:
              "Check what moves focus here, such as autofocus, a focus trap or a focus call after the action."
          }
    }
    case "tab-order": {
      for (const [i, sel] of e.selectors.entries()) {
        await page.press("Tab")
        if (!(await page.isFocused(sel)))
          return {
            status: "fail",
            reason: `Tab ${i + 1} should reach ${sel}, but focus is on ${await page.activeElement()}`,
            suggestion:
              "Check the order of focusable elements, tabindex values and anything that traps or skips focus."
          }
      }
      return { status: "pass", reason: `Tab visits ${e.selectors.join(", then ")} in that order` }
    }
    case "contains": {
      const ok = await page.contains(e.outer, e.inner)
      return ok
        ? { status: "pass", reason: `${e.inner} is inside ${e.outer}` }
        : { status: "fail", reason: `${e.inner} is not inside ${e.outer} in the rendered page` }
    }
    case "count": {
      const n = await page.count(e.selector)
      const low = e.min !== undefined && n < e.min
      const high = e.max !== undefined && n > e.max
      return low || high
        ? {
            status: "fail",
            reason: `${n} match ${e.selector}, expected ${e.min !== undefined ? `at least ${e.min}` : ""}${e.min !== undefined && e.max !== undefined ? " and " : ""}${e.max !== undefined ? `at most ${e.max}` : ""}`
          }
        : { status: "pass", reason: `${n} match ${e.selector}` }
    }
  }
}

async function runOne(
  driver: BrowserDriver,
  spec: BrowserSpec,
  scenario: Scenario,
  viewport: { width: number; height: number }
): Promise<BrowserResult[]> {
  const url = new URL(scenario.path, spec.baseUrl).toString()
  const context: BrowserContext = { browser: driver.browser, browserVersion: driver.version(), viewport, url }
  const base = {
    scenario: scenario.id,
    level: "runtime-verified" as const,
    context,
    ...(scenario.pattern ? { pattern: scenario.pattern } : {}),
    ...(scenario.constraint ? { constraint: scenario.constraint } : {})
  }
  const everything = (
    status: "error",
    reason: string,
    check: string,
    suggestion?: string
  ): BrowserResult[] => [
    { ...base, check, kind: "scenario", status, reason, ...(suggestion ? { suggestion } : {}) }
  ]
  let page: PageHandle
  try {
    page = await driver.open({
      viewport,
      allowedOrigins: allowedOrigins(spec),
      timeoutMs: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS
    })
  } catch (e) {
    return everything("error", `could not open a page: ${message(e)}`, "open")
  }
  try {
    try {
      await page.goto(url)
    } catch (e) {
      return everything(
        "error",
        `could not load ${url}: ${message(e)}`,
        "goto",
        "Is the app running at baseUrl?"
      )
    }
    for (const [i, s] of scenario.steps.entries())
      try {
        await runStep(page, s)
      } catch (e) {
        return everything(
          "error",
          `step ${i + 1} (${describeStep(s)}) failed: ${message(e)}`,
          `step ${i + 1}`,
          "The expectations were not checked. Fix the step or the selector."
        )
      }
    const out: BrowserResult[] = []
    for (const [i, e] of scenario.expect.entries()) {
      try {
        const r = await evaluate(page, e)
        out.push({ ...base, check: `expect ${i + 1}`, kind: e.kind, ...r })
      } catch (err) {
        out.push({
          ...base,
          check: `expect ${i + 1}`,
          kind: e.kind,
          status: "error",
          reason: `could not check: ${message(err)}`
        })
      }
    }
    return out
  } finally {
    await page.close().catch(() => undefined)
  }
}

/**
 * Runs each scenario, once per viewport, in a fresh page. Results are runtime findings tied to the browser,
 * its version, the viewport and the URL. The run opens no browser by itself: the driver does, and a caller that
 * never builds a driver never touches one.
 */
export async function runBrowserChecks(driver: BrowserDriver, spec: BrowserSpec): Promise<BrowserResult[]> {
  const results: BrowserResult[] = []
  for (const scenario of spec.scenarios)
    for (const viewport of scenario.viewports ?? [DEFAULT_VIEWPORT])
      results.push(...(await runOne(driver, spec, scenario, viewport)))
  return results
}

export interface BrowserSummary {
  pass: number
  fail: number
  error: number
}

export const summarizeBrowser = (results: readonly BrowserResult[]): BrowserSummary => {
  const out = { pass: 0, fail: 0, error: 0 }
  for (const r of results) out[r.status]++
  return out
}
