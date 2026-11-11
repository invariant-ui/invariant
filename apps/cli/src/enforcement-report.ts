import type { EnforcementEvent, LoggedFinding } from "./enforcement-log.js"
import { esc, STYLE } from "./report.js"

/** One step in a file's story. `fixed` is derived: a clean pass that follows a block or warning on that file. */
export interface Step {
  time: string
  file: string
  outcome: "blocked" | "warned" | "passed" | "fixed"
  findings: LoggedFinding[]
  omitted: number
  checked: number
  /** For `fixed`: the rule codes that were caught on this file and are now gone. */
  resolves: string[]
}

export interface Summary {
  session: string
  steps: Step[]
  writes: number
  caught: number
  fixed: number
  outstanding: number
}

/**
 * Turns one session's events (in log order) into the timeline and its headline numbers. A catch is a blocked
 * or warned write; it is fixed when a later write to the same file passes clean, outstanding otherwise.
 */
export function summarize(session: string, events: readonly EnforcementEvent[]): Summary {
  const open = new Map<string, { catches: number; codes: string[] }>()
  let caught = 0
  let fixed = 0
  const steps: Step[] = []
  for (const e of events) {
    const step = {
      time: e.time,
      file: e.file,
      findings: e.findings,
      omitted: e.omitted,
      checked: e.checked,
      resolves: [] as string[]
    }
    if (e.outcome === "passed") {
      const pending = open.get(e.file)
      if (pending) {
        fixed += pending.catches
        open.delete(e.file)
        steps.push({ ...step, outcome: "fixed", resolves: [...new Set(pending.codes)] })
      } else steps.push({ ...step, outcome: "passed" })
      continue
    }
    caught++
    const pending = open.get(e.file) ?? { catches: 0, codes: [] }
    pending.catches++
    pending.codes.push(...e.findings.map((f) => f.code))
    open.set(e.file, pending)
    steps.push({ ...step, outcome: e.outcome })
  }
  return { session, steps, writes: events.length, caught, fixed, outstanding: caught - fixed }
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`

export function headline(s: Summary): string {
  return `${plural(s.writes, "write")} checked · ${plural(s.caught, "violation")} caught · ${s.fixed} fixed · ${s.outstanding} outstanding`
}

const MARK = { error: "✗", warning: "⚠", info: "ℹ" } as const

export function renderText(s: Summary): string {
  const lines = [`Invariant enforcement: ${headline(s)}`, `session ${s.session}`, ""]
  for (const step of s.steps) {
    const uses = plural(step.checked, "component use")
    const state =
      step.outcome === "fixed"
        ? `fixed (caught ${step.resolves.join(", ")}; now clean, ${uses} checked)`
        : step.outcome === "passed"
          ? `passed (${uses} checked)`
          : `${step.outcome} (${plural(step.findings.length + step.omitted, "finding")})`
    lines.push(`${step.time}  ${step.file}  ${state}`)
    for (const f of step.findings) {
      lines.push(
        `    ${MARK[f.severity]} ${f.code}: ${f.message}${f.line !== undefined ? ` (line ${f.line})` : ""}`
      )
      if (f.fix) lines.push(`        fix: ${f.fix}`)
    }
    if (step.omitted > 0) lines.push(`    …and ${step.omitted} more`)
  }
  if (s.steps.length === 0) lines.push("No writes were checked in this session.")
  return `${lines.join("\n")}\n`
}

export function renderHtml(s: Summary): string {
  const rows = s.steps
    .map((step) => {
      const found = step.findings
        .map(
          (f) =>
            `<div><span class="${esc(f.severity)}">${MARK[f.severity]}</span> <code>${esc(f.code)}</code> ${esc(f.message)}${f.line !== undefined ? ` (line ${esc(f.line)})` : ""}${f.fix ? `<br><small>fix: ${esc(f.fix)}</small>` : ""}</div>`
        )
        .join("")
      const detail =
        step.outcome === "fixed"
          ? `Caught ${step.resolves.map((c) => `<code>${esc(c)}</code>`).join(", ")}; now clean.`
          : step.outcome === "passed"
            ? `Clean (${esc(plural(step.checked, "component use"))} checked).`
            : found + (step.omitted > 0 ? `<div>…and ${esc(step.omitted)} more</div>` : "")
      return `<tr><td>${esc(step.time)}</td><td><code>${esc(step.file)}</code></td><td>${esc(step.outcome)}</td><td>${detail}</td></tr>`
    })
    .join("\n")
  const table =
    s.steps.length === 0
      ? "<p>No writes were checked in this session.</p>"
      : `<table><thead><tr><th>Time</th><th>File</th><th>Outcome</th><th>Detail</th></tr></thead><tbody>\n${rows}\n</tbody></table>`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Invariant enforcement report</title>
<style>${STYLE}</style></head><body>
<h1>Invariant enforcement</h1>
<p><strong>${esc(headline(s))}</strong></p>
<p>Session <code>${esc(s.session)}</code></p>
${table}
</body></html>
`
}
