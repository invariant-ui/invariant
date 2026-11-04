import { describe, expect, it } from "vitest"
import { type Diagnostic, diagnostic, hasErrors, sortDiagnostics } from "./diagnostic.js"

const base = { code: "contract.dangling-reference", severity: "error", message: "m" } as const

describe("diagnostic", () => {
  it("accepts well-formed diagnostics and rejects malformed codes and unknown fields", () => {
    expect(diagnostic(base)).toEqual(base)
    expect(() => diagnostic({ ...base, code: "NoDots" })).toThrow()
    expect(() => diagnostic({ ...base, extra: 1 } as unknown as Diagnostic)).toThrow()
  })

  it("detects errors", () => {
    expect(hasErrors([{ ...base, severity: "warning" }])).toBe(false)
    expect(hasErrors([base])).toBe(true)
  })

  it("sorts deterministically by severity, code, then location", () => {
    const a: Diagnostic = { ...base, severity: "info", code: "a.b" }
    const b: Diagnostic = { ...base, severity: "error", code: "z.z" }
    const c: Diagnostic = { ...base, severity: "error", code: "a.a", location: { path: "x.ts", line: 2 } }
    const d: Diagnostic = { ...base, severity: "error", code: "a.a", location: { path: "x.ts", line: 1 } }
    const expected = [d, c, b, a]
    expect(sortDiagnostics([a, b, c, d])).toEqual(expected)
    expect(sortDiagnostics([d, c, a, b])).toEqual(expected)
  })
})
