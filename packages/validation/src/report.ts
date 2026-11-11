import type { Evaluation } from "./pattern-rules.js"
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
  /** How the structural pattern checks came out across all files. Not-verifiable and skipped checks are not failures, and not passes. */
  patternRules: Record<"pass" | "fail" | "warning" | "notVerifiable" | "skipped", number>
  /**
   * Present when an interaction check found something: how much each result establishes. `runtimeVerified` is
   * always 0 here, because static analysis does not run the code.
   */
  interactionEvidence?: { structural: number; staticInferred: number; runtimeVerified: number }
}

export function summarize(
  violations: readonly Violation[],
  files: number,
  componentsChecked: number,
  evaluations: readonly Evaluation[] = []
): RunSummary {
  const n = (s: Severity): number => violations.filter((v) => v.severity === s).length
  const patternRules = { pass: 0, fail: 0, warning: 0, notVerifiable: 0, skipped: 0 }
  for (const e of evaluations) patternRules[e.status === "not-verifiable" ? "notVerifiable" : e.status]++
  const leveled = evaluations.filter((e) => e.level !== undefined)
  const interactionEvidence =
    leveled.length === 0
      ? undefined
      : {
          structural: leveled.filter((e) => e.level === "structural").length,
          staticInferred: leveled.filter((e) => e.level === "static-inferred").length,
          runtimeVerified: leveled.filter((e) => e.level === "runtime-verified").length
        }
  return {
    files,
    errors: n("error"),
    warnings: n("warning"),
    info: n("info"),
    componentsChecked,
    patternRules,
    ...(interactionEvidence ? { interactionEvidence } : {})
  }
}

const evidenceLine = (s: RunSummary): string | undefined => {
  const e = s.interactionEvidence
  if (!e) return undefined
  return `interaction evidence: ${e.structural + e.staticInferred + e.runtimeVerified} structural or better (${e.staticInferred} statically inferred, ${e.structural} structural only, ${e.runtimeVerified} runtime verified; static analysis does not run the code)`
}

const patternLine = (s: RunSummary["patternRules"]): string =>
  `${s.pass} passed, ${s.fail} failed, ${s.warning} warnings, ${s.notVerifiable} not verifiable, ${s.skipped} skipped`
const hasPatternRules = (s: RunSummary["patternRules"]): boolean => Object.values(s).some((n) => n > 0)

export function sortEvaluations(evaluations: readonly Evaluation[]): Evaluation[] {
  return [...evaluations].sort(
    (a, b) =>
      ((a.file ?? "") < (b.file ?? "") ? -1 : (a.file ?? "") > (b.file ?? "") ? 1 : 0) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.column ?? 0) - (b.column ?? 0) ||
      (a.constraint < b.constraint ? -1 : a.constraint > b.constraint ? 1 : 0)
  )
}

const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 }

/** Sorts worst-first: file, then position in it, then severity, then rule. `file` is optional for snippet checks. */
export function sortViolations<T extends Finding>(violations: readonly T[]): T[] {
  const fileOf = (f: Finding): string => f.file ?? ""
  return [...violations].sort(
    (a, b) =>
      (fileOf(a) < fileOf(b) ? -1 : fileOf(a) > fileOf(b) ? 1 : 0) ||
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

export function formatText(
  violations: readonly Violation[],
  summary: RunSummary,
  evaluations: readonly Evaluation[] = []
): string {
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
  const unestablished = sortEvaluations(evaluations).filter(
    (e) => e.status === "not-verifiable" || e.status === "skipped"
  )
  if (hasPatternRules(summary.patternRules)) {
    lines.push(`pattern rules: ${patternLine(summary.patternRules)}`)
    const evidence = evidenceLine(summary)
    if (evidence) lines.push(evidence)
    for (const e of unestablished.slice(0, 50))
      lines.push(
        `  ${e.status === "skipped" ? "skipped" : "not verifiable"} ${e.file ?? "(snippet)"}:${e.line ?? 1} ${e.rule}: ${e.reason}`
      )
    if (unestablished.length > 50) lines.push(`  ... ${unestablished.length - 50} more (see --format json)`)
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
  contractHash: string,
  evaluations: readonly Evaluation[] = []
): Record<string, unknown> {
  return {
    contractHash,
    summary,
    violations: sortViolations(violations),
    evaluations: sortEvaluations(evaluations)
  }
}

/** The pattern-rule tally for a one-line summary, or an empty string when no pattern rule applied. */
export const patternSummaryText = (s: RunSummary): string => {
  if (!hasPatternRules(s.patternRules)) return ""
  const evidence = evidenceLine(s)
  return `pattern rules: ${patternLine(s.patternRules)}${evidence ? `\n${evidence}` : ""}`
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
  tool: { name: string; version: string },
  summary?: RunSummary
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
        ...(summary && hasPatternRules(summary.patternRules)
          ? { properties: { patternRules: summary.patternRules } }
          : {}),
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
