import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import {
  type ContractDraft,
  createEvidenceFile,
  evidenceFileSchema,
  finalizeContract,
  parseContract,
  verifyContract
} from "@invariant/contract"
import { sha256Hex } from "@invariant/shared"
import { describe, expect, it } from "vitest"
import { compilePatterns, type PatternDefinition, parsePatterns, patternsFileJsonSchema } from "./index.js"

const golden = (file: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../../fixtures/contract-golden/acme-ui/${file}`, import.meta.url)),
    "utf8"
  )
const baseEvidence = evidenceFileSchema.parse(JSON.parse(golden("invariant.evidence.json"))).evidence

function draft(): ContractDraft {
  const parsed = parseContract(JSON.parse(golden("invariant.contract.json")))
  if (!parsed.ok) throw new Error("fixture invalid")
  const { integrity: _i, ...rest } = parsed.value
  return {
    ...rest,
    tokens: [
      {
        id: "token:breakpoint.md",
        name: "breakpoint.md",
        category: "breakpoint",
        value: { value: "768px" },
        facts: {}
      },
      {
        id: "token:spacing.md",
        name: "spacing.md",
        category: "spacing",
        value: { value: "16px" },
        facts: {}
      }
    ]
  }
}

const FILE = "invariant.patterns.json"
const clock = (): string => "2026-11-03T09:00:00.000Z"
const approval = { approvedBy: "owners", approvedAt: "2026-11-03T10:00:00.000Z", reference: "DS-1" }

const pattern = (id: string, extra: Partial<PatternDefinition> = {}): PatternDefinition => ({
  id,
  name: id,
  category: "composition",
  description: `The ${id} pattern.`,
  ...extra
})

function compile(defs: PatternDefinition[], base: ContractDraft = draft()) {
  const file = { version: 1 as const, patterns: defs }
  const text = JSON.stringify(file)
  const result = compilePatterns(base, file, { file: FILE, text, clock })
  const errors = (): string[] => {
    const c = finalizeContract(result.contract)
    return verifyContract(
      c,
      createEvidenceFile(c.integrity.contentHash, [...baseEvidence, ...result.evidence])
    )
      .filter((x) => x.severity === "error")
      .map((x) => `${x.code}: ${x.message}`)
  }
  return { ...result, text, errors, codes: result.diagnostics.map((d) => d.code) }
}
const added = (r: ReturnType<typeof compile>, id: string) => r.contract.patterns.find((p) => p.id === id)

describe("parsePatterns", () => {
  const valid = JSON.stringify({ version: 1, patterns: [pattern("page.x")] })

  it("accepts a valid file", () => {
    expect(parsePatterns(valid)).toMatchObject({ ok: true })
  })

  it("explains where a file is wrong", () => {
    const wrong = (value: unknown) => parsePatterns(JSON.stringify(value))
    expect(parsePatterns("{ nope")).toMatchObject({
      ok: false,
      message: expect.stringMatching(/not valid JSON/)
    })
    expect(wrong({ version: 2, patterns: [] })).toMatchObject({
      message: expect.stringMatching(/invalid at version/)
    })
    expect(wrong({ version: 1, patterns: [{ ...pattern("page.x"), category: "dashboard" }] })).toMatchObject({
      message: expect.stringMatching(/invalid at patterns\.0\.category/)
    })
    expect(wrong({ version: 1, patterns: [{ ...pattern("Page X") }] })).toMatchObject({
      message: expect.stringMatching(/patterns\.0\.id/)
    })
    expect(wrong({ version: 1, patterns: [{ ...pattern("page.x"), surprise: 1 }] }).ok).toBe(false)
    expect(
      wrong({
        version: 1,
        patterns: [pattern("page.x", { relationships: [{ id: "has.dot", type: "uses", target: "Button" }] })]
      }).ok
    ).toBe(false)
    expect(
      wrong({
        version: 1,
        patterns: [
          pattern("page.x", {
            constraints: [{ id: "c", kind: "legacy" as never, description: "d", details: {} }]
          })
        ]
      }).ok
    ).toBe(false)
  })

  it("names the file in its messages", () => {
    expect(parsePatterns("{", "design/patterns.json")).toMatchObject({
      message: expect.stringMatching(/^design\/patterns\.json is not valid JSON/)
    })
  })

  it("has a JSON Schema for editors", () => {
    const schema = patternsFileJsonSchema() as { title: string; properties: Record<string, unknown> }
    expect(schema.title).toMatch(/pattern definitions/)
    expect(Object.keys(schema.properties)).toEqual(["$schema", "version", "patterns"])
  })
})

describe("compilePatterns: what is added", () => {
  it("adds a pattern with documented facts, manual evidence and a source", () => {
    const r = compile([
      pattern("composition.card", {
        intent: "Group content.",
        composition: { parts: [{ name: "card", ref: "Card", role: "required" }] }
      })
    ])
    const p = added(r, "pattern:composition.card")
    expect(p).toMatchObject({
      category: "composition",
      intent: "Group content.",
      components: ["component:card"]
    })
    expect(Object.keys(p?.facts ?? {}).sort()).toEqual(["composition", "description", "intent"])
    expect(Object.values(p?.facts ?? {}).every((f) => f.status === "documented")).toBe(true)
    expect(r.evidence).toHaveLength(1)
    expect(r.evidence[0]).toMatchObject({
      sourceId: "patterns",
      method: "manual",
      location: { type: "file", path: FILE },
      sourceRef: `${FILE}#composition.card`,
      verificationStatus: "unverified",
      capturedAt: clock()
    })
    expect(r.summary).toEqual({ added: 1, skipped: 0, constraints: 0, policies: 0, awaitingApproval: 1 })
    expect(r.contract.sources.find((s) => s.id === "patterns")).toMatchObject({
      type: "patterns",
      location: FILE,
      version: { kind: "content-hash", value: sha256Hex(r.text) },
      health: { status: "ok", diagnosticCount: 0 }
    })
    expect(r.errors()).toEqual([])
  })

  it("omits optional sections it was not given, instead of writing empty ones", () => {
    const p = added(compile([pattern("composition.bare")]), "pattern:composition.bare")
    for (const key of [
      "intent",
      "composition",
      "layout",
      "behavior",
      "accessibility",
      "relationships",
      "constraints"
    ])
      expect(p).not.toHaveProperty(key)
    expect(p?.components).toEqual([])
  })

  it("does not change what was already in the contract, and sorts what it adds", () => {
    const base = draft()
    const before = JSON.stringify(base)
    const r = compile([pattern("page.z"), pattern("composition.a")], base)
    expect(JSON.stringify(base)).toBe(before)
    expect(r.contract.patterns.map((p) => p.id)).toEqual(["pattern:composition.a", "pattern:page.z"])
    expect(r.contract.components).toEqual(base.components)
  })

  it("produces the same result every time", () => {
    const defs = [
      pattern("composition.card", {
        composition: { parts: [{ name: "card", ref: "Card", role: "required" }] }
      })
    ]
    expect(JSON.stringify(compile(defs).contract)).toBe(JSON.stringify(compile(defs).contract))
    expect(compile(defs).evidence).toEqual(compile(defs).evidence)
  })

  it("adds nothing, and no source, for an empty file", () => {
    const r = compile([])
    expect(r.contract.sources.some((s) => s.id === "patterns")).toBe(false)
    expect(r.summary.added).toBe(0)
  })
})

describe("compilePatterns: approval", () => {
  const withApproval = pattern("composition.card", {
    intent: "Group content.",
    composition: { parts: [{ name: "card", ref: "Card", role: "required" }] },
    approval
  })

  it("makes every fact approved over documented, with a fingerprint that verifies", () => {
    const r = compile([withApproval])
    const facts = Object.values(added(r, "pattern:composition.card")?.facts ?? {})
    expect(facts.every((f) => f.status === "approved")).toBe(true)
    expect(facts[0]).toMatchObject({
      approval: { approvedBy: "owners", reference: "DS-1", priorStatus: "documented" }
    })
    expect(r.summary.awaitingApproval).toBe(0)
    expect(r.errors()).toEqual([])
  })

  it("is stale, not silently kept, once the approved value changes", () => {
    const r = compile([withApproval])
    const changed = JSON.parse(JSON.stringify(r.contract)) as ContractDraft
    const p = changed.patterns.find((x) => x.id === "pattern:composition.card")
    if (p) p.intent = "Something else."
    const c = finalizeContract(changed)
    const codes = verifyContract(
      c,
      createEvidenceFile(c.integrity.contentHash, [...baseEvidence, ...r.evidence])
    ).map((d) => d.code)
    expect(codes).toContain("contract.approval-stale")
  })

  it("never approves anything without an approval block", () => {
    const r = compile([pattern("composition.card", { intent: "x" })])
    expect(JSON.stringify(r.contract.patterns)).not.toContain('"approved"')
  })
})

describe("compilePatterns: constraints and policies", () => {
  const constraint = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    kind: "required-child" as const,
    description: `Rule ${id}.`,
    details: { parent: "Modal", child: "Button" },
    ...extra
  })

  it("turns constraints into entities with resolved details and facts", () => {
    const r = compile([pattern("composition.dialog", { constraints: [constraint("needs-confirm")] })])
    expect(
      r.contract.constraints.find((c) => c.id === "constraint:composition.dialog.needs-confirm")
    ).toMatchObject({
      kind: "required-child",
      subjects: ["pattern:composition.dialog"],
      details: { parent: "component:modal", child: "component:button" }
    })
    expect(added(r, "pattern:composition.dialog")?.constraints).toEqual([
      "constraint:composition.dialog.needs-confirm"
    ])
    expect(r.summary.constraints).toBe(1)
    expect(r.errors()).toEqual([])
  })

  it("creates a policy only when the pattern is approved and the constraint asks to be enforced", () => {
    const enforce = { severity: "error" as const, enforcement: "block" as const }
    const approved = compile([
      pattern("composition.dialog", {
        approval,
        appliesTo: { paths: ["src/**"], frameworks: ["react"] },
        constraints: [constraint("needs-confirm", { enforce }), constraint("plain")]
      })
    ])
    expect(approved.contract.policies.map((p) => p.id)).toEqual(["policy:composition.dialog.needs-confirm"])
    expect(approved.contract.policies[0]).toMatchObject({
      severity: "error",
      enforcement: "block",
      scope: { entities: ["pattern:composition.dialog"], frameworks: ["react"], paths: ["src/**"] },
      basedOn: ["constraint:composition.dialog.needs-confirm"]
    })
    expect(approved.summary.policies).toBe(1)
    expect(approved.errors()).toEqual([])

    const unapproved = compile([
      pattern("composition.dialog", { constraints: [constraint("needs-confirm", { enforce })] })
    ])
    expect(unapproved.contract.policies).toEqual([])
    expect(unapproved.codes).toContain("governance.pattern-policy-needs-approval")
    expect(
      unapproved.diagnostics.find((d) => d.code === "governance.pattern-policy-needs-approval")?.severity
    ).toBe("warning")
    expect(unapproved.summary.added).toBe(1)
  })

  it("defaults enforcement to block when only severity is given", () => {
    const r = compile([
      pattern("composition.dialog", {
        approval,
        constraints: [constraint("c", { enforce: { severity: "warning" } })]
      })
    ])
    expect(r.contract.policies[0]).toMatchObject({ severity: "warning", enforcement: "block" })
  })

  it("rejects details that do not fit the kind, and regions the pattern does not define", () => {
    const bad = (
      details: Record<string, unknown>,
      kind: "cardinality" | "required-region" | "ordering" = "cardinality"
    ) => compile([pattern("composition.dialog", { constraints: [constraint("c", { kind, details })] })])
    expect(bad({ target: "Button" }).codes).toContain("governance.pattern-constraint-invalid")
    expect(bad({ target: "Button", min: 3, max: 1 }).codes).toContain("governance.pattern-constraint-invalid")
    expect(bad({ target: "Button", min: 1, extra: true }).codes).toContain(
      "governance.pattern-constraint-invalid"
    )
    expect(bad({ before: "Button" }, "ordering").codes).toContain("governance.pattern-constraint-invalid")
    const region = bad({ region: "region:footer" }, "required-region")
    expect(region.codes).toContain("governance.pattern-unknown-region")
    expect(region.diagnostics.find((d) => d.code === "governance.pattern-unknown-region")?.message).toMatch(
      /defines no layout/
    )
    expect(bad({ region: "footer" }, "required-region").codes).toContain(
      "governance.pattern-constraint-invalid"
    )
  })

  it("accepts a region the pattern defines", () => {
    const r = compile([
      pattern("page.x", {
        layout: { regions: [{ name: "content", required: true }] },
        constraints: [constraint("c", { kind: "required-region", details: { region: "region:content" } })]
      })
    ])
    expect(r.summary.added).toBe(1)
    expect(r.errors()).toEqual([])
  })

  it("refuses a constraint or policy id that already exists", () => {
    const base = draft()
    base.constraints = [
      ...base.constraints,
      {
        id: "constraint:composition.dialog.c",
        name: "x",
        kind: "required-prop",
        description: "x",
        subjects: ["component:button"],
        facts: {}
      }
    ]
    const r = compile([pattern("composition.dialog", { constraints: [constraint("c")] })], base)
    expect(r.codes).toContain("governance.pattern-id-taken")
    expect(r.summary).toMatchObject({ added: 0, skipped: 1 })
  })
})

describe("compilePatterns: resolving references", () => {
  const part = (ref: string) => ({ composition: { parts: [{ name: "p", ref, role: "required" as const }] } })
  const resolved = (ref: string): string | undefined =>
    added(compile([pattern("composition.x", part(ref))]), "pattern:composition.x")?.composition?.parts[0]?.ref

  it("resolves an id, a name, and a name with different case or separators", () => {
    for (const ref of ["component:iconbutton", "iconbutton", "Icon Button", "ICON_BUTTON"])
      expect(resolved(ref), ref).toBe("component:iconbutton")
    expect(resolved("Card")).toBe("component:card")
    expect(resolved("component:card.header")).toBe("component:card.header")
  })

  it("suggests the nearest name for a misspelling, and does not guess for a prefixed id", () => {
    const typo = compile([pattern("composition.x", part("Buton"))])
    expect(typo.diagnostics.find((d) => d.code === "governance.pattern-unknown-component")?.message).toMatch(
      /did you mean Button\?/
    )
    const prefixed = compile([pattern("composition.x", part("component:buton"))])
    expect(prefixed.codes).toContain("governance.pattern-unknown-component")
    expect(prefixed.summary.added).toBe(0)
  })

  it("resolves a pattern by id, by id without prefix, by the part after the category, and by name, including one defined later in the file", () => {
    const r = compile([
      pattern("page.x", {
        relationships: [
          { id: "a", type: "composes", target: "pattern:composition.card" },
          { id: "b", type: "requires", target: "composition.card" },
          { id: "c", type: "extends", target: "card" },
          { id: "d", type: "alternative-to", target: "Card Pattern" }
        ]
      }),
      pattern("composition.card", { name: "Card Pattern" })
    ])
    expect(added(r, "pattern:page.x")?.relationships?.map((x) => x.target)).toEqual(
      Array(4).fill("pattern:composition.card")
    )
    expect(r.errors()).toEqual([])
  })

  it("prefers a component named Card over a pattern whose short id is card, unless the position takes only patterns", () => {
    const r = compile([
      pattern("page.x", { relationships: [{ id: "u", type: "uses", target: "card" }] }),
      pattern("composition.card", { name: "Card Pattern" })
    ])
    expect(added(r, "pattern:page.x")?.relationships?.[0]?.target).toBe("component:card")
  })

  it("resolves against patterns already in the contract", () => {
    const base = draft()
    const first = compile([pattern("layout.shell")], base)
    const second = compile(
      [pattern("page.x", { relationships: [{ id: "r", type: "composes", target: "shell" }] })],
      first.contract
    )
    expect(added(second, "pattern:page.x")?.relationships?.[0]?.target).toBe("pattern:layout.shell")
  })

  it("lets a relationship that is not `contains` or `uses` target only a pattern", () => {
    const r = compile([
      pattern("page.x", { relationships: [{ id: "r", type: "extends", target: "Button" }] })
    ])
    expect(r.codes).toContain("governance.pattern-unknown-pattern")
    const ok = compile([pattern("page.x", { relationships: [{ id: "r", type: "uses", target: "Button" }] })])
    expect(added(ok, "pattern:page.x")?.relationships?.[0]?.target).toBe("component:button")
  })

  it("reports a name that means both a component and a pattern, and asks for the id", () => {
    const r = compile([pattern("layout.button", { name: "Button" }), pattern("page.x", part("Button"))])
    const ambiguous = r.diagnostics.find((d) => d.code === "governance.pattern-ambiguous-reference")
    expect(ambiguous?.message).toMatch(
      /both a component \(component:button\) and a pattern \(pattern:layout\.button\)/
    )
    expect(r.contract.patterns.map((p) => p.id)).toEqual(["pattern:layout.button"])
    const exact = compile([
      pattern("layout.button", { name: "Button" }),
      pattern("page.x", part("pattern:layout.button"))
    ])
    expect(exact.summary.added).toBe(2)
  })

  it("resolves tokens for spacing, grid gaps and breakpoints", () => {
    const r = compile([
      pattern("page.x", {
        layout: {
          regions: [
            {
              name: "content",
              required: true,
              spacing: "spacing.md",
              grid: { columns: 2, gap: "token:spacing.md" },
              responsive: [{ breakpoint: "breakpoint.md", behavior: "stack" }]
            }
          ]
        }
      })
    ])
    const region = added(r, "pattern:page.x")?.layout?.regions[0]
    expect(region).toMatchObject({
      spacing: "token:spacing.md",
      grid: { columns: 2, gap: "token:spacing.md" },
      responsive: [{ breakpoint: "token:breakpoint.md", behavior: "stack" }]
    })
    expect(r.errors()).toEqual([])
    const bad = compile([
      pattern("page.y", { layout: { regions: [{ name: "c", required: true, spacing: "spacing.huge" }] } })
    ])
    expect(bad.codes).toContain("governance.pattern-unknown-token")
  })

  it("resolves guidelines and reports an unknown one", () => {
    const known = draft().guidelines[0]
    if (!known) throw new Error("fixture has no guideline")
    expect(
      added(compile([pattern("composition.x", { guidelines: [known.id] })]), "pattern:composition.x")
        ?.guidelines
    ).toEqual([known.id])
    expect(compile([pattern("composition.x", { guidelines: ["nope"] })]).codes).toContain(
      "governance.pattern-unknown-guideline"
    )
  })

  it("leaves out a pattern with any bad reference whole, reports every problem, and keeps the good ones", () => {
    const r = compile([
      pattern("page.bad", {
        composition: {
          parts: [
            { name: "a", ref: "Nope", role: "required" },
            { name: "b", ref: "Nada", role: "required" }
          ]
        }
      }),
      pattern("composition.good")
    ])
    expect(r.contract.patterns.map((p) => p.id)).toEqual(["pattern:composition.good"])
    expect(r.codes.filter((c) => c === "governance.pattern-unknown-component")).toHaveLength(2)
    expect(r.diagnostics.find((d) => d.code === "governance.pattern-skipped")?.message).toMatch(
      /because of the 2 problem/
    )
    expect(r.diagnostics.every((d) => d.severity !== "error" || d.location?.path === FILE)).toBe(true)
    expect(r.summary).toMatchObject({ added: 1, skipped: 1 })
    expect(r.contract.sources.find((s) => s.id === "patterns")?.health).toMatchObject({ status: "degraded" })
    expect(r.errors()).toEqual([])
  })
})

describe("compilePatterns: identity", () => {
  it("reports a duplicate id in the file and uses the first", () => {
    const r = compile([
      pattern("page.x", { description: "first" }),
      pattern("page.x", { description: "second" })
    ])
    expect(r.codes).toContain("governance.pattern-duplicate-id")
    expect(added(r, "pattern:page.x")?.description).toBe("first")
    expect(r.summary).toMatchObject({ added: 1, skipped: 1 })
  })

  it("accepts an id with or without the prefix, and refuses one a source already defined", () => {
    expect(compile([pattern("pattern:page.x")]).summary.added).toBe(1)
    const base = draft()
    const first = compile([pattern("page.x")], base)
    const again = compile([pattern("page.x")], first.contract)
    expect(again.codes).toContain("governance.pattern-id-taken")
    expect(again.summary).toMatchObject({ added: 0, skipped: 1 })
  })

  it("lets the contract's own verification catch what compiling does not: a cycle", () => {
    const r = compile([
      pattern("page.a", { relationships: [{ id: "r", type: "composes", target: "page.b" }] }),
      pattern("page.b", { relationships: [{ id: "r", type: "composes", target: "page.a" }] })
    ])
    expect(r.summary.added).toBe(2)
    expect(r.errors().some((e) => e.startsWith("contract.pattern-cycle"))).toBe(true)
  })
})

describe("the JSON Schema for definition files", () => {
  const schemaFile = fileURLToPath(new URL("../schema/patterns-file-v1.schema.json", import.meta.url))
  const fixture = (rel: string): unknown =>
    JSON.parse(
      readFileSync(
        fileURLToPath(new URL(`../../../fixtures/pattern-definitions/${rel}`, import.meta.url)),
        "utf8"
      )
    )
  type Ajv = { compile(schema: object): ((data: unknown) => boolean) & { errors?: unknown } }
  const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as new (options: object) => Ajv

  it("matches the committed file", () => {
    const expected = `${JSON.stringify(patternsFileJsonSchema(), null, 2)}\n`
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(schemaFile)) writeFileSync(schemaFile, expected)
    expect(readFileSync(schemaFile, "utf8")).toBe(expected)
  })

  it("accepts the sample definitions and rejects a broken file", () => {
    const validate = new Ajv2020({ strict: false }).compile(patternsFileJsonSchema())
    expect(validate(fixture("invariant.patterns.json")), JSON.stringify(validate.errors)).toBe(true)
    expect(
      validate({ version: 1, patterns: [{ id: "Bad Id", name: "x", category: "page", description: "d" }] })
    ).toBe(false)
    expect(validate({ version: 2, patterns: [] })).toBe(false)
  })

  it("lets a file point at the schema with $schema", () => {
    expect(
      parsePatterns(
        JSON.stringify({ $schema: "./schema/patterns-file-v1.schema.json", version: 1, patterns: [] })
      ).ok
    ).toBe(true)
  })
})

describe("compilePatterns: required-state constraints", () => {
  const state = (details: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    pattern("composition.form", {
      constraints: [
        { id: "s", kind: "required-state", description: "A form shows it is submitting.", details, ...extra }
      ]
    } as never)

  it("keeps the workflow and state as written, and resolves nothing", () => {
    const r = compile([
      state({ workflow: "form-submission", state: "submitting", minimum: "static-inferred" })
    ])
    expect(r.contract.constraints.find((c) => c.id === "constraint:composition.form.s")?.details).toEqual({
      workflow: "form-submission",
      state: "submitting",
      minimum: "static-inferred"
    })
    expect(r.errors()).toEqual([])
  })

  it("rejects a state the workflow does not have, and leaves the pattern out", () => {
    const r = compile([state({ workflow: "form-submission", state: "loading" })])
    expect(r.codes).toContain("governance.pattern-constraint-invalid")
    expect(r.diagnostics.find((d) => d.code === "governance.pattern-constraint-invalid")?.message).toMatch(
      /state is not one of the workflow's states/
    )
    expect(r.summary).toMatchObject({ added: 0, skipped: 1 })
  })

  it("makes an enforceable policy only for an approved pattern", () => {
    const enforce = { severity: "error" as const, enforcement: "block" as const }
    const approved = compile([
      { ...state({ workflow: "search-results", state: "empty" }, { enforce }), approval } as never
    ])
    expect(approved.contract.policies.map((p) => p.id)).toEqual(["policy:composition.form.s"])
    expect(compile([state({ workflow: "search-results", state: "empty" }, { enforce })]).codes).toContain(
      "governance.pattern-policy-needs-approval"
    )
  })
})

describe("compilePatterns: variations", () => {
  const base = pattern("page.x", {
    composition: {
      parts: [
        { name: "header", ref: "Card", role: "required" },
        { name: "actions", ref: "Button", role: "optional" }
      ]
    },
    variations: [
      {
        name: "read-only",
        description: "Read only",
        when: "The person cannot change it.",
        roles: [{ part: "actions", role: "prohibited" }],
        parts: [{ name: "banner", ref: "Badge", role: "optional" }]
      }
    ]
  } as never)

  it("resolves the references of a variation's added parts and keeps its role changes", () => {
    const r = compile([base])
    const p = added(r, "pattern:page.x")
    expect(p?.variations).toEqual([
      {
        name: "read-only",
        description: "Read only",
        when: "The person cannot change it.",
        roles: [{ part: "actions", role: "prohibited" }],
        parts: [{ name: "banner", ref: "component:badge", role: "optional" }]
      }
    ])
    expect(p?.components).toEqual(["component:badge", "component:button", "component:card"])
    expect(r.errors()).toEqual([])
  })

  it("gives each variation a fact of its own, so it can be approved separately", () => {
    const p = added(compile([base]), "pattern:page.x")
    expect(Object.keys(p?.facts ?? {}).sort()).toEqual(["composition", "description", "variations.read-only"])
    expect(p?.facts["variations.read-only"]?.status).toBe("documented")
    const approved = added(compile([{ ...base, approval } as never]), "pattern:page.x")
    expect(approved?.facts["variations.read-only"]).toMatchObject({
      status: "approved",
      approval: { priorStatus: "documented" }
    })
  })

  it("reports an unknown reference inside a variation, and leaves the pattern out", () => {
    const bad = pattern("page.y", {
      composition: { parts: [{ name: "header", ref: "Card", role: "required" }] },
      variations: [{ name: "v", parts: [{ name: "x", ref: "Nope", role: "optional" }] }]
    } as never)
    const r = compile([bad])
    expect(r.codes).toContain("governance.pattern-unknown-component")
    expect(r.diagnostics.find((d) => d.code === "governance.pattern-unknown-component")?.message).toMatch(
      /variations\.v\.parts\.x\.ref/
    )
    expect(r.summary).toMatchObject({ added: 0, skipped: 1 })
  })

  it("rejects a variation that changes nothing, and leaves the rest to the contract's checks", () => {
    expect(
      parsePatterns(
        JSON.stringify({
          version: 1,
          patterns: [pattern("page.z", { variations: [{ name: "empty" }] } as never)]
        })
      ).ok
    ).toBe(false)
    const ghost = compile([
      pattern("page.w", {
        composition: { parts: [{ name: "header", ref: "Card", role: "required" }] },
        variations: [{ name: "v", roles: [{ part: "ghost", role: "optional" }] }]
      } as never)
    ])
    expect(ghost.summary.added).toBe(1)
    expect(ghost.errors().some((e) => e.startsWith("contract.pattern-variation-unknown-part"))).toBe(true)
  })
})
