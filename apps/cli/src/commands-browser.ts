import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import {
  BROWSER_RESULTS_FILE,
  BROWSER_SPEC_FILE,
  BROWSERS,
  type BrowserDriver,
  type BrowserName,
  type BrowserResult,
  checkOrigins,
  PlaywrightMissing,
  parseSpec,
  playwrightDriver,
  runBrowserChecks,
  summarizeBrowser
} from "@invariant/browser-verify"
import { type Context, json, outputDir, print, writableDir } from "./commands.js"
import { CliError } from "./errors.js"
import { table } from "./format.js"
import { loadCompiled } from "./store.js"
import { CLI_NAME } from "./version.js"

const USAGE = `usage: ${CLI_NAME} browser run [--spec ${BROWSER_SPEC_FILE}] [--browser chromium|firefox|webkit] [--url <base url>] [--json]
Runs the scenarios in the spec against a running app in a headless browser. Opt-in: it needs Playwright in your project,
and nothing else in ${CLI_NAME} starts a browser. Results are runtime findings, kept apart from \`validate\`.`

/** `invariant browser run`: runtime checks in a real browser, separate from static validation. */
export async function browser(c: Context): Promise<number> {
  const [, sub] = c.args.positionals
  if (sub !== "run") throw new CliError(USAGE)
  const specFile = path.resolve(c.cwd, c.args.values.spec ?? BROWSER_SPEC_FILE)
  if (!existsSync(specFile))
    throw new CliError(
      `no ${path.basename(specFile)}. Write one (see docs/specifications/browser-verification-v1.md), or pass --spec.`
    )
  const parsed = parseSpec(readFileSync(specFile, "utf8"), path.basename(specFile))
  if (!parsed.ok) throw new CliError(parsed.message)
  const spec = c.args.values.url ? { ...parsed.value, baseUrl: c.args.values.url } : parsed.value
  if (c.args.values.url) {
    try {
      new URL(c.args.values.url)
    } catch {
      throw new CliError("--url must be a full URL such as http://localhost:3000")
    }
  }
  const refused = checkOrigins(spec)
  if (refused) throw new CliError(refused)
  const name = (c.args.values.browser ?? spec.browser ?? "chromium") as BrowserName
  if (!BROWSERS.includes(name)) throw new CliError(`--browser must be one of: ${BROWSERS.join(", ")}`)

  const notes: string[] = []
  try {
    const { contract } = loadCompiled(await outputDir(c))
    const patterns = new Map(contract.patterns.map((p) => [p.id as string, p]))
    const constraints = new Set(contract.constraints.map((x) => x.id as string))
    for (const s of spec.scenarios) {
      if (s.pattern && !patterns.has(s.pattern))
        notes.push(`${s.id}: pattern ${s.pattern} is not in the contract`)
      if (s.constraint && !constraints.has(s.constraint))
        notes.push(`${s.id}: constraint ${s.constraint} is not in the contract`)
    }
  } catch {
    // No compiled contract is fine: scenarios are checked without linking them to patterns.
  }

  let driver: BrowserDriver
  try {
    driver = await (c.io.browserDriver ?? playwrightDriver)(name, c.cwd)
  } catch (error) {
    if (error instanceof PlaywrightMissing) throw new CliError(error.message)
    throw error
  }
  let results: BrowserResult[]
  try {
    results = await runBrowserChecks(driver, spec)
  } finally {
    await driver.close().catch(() => undefined)
  }
  const summary = summarizeBrowser(results)
  const report = {
    version: 1,
    kind: "runtime",
    spec: path.basename(specFile),
    browser: { name, version: driver.version() },
    summary,
    notes,
    results
  }
  const dir = await writableDir(c)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, BROWSER_RESULTS_FILE), `${JSON.stringify(report, null, 2)}\n`)

  if (c.args.values.json) json(c, report)
  else {
    print(
      c,
      `${name} ${driver.version()}: ${summary.pass} passed, ${summary.fail} failed, ${summary.error} could not run (runtime results; static results are from \`validate\`)`
    )
    for (const n of notes) print(c, `note: ${n}`)
    const bad = results.filter((r) => r.status !== "pass")
    if (bad.length > 0)
      print(
        c,
        `\n${table(
          ["scenario", "check", "status", "viewport", "why"],
          bad.map((r) => [
            r.scenario,
            r.check,
            r.status,
            `${r.context.viewport.width}x${r.context.viewport.height}`,
            r.reason
          ])
        )}`
      )
    for (const r of bad) if (r.suggestion) print(c, `  ${r.scenario} ${r.check}: ${r.suggestion}`)
    print(c, `\nwritten to ${BROWSER_RESULTS_FILE}`)
  }
  return summary.fail + summary.error > 0 ? 1 : 0
}
