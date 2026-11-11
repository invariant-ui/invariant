import { describe, expect, it } from "vitest"
import { CARD_FINDINGS_LIMIT, enforcementCard, passCard } from "./index.js"
import type { Finding } from "./validate-usage.js"

const finding = (over: Partial<Finding>): Finding => ({
  code: "prop-value-not-allowed",
  severity: "error",
  message: 'variant "danger" is not allowed on Button',
  basis: "documented",
  ...over
})

describe("enforcementCard", () => {
  it("states the file, the contract, and counts by severity, in file order", () => {
    const card = enforcementCard({
      findings: [
        finding({ severity: "warning", code: "prop-deprecated", message: "plain is deprecated", line: 4 }),
        finding({ severity: "info", code: "color-matches-token", message: "#fff is surface", line: 2 }),
        finding({ line: 3, suggestion: "Use variant primary, secondary or ghost." })
      ],
      contractName: "@acme/ui",
      file: "src/Page.tsx",
      next: "Fix these, then validate again."
    })
    expect(card).toBe(
      [
        "invariant checked src/Page.tsx: 1 error, 1 warning, 1 info against the @acme/ui contract",
        "",
        "ℹ color-matches-token: #fff is surface (line 2)",
        '✗ prop-value-not-allowed: variant "danger" is not allowed on Button (line 3)',
        "    fix: Use variant primary, secondary or ghost.",
        "⚠ prop-deprecated: plain is deprecated (line 4)",
        "",
        "Fix these, then validate again. Facts and fixes come from the compiled contract, not guesses."
      ].join("\n")
    )
  })

  it("says blocked, and the snippet, when the caller has no file", () => {
    const card = enforcementCard({
      findings: [finding({ severity: "warning", message: "plain is deprecated", line: 1 })],
      contractName: "@acme/ui",
      blocked: true,
      next: "Fix these, then write the file again."
    })
    expect(card).toContain("invariant blocked the snippet: 1 warning against the @acme/ui contract")
    expect(card).toContain("⚠ prop-value-not-allowed: plain is deprecated (line 1)")
    expect(card).toContain("Fix these, then write the file again.")
    expect(card).toContain("Facts and fixes come from the compiled contract, not guesses.")
  })

  it("omits what is absent: counts, line, fix", () => {
    const card = enforcementCard({
      findings: [finding({ severity: "info", message: "no line here" })],
      contractName: "@acme/ui",
      next: "Fix these."
    })
    expect(card).toContain("invariant checked the snippet: 1 info against the @acme/ui contract")
    expect(card).toContain("ℹ prop-value-not-allowed: no line here")
    expect(card).not.toContain("(line")
    expect(card).not.toContain("fix:")
  })

  it("caps findings and points at the rest; the caller can say where it is", () => {
    const findings = Array.from({ length: CARD_FINDINGS_LIMIT + 3 }, (_, i) =>
      finding({ line: i + 1, code: `rule-${i}` })
    )
    const card = enforcementCard({
      findings,
      contractName: "@acme/ui",
      next: "Fix these.",
      more: (n) => `…and ${n} more (run \`invariant validate src/Page.tsx\`)`
    })
    expect(card).toContain("invariant checked the snippet: 13 errors against the @acme/ui contract")
    expect(card).toContain('✗ rule-9: variant "danger" is not allowed on Button (line 10)')
    expect(card).not.toContain("rule-10:")
    expect(card).toContain("…and 3 more (run `invariant validate src/Page.tsx`)")
  })

  it("counts findings past the limit itself when the caller does not", () => {
    const findings = Array.from({ length: CARD_FINDINGS_LIMIT + 1 }, (_, i) =>
      finding({ line: i + 1, code: `rule-${i}` })
    )
    const card = enforcementCard({ findings, contractName: "@acme/ui", next: "Fix these." })
    expect(card).toContain("…and 1 more")
  })

  it("honors a smaller limit", () => {
    const card = enforcementCard({
      findings: [finding({ line: 1 }), finding({ line: 2 }), finding({ line: 3 })],
      contractName: "@acme/ui",
      next: "Fix these.",
      limit: 1
    })
    expect(card).toContain("…and 2 more")
    expect(card).not.toContain("(line 2)")
  })
})

describe("passCard", () => {
  it("confirms what was checked, and pluralizes", () => {
    expect(passCard({ contractName: "@acme/ui", file: "src/Save.tsx", componentsChecked: ["Button"] })).toBe(
      "invariant ✓ src/Save.tsx follows the @acme/ui contract (1 component use checked)"
    )
    expect(
      passCard({ contractName: "@acme/ui", file: "src/Page.tsx", componentsChecked: ["Button", "Card"] })
    ).toBe("invariant ✓ src/Page.tsx follows the @acme/ui contract (2 component uses checked)")
  })

  it("says no component uses were checked, and the snippet, when there is no file", () => {
    expect(passCard({ contractName: "@acme/ui", componentsChecked: [] })).toBe(
      "invariant ✓ the snippet follows the @acme/ui contract (no component uses checked)"
    )
  })
})
