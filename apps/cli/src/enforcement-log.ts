import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { z } from "zod"

/**
 * The enforcement log: what `invariant hook` checked, one JSON object per line, under `.invariant/` in the
 * project. Only the user-installed hook writes it; the MCP server stays read-only (ADR 0003).
 *
 * Appends use a single O_APPEND write of one short line, which POSIX keeps whole when hooks run concurrently
 * (lines stay under 4 KB: findings are capped and their text truncated). The log holds findings and file
 * paths, never file contents.
 */
export const LOG_DIR = ".invariant"
export const LOG_FILE = `${LOG_DIR}/enforcement.jsonl`

const MAX_FINDINGS = 10
const MAX_TEXT = 200

export const findingSchema = z.object({
  code: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  line: z.number().optional(),
  fix: z.string().optional()
})
export type LoggedFinding = z.infer<typeof findingSchema>

export const eventSchema = z.object({
  v: z.literal(1),
  time: z.string(),
  session: z.string(),
  file: z.string(),
  /** `blocked`: the write was denied. `warned`: it landed with findings. `passed`: it landed clean. */
  outcome: z.enum(["blocked", "warned", "passed"]),
  findings: z.array(findingSchema),
  /** Findings beyond the cap, so the count stays honest. */
  omitted: z.number().int().nonnegative(),
  /** Component uses checked, for clean passes. */
  checked: z.number().int().nonnegative()
})
export type EnforcementEvent = z.infer<typeof eventSchema>

const clip = (s: string): string => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s)

export interface LogInput {
  time: string
  session: string
  file: string
  outcome: EnforcementEvent["outcome"]
  findings: ReadonlyArray<{
    code: string
    severity: "error" | "warning" | "info"
    message: string
    line?: number | undefined
    suggestion?: string | undefined
  }>
  checked: number
}

/** Appends one event. The caller decides what a failure means; the hook notes it and carries on. */
export function appendEvent(root: string, input: LogInput): void {
  const dir = path.join(root, LOG_DIR)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    // Local state: ignore the whole directory without touching the project's own .gitignore.
    writeFileSync(path.join(dir, ".gitignore"), "*\n")
  }
  const event: EnforcementEvent = {
    v: 1,
    time: input.time,
    session: input.session,
    file: input.file,
    outcome: input.outcome,
    findings: input.findings.slice(0, MAX_FINDINGS).map((f) => ({
      code: f.code,
      severity: f.severity,
      message: clip(f.message),
      ...(f.line !== undefined ? { line: f.line } : {}),
      ...(f.suggestion ? { fix: clip(f.suggestion) } : {})
    })),
    omitted: Math.max(0, input.findings.length - MAX_FINDINGS),
    checked: input.checked
  }
  appendFileSync(path.join(root, LOG_FILE), `${JSON.stringify(event)}\n`)
}

/** Reads every well-formed event; a torn or foreign line is skipped, never fatal. */
export function readEvents(root: string): EnforcementEvent[] {
  const file = path.join(root, LOG_FILE)
  if (!existsSync(file)) return []
  const events: EnforcementEvent[] = []
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue
    try {
      const parsed = eventSchema.safeParse(JSON.parse(line))
      if (parsed.success) events.push(parsed.data)
    } catch {
      // a torn line is skipped
    }
  }
  return events
}
