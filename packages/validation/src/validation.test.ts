import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  type Contract,
  type EvidenceFile,
  evidenceFileSchema,
  parseContract,
  type Token
} from "@invariant/contract"
import { DesignSystem } from "@invariant/contract-query"
import { describe, expect, it } from "vitest"
import { defaultFramework, scanMarkup, validateCode, validateUsage } from "./index.js"

const golden = (name: string, file: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../../fixtures/contract-golden/${name}/${file}`, import.meta.url)),
    "utf8"
  )

function load(name: string): { contract: Contract; evidence: EvidenceFile } {
  const parsed = parseContract(JSON.parse(golden(name, "invariant.contract.json")))
  if (!parsed.ok) throw new Error("fixture contract invalid")
  return {
    contract: parsed.value,
    evidence: evidenceFileSchema.parse(JSON.parse(golden(name, "invariant.evidence.json")))
  }
}

const token = (name: string, value: Token["value"], extra: Partial<Token> = {}): Token => ({
  id: `token:${name}` as Token["id"],
  name,
  category: "color",
  value,
  facts: {},
  ...extra
})

function withTokens(tokens: Token[]): DesignSystem {
  const { contract, evidence } = load("acme-ui")
  return new DesignSystem(
    { ...contract, tokens, themes: [{ id: "theme:dark" as never, name: "dark" }] },
    evidence
  )
}

const acme = (): DesignSystem => {
  const { contract, evidence } = load("acme-ui")
  return new DesignSystem(contract, evidence)
}

describe("validateUsage", () => {
  const ds = acme()
  const codes = (r: ReturnType<typeof validateUsage>) => r.findings.map((f) => f.code)

  it("accepts correct usage", () => {
    const r = validateUsage(ds, {
      component: "Button",
      props: { variant: "ghost", size: "sm" },
      hasChildren: true
    })
    expect(r.findings).toEqual([])
  })

  it("reports an unknown component with candidates", () => {
    const r = validateUsage(ds, { component: "Buttn" })
    expect(codes(r)).toEqual(["component-unknown"])
  })

  it("rejects a value outside the declared domain, citing where it is declared", () => {
    const r = validateUsage(ds, { component: "Button", props: { variant: "danger" }, hasChildren: true })
    expect(r.findings).toMatchObject([
      {
        code: "prop-value-not-allowed",
        severity: "error",
        path: "props.variant.allowedValues",
        basis: "discovered",
        source: expect.stringMatching(/Button\.tsx/)
      }
    ])
  })

  it("reports a deprecated prop, a missing required prop, and a wrong type", () => {
    expect(
      codes(validateUsage(ds, { component: "Button", props: { plain: true }, hasChildren: true }))
    ).toEqual(["prop-deprecated"])
    expect(codes(validateUsage(ds, { component: "Button", props: {}, hasChildren: false }))).toEqual([
      "required-prop-missing"
    ])
    expect(
      codes(validateUsage(ds, { component: "Button", props: { loading: "yes" }, hasChildren: true }))
    ).toEqual(["prop-type-mismatch"])
  })

  it("does not claim a missing required prop when children are unknown or props may be spread", () => {
    expect(codes(validateUsage(ds, { component: "Button", props: {} }))).toEqual([])
    expect(codes(validateUsage(ds, { component: "Modal", props: {}, hasSpread: true }))).toEqual([])
    expect(codes(validateUsage(ds, { component: "Modal", props: {} }))).toEqual(["required-prop-missing"])
  })

  it("says unknown props are unverifiable when the API listing is incomplete, and warns when it is complete", () => {
    expect(
      codes(validateUsage(ds, { component: "Button", props: { wobble: 1 }, hasChildren: true }))
    ).toEqual(["unverifiable-prop"])
    expect(codes(validateUsage(ds, { component: "Badge", props: { wobble: 1 } }))).toEqual(["unknown-prop"])
  })

  it("ignores pass-through attributes and never checks dynamic values", () => {
    const r = validateUsage(ds, {
      component: "Badge",
      props: { "aria-label": "x", "data-id": "1", className: "c", tone: { expression: "tone" } }
    })
    expect(r.findings).toEqual([])
    expect(r.unverifiedValues).toBe(1)
  })

  it("rejects a framework the component does not have", () => {
    expect(codes(validateUsage(ds, { component: "Badge", framework: "vue" }))).toContain(
      "framework-not-implemented"
    )
  })

  it("treats a JSON object with other keys as a literal, not as dynamic", () => {
    const r = validateUsage(ds, {
      component: "Button",
      props: { loading: { expression: "x", other: 1 } as never },
      hasChildren: true
    })
    expect(codes(r)).toEqual(["prop-type-mismatch"])
  })
})

describe("validateCode (React)", () => {
  const ds = withTokens([token("color-brand", { value: "#0057ff" }), token("color-bg", { value: "#fff" })])
  const run = (code: string, extra: Record<string, unknown> = {}) =>
    validateCode(ds, { code, framework: "react", ...extra })
  const at = (r: ReturnType<typeof run>) => r.findings.map((f) => `${f.line}:${f.code}`)

  it("checks component uses with literal props and reports line numbers", () => {
    const r = run(
      `const a = (\n  <div>\n    <Button variant="danger" plain>Save</Button>\n    <Button variant={v} size="sm" />\n  </div>\n)`
    )
    expect(at(r)).toEqual(["3:prop-deprecated", "3:prop-value-not-allowed", "4:required-prop-missing"])
    expect(r.summary).toMatchObject({
      errors: 2,
      warnings: 1,
      componentsChecked: ["component:button"],
      unverifiedValues: 1
    })
    expect(r.valid).toBe(false)
  })

  it("is valid for correct code and does not run it", () => {
    const r = run(`export const x = () => <Button variant="primary">Go</Button>\nprocess.exit(1)`)
    expect(r).toMatchObject({ valid: true, findings: [] })
  })

  it("matches compound member names and tolerates spread", () => {
    const r = run(`<Card.Header {...props} />`)
    expect(r.summary.componentsChecked).toEqual(["component:card.header"])
  })

  it("compares literal colors and CSS variables with tokens", () => {
    const r = run(
      `const s = { color: "#0057ff", background: "#FFF", border: "1px solid #abc123" }\nconst css = "var(--color-brand) var(--nope)"`
    )
    expect(at(r)).toEqual([
      "1:color-matches-token",
      "1:color-matches-token",
      "1:color-not-in-tokens",
      "2:unknown-css-variable"
    ])
    expect(r.findings.find((f) => f.code === "unknown-css-variable")?.message).toContain("--nope")
  })

  it("does not flag anchors and entities as colors", () => {
    expect(run(`<a href="#add">x</a> &#123;`).findings.filter((f) => f.code.startsWith("color"))).toEqual([])
  })

  it("marks native-element suggestions as heuristic, not as rules", () => {
    const r = run(`<button>Go</button>`)
    expect(r.findings).toMatchObject([
      { code: "native-element-has-equivalent", severity: "info", basis: "heuristic", confidence: 0.5 }
    ])
    expect(r.valid).toBe(true)
  })

  it("lists elements it does not recognize instead of judging them", () => {
    const r = run(`<Foreign.Widget a="1" /><x-thing />`)
    expect(r.summary.elementsNotInContract).toEqual(["Foreign.Widget", "x-thing"].sort())
    expect(r.findings).toEqual([])
  })

  it("skips color checks when no token has a literal color, and says so", () => {
    const r = validateCode(acme(), { code: `const c = "#123456"` })
    expect(r.findings).toEqual([])
    expect(r.limitations.join(" ")).toMatch(/not checked/)
  })

  it("refuses oversized input", () => {
    const r = run("x".repeat(200_001))
    expect(r.valid).toBe(false)
    expect(r.findings[0]?.code).toBe("input-too-large")
  })
})

describe("validateCode (templates)", () => {
  const ds = withTokens([token("color-brand", { value: "#0057ff" })])

  it("checks Vue templates: static values, bindings as unverified, events and directives skipped", () => {
    const code = `<template>\n  <Button\n    variant="danger"\n    :size="s"\n    @click="go"\n    v-if="ok"\n  >Save</Button>\n  <Button variant="primary" />\n</template>`
    const r = validateCode(ds, { code, framework: "html" })
    expect(r.findings.map((f) => `${f.line}:${f.code}`)).toEqual([
      "2:prop-value-not-allowed",
      "8:required-prop-missing"
    ])
    expect(r.summary.unverifiedValues).toBe(1)
  })

  it("matches Angular element selectors and kebab-case tags", () => {
    expect(
      validateCode(ds, { code: `<ui-badge tone="loud"></ui-badge>`, framework: "angular" }).summary
        .componentsChecked
    ).toEqual([])
    expect(
      validateCode(ds, { code: `<Badge tone="loud"></Badge>`, framework: "html" }).findings.map((f) => f.code)
    ).toEqual(["prop-value-not-allowed"])
  })

  it("rejects a framework the component lacks, for templates too", () => {
    expect(validateCode(ds, { code: `<Badge />`, framework: "vue" }).findings.map((f) => f.code)).toEqual([
      "framework-not-implemented"
    ])
  })

  it("normalizes kebab-case attributes to prop names", () => {
    const r = validateCode(ds, {
      code: `<Modal open title="t" on-close="x" size="giant">x</Modal>`,
      framework: "html"
    })
    expect(r.findings.map((f) => f.code)).toEqual(["prop-value-not-allowed"])
  })
})

describe("default framework", () => {
  const ds = acme()
  const only = (frameworks: string[]): DesignSystem =>
    new DesignSystem({
      ...ds.contract,
      metadata: { ...ds.contract.metadata, frameworks: frameworks as never }
    })
  it("follows the file name, then the contract's only framework, then React", () => {
    expect(defaultFramework(ds, "A.vue")).toBe("vue")
    expect(defaultFramework(ds, "x.component.html")).toBe("angular")
    expect(defaultFramework(ds, "x.html")).toBe("html")
    expect(defaultFramework(ds, "x.tsx")).toBe("react")
    expect(defaultFramework(only(["vue"]))).toBe("vue")
    expect(defaultFramework(only(["angular"]))).toBe("angular")
    expect(defaultFramework(only(["react", "vue"]))).toBe("react")
    expect(defaultFramework(only([]))).toBe("react")
  })
})

describe("markup scanner robustness", () => {
  it("ignores comments, handles quoted '>' and raw-text blocks", () => {
    const uses = scanMarkup(
      `<!-- <Button variant="x"> -->\n<Foo a="1>2" b='3' c=4 d />\n<script>if (a < b) { <Bar /> }</script>\n<Baz/>`
    )
    expect(uses.map((u) => [u.tag, u.line])).toEqual([
      ["Foo", 2],
      ["script", 3],
      ["Baz", 4]
    ])
    expect(uses[0]?.attrs).toEqual({ a: "1>2", b: "3", c: "4", d: true })
  })

  it("stays linear on hostile input", () => {
    for (const code of [
      "<a ".repeat(60_000),
      `<a b="${"c".repeat(150_000)}`,
      "<".repeat(190_000),
      `<x ${"a=".repeat(50_000)}`
    ]) {
      const t = Date.now()
      scanMarkup(code)
      expect(Date.now() - t).toBeLessThan(1500)
    }
  })
})

describe("validateCode: more literal kinds", () => {
  const ds = withTokens([
    token("color-brand", { value: "#0057ff" }),
    token("color-ink", { value: "rgb(0, 0, 0)" }),
    token("space-2", { value: "8px" }, { category: "spacing" }),
    token("space-4", { value: "1rem" }, { category: "spacing" }),
    token("font-size-md", { value: "16px" }, { category: "typography" }),
    token(
      "font-body",
      { value: { fontFamily: "Inter, sans-serif", fontWeight: 400 } },
      { category: "typography" }
    )
  ])
  const run = (code: string) => validateCode(ds, { code, framework: "react" })
  const at = (r: ReturnType<typeof run>) => r.findings.map((f) => `${f.line}:${f.code}`)

  it("matches rgb and hsl colors against hex and functional tokens", () => {
    const r = run(
      `a { color: rgb(0 87 255); background: hsl(0 0% 0%); border-color: rgb(1, 2, 3); fill: tomato }`
    )
    expect(r.findings.map((f) => `${f.code}:${f.subject ?? ""}`)).toEqual([
      "color-matches-token:token:color-brand",
      "color-matches-token:token:color-ink",
      "color-not-in-tokens:",
      "color-not-in-tokens:"
    ])
  })

  it("checks spacing: on-scale values are info, off-scale are warnings, rem equals px", () => {
    const r = run(
      `const s = { padding: 8, margin: "1rem", gap: 13 }\n.a { margin: 0 auto; padding: 8px 5px }`
    )
    expect(at(r)).toEqual([
      "1:spacing-matches-token",
      "1:spacing-matches-token",
      "1:spacing-not-in-tokens",
      "2:spacing-matches-token",
      "2:spacing-not-in-tokens"
    ])
    expect(r.findings.find((f) => f.code === "spacing-not-in-tokens")?.severity).toBe("warning")
    expect(r.findings.find((f) => f.code === "spacing-matches-token")?.severity).toBe("info")
  })

  it("checks typography against simple and composite token values", () => {
    const r = run(
      `.a { font-size: 16px; font-size: 17px; font-weight: 400; font-family: "Inter", serif; font-weight: 650 }`
    )
    expect(r.findings.map((f) => f.code)).toEqual([
      "typography-matches-token",
      "typography-not-in-tokens",
      "typography-matches-token",
      "typography-matches-token",
      "typography-not-in-tokens"
    ])
  })

  it("states plainly when a category has no literal tokens", () => {
    const bare = withTokens([token("color-brand", { value: "#0057ff" })])
    const r = validateCode(bare, { code: `a { padding: 13px; font-size: 13px }`, framework: "react" })
    expect(r.findings).toEqual([])
    expect(r.limitations).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/No spacing token has a literal value/),
        expect.stringMatching(/No typography token has a literal value/)
      ])
    )
  })

  it("does not read spacing tokens as typography or the reverse", () => {
    const r = run(`.a { font-size: 8px; padding: 16px }`)
    expect(r.findings.map((f) => f.code)).toEqual(["typography-not-in-tokens", "spacing-matches-token"])
  })
})
