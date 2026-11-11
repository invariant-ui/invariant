import { sortViolations } from "./report.js"
import type { Finding } from "./validate-usage.js"

/**
 * The most findings a card shows before pointing at the rest. Claude Code caps hook strings at 10,000
 * characters, and a person reads this in a chat: ten is as much as anyone acts on at once.
 */
export const CARD_FINDINGS_LIMIT = 10

const MARK: Record<Finding["severity"], string> = { error: "✗", warning: "⚠", info: "ℹ" }

export interface EnforcementCardInput {
  /** What the check found. The card sorts and caps the list itself. */
  findings: readonly Finding[]
  /** The compiled contract's name, the one the person watching the chat recognizes. */
  contractName: string
  /** What was checked: a project-relative path, or "the snippet" when there is no file. */
  file?: string | undefined
  /** True when these findings stopped the write; false reports them without blocking. */
  blocked?: boolean
  /** What the agent should do next; the card closes with it. */
  next: string
  /**
   * How to point at findings beyond the limit, given how many were left out. Defaults to naming the count;
   * a caller that knows where the rest are, like the hook's `invariant validate`, says so.
   */
  more?: (remaining: number) => string
  /** How many findings to show before the more line. Defaults to {@link CARD_FINDINGS_LIMIT}. */
  limit?: number | undefined
}

/**
 * The enforcement card: the one finding list every surface shows the agent — the hook's deny reason, the
 * validate tool's text content — so the chat the person is watching says the same thing everywhere it is
 * checked. Rule, what is wrong, where, and the fix, in file order and capped so it stays readable in a
 * message. Show {@link passCard} instead when there is nothing to fix.
 */
export function enforcementCard(input: EnforcementCardInput): string {
  const { findings, contractName, next } = input
  const file = input.file ?? "the snippet"
  const limit = input.limit ?? CARD_FINDINGS_LIMIT
  const count = (severity: Finding["severity"]): number =>
    findings.filter((f) => f.severity === severity).length
  const errors = count("error")
  const warnings = count("warning")
  const info = count("info")
  const counts = [
    errors > 0 ? `${errors} error${errors === 1 ? "" : "s"}` : undefined,
    warnings > 0 ? `${warnings} warning${warnings === 1 ? "" : "s"}` : undefined,
    info > 0 ? `${info} info` : undefined
  ]
    .filter(Boolean)
    .join(", ")
  const lines = [
    `invariant ${input.blocked === true ? "blocked" : "checked"} ${file}: ${counts} against the ${contractName} contract`,
    ""
  ]
  for (const f of sortViolations([...findings]).slice(0, limit)) {
    const where = f.line !== undefined ? ` (line ${f.line})` : ""
    lines.push(`${MARK[f.severity]} ${f.code}: ${f.message}${where}`)
    if (f.suggestion) lines.push(`    fix: ${f.suggestion}`)
  }
  if (findings.length > limit)
    lines.push(input.more ? input.more(findings.length - limit) : `…and ${findings.length - limit} more`)
  lines.push("")
  lines.push(`${next} Facts and fixes come from the compiled contract, not guesses.`)
  return lines.join("\n")
}

export interface PassCardInput {
  /** The compiled contract's name, the one the person watching the chat recognizes. */
  contractName: string
  /** What was checked: a project-relative path, or "the snippet" when there is no file. */
  file?: string | undefined
  /** The components whose uses were checked, as `validateCode` reports them. */
  componentsChecked: readonly string[]
}

/** The one-line confirmation of a clean pass: what was checked, and that it follows the contract. */
export function passCard(input: PassCardInput): string {
  const n = input.componentsChecked.length
  return `invariant ✓ ${input.file ?? "the snippet"} follows the ${input.contractName} contract (${n === 0 ? "no" : n} component use${n === 1 ? "" : "s"} checked)`
}
