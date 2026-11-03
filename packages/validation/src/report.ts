import { RULES, ruleFor, type Severity } from "./rules.js"
import type { Finding } from "./validate-usage.js"

export interface Violation extends Finding {
  file: string
}

export interface RunSummary {
  files: number
  errors: number
  warnings: number
  info: number
  componentsChecked: number
}

export function summarize(
  violations: readonly Violation[],
  files: number,
  componentsChecked: number
): RunSummary {
  const n = (s: Severity): number => violations.filter((v) => v.severity === s).length
  return { files, errors: n("error"), warnings: n("warning"), info: n("info"), componentsChecked }
}

const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 }

export function sortViolations(violations: readonly Violation[]): Violation[] {
  return [...violations].sort(
    (a, b) =>
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.column ?? 0) - (b.column ?? 0) ||
      RANK[a.severity] - RANK[b.severity] ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)
  )
}

export type FailOn = "error" | "warning" | "never"

/** True when the run should fail the build. */
export function shouldFail(summary: RunSummary, failOn: FailOn): boolean {
  return failOn === "never"
    ? false
    : failOn === "warning"
      ? summary.errors + summary.warnings > 0
      : summary.errors > 0
}

export function formatText(violations: readonly Violation[], summary: RunSummary): string {
  const lines: string[] = []
  for (const v of sortViolations(violations)) {
    lines.push(`${v.file}:${v.line ?? 1}:${v.column ?? 1} ${v.severity} ${v.code}`)
    lines.push(`  ${v.message}`)
    if (v.suggestion) lines.push(`  fix: ${v.suggestion}`)
    const refs = [
      v.source ? `evidence ${v.source} (${v.basis})` : `basis ${v.basis}`,
      v.policy ? `policy ${v.policy}` : undefined,
      v.subject ? `subject ${v.subject}` : undefined
    ].filter(Boolean)
    lines.push(`  ${refs.join("; ")}`)
    lines.push("")
  }
  lines.push(
    `${summary.errors} errors, ${summary.warnings} warnings, ${summary.info} info in ${summary.files} files (${summary.componentsChecked} components checked)`
  )
  return lines.join("\n")
}

export function toJson(
  violations: readonly Violation[],
  summary: RunSummary,
  contractHash: string
): Record<string, unknown> {
  return { contractHash, summary, violations: sortViolations(violations) }
}

const escData = (s: string): string => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")
const escProp = (s: string): string => escData(s).replace(/:/g, "%3A").replace(/,/g, "%2C")

/** GitHub Actions workflow commands: one annotation per violation. */
export function formatGithub(violations: readonly Violation[]): string {
  return sortViolations(violations)
    .map((v) => {
      const level = v.severity === "error" ? "error" : v.severity === "warning" ? "warning" : "notice"
      const props = `file=${escProp(v.file)},line=${v.line ?? 1},col=${v.column ?? 1},title=${escProp(v.code)}`
      return `::${level} ${props}::${escData(v.suggestion ? `${v.message}. Fix: ${v.suggestion}` : v.message)}`
    })
    .join("\n")
}

/** SARIF 2.1.0, accepted by GitHub code scanning and most CI viewers. */
export function toSarif(
  violations: readonly Violation[],
  tool: { name: string; version: string }
): Record<string, unknown> {
  const level = (s: Severity): string => (s === "info" ? "note" : s)
  const used = new Set(violations.map((v) => v.code))
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: tool.name,
            version: tool.version,
            rules: RULES.filter((r) => used.has(r.code)).map((r) => ({
              id: r.code,
              name: r.title,
              shortDescription: { text: r.title },
              properties: { planRule: r.plan, origin: r.origin },
              defaultConfiguration: { level: level(r.severity) }
            }))
          }
        },
        results: sortViolations(violations).map((v) => ({
          ruleId: v.code,
          level: level(v.severity),
          message: { text: v.suggestion ? `${v.message}. Fix: ${v.suggestion}` : v.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: v.file },
                region: { startLine: v.line ?? 1, startColumn: v.column ?? 1 }
              }
            }
          ],
          properties: {
            basis: v.basis,
            ...(v.source ? { evidence: v.source } : {}),
            ...(v.policy ? { policy: v.policy } : {}),
            ...(v.subject ? { subject: v.subject } : {}),
            ...(ruleFor(v.code) ? {} : {})
          }
        }))
      }
    ]
  }
}
