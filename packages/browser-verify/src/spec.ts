import { z } from "zod"

export const BROWSER_SPEC_FILE = "invariant.browser.json"
export const BROWSER_RESULTS_FILE = "invariant.browser-results.json"
export const BROWSERS = ["chromium", "firefox", "webkit"] as const
export type BrowserName = (typeof BROWSERS)[number]

/** Selectors are CSS or Playwright selector strings. A spec holds data only: it can never carry code to run. */
const selector = z.string().min(1).max(300)

const step = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("click"), selector }),
  z.strictObject({ action: z.literal("fill"), selector, value: z.string().max(1000) }),
  z.strictObject({ action: z.literal("press"), key: z.string().min(1).max(40) }),
  z.strictObject({ action: z.literal("wait-for"), selector })
])
export type Step = z.infer<typeof step>

const expectation = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("visible"), selector }),
  z.strictObject({ kind: z.literal("hidden"), selector }),
  z.strictObject({
    kind: z.literal("text"),
    selector,
    equals: z.string().max(1000).optional(),
    contains: z.string().max(1000).optional()
  }),
  z.strictObject({ kind: z.literal("focused"), selector }),
  /** Pressing Tab from the current focus visits these, in this order. */
  z.strictObject({ kind: z.literal("tab-order"), selectors: z.array(selector).min(1).max(50) }),
  /** The element for `inner` is inside the element for `outer` in the rendered page. */
  z.strictObject({ kind: z.literal("contains"), outer: selector, inner: selector }),
  z.strictObject({
    kind: z.literal("count"),
    selector,
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().nonnegative().optional()
  })
])
export type Expectation = z.infer<typeof expectation>

const viewport = z.strictObject({
  width: z.number().int().min(200).max(4000),
  height: z.number().int().min(200).max(4000)
})

export const scenarioSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]*$/)
    .max(80),
  description: z.string().min(1).max(500).optional(),
  /** The approved pattern and constraint this scenario gives a runtime check for. Recorded, never inferred. */
  pattern: z.string().min(1).max(200).optional(),
  constraint: z.string().min(1).max(200).optional(),
  /** A path on the base URL, starting with `/`. */
  path: z
    .string()
    .regex(/^\/[^\s]*$/)
    .max(500),
  /** One result is produced per viewport; no viewport means 1280 by 800. */
  viewports: z.array(viewport).min(1).max(6).optional(),
  steps: z.array(step).max(100).default([]),
  expect: z.array(expectation).min(1).max(100)
})
export type Scenario = z.infer<typeof scenarioSchema>

export const browserSpecSchema = z.strictObject({
  $schema: z.string().optional(),
  version: z.literal(1),
  baseUrl: z.url().max(300),
  /** Origins besides the base URL the page may load from. Everything else is blocked. */
  allowOrigins: z.array(z.url().max(300)).max(20).optional(),
  browser: z.enum(BROWSERS).optional(),
  timeoutMs: z.number().int().min(500).max(60000).optional(),
  scenarios: z.array(scenarioSchema).min(1).max(200)
})
export type BrowserSpec = z.infer<typeof browserSpecSchema>

export type ParsedSpec = { ok: true; value: BrowserSpec } | { ok: false; message: string }

export function parseSpec(text: string, name = BROWSER_SPEC_FILE): ParsedSpec {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ok: false, message: `${name} is not valid JSON: ${(error as Error).message}` }
  }
  const parsed = browserSpecSchema.safeParse(raw)
  if (!parsed.success) {
    const i = parsed.error.issues[0]
    return {
      ok: false,
      message: `${name} is invalid at ${i?.path.join(".") || "(root)"}: ${i?.message ?? "schema error"}`
    }
  }
  const ids = parsed.data.scenarios.map((s) => s.id)
  const dup = ids.find((id, i) => ids.indexOf(id) !== i)
  if (dup) return { ok: false, message: `${name}: scenario id "${dup}" is used twice` }
  return { ok: true, value: parsed.data }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

/** A run reaches only the base URL's origin and listed origins, and the base URL must be local unless listed. */
export function checkOrigins(spec: BrowserSpec): string | undefined {
  const base = new URL(spec.baseUrl)
  if (
    !LOOPBACK.has(base.hostname) &&
    !(spec.allowOrigins ?? []).some((o) => new URL(o).origin === base.origin)
  )
    return `baseUrl ${base.origin} is not local. To verify a remote site, list its origin in allowOrigins to say that is intended.`
  return undefined
}

export function allowedOrigins(spec: BrowserSpec): string[] {
  return [
    ...new Set([new URL(spec.baseUrl).origin, ...(spec.allowOrigins ?? []).map((o) => new URL(o).origin)])
  ].sort()
}
