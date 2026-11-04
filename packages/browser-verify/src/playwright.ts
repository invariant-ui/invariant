import type { BrowserDriver, OpenOptions, PageHandle } from "./driver.js"
import type { BrowserName } from "./spec.js"

/** The page-side objects the functions below touch. They run inside the browser, where the real DOM types apply. */
interface PageElement {
  id: string
  tagName: string
  getAttribute(name: string): string | null
}
declare const document: { activeElement: PageElement | null; body: PageElement }

/** The few Playwright members used. Declared here so this package needs no Playwright types or install. */
interface PwLocator {
  first(): PwLocator
  locator(selector: string): PwLocator
  click(o?: { timeout?: number }): Promise<void>
  fill(v: string, o?: { timeout?: number }): Promise<void>
  waitFor(o?: { timeout?: number }): Promise<void>
  isVisible(): Promise<boolean>
  count(): Promise<number>
  textContent(o?: { timeout?: number }): Promise<string | null>
  evaluate<T>(fn: (el: PageElement) => T): Promise<T>
}
interface PwPage {
  goto(url: string, o?: { timeout?: number }): Promise<unknown>
  locator(selector: string): PwLocator
  keyboard: { press(key: string): Promise<void> }
  evaluate<T>(fn: () => T): Promise<T>
  close(): Promise<void>
  setDefaultTimeout(ms: number): void
}
interface PwContext {
  newPage(): Promise<PwPage>
  route(
    url: string,
    handler: (route: {
      request(): { url(): string }
      continue(): Promise<void>
      abort(): Promise<void>
    }) => void
  ): Promise<void>
  close(): Promise<void>
}
interface PwBrowser {
  version(): string
  newContext(o: { viewport: { width: number; height: number }; serviceWorkers: "block" }): Promise<PwContext>
  close(): Promise<void>
}
interface PwModule {
  chromium?: { launch(o: { headless: boolean }): Promise<PwBrowser> }
  firefox?: { launch(o: { headless: boolean }): Promise<PwBrowser> }
  webkit?: { launch(o: { headless: boolean }): Promise<PwBrowser> }
}

export class PlaywrightMissing extends Error {}

export const INSTALL_HINT =
  "Browser verification is opt-in and needs Playwright, which Invariant does not install. Run: npm install --save-dev playwright && npx playwright install chromium"

/** Loaded on demand, from the project being checked, so nothing else in Invariant depends on it. */
async function loadPlaywright(projectRoot: string): Promise<PwModule> {
  const { createRequire } = await import("node:module")
  const { pathToFileURL } = await import("node:url")
  const require = createRequire(`${projectRoot.replace(/\/$/, "")}/`)
  let file: string
  try {
    file = require.resolve("playwright")
  } catch {
    throw new PlaywrightMissing(INSTALL_HINT)
  }
  return (await import(pathToFileURL(file).href)) as PwModule
}

function handle(page: PwPage, context: PwContext, timeoutMs: number): PageHandle {
  const at = (s: string): PwLocator => page.locator(s).first()
  return {
    goto: async (url) => void (await page.goto(url, { timeout: timeoutMs })),
    click: (s) => at(s).click({ timeout: timeoutMs }),
    fill: (s, v) => at(s).fill(v, { timeout: timeoutMs }),
    press: (k) => page.keyboard.press(k),
    waitFor: (s) => at(s).waitFor({ timeout: timeoutMs }),
    isVisible: (s) => at(s).isVisible(),
    count: (s) => page.locator(s).count(),
    text: async (s) =>
      (await page.locator(s).count()) === 0 ? null : at(s).textContent({ timeout: timeoutMs }),
    isFocused: async (s) =>
      (await page.locator(s).count()) === 0 ? false : at(s).evaluate((el) => el === document.activeElement),
    activeElement: () =>
      page.evaluate(() => {
        const el = document.activeElement
        if (!el || el === document.body) return "nothing (the page body)"
        const id = el.id ? `#${el.id}` : ""
        const label = el.getAttribute("aria-label")
        return `<${el.tagName.toLowerCase()}${id}>${label ? ` "${label}"` : ""}`
      }),
    contains: async (outer, inner) =>
      (await page.locator(outer).count()) === 0 ? false : (await at(outer).locator(inner).count()) > 0,
    close: async () => {
      await page.close()
      await context.close()
    }
  }
}

/** A driver for Playwright's chromium, firefox or webkit, headless. Not exercised by this repository's tests. */
export async function playwrightDriver(browser: BrowserName, projectRoot: string): Promise<BrowserDriver> {
  const pw = await loadPlaywright(projectRoot)
  const kind = pw[browser]
  if (!kind) throw new PlaywrightMissing(`this Playwright install has no ${browser}. ${INSTALL_HINT}`)
  let launched: PwBrowser
  try {
    launched = await kind.launch({ headless: true })
  } catch (e) {
    throw new PlaywrightMissing(
      `could not start ${browser}: ${(e as Error).message.split("\n")[0]}. Try: npx playwright install ${browser}`
    )
  }
  return {
    browser,
    version: () => launched.version(),
    async open(options: OpenOptions) {
      const context = await launched.newContext({ viewport: options.viewport, serviceWorkers: "block" })
      const allowed = new Set(options.allowedOrigins)
      await context.route("**/*", (route) => {
        const url = route.request().url()
        const origin = url.startsWith("data:") || url.startsWith("blob:") ? undefined : new URL(url).origin
        if (origin === undefined || allowed.has(origin)) void route.continue()
        else void route.abort()
      })
      const page = await context.newPage()
      page.setDefaultTimeout(options.timeoutMs)
      return handle(page, context, options.timeoutMs)
    },
    close: () => launched.close()
  }
}
