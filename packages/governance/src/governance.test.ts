import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  type Component,
  type ContractDraft,
  createEvidenceFile,
  evidenceFileSchema,
  finalizeContract,
  type Guideline,
  parseContract,
  type Token,
  verifyContract
} from "@invariant/contract"
import { describe, expect, it } from "vitest"
import {
  addDecision,
  applyDecisions,
  claimsHash,
  compilePolicies,
  type Decision,
  type DecisionsFile,
  parseDecisions,
  parsePolicies,
  serializeDecisions
} from "./index.js"

const golden = (file: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../../fixtures/contract-golden/acme-ui/${file}`, import.meta.url)),
    "utf8"
  )
const evidence = evidenceFileSchema.parse(JSON.parse(golden("invariant.evidence.json")))
const EV = evidence.evidence[0]?.id as string

function draft(): ContractDraft {
  const parsed = parseContract(JSON.parse(golden("invariant.contract.json")))
  if (!parsed.ok) throw new Error("fixture invalid")
  const { integrity: _i, ...rest } = parsed.value
  return rest
}
/** Errors found by the contract's own verification, with the evidence file. */
function problems(d: ContractDraft): string[] {
  const c = finalizeContract(d)
  return verifyContract(c, createEvidenceFile(c.integrity.contentHash, evidence.evidence))
    .filter((x) => x.severity === "error")
    .map((x) => `${x.code}: ${x.message}`)
}

const at = "2026-02-01T00:00:00.000Z"
const fact = (
  subject: string,
  path: string,
  value: unknown,
  action: "approve" | "reject" = "approve",
  extra: Partial<Decision> = {}
): Decision =>
  ({ kind: "fact", action, subject, path, value: value as never, by: "Jane", at, ...extra }) as Decision
const file = (...decisions: Decision[]): DecisionsFile => ({ version: 1, decisions })
const inferred = {
  status: "inferred" as const,
  evidenceIds: [EV],
  confidence: 0.5,
  derivation: { rule: "r", reasoning: "r", inputs: [] }
}
const discovered = { status: "discovered" as const, evidenceIds: [EV] }

function withCompound(): { d: ContractDraft; id: string } {
  const base = draft()
  const parent = base.components.find((c) => c.id === "component:card") as Component
  const targets = ["component:badge", "component:button", "component:icon"] as const
  const next: Component = {
    ...parent,
    composition: targets.map((t) => ({ type: "contains" as const, target: t as never })),
    facts: {
      ...parent.facts,
      "composition.0": inferred,
      "composition.1": discovered,
      "composition.2": { ...inferred, confidence: 0.7 }
    }
  }
  return {
    d: { ...base, components: base.components.map((c) => (c.id === parent.id ? next : c)) },
    id: parent.id
  }
}

describe("approving facts", () => {
  it("layers approved over the prior status with a fingerprint the contract itself verifies", () => {
    const d = draft()
    const g = d.guidelines.find((x) => x.facts.kind?.status === "inferred") as Guideline
    const r = applyDecisions(
      d,
      file(fact(g.id, "kind", g.kind, "approve", { role: "design lead", reference: "RFC-1" }))
    )
    expect(r.diagnostics).toEqual([])
    const out = r.contract.guidelines.find((x) => x.id === g.id)?.facts.kind
    expect(out).toMatchObject({
      status: "approved",
      confidence: 0.4,
      derivation: { rule: "document.classify.fallback" },
      approval: {
        approvedBy: "Jane",
        approvedAt: at,
        role: "design lead",
        reference: "RFC-1",
        priorStatus: "inferred"
      }
    })
    expect(problems(r.contract)).toEqual([])
    expect(r.applied).toEqual([{ action: "approve", target: `${g.id} kind` }])
  })

  it("can approve a discovered fact too, and is idempotent", () => {
    const d = draft()
    const button = d.components.find((c) => c.id === "component:button") as Component
    const once = applyDecisions(
      d,
      file(
        fact(button.id, "props.variant.type.text", button.props.find((p) => p.name === "variant")?.type.text)
      )
    )
    expect(
      once.contract.components.find((c) => c.id === button.id)?.facts["props.variant.type.text"]
    ).toMatchObject({ status: "approved", approval: { priorStatus: "discovered" } })
    expect(problems(once.contract)).toEqual([])
    const twice = applyDecisions(
      once.contract,
      file(
        fact(button.id, "props.variant.type.text", button.props.find((p) => p.name === "variant")?.type.text)
      )
    )
    expect(twice.contract).toEqual(once.contract)
  })

  it("is stale, and not applied, when the value has changed", () => {
    const d = draft()
    const g = d.guidelines.find((x) => x.facts.kind?.status === "inferred") as Guideline
    const r = applyDecisions(d, file(fact(g.id, "kind", "usage")))
    expect(r.contract).toEqual(d)
    expect(r.stale).toHaveLength(1)
    expect(r.diagnostics.map((x) => x.code)).toEqual(["governance.decision-stale"])
  })

  it("reports a missing entity or fact and applies nothing", () => {
    const d = draft()
    expect(applyDecisions(d, file(fact("component:nope", "x", 1))).diagnostics.map((x) => x.code)).toEqual([
      "governance.decision-target-missing"
    ])
    expect(
      applyDecisions(d, file(fact("component:button", "description", "x"))).diagnostics.map((x) => x.code)
    ).toEqual(["governance.decision-stale"])
  })

  it("rejects approvers who are not on the allowlist, and applies the rest", () => {
    const d = draft()
    const g = d.guidelines.find((x) => x.facts.kind?.status === "inferred") as Guideline
    const decisions = file(
      fact(g.id, "kind", g.kind, "approve", { by: "Mallory" }),
      fact(g.id, "kind", g.kind, "approve", { by: "Jane" })
    )
    const r = applyDecisions(d, decisions, { approvers: ["Jane"] })
    expect(r.diagnostics.map((x) => x.code)).toEqual(["governance.unauthorized"])
    expect(r.contract.guidelines.find((x) => x.id === g.id)?.facts.kind?.approval?.approvedBy).toBe("Jane")
    expect(applyDecisions(d, decisions, { approvers: [] }).diagnostics).toEqual([])
  })
})

describe("rejecting inferences", () => {
  it("removes an inferred containment link and renumbers the facts that follow", () => {
    const { d, id } = withCompound()
    const r = applyDecisions(
      d,
      file(fact(id, "composition.0", { type: "contains", target: "component:badge" }, "reject"))
    )
    const c = r.contract.components.find((x) => x.id === id) as Component
    expect(c.composition.map((x) => x.target)).toEqual(["component:button", "component:icon"])
    expect(
      Object.keys(c.facts)
        .filter((k) => k.startsWith("composition."))
        .sort()
    ).toEqual(["composition.0", "composition.1"])
    expect(c.facts["composition.0"]?.status).toBe("discovered")
    expect(c.facts["composition.1"]).toMatchObject({ status: "inferred", confidence: 0.7 })
    expect(problems(r.contract)).toEqual([])
  })

  it("finds the link by value even after other links moved, so decisions survive reordering", () => {
    const { d, id } = withCompound()
    const r = applyDecisions(
      d,
      file(fact(id, "composition.0", { type: "contains", target: "component:icon" }, "reject"))
    )
    expect(
      (r.contract.components.find((x) => x.id === id) as Component).composition.map((x) => x.target)
    ).toEqual(["component:badge", "component:button"])
  })

  it("removes an inferred guideline link", () => {
    const d = draft()
    const g = d.guidelines.find(
      (x) => x.appliesTo.length > 0 && x.facts["appliesTo.0"]?.status === "inferred"
    ) as Guideline
    const r = applyDecisions(d, file(fact(g.id, "appliesTo.0", g.appliesTo[0], "reject")))
    const out = r.contract.guidelines.find((x) => x.id === g.id) as Guideline
    expect(out.appliesTo).toEqual(g.appliesTo.slice(1))
    expect(out.facts["appliesTo.0"]).toBeUndefined()
    expect(problems(r.contract)).toEqual([])
  })

  it("puts an inferred token category back to the placeholder", () => {
    const base = draft()
    const token: Token = {
      id: "token:zebra" as never,
      name: "zebra",
      category: "color",
      value: { value: "#fff" },
      facts: { category: inferred, name: discovered }
    }
    const r = applyDecisions(
      { ...base, tokens: [token] },
      file(fact("token:zebra", "category", "color", "reject"))
    )
    expect(r.contract.tokens[0]).toMatchObject({ category: "other" })
    expect(r.contract.tokens[0]?.facts.category).toBeUndefined()
    expect(r.contract.tokens[0]?.facts.name).toBeDefined()
  })

  it("refuses to reject discovered or approved facts, or inferences it cannot remove", () => {
    const { d, id } = withCompound()
    expect(
      applyDecisions(
        d,
        file(fact(id, "composition.1", { type: "contains", target: "component:button" }, "reject"))
      ).diagnostics.map((x) => x.code)
    ).toEqual(["governance.reject-unsupported"])
    const g = d.guidelines.find((x) => x.facts.kind?.status === "inferred") as Guideline
    const approved = applyDecisions(d, file(fact(g.id, "kind", g.kind), fact(g.id, "kind", g.kind, "reject")))
    expect(approved.diagnostics.map((x) => x.code)).toEqual(["governance.reject-approved"])
    const other = applyDecisions(d, file(fact(g.id, "kind", g.kind, "reject")))
    expect(other.diagnostics.map((x) => x.code)).toEqual(["governance.reject-unsupported"])
    expect(other.contract).toEqual(d)
  })
})

describe("conflict decisions", () => {
  const first = (d: ContractDraft) => d.conflicts[0] as ContractDraft["conflicts"][number]
  const decision = (
    d: ContractDraft,
    action: "resolve" | "accept" | "dismiss",
    extra: Record<string, unknown> = {}
  ): Decision =>
    ({
      kind: "conflict",
      action,
      id: first(d).id,
      claimsHash: claimsHash(first(d)),
      by: "Jane",
      at,
      ...extra
    }) as Decision

  it("records resolution state without touching the claims or the kept value", () => {
    const d = draft()
    const source = first(d).claims[0]?.sourceId as string
    const r = applyDecisions(
      d,
      file(decision(d, "resolve", { chosenSourceId: source, note: "fixing the story" }))
    )
    expect(first(r.contract).resolution).toEqual({
      state: "resolved",
      chosenSourceId: source,
      decidedBy: "Jane",
      decidedAt: at,
      note: "fixing the story"
    })
    expect(first(r.contract).claims).toEqual(first(d).claims)
    expect(r.contract.components).toEqual(d.components)
    expect(problems(r.contract)).toEqual([])
    expect(first(applyDecisions(d, file(decision(d, "accept"))).contract).resolution.state).toBe("accepted")
    expect(first(applyDecisions(d, file(decision(d, "dismiss"))).contract).resolution.state).toBe("dismissed")
  })

  it("is stale when the claims changed, and invalid for an unknown source", () => {
    const d = draft()
    const stale = applyDecisions(
      d,
      file({ ...decision(d, "accept"), claimsHash: "0".repeat(64) } as Decision)
    )
    expect(stale.diagnostics.map((x) => x.code)).toEqual(["governance.decision-stale"])
    expect(first(stale.contract).resolution.state).toBe("open")
    expect(
      applyDecisions(d, file(decision(d, "resolve", { chosenSourceId: "nope" }))).diagnostics.map(
        (x) => x.code
      )
    ).toEqual(["governance.decision-invalid"])
  })

  it("reports a conflict that no longer exists", () => {
    const d = draft()
    expect(
      applyDecisions({ ...d, conflicts: [] }, file(decision(d, "accept"))).diagnostics.map((x) => x.code)
    ).toEqual(["governance.decision-target-missing"])
  })
})

describe("the decisions file", () => {
  it("replaces an earlier decision about the same target, keeps others, and round-trips canonically", () => {
    const a = fact("component:x", "composition.0", { t: 1 }, "approve")
    const b = fact("component:x", "composition.3", { t: 1 }, "reject", { by: "Sam" })
    const c = fact("component:x", "composition.1", { t: 2 }, "approve")
    const f = addDecision(addDecision(addDecision(undefined, a), c), b)
    expect(f.decisions).toEqual([c, b])
    const text = serializeDecisions(f)
    const parsed = parseDecisions(text)
    expect(parsed).toEqual({ ok: true, value: f })
    expect(serializeDecisions((parsed as { value: DecisionsFile }).value)).toBe(text)
  })
  it("rejects malformed files with a readable message", () => {
    expect(parseDecisions("{nope")).toMatchObject({
      ok: false,
      message: expect.stringMatching(/not valid JSON/)
    })
    expect(parseDecisions('{"version":2,"decisions":[]}')).toMatchObject({ ok: false })
    expect(
      parseDecisions(JSON.stringify({ version: 1, decisions: [{ kind: "fact", action: "approve" }] }))
    ).toMatchObject({ ok: false, message: expect.stringMatching(/decisions\.0/) })
    expect(
      parseDecisions(JSON.stringify({ version: 1, decisions: [{ ...fact("a", "b", 1), extra: 1 }] }))
    ).toMatchObject({ ok: false })
  })
})

describe("policies", () => {
  const approval = { approvedBy: "Jane", approvedAt: "2026-01-01T00:00:00.000Z", role: "lead" }
  const policy = (over: Record<string, unknown> = {}) => ({
    id: "icon-labels",
    name: "Icon buttons need labels",
    statement: "Icon-only buttons must have an accessible name.",
    severity: "error",
    approval,
    rule: {
      kind: "require-attribute",
      components: ["Button"],
      anyOf: ["aria-label"],
      unlessChildren: true,
      category: "accessibility"
    },
    ...over
  })
  const parse = (...policies: unknown[]) => parsePolicies(JSON.stringify({ version: 1, policies }))

  it("parses valid files and refuses a policy without approval, with a bad rule, or duplicated", () => {
    expect(parse(policy())).toMatchObject({ ok: true })
    const { approval: _a, ...noApproval } = policy()
    expect(parse(noApproval)).toMatchObject({ ok: false, message: expect.stringMatching(/approval/) })
    expect(parse(policy({ rule: { kind: "nonsense" } }))).toMatchObject({ ok: false })
    expect(parse(policy({ approval: { approvedBy: "", approvedAt: "x" } }))).toMatchObject({ ok: false })
    expect(parse(policy({ id: "Bad Id" }))).toMatchObject({ ok: false })
    expect(parse(policy(), policy())).toMatchObject({
      ok: false,
      message: expect.stringMatching(/duplicate/)
    })
    expect(parsePolicies("{")).toMatchObject({ ok: false })
  })

  it("adds a policy and its constraint, defaults enforcement to block, and the result verifies", () => {
    const parsed = parse(
      policy(),
      policy({
        id: "no-plain",
        name: "No plain",
        rule: { kind: "forbid-prop", component: "Button", prop: "plain" }
      })
    ) as { value: Parameters<typeof compilePolicies>[1] }
    const d = draft()
    const r = compilePolicies(d, parsed.value)
    expect(r.diagnostics).toEqual([])
    expect(r.contract.policies.map((p) => p.id)).toEqual(["policy:icon-labels", "policy:no-plain"])
    expect(r.contract.policies[0]).toMatchObject({
      enforcement: "block",
      severity: "error",
      basedOn: ["constraint:icon-labels"],
      approval
    })
    expect(r.contract.constraints[0]).toMatchObject({
      id: "constraint:icon-labels",
      kind: "required-prop",
      subjects: ["component:button"],
      extensions: { invariant: { source: "invariant.policies.json", policy: "icon-labels" } }
    })
    expect(r.contract.constraints[1]?.kind).toBe("deprecated-api")
    expect(r.contract.components).toEqual(d.components)
    expect(problems(r.contract)).toEqual([])
  })

  it("keeps a policy that names an unknown component, falls back to the policy as subject, and says so", () => {
    const parsed = parse(policy({ rule: { kind: "forbid-component", component: "Ghost" } })) as {
      value: Parameters<typeof compilePolicies>[1]
    }
    const r = compilePolicies(draft(), parsed.value)
    expect(r.diagnostics.map((x) => x.code)).toEqual(["governance.policy-unknown-component"])
    expect(r.contract.constraints[0]?.subjects).toEqual(["policy:icon-labels"])
    expect(problems(r.contract)).toEqual([])
  })

  it("maps every rule kind to a constraint kind and finds tokens by name", () => {
    const rules = [
      { kind: "forbid-prop-value", component: "Button", prop: "variant", values: ["ghost"] },
      { kind: "forbid-component", component: "Icon", use: "Glyph" },
      { kind: "allowed-children", container: "Card", children: ["Card.Body"], category: "layout" },
      { kind: "required-parent", component: "Card.Header", parents: ["Card"] },
      { kind: "forbid-token", tokens: ["--color-old"] }
    ]
    const parsed = parse(...rules.map((rule, i) => policy({ id: `r${i}`, rule }))) as {
      value: Parameters<typeof compilePolicies>[1]
    }
    const token: Token = {
      id: "token:color-old" as never,
      name: "color-old",
      category: "color",
      value: { value: "#000" },
      facts: {}
    }
    const r = compilePolicies({ ...draft(), tokens: [token] }, parsed.value)
    expect(r.contract.constraints.map((c) => c.kind)).toEqual([
      "invalid-combination",
      "deprecated-api",
      "valid-combination",
      "valid-combination",
      "deprecated-api"
    ])
    expect(r.contract.constraints[4]?.subjects).toEqual(["token:color-old"])
    expect(r.diagnostics).toEqual([])
    expect(problems(r.contract)).toEqual([])
  })

  it("never overwrites an existing policy id", () => {
    const parsed = parse(policy()) as { value: Parameters<typeof compilePolicies>[1] }
    const once = compilePolicies(draft(), parsed.value).contract
    const twice = compilePolicies(once, parsed.value)
    expect(twice.diagnostics.map((x) => x.code)).toEqual(["governance.policy-id-taken"])
    expect(twice.contract.policies).toHaveLength(1)
  })
})
