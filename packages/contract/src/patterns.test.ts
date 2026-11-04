import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { acmeDraft, buildAcme } from "../test/acme.ts"
import { buildPatterns, patternsDraft, patternsEvidence } from "../test/patterns.ts"
import {
  type Contract,
  type ContractDraft,
  contractJsonSchemas,
  createEvidenceFile,
  finalizeContract,
  parseContract,
  serializeContract,
  serializeEvidenceFile,
  verifyContract
} from "./index.js"

type AjvInstance = { compile(schema: object): ((data: unknown) => boolean) & { errors?: unknown } }
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as new (options: object) => AjvInstance
const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/patterns/${name}`, import.meta.url))

const build = (change: (d: ContractDraft) => void): Contract => {
  const draft = patternsDraft()
  change(draft)
  return finalizeContract(draft)
}
const problems = (c: Contract): Array<{ code: string; severity: string }> =>
  verifyContract(c, createEvidenceFile(c.integrity.contentHash, patternsEvidence())).map((d) => ({
    code: d.code,
    severity: d.severity
  }))
const codes = (c: Contract): string[] => problems(c).map((p) => p.code)
const page = (d: ContractDraft) => {
  const p = d.patterns.find((x) => x.id === "pattern:page.data-management")
  if (!p) throw new Error("fixture bug: page pattern missing")
  return p
}
const confirmation = (d: ContractDraft) => {
  const p = d.patterns.find((x) => x.id === "pattern:interaction.destructive-confirmation")
  if (!p) throw new Error("fixture bug: confirmation pattern missing")
  return p
}

describe("pattern contracts: the sample", () => {
  const { contract, evidence } = buildPatterns()

  it("is valid, round-trips, and declares 1.1.0", () => {
    expect(contract.contractVersion).toBe("1.1.0")
    expect(verifyContract(contract, evidence)).toEqual([])
    expect(parseContract(JSON.parse(serializeContract(contract)))).toEqual({ ok: true, value: contract })
  })

  it("represents all four categories and every relationship it uses", () => {
    const categories = contract.patterns.map((p) => p.category).sort()
    expect(categories).toEqual(["composition", "form", "interaction", "layout", "page"])
    const types = contract.patterns.flatMap((p) => p.relationships ?? []).map((r) => r.type)
    expect(types).toEqual(["composes", "composes", "uses", "uses"])
  })

  it("keeps fact statuses distinguishable on a pattern, with approval layered over its prior status", () => {
    const facts = contract.patterns.find((p) => p.id === "pattern:page.data-management")?.facts ?? {}
    expect(facts.intent?.status).toBe("documented")
    expect(facts["relationships.tools"]?.status).toBe("discovered")
    expect(facts["relationships.delete"]).toMatchObject({ status: "inferred", confidence: 0.6 })
    expect(facts["layout.regions.results.required"]).toMatchObject({
      status: "approved",
      approval: { priorStatus: "documented" }
    })
  })

  it("matches the committed golden files and validates against the JSON Schema", () => {
    const golden = [
      [fixture("invariant.contract.json"), serializeContract(contract)],
      [fixture("invariant.evidence.json"), serializeEvidenceFile(evidence)]
    ] as const
    mkdirSync(dirname(fixture("invariant.contract.json")), { recursive: true })
    for (const [path, expected] of golden) {
      if (process.env.UPDATE_GOLDEN === "1" || !existsSync(path)) writeFileSync(path, expected)
      expect(readFileSync(path, "utf8")).toBe(expected)
    }
    const validate = new Ajv2020({ strict: false }).compile(
      contractJsonSchemas()["contract-v1.schema.json"] as object
    )
    expect(validate(JSON.parse(readFileSync(fixture("invariant.contract.json"), "utf8")))).toBe(true)
  })
})

describe("compatibility with 1.0.0", () => {
  it("reads a 1.0.0 document unchanged, with its hash still valid", () => {
    const { contract, evidence } = buildAcme()
    expect(contract.contractVersion).toBe("1.0.0")
    const parsed = parseContract(JSON.parse(serializeContract(contract)))
    expect(parsed).toEqual({ ok: true, value: contract })
    expect(verifyContract(contract, evidence)).toEqual([])
  })

  it("rejects a 1.0.0 document that uses fields or values from 1.1.0", () => {
    const old = acmeDraft()
    const login = old.patterns[0]
    if (!login) throw new Error("fixture bug")
    login.intent = "Collect credentials."
    expect(codes(finalizeContract(old))).toContain("contract.field-newer-than-version")

    const page1 = acmeDraft()
    const pattern = page1.patterns[0]
    if (!pattern) throw new Error("fixture bug")
    pattern.category = "page"
    expect(codes(finalizeContract(page1))).toContain("contract.field-newer-than-version")

    const kind = acmeDraft()
    const constraint = kind.constraints[0]
    if (!constraint) throw new Error("fixture bug")
    constraint.kind = "cardinality"
    expect(codes(finalizeContract(kind))).toContain("contract.field-newer-than-version")
  })

  it("still rejects another major version and unknown fields", () => {
    const { contract } = buildPatterns()
    const wrong = { ...JSON.parse(serializeContract(contract)), contractVersion: "2.0.0" }
    const result = parseContract(wrong)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics[0]?.code).toBe("contract.unsupported-version")

    const extra = JSON.parse(serializeContract(contract))
    extra.patterns[0].surprise = true
    expect(parseContract(extra).ok).toBe(false)
  })
})

describe("references and identity", () => {
  it("reports an unknown component, pattern, constraint or token", () => {
    const c = build((d) => {
      const p = page(d)
      p.composition?.parts.push({ name: "extra", ref: "component:nope", role: "optional" })
      p.relationships?.push({ id: "ghost", type: "composes", target: "pattern:nope" })
      p.constraints?.push("constraint:nope")
      const region = p.layout?.regions[0]
      if (region) region.spacing = "token:nope"
    })
    const dangling = verifyContract(c).filter((d) => d.code === "contract.dangling-reference")
    const text = dangling.map((d) => d.message).join("\n")
    for (const missing of ["component:nope", "pattern:nope", "constraint:nope", "token:nope"])
      expect(text).toContain(missing)
  })

  it("reports an unknown component inside a constraint's details", () => {
    const c = build((d) => {
      const k = d.constraints.find((x) => x.id === "constraint:data-management.single-table")
      if (k) k.details = { target: "component:nope", min: 1 }
    })
    expect(
      verifyContract(c).some(
        (x) => x.code === "contract.dangling-reference" && /component:nope/.test(x.message)
      )
    ).toBe(true)
  })

  it("rejects duplicate names within one pattern", () => {
    const c = build((d) => {
      const p = page(d)
      p.layout?.regions.push({ name: "header", required: false })
      p.relationships?.push({ id: "frame", type: "uses", target: "component:button" })
      p.behavior?.states.push({ name: "ready" })
      p.behavior?.transitions.push({ id: "found", from: "loading", to: "ready" })
    })
    expect(codes(c).filter((x) => x === "contract.pattern-duplicate-name")).toHaveLength(4)
  })

  it("keeps relationship, region and state names usable as fact paths", () => {
    const bad = patternsDraft()
    const p = page(bad)
    p.relationships?.push({ id: "has.dot", type: "uses", target: "component:button" })
    expect(parseContract(JSON.parse(serializeContract(finalizeContract(bad)))).ok).toBe(false)
  })
})

describe("relationships", () => {
  it("rejects a self relationship, a wrong target kind and a repeated edge", () => {
    const c = build((d) => {
      const p = page(d)
      p.relationships?.push(
        { id: "me", type: "uses", target: "pattern:page.data-management" },
        { id: "tool", type: "extends", target: "component:button" },
        { id: "again", type: "composes", target: "pattern:composition.table-toolbar" }
      )
    })
    expect(codes(c)).toEqual(
      expect.arrayContaining([
        "contract.pattern-self-relationship",
        "contract.pattern-relationship-target",
        "contract.pattern-duplicate-relationship"
      ])
    )
  })

  it("detects a circular reference through relationships", () => {
    const c = build((d) => {
      const shell = d.patterns.find((p) => p.id === "pattern:layout.application-shell")
      shell?.relationships?.push({ id: "back", type: "composes", target: "pattern:page.data-management" })
      if (shell && !shell.relationships)
        shell.relationships = [{ id: "back", type: "composes", target: "pattern:page.data-management" }]
    })
    const cycle = verifyContract(c).find((x) => x.code === "contract.pattern-cycle")
    expect(cycle?.message).toBe(
      "Patterns form a cycle: pattern:layout.application-shell -> pattern:page.data-management -> pattern:layout.application-shell"
    )
  })

  it("detects a cycle through composition parts and reports it once", () => {
    const c = build((d) => {
      const toolbar = d.patterns.find((p) => p.id === "pattern:composition.table-toolbar")
      toolbar?.composition?.parts.push({
        name: "page",
        ref: "pattern:page.data-management",
        role: "optional"
      })
    })
    expect(codes(c).filter((x) => x === "contract.pattern-cycle")).toHaveLength(1)
  })

  it("allows symmetric and non-nesting relationships to point both ways", () => {
    const c = build((d) => {
      const a = d.patterns.find((p) => p.id === "pattern:layout.application-shell")
      const b = d.patterns.find((p) => p.id === "pattern:form.login")
      const rel = (id: string, type: "alternative-to" | "prohibited-with" | "uses", target: string) => ({
        id,
        type,
        target: target as `pattern:${string}`
      })
      if (a) a.relationships = [rel("alt", "alternative-to", "pattern:form.login")]
      if (b)
        b.relationships = [
          rel("alt", "alternative-to", "pattern:layout.application-shell"),
          rel("never", "prohibited-with", "pattern:layout.application-shell")
        ]
    })
    expect(codes(c)).toEqual([])
  })

  it("does not count a prohibited part as nesting", () => {
    const c = build((d) => {
      const toolbar = d.patterns.find((p) => p.id === "pattern:composition.table-toolbar")
      toolbar?.composition?.parts.push({
        name: "page",
        ref: "pattern:page.data-management",
        role: "prohibited"
      })
    })
    expect(codes(c)).toEqual([])
  })
})

describe("layout and behavior", () => {
  it("rejects an unknown region parent, a region cycle and a part in an unknown region", () => {
    const c = build((d) => {
      const p = page(d)
      const regions = p.layout?.regions ?? []
      regions.push({ name: "a", required: false, parent: "b" }, { name: "b", required: false, parent: "a" })
      regions.push({ name: "orphan", required: false, parent: "missing" })
      p.composition?.parts.push({ name: "x", ref: "component:button", role: "optional", region: "nowhere" })
    })
    const found = codes(c)
    expect(found.filter((x) => x === "contract.pattern-region-cycle")).toHaveLength(2)
    expect(found.filter((x) => x === "contract.pattern-region-unknown")).toHaveLength(2)
  })

  it("rejects a state machine whose initial state or transition ends do not exist", () => {
    const c = build((d) => {
      const b = confirmation(d).behavior
      if (!b) return
      b.initial = "start"
      b.transitions.push({ id: "lost", from: "done", to: "nowhere" })
    })
    expect(codes(c).filter((x) => x === "contract.pattern-state-unknown")).toHaveLength(2)
  })

  it("warns, but does not fail, about a state that cannot be reached", () => {
    const c = build((d) => {
      confirmation(d).behavior?.states.push({ name: "orphan" })
    })
    expect(problems(c)).toEqual([{ code: "contract.pattern-unreachable-state", severity: "warning" }])
  })
})

describe("structural constraints", () => {
  const withDetails = (id: string, details: Record<string, unknown>): Contract =>
    build((d) => {
      const k = d.constraints.find((x) => x.id === id)
      if (k) k.details = details as never
    })

  it("rejects details that do not match the constraint kind", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["constraint:data-management.single-table", { target: "component:data-table" }],
      ["constraint:data-management.single-table", { target: "component:data-table", min: 3, max: 1 }],
      ["constraint:data-management.single-table", { target: "component:data-table", min: 1, extra: true }],
      ["constraint:data-management.toolbar-before-table", { before: "pattern:composition.table-toolbar" }],
      ["constraint:data-management.results-required", { region: "results" }],
      ["constraint:data-management.results-required", {}]
    ]
    for (const [id, details] of cases)
      expect(codes(withDetails(id, details)), JSON.stringify(details)).toContain(
        "contract.constraint-details-invalid"
      )
  })

  it("rejects a constraint with no details at all", () => {
    const c = build((d) => {
      const k = d.constraints.find((x) => x.id === "constraint:data-management.single-table")
      if (k) delete k.details
    })
    expect(codes(c)).toContain("contract.constraint-details-invalid")
  })

  it("rejects a region the owning pattern does not define, and a region constraint nobody owns", () => {
    const unknown = withDetails("constraint:data-management.results-required", { region: "region:footer" })
    expect(codes(unknown)).toContain("contract.pattern-region-unknown")

    const orphan = build((d) => {
      const p = page(d)
      p.constraints = (p.constraints ?? []).filter(
        (id) => id !== "constraint:data-management.results-required"
      )
    })
    expect(verifyContract(orphan).some((x) => /no pattern owns the constraint/.test(x.message))).toBe(true)
  })

  it("keeps the older constraint kinds free-form", () => {
    expect(codes(build(() => {}))).toEqual([])
  })
})

describe("evidence and approval on patterns", () => {
  it("reports a fact path that does not resolve", () => {
    const c = build((d) => {
      page(d).facts["relationships.missing"] = {
        status: "discovered",
        evidenceIds: [patternsEvidence()[0]?.id ?? ""]
      }
    })
    expect(codes(c)).toContain("contract.unresolvable-fact-path")
  })

  it("reports an approval that no longer matches the value it approved", () => {
    const c = build((d) => {
      const region = page(d).layout?.regions.find((r) => r.name === "results")
      if (region) region.required = false
    })
    expect(codes(c)).toContain("contract.approval-stale")
  })

  it("requires evidence for every pattern fact", () => {
    const c = build((d) => {
      page(d).facts.intent = { status: "documented", evidenceIds: ["ev_000000000000000000000000"] }
    })
    expect(codes(c)).toContain("contract.unknown-evidence")
  })
})

describe("required-state constraints", () => {
  const withState = (details: Record<string, unknown>): Contract =>
    build((d) => {
      d.constraints = [
        ...d.constraints,
        {
          id: "constraint:data-management.zz-state",
          name: "State",
          kind: "required-state",
          description: "A form shows that it is submitting.",
          subjects: ["pattern:page.data-management"],
          details: details as never,
          facts: {}
        }
      ].sort((a, b) => (a.id < b.id ? -1 : 1)) as never
      const page = d.patterns.find((p) => p.id === "pattern:page.data-management")
      if (page) page.constraints = [...(page.constraints ?? []), "constraint:data-management.zz-state"]
    })

  it("accepts a workflow and one of its states, with or without a minimum", () => {
    expect(codes(withState({ workflow: "form-submission", state: "submitting" }))).toEqual([])
    expect(
      codes(withState({ workflow: "search-results", state: "empty", minimum: "static-inferred" }))
    ).toEqual([])
    expect(
      codes(withState({ workflow: "destructive-confirmation", state: "cancellable", minimum: "structural" }))
    ).toEqual([])
  })

  it("does not read the workflow or the state as references to other entities", () => {
    expect(codes(withState({ workflow: "form-submission", state: "guarded" }))).not.toContain(
      "contract.dangling-reference"
    )
  })

  it("rejects a state the workflow does not have, an unknown workflow, a bad minimum and extra fields", () => {
    for (const details of [
      { workflow: "form-submission", state: "loading" },
      { workflow: "checkout", state: "submitting" },
      { workflow: "form-submission", state: "submitting", minimum: "runtime-verified" },
      { workflow: "form-submission", state: "submitting", extra: true },
      { state: "submitting" }
    ])
      expect(codes(withState(details)), JSON.stringify(details)).toContain(
        "contract.constraint-details-invalid"
      )
  })

  it("only exists from 1.1.0", () => {
    const old = acmeDraft()
    const k = old.constraints[0]
    if (!k) throw new Error("fixture bug")
    k.kind = "required-state"
    expect(codes(finalizeContract(old))).toContain("contract.field-newer-than-version")
  })
})
