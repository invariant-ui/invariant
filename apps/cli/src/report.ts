import type { Contract } from "@invariant/contract"
import type { Diagnostic } from "@invariant/diagnostics"
import type { ReviewItem } from "@invariant/reconciliation"

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
}
/** Every value that reaches the page goes through here: names and messages come from customer source. */
export const esc = (value: unknown): string => String(value).replace(/[&<>"']/g, (c) => ESCAPES[c] as string)

const STYLE = `body{font:14px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:72rem;padding:0 1rem;color:#1a1a1a}
h1,h2{font-weight:600}table{border-collapse:collapse;width:100%;margin:.5rem 0 1.5rem}
th,td{border:1px solid #d0d0d0;padding:.3rem .5rem;text-align:left;vertical-align:top}th{background:#f3f3f3}
code{font:12px ui-monospace,monospace}summary{cursor:pointer;margin:.5rem 0}.error{color:#a40000}.warning{color:#8a5a00}.info{color:#555}`

function table(head: string[], rows: string[][]): string {
  if (rows.length === 0) return "<p>None.</p>"
  const th = head.map((h) => `<th>${esc(h)}</th>`).join("")
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("\n")
  return `<table><thead><tr>${th}</tr></thead><tbody>\n${body}\n</tbody></table>`
}

/** Rows shown before the rest fold into a `<details>` block. The report never drops rows and needs no script. */
const VISIBLE_ROWS = 200

function longTable(head: string[], rows: string[][]): string {
  if (rows.length <= VISIBLE_ROWS) return table(head, rows)
  const rest = rows.length - VISIBLE_ROWS
  return `${table(head, rows.slice(0, VISIBLE_ROWS))}
<details><summary>Show the remaining ${esc(rest)} rows</summary>
${table(head, rows.slice(VISIBLE_ROWS))}
</details>`
}

const anchor = (id: string): string => `c-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`

/**
 * A self-contained, static HTML summary: no scripts, no external requests, no timestamps. It is a view of the
 * contract for people; the contract file stays canonical.
 */
export function renderReport(input: {
  contract: Contract
  review: readonly ReviewItem[]
  diagnostics: readonly Diagnostic[]
}): string {
  const { contract: c, review, diagnostics } = input
  const inferred = review.filter((r) => r.kind === "inferred-fact").length
  const openConflicts = c.conflicts.filter((x) => x.resolution.state === "open").length
  const counts = (sev: string): number => diagnostics.filter((d) => d.severity === sev).length
  const parts: string[] = []
  parts.push(`<h1>${esc(c.metadata.name)}</h1>`)
  parts.push(
    `<p>Contract <code>${esc(c.metadata.contractId)}</code> v${esc(c.contractVersion)}, compiler ${esc(c.metadata.compilerVersion)}, content hash <code>${esc(c.integrity.contentHash)}</code>.</p>`
  )
  parts.push(
    table(
      [
        "Components",
        "Tokens",
        "Themes",
        "Guidelines",
        "Open conflicts",
        "Inferred facts",
        "Errors",
        "Warnings"
      ],
      [
        [
          c.components.length,
          c.tokens.length,
          c.themes.length,
          c.guidelines.length,
          openConflicts,
          inferred,
          counts("error"),
          counts("warning")
        ].map(esc)
      ]
    )
  )
  parts.push("<h2>Sources</h2>")
  parts.push(
    table(
      ["Id", "Type", "Location", "Health", "Diagnostics"],
      c.sources.map((s) => [
        esc(s.id),
        esc(s.type),
        esc(s.location),
        esc(s.health.status),
        esc(s.health.diagnosticCount)
      ])
    )
  )
  parts.push("<h2>Conflicts</h2>")
  parts.push(
    longTable(
      ["Severity", "Type", "Subject", "Path", "Claims", "State"],
      c.conflicts.map((x) => [
        `<span class="${esc(x.severity)}">${esc(x.severity)}</span>`,
        esc(x.type),
        `<a href="#${esc(anchor(x.subject))}">${esc(x.subject)}</a>`,
        `<code>${esc(x.path ?? "")}</code>`,
        x.claims
          .map(
            (cl) =>
              `${esc(cl.sourceId)}: <code>${esc(cl.value === undefined ? "(absent)" : JSON.stringify(cl.value))}</code> (${esc(cl.status)})`
          )
          .join("<br>"),
        esc(x.resolution.state)
      ])
    )
  )
  parts.push("<h2>Components</h2>")
  parts.push(
    longTable(
      ["Id", "Name", "Implementations", "Props", "Events", "Slots", "Variants"],
      c.components.map((x) => [
        `<a id="${esc(anchor(x.id))}"></a><code>${esc(x.id)}</code>`,
        esc(x.name),
        esc(x.implementations.map((i) => i.framework).join(", ")),
        esc(x.props.length),
        esc(x.events.length),
        esc(x.slots.length),
        esc(x.variants.length)
      ])
    )
  )
  parts.push("<h2>Tokens</h2>")
  parts.push(
    longTable(
      ["Id", "Category", "Value", "Modes"],
      c.tokens.map((t) => [
        `<code>${esc(t.id)}</code>`,
        `${esc(t.category)}${t.facts.category?.status === "inferred" ? " (inferred)" : ""}`,
        `<code>${esc("aliasOf" in t.value && t.value.aliasOf ? `-> ${t.value.aliasOf}` : JSON.stringify(t.value.value))}</code>`,
        esc(Object.keys(t.modes ?? {}).join(", "))
      ])
    )
  )
  parts.push("<h2>Needs review</h2>")
  parts.push(
    longTable(
      ["Priority", "Kind", "Subject", "Path", "Confidence", "Reason"],
      review.map((r) => [
        esc(r.priority),
        esc(r.kind),
        esc(r.subject),
        `<code>${esc(r.path ?? "")}</code>`,
        esc(r.confidence ?? ""),
        esc(r.reason)
      ])
    )
  )
  parts.push("<h2>Diagnostics</h2>")
  parts.push(
    longTable(
      ["Severity", "Code", "Message", "Location"],
      diagnostics.map((d) => [
        `<span class="${esc(d.severity)}">${esc(d.severity)}</span>`,
        `<code>${esc(d.code)}</code>`,
        esc(d.message),
        esc(d.location ? `${d.location.path}${d.location.line ? `:${d.location.line}` : ""}` : "")
      ])
    )
  )
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${esc(c.metadata.name)} - Invariant report</title>
<style>${STYLE}</style></head><body>
${parts.join("\n")}
</body></html>
`
}
