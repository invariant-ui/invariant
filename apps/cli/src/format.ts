import type { Diagnostic } from "@invariant/diagnostics"

export function table(head: string[], rows: ReadonlyArray<ReadonlyArray<string | number>>): string {
  const all = [head, ...rows.map((r) => r.map(String))]
  const widths = head.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)))
  const line = (r: readonly string[]): string =>
    r
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd()
  return [line(head), line(widths.map((w) => "-".repeat(w))), ...all.slice(1).map(line)].join("\n")
}

export function formatDiagnostic(d: Diagnostic): string {
  const where = d.location ? ` (${d.location.path}${d.location.line ? `:${d.location.line}` : ""})` : ""
  return `${d.severity.padEnd(7)} ${d.code}: ${d.message}${where}`
}

export function countBySeverity(diagnostics: readonly Diagnostic[]): string {
  const n = (s: string): number => diagnostics.filter((d) => d.severity === s).length
  return `${n("error")} errors, ${n("warning")} warnings, ${n("info")} info`
}

export function shortValue(value: unknown, max = 40): string {
  const text = value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
