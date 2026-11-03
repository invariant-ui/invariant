import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { type Contract, evidenceFileSchema, parseContract, type Token } from "@invariant/contract"
import { DesignSystem } from "@invariant/contract-query"
import { describe, expect, it } from "vitest"
import {
  formatGithub,
  formatText,
  PLAN_RULES,
  type PolicyRule,
  RULES,
  scanMarkup,
  shouldFail,
  summarize,
  toJson,
  toSarif,
  type Violation,
  validateCode
} from "./index.js"

const golden = (file: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../../fixtures/contract-golden/acme-ui/${file}`, import.meta.url)),
    "utf8"
  )

function base(): { contract: Contract; ds: DesignSystem } {
  const parsed = parseContract(JSON.parse(golden("invariant.contract.json")))
  if (!parsed.ok) throw new Error("fixture invalid")
  const evidence = evidenceFileSchema.parse(JSON.parse(golden("invariant.evidence.json")))
  return { contract: parsed.value, ds: new DesignSystem(parsed.value, evidence) }
}

const policy = (
  id: string,
  rule: PolicyRule,
  over: { severity?: "error" | "warning" | "info"; enforcement?: "block" | "warn" | "report-only" } = {}
) => ({
  policy: {
    id: `policy:${id}` as never,
    name: `Policy ${id}`,
    statement: "s",
    severity: over.severity ?? "error",
    enforcement: over.enforcement ?? "block",
    scope: {},
    basedOn: [`constraint:${id}` as never],
    approval: { approvedBy: "Jane", approvedAt: "2026-01-01T00:00:00.000Z" }
  },
  constraint: {
    id: `constraint:${id}` as never,
    name: id,
    kind: "required-prop" as const,
    description: "d",
    subjects: ["component:button" as never],
    facts: {},
    extensions: { invariant: { rule: rule as never, source: "invariant.policies.json" } }
  }
})

function withPolicies(...ps: Array<ReturnType<typeof policy>>): DesignSystem {
  const { contract, ds } = base()
  void ds
  return new DesignSystem({
    ...contract,
    policies: ps.map((p) => p.policy),
    constraints: ps.map((p) => p.constraint)
  })
}

const token = (name: string, value: Token["value"], extra: Partial<Token> = {}): Token => ({
  id: `token:${name}` as never,
  name,
  category: "color",
  value,
  facts: {},
  ...extra
})
function withTokens(tokens: Token[]): DesignSystem {
  const { contract } = base()
  return new DesignSystem({ ...contract, tokens })
}

const run = (ds: DesignSystem, code: string, extra: Record<string, unknown> = {}) =>
  validateCode(ds, { code, framework: "react", filename: "src/App.tsx", ...extra })
const codes = (r: ReturnType<typeof run>) => r.findings.map((f) => `${f.line}:${f.code}`)

describe("imports decide what is a design-system component", () => {
  const ds = base().ds
  it("reports an unknown component imported from a design-system package, with candidates", () => {
    const r = run(ds, `import { Buttn } from "@acme/ui"\nexport const A = () => <Buttn />`)
    expect(r.findings).toMatchObject([
      {
        code: "component-unknown",
        severity: "error",
        line: 2,
        file: "src/App.tsx",
        suggestion: expect.stringContaining("Button")
      }
    ])
  })
  it("resolves aliases and namespace imports to the real component", () => {
    const aliased = run(
      ds,
      `import { Button as Btn } from "@acme/ui"\nconst a = <Btn variant="danger">x</Btn>`
    )
    expect(codes(aliased)).toEqual(["2:prop-value-not-allowed"])
    const ns = run(ds, `import * as DS from "@acme/ui"\nconst a = <DS.Button variant="danger">x</DS.Button>`)
    expect(codes(ns)).toEqual(["2:prop-value-not-allowed"])
  })
  it("never judges a tag imported from another package, even if the name matches", () => {
    const r = run(ds, `import { Button } from "@mui/material"\nconst a = <Button variant="danger" />`)
    expect(r.findings).toEqual([])
    expect(r.summary.componentsChecked).toEqual([])
  })
  it("does not call a tag unknown just because it has no import", () => {
    expect(run(ds, `const a = <Mystery />`).findings).toEqual([])
    expect(run(ds, `const a = <Mystery />`).summary.elementsNotInContract).toEqual(["Mystery"])
  })
  it("does not flag non-component imports from the design-system package", () => {
    expect(run(ds, `import { useTheme, ButtonProps } from "@acme/ui"\nconst a = <div />`).findings).toEqual(
      []
    )
  })
  it("handles subpath imports of the design-system package", () => {
    expect(codes(run(ds, `import { Buttn } from "@acme/ui/button"\nconst a = <Buttn />`))).toEqual([
      "2:component-unknown"
    ])
  })
})

describe("suggestions and locations", () => {
  const ds = base().ds
  it("every finding names a fix where one exists, with line and column", () => {
    const r = run(ds, `const a = (\n  <Button variant="primery" sise="sm" plain>x</Button>\n)`)
    const by = Object.fromEntries(r.findings.map((f) => [f.code, f]))
    expect(by["prop-value-not-allowed"]).toMatchObject({
      line: 2,
      column: 3,
      suggestion: expect.stringContaining('closest: "primary"'),
      subject: "component:button"
    })
    expect(by["unverifiable-prop"]?.severity).toBe("info")
    expect(by["prop-deprecated"]?.suggestion).toBeTruthy()
  })
  it("suggests close prop names when the API is complete", () => {
    const r = run(ds, `<Badge tonne="info" />`)
    expect(r.findings[0]).toMatchObject({ code: "unknown-prop", suggestion: 'Did you mean "tone"?' })
  })
  it("suggests the token whose value equals a literal color", () => {
    const tokens = withTokens([token("color-brand", { value: "#0057ff" })])
    const r = run(tokens, `const c = { color: "#0057ff" }`)
    expect(r.findings[0]).toMatchObject({
      code: "color-matches-token",
      suggestion: "Reference token:color-brand instead of the literal.",
      column: 21
    })
  })
})

describe("nesting in templates", () => {
  it("records the enclosing element for nested and sibling tags, closing tags and void elements", () => {
    const uses = scanMarkup(`<A>\n  <B>\n    <input>\n    <C/>\n  </B>\n  <D></D>\n</A>\n<E/>`)
    expect(uses.map((u) => [u.tag, u.parent === undefined ? null : uses[u.parent]?.tag, u.column])).toEqual([
      ["A", null, 1],
      ["B", "A", 3],
      ["input", "B", 5],
      ["C", "B", 5],
      ["D", "A", 3],
      ["E", null, 1]
    ])
  })
  it("survives unbalanced closing tags", () => {
    expect(() => scanMarkup("</x></y><a><b></c></a>")).not.toThrow()
  })
})

describe("approved policies", () => {
  it("require-attribute: accessibility category, with the children exemption and unknowns left alone", () => {
    const ds = withPolicies(
      policy("labels", {
        kind: "require-attribute",
        components: ["Button"],
        anyOf: ["aria-label", "aria-labelledby"],
        unlessChildren: true,
        category: "accessibility"
      })
    )
    const r = run(
      ds,
      `<Button icon={i} />\n<Button icon={i} aria-label="Close" />\n<Button icon={i}>Text</Button>\n<Button {...p} />`
    )
    const f = r.findings.filter((x) => x.code === "accessibility-requirement-missing")
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({
      line: 1,
      severity: "error",
      policy: "policy:labels",
      basis: "approved",
      source: "invariant.policies.json",
      suggestion: 'Add aria-label="...".'
    })
    expect(
      run(ds, `<Button icon={i}></Button>`).findings.some(
        (x) => x.code === "accessibility-requirement-missing"
      )
    ).toBe(true)
    const html = validateCode(ds, { code: `<Button icon="x">\n</Button>`, framework: "html" })
    expect(html.findings.some((x) => x.code === "accessibility-requirement-missing")).toBe(false)
  })
  it("forbid-prop, forbid-prop-value, forbid-component", () => {
    const ds = withPolicies(
      policy("no-plain", { kind: "forbid-prop", component: "Button", prop: "plain", replacedBy: "variant" }),
      policy("no-ghost", {
        kind: "forbid-prop-value",
        component: "Button",
        prop: "variant",
        values: ["ghost"]
      }),
      policy("no-icon", { kind: "forbid-component", component: "Icon", use: "Glyph" })
    )
    const r = run(ds, `<Button plain variant="ghost">x</Button>\n<Icon />`)
    expect(r.findings.map((f) => f.code).sort()).toEqual(
      [
        "component-forbidden",
        "prop-deprecated",
        "prop-forbidden",
        "prop-value-forbidden",
        "required-prop-missing"
      ].sort()
    )
    expect(r.findings.find((f) => f.code === "component-forbidden")?.suggestion).toBe("Use Glyph instead.")
    expect(r.findings.find((f) => f.code === "prop-forbidden")?.suggestion).toBe("Use variant instead.")
  })
  it("forbid-token: reports the policy even for a known token", () => {
    const ds = (() => {
      const { contract } = base()
      const p = policy("old-tokens", {
        kind: "forbid-token",
        tokens: ["--color-old"],
        replacedBy: "--color-new"
      })
      return new DesignSystem({
        ...contract,
        tokens: [token("color-old", { value: "#111111" }), token("color-new", { value: "#222222" })],
        policies: [p.policy],
        constraints: [p.constraint]
      })
    })()
    const r = run(ds, `const css = "color: var(--color-old)"`)
    expect(r.findings).toMatchObject([
      {
        code: "token-forbidden",
        severity: "error",
        policy: "policy:old-tokens",
        suggestion: "Use --color-new instead."
      }
    ])
  })
  it("allowed-children: layout vs composition codes; native and unknown children are ignored", () => {
    const layout = withPolicies(
      policy("card-kids", {
        kind: "allowed-children",
        container: "Card",
        children: ["Card.Header", "Card.Body"],
        category: "layout"
      })
    )
    const r = run(
      layout,
      `<Card>\n  <Card.Header />\n  <Button>x</Button>\n  <div />\n  <Mystery />\n</Card>`
    )
    expect(r.findings.filter((f) => f.code === "layout-pattern-invalid")).toHaveLength(1)
    expect(r.findings.find((f) => f.code === "layout-pattern-invalid")).toMatchObject({
      line: 3,
      policy: "policy:card-kids"
    })
    const comp = withPolicies(
      policy("card-kids", { kind: "allowed-children", container: "Card", children: ["Card.Body"] })
    )
    expect(run(comp, `<Card><Button>x</Button></Card>`).findings.map((f) => f.code)).toContain(
      "composition-not-allowed"
    )
  })
  it("required-parent: only flags a design-system child inside other design-system components", () => {
    const ds = withPolicies(
      policy("header-in-card", { kind: "required-parent", component: "Card.Header", parents: ["Card"] })
    )
    expect(
      run(ds, `const a = <Card.Header />`).findings.filter((f) => f.code === "composition-not-allowed")
    ).toEqual([])
    expect(
      run(ds, `const a = <Card><Card.Header /></Card>`).findings.filter(
        (f) => f.code === "composition-not-allowed"
      )
    ).toEqual([])
    expect(
      run(ds, `const a = <Modal open><Card.Header /></Modal>`).findings.filter(
        (f) => f.code === "composition-not-allowed"
      )
    ).toHaveLength(1)
    expect(
      run(ds, `const a = <div><Card.Header /></div>`).findings.filter(
        (f) => f.code === "composition-not-allowed"
      )
    ).toEqual([])
  })
  it("enforcement lowers severity: warn caps at warning, report-only is info", () => {
    const rule: PolicyRule = { kind: "forbid-prop", component: "Button", prop: "plain" }
    expect(
      run(withPolicies(policy("p", rule, { enforcement: "warn" })), `<Button plain>x</Button>`).findings.find(
        (f) => f.code === "prop-forbidden"
      )?.severity
    ).toBe("warning")
    expect(
      run(
        withPolicies(policy("p", rule, { enforcement: "report-only" })),
        `<Button plain>x</Button>`
      ).findings.find((f) => f.code === "prop-forbidden")?.severity
    ).toBe("info")
    expect(
      run(withPolicies(policy("p", rule, { severity: "info" })), `<Button plain>x</Button>`).findings.find(
        (f) => f.code === "prop-forbidden"
      )?.severity
    ).toBe("info")
  })
  it("a policy with an unreadable rule is reported as not enforced", () => {
    const bad = policy("broken", { kind: "forbid-prop", component: "Button", prop: "x" })
    ;(bad.constraint.extensions.invariant as { rule: unknown }).rule = { kind: "nonsense" }
    const r = run(withPolicies(bad), `<Button>x</Button>`)
    expect(r.limitations.join(" ")).toMatch(/Not enforced: policy policy:broken/)
  })
  it("the contract's own requires-parent relationships are enforced, inferred ones are not", () => {
    const { contract } = base()
    const comps = contract.components.map((c) =>
      c.id === "component:card.header"
        ? {
            ...c,
            composition: [{ type: "requires-parent" as const, target: "component:card" as never }],
            facts: {
              ...c.facts,
              "composition.0": { status: "discovered" as const, evidenceIds: ["ev_000000000000000000000000"] }
            }
          }
        : c
    )
    const ds = new DesignSystem({ ...contract, components: comps })
    expect(run(ds, `<Modal open><Card.Header /></Modal>`).findings.map((f) => f.code)).toContain(
      "composition-parent-required"
    )
    const inferred = new DesignSystem({
      ...contract,
      components: comps.map((c) =>
        c.id === "component:card.header"
          ? {
              ...c,
              facts: {
                ...c.facts,
                "composition.0": {
                  status: "inferred" as const,
                  evidenceIds: ["ev_000000000000000000000000"],
                  confidence: 0.5,
                  derivation: { rule: "r", reasoning: "r", inputs: [] }
                }
              }
            }
          : c
      )
    })
    expect(run(inferred, `<Modal open><Card.Header /></Modal>`).findings.map((f) => f.code)).not.toContain(
      "composition-parent-required"
    )
  })
})

describe("noise control", () => {
  it("says each helper finding once per file, at its first use", () => {
    const ds = base().ds
    const r = run(ds, `<button>a</button>\n<button>b</button>\n<Badge wobble="1" />\n<Badge wobble="2" />`)
    expect(r.findings.filter((f) => f.code === "native-element-has-equivalent").map((f) => f.line)).toEqual([
      1
    ])
  })

  it("uses the import to choose between components that share an export name", () => {
    const { contract } = base()
    const badge = contract.components.find(
      (c) => c.id === "component:badge"
    ) as Contract["components"][number]
    const twin = (id: string, pkg: string): Contract["components"][number] => ({
      ...badge,
      id: id as never,
      name: id.slice(10),
      implementations: badge.implementations.map((i) => ({
        ...i,
        exportName: "Chip",
        packageName: pkg,
        importPath: pkg
      }))
    })
    const ds = new DesignSystem({
      ...contract,
      components: [...contract.components, twin("component:chipa", "@a/ui"), twin("component:chipb", "@b/ui")]
    })
    const ambiguous = run(ds, `const x = <Chip tone="info" />`)
    expect(ambiguous.findings.map((f) => f.code)).toEqual(["component-ambiguous"])
    const picked = run(ds, `import { Chip } from "@b/ui"\nconst x = <Chip tone="loud" />`)
    expect(picked.summary.componentsChecked).toEqual(["component:chipb"])
    expect(picked.findings.map((f) => f.code)).toEqual(["prop-value-not-allowed"])
  })
})

describe("false-positive control", () => {
  it("does not call standard HTML attributes unknown props, even when the API listing is complete", () => {
    const ds = base().ds
    const r = run(
      ds,
      `<Badge tone="info" placeholder="x" href="/a" alt="b" disabled />\n<Badge wobble="1" />`
    )
    expect(r.findings.map((f) => `${f.line}:${f.code}`)).toEqual(["2:unknown-prop"])
  })
  it("does not call a CSS variable unknown when the same file declares it", () => {
    const ds = withTokens([token("color-brand", { value: "#0057ff" })])
    const r = run(ds, `const css = ".a { --bleed: 4px; margin: var(--bleed); color: var(--nope); }"`)
    expect(r.findings.map((f) => f.code)).toEqual(["unknown-css-variable"])
    expect(r.findings[0]?.message).toContain("--nope")
  })
})

describe("deprecated tokens", () => {
  it("warns and points at the replacement", () => {
    const ds = withTokens([
      token(
        "color-old",
        { value: "#111111" },
        { deprecated: { reason: "retired", replacedBy: "token:color-new" as never } }
      ),
      token("color-new", { value: "#222222" })
    ])
    expect(run(ds, `x = "var(--color-old)"`).findings).toMatchObject([
      { code: "token-deprecated", severity: "warning", suggestion: "Use --color-new." }
    ])
  })
})

describe("severity overrides", () => {
  const ds = base().ds
  it("can raise, lower and turn off rules", () => {
    const code = `<Button variant="danger" plain>x</Button>`
    const r = run(ds, code, {})
    expect(r.findings.map((f) => [f.code, f.severity])).toContainEqual(["prop-value-not-allowed", "error"])
    const changed = validateCode(
      ds,
      { code, framework: "react" },
      {
        rules: { "prop-value-not-allowed": "warning", "prop-deprecated": "off", "unverifiable-prop": "error" }
      }
    )
    expect(changed.findings.map((f) => [f.code, f.severity])).toEqual([["prop-value-not-allowed", "warning"]])
    expect(changed.valid).toBe(true)
  })
})

describe("rule catalog", () => {
  it("covers all eleven plan rules", () => {
    for (const p of PLAN_RULES)
      expect(
        RULES.some((r) => r.plan === p),
        p
      ).toBe(true)
    expect(new Set(RULES.map((r) => r.code)).size).toBe(RULES.length)
  })
  it("lists every code the validators can emit", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url))
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    const emitted = new Set<string>()
    for (const f of sources)
      for (const m of readFileSync(path.join(dir, f), "utf8").matchAll(
        /code: (?:"([a-z-]+)"|[^"\n]*\? "([a-z-]+)" : "([a-z-]+)")/g
      ))
        for (const g of [m[1], m[2], m[3]]) if (g) emitted.add(g)
    const known = new Set(RULES.map((r) => r.code))
    for (const code of emitted) expect(known.has(code), `${code} is not in the rule catalog`).toBe(true)
    expect(emitted.size).toBeGreaterThan(15)
  })
})

describe("reporters", () => {
  const v = (over: Partial<Violation> = {}): Violation => ({
    code: "prop-value-not-allowed",
    severity: "error",
    message: "Button.variant is 'x'",
    file: "src/App.tsx",
    line: 4,
    column: 9,
    basis: "discovered",
    source: "src/Button.tsx:28",
    subject: "component:button",
    suggestion: "Use one of a, b",
    ...over
  })
  const violations = [
    v({ file: "src/B.tsx", line: 1 }),
    v(),
    v({ severity: "warning", code: "unknown-prop", line: 2 }),
    v({ severity: "info", code: "color-matches-token", line: 3 })
  ]
  const summary = summarize(violations, 3, 2)

  it("summarizes and decides failure by threshold", () => {
    expect(summary).toEqual({ files: 3, errors: 2, warnings: 1, info: 1, componentsChecked: 2 })
    expect(shouldFail(summary, "error")).toBe(true)
    expect(shouldFail({ ...summary, errors: 0 }, "error")).toBe(false)
    expect(shouldFail({ ...summary, errors: 0 }, "warning")).toBe(true)
    expect(shouldFail(summary, "never")).toBe(false)
  })

  it("text: sorted by file and line, with fix, evidence and policy lines", () => {
    const text = formatText([v({ policy: "policy:p" }), v({ file: "src/A.tsx", line: 9 })], summary)
    expect(text.indexOf("src/A.tsx:9")).toBeLessThan(text.indexOf("src/App.tsx:4"))
    expect(text).toContain("fix: Use one of a, b")
    expect(text).toContain(
      "evidence src/Button.tsx:28 (discovered); policy policy:p; subject component:button"
    )
    expect(text.trim().split("\n").at(-1)).toBe(
      "2 errors, 1 warnings, 1 info in 3 files (2 components checked)"
    )
  })

  it("json is stable and carries the contract hash", () => {
    expect(JSON.stringify(toJson(violations, summary, "h"))).toBe(
      JSON.stringify(toJson([...violations].reverse(), summary, "h"))
    )
  })

  it("github: workflow commands with escaped data and properties", () => {
    const out = formatGithub([v({ message: "50% off\nnext", file: "a,b:c.tsx" })])
    expect(out).toBe(
      "::error file=a%2Cb%3Ac.tsx,line=4,col=9,title=prop-value-not-allowed::50%25 off%0Anext. Fix: Use one of a, b"
    )
    expect(formatGithub([v({ severity: "info" })]).startsWith("::notice ")).toBe(true)
  })

  it("sarif 2.1.0: rules used, levels mapped, locations with one-based regions", () => {
    const sarif = toSarif(violations, { name: "invariant", version: "0.0.0" }) as {
      version: string
      runs: Array<{
        tool: { driver: { rules: Array<{ id: string }> } }
        results: Array<{
          level: string
          ruleId: string
          locations: Array<{ physicalLocation: { region: { startLine: number } } }>
        }>
      }>
    }
    expect(sarif.version).toBe("2.1.0")
    const run0 = sarif.runs[0]
    expect(run0?.tool.driver.rules.map((r) => r.id).sort()).toEqual([
      "color-matches-token",
      "prop-value-not-allowed",
      "unknown-prop"
    ])
    expect(run0?.results.map((r) => r.level).sort()).toEqual(["error", "error", "note", "warning"])
    expect(run0?.results.every((r) => r.locations[0]?.physicalLocation.region.startLine !== undefined)).toBe(
      true
    )
  })
})
