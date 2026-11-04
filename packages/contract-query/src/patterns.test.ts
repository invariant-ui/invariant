import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { type Contract, evidenceFileSchema, parseContract } from "@invariant/contract"
import { describe, expect, it } from "vitest"
import {
  DesignSystem,
  patternRelationships,
  patternStatus,
  patternsView,
  patternView,
  search
} from "./index.js"

const file = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../contract/fixtures/patterns/${name}`, import.meta.url)), "utf8")

function load(change?: (c: Contract) => void): DesignSystem {
  const parsed = parseContract(JSON.parse(file("invariant.contract.json")))
  if (!parsed.ok) throw new Error("fixture contract invalid")
  const contract = structuredClone(parsed.value)
  change?.(contract)
  return new DesignSystem(contract, evidenceFileSchema.parse(JSON.parse(file("invariant.evidence.json"))))
}

const ds = load()
const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("expected a value")
  return value
}
const pattern = (id: string) => must(ds.pattern(id))
type Row = Record<string, any>

describe("findPattern", () => {
  it("resolves an id, an id without its prefix, the part after the category, and a name", () => {
    for (const q of [
      "pattern:page.data-management",
      "page.data-management",
      "data-management",
      "Data management page",
      "  DATA_MANAGEMENT  "
    ])
      expect(ds.findPattern(q).match?.id, q).toBe("pattern:page.data-management")
  })

  it("returns candidates, not a guess, when a name is ambiguous or unknown", () => {
    const twin = load((c) => {
      const copy = structuredClone(must(c.patterns.find((p) => p.id === "pattern:layout.application-shell")))
      copy.id = "pattern:page.application-shell"
      c.patterns.push(copy)
    })
    const ambiguous = twin.findPattern("application-shell")
    expect(ambiguous.match).toBeUndefined()
    expect(ambiguous.candidates.map((p) => p.id).sort()).toEqual([
      "pattern:layout.application-shell",
      "pattern:page.application-shell"
    ])
    expect(ds.findPattern("nope")).toEqual({ candidates: [] })
    expect(ds.findPattern("toolbar").candidates.map((p) => p.id)).toEqual([
      "pattern:composition.table-toolbar"
    ])
  })
})

describe("patternStatus", () => {
  it("is derived from facts: none, one shared status, or mixed", () => {
    expect(patternStatus({ facts: {} })).toEqual({ overall: "none", counts: {}, total: 0 })
    const fact = (status: "documented" | "approved") => ({ status, evidenceIds: ["e"] }) as never
    expect(patternStatus({ facts: { a: fact("documented"), b: fact("documented") } }).overall).toBe(
      "documented"
    )
    expect(patternStatus({ facts: { a: fact("approved") } }).overall).toBe("approved")
    expect(patternStatus({ facts: { a: fact("approved"), b: fact("documented") } })).toMatchObject({
      overall: "mixed",
      counts: { approved: 1, documented: 1 },
      total: 2
    })
  })
})

describe("patternsView", () => {
  it("lists every pattern with a derived status and says which are not approved", () => {
    const v = patternsView(ds) as Row
    expect(v.total).toBe(5)
    expect(v.patterns.map((p: Row) => p.id)).toEqual([
      "pattern:composition.table-toolbar",
      "pattern:form.login",
      "pattern:interaction.destructive-confirmation",
      "pattern:layout.application-shell",
      "pattern:page.data-management"
    ])
    const page = v.patterns.find((p: Row) => p.id === "pattern:page.data-management")
    expect(page).toMatchObject({
      status: { overall: "mixed", total: 4 },
      approved: false,
      intent: expect.any(String)
    })
    expect(v.patterns.every((p: Row) => p.approved === false)).toBe(true)
    expect(v.notes.join(" ")).toMatch(/not fully approved/)
  })

  it("keeps the fields it always had", () => {
    const first = (patternsView(ds) as Row).patterns[0]
    for (const key of ["id", "name", "category", "description", "components"])
      expect(first).toHaveProperty(key)
  })

  it("filters by category, status and text, and pages", () => {
    const ids = (v: unknown): string[] => (v as Row).patterns.map((p: Row) => p.id)
    expect(ids(patternsView(ds, { category: "interaction" }))).toEqual([
      "pattern:interaction.destructive-confirmation"
    ])
    expect(ids(patternsView(ds, { status: "mixed" }))).toEqual(["pattern:page.data-management"])
    expect(ids(patternsView(ds, { status: "none" }))).toEqual([
      "pattern:form.login",
      "pattern:interaction.destructive-confirmation"
    ])
    expect(ids(patternsView(ds, { query: "toolbar" }))[0]).toBe("pattern:composition.table-toolbar")
    // The page matches "toolbars" through its toolbar part; the category filter then applies to those hits.
    expect(ids(patternsView(ds, { query: "toolbars", category: "page" }))).toEqual([
      "pattern:page.data-management"
    ])
    expect(ids(patternsView(ds, { query: "toolbars", category: "layout" }))).toEqual([])
    const paged = patternsView(ds, { limit: 2, offset: 1 }) as Row
    expect(paged).toMatchObject({ total: 5, offset: 1, limit: 2, truncated: true })
    expect(ids(paged)).toHaveLength(2)
  })

  it("says plainly when there are no patterns, or none match", () => {
    const empty = load((c) => {
      c.patterns = []
    })
    expect(((patternsView(empty) as Row).notes as string[])[0]).toMatch(/No patterns are defined/)
    expect(((patternsView(ds, { category: "dialog" }) as Row).notes as string[])[0]).toMatch(
      /No pattern matches these filters; the contract has 5/
    )
  })

  it("shows approval as approved only when every fact is", () => {
    const approved = load((c) => {
      const p = must(c.patterns.find((x) => x.id === "pattern:page.data-management"))
      for (const key of Object.keys(p.facts)) {
        const f = must(p.facts[key])
        if (f.status !== "approved") delete p.facts[key]
      }
    })
    expect(patternStatus(must(approved.pattern("pattern:page.data-management"))).overall).toBe("approved")
    const row = ((patternsView(approved) as Row).patterns as Row[]).find(
      (p) => p.id === "pattern:page.data-management"
    )
    expect(row?.approved).toBe(true)
  })
})

describe("patternView", () => {
  const view = patternView(ds, pattern("pattern:page.data-management")) as Row

  it("resolves references to names and keeps their kind", () => {
    expect(view.composition.parts.find((p: Row) => p.name === "toolbar").ref).toEqual({
      id: "pattern:composition.table-toolbar",
      kind: "pattern",
      name: "Table toolbar"
    })
    expect(view.composition.parts.find((p: Row) => p.name === "table").ref).toMatchObject({
      kind: "component",
      name: "DataTable"
    })
    expect(view.relationships.find((r: Row) => r.id === "frame").target.name).toBe("Application shell")
  })

  it("carries the status of the fact behind each part and edge", () => {
    expect(view.relationships.find((r: Row) => r.id === "delete").fact).toMatchObject({
      status: "inferred",
      confidence: 0.6
    })
    expect(view.relationships.find((r: Row) => r.id === "tools").fact.status).toBe("discovered")
    expect(view.relationships.find((r: Row) => r.id === "frame").fact).toBeNull()
  })

  it("returns evidence for every fact: source, method and location", () => {
    const delete_ = view.facts.find((f: Row) => f.path === "relationships.delete")
    expect(delete_.evidence).toHaveLength(1)
    expect(delete_.evidence[0]).toMatchObject({
      sourceId: "ui-react",
      method: "ast",
      location: "packages/ui-react/src/CustomerList.tsx:52"
    })
    const doc = view.facts.find((f: Row) => f.path === "intent")
    expect(doc.evidence[0]).toMatchObject({ method: "document-parse", location: "page/data-management" })
    expect(view.facts.map((f: Row) => f.path)).toEqual([...view.facts.map((f: Row) => f.path)].sort())
  })

  it("lists constraints with their kind and typed details", () => {
    expect(view.constraints.map((c: Row) => [c.id, c.kind])).toEqual([
      ["constraint:data-management.results-required", "required-region"],
      ["constraint:data-management.single-table", "cardinality"],
      ["constraint:data-management.toolbar-before-table", "ordering"]
    ])
    expect(view.constraints[1].details).toEqual({
      max: 1,
      min: 1,
      target: "component:data-table",
      within: "region:results"
    })
  })

  it("says it is not approved, and that nothing enforces it, until a policy does", () => {
    expect(view.approved).toBe(false)
    expect(view.enforcedBy).toEqual([])
    expect(view.notes.join(" ")).toMatch(/not fully approved \(mixed\)/)
    expect(view.notes.join(" ")).toMatch(/1 fact\(s\) are inferred/)

    const enforced = load((c) => {
      c.policies.push({
        id: "policy:data-management.single-table",
        name: "One table",
        statement: "Exactly one table.",
        severity: "error",
        enforcement: "block",
        scope: { entities: ["pattern:page.data-management"] },
        basedOn: ["constraint:data-management.single-table"],
        approval: { approvedBy: "owners", approvedAt: "2026-11-03T10:00:00.000Z" }
      })
    })
    const v = patternView(enforced, must(enforced.pattern("pattern:page.data-management"))) as Row
    expect(v.enforcedBy).toEqual([
      expect.objectContaining({
        policy: "policy:data-management.single-table",
        enforcement: "block",
        constraints: ["constraint:data-management.single-table"]
      })
    ])
  })

  it("says when a pattern has no constraints, and reports a missing constraint instead of hiding it", () => {
    const toolbar = patternView(ds, pattern("pattern:composition.table-toolbar")) as Row
    expect(toolbar.notes.join(" ")).toMatch(/No constraints are attached/)
    const broken = load((c) => {
      must(c.patterns.find((p) => p.id === "pattern:page.data-management")).constraints = ["constraint:gone"]
    })
    const v = patternView(broken, must(broken.pattern("pattern:page.data-management"))) as Row
    expect(v.constraints).toEqual([{ id: "constraint:gone", missing: true }])
  })

  it("is plain JSON and the same every time", () => {
    const again = patternView(ds, pattern("pattern:page.data-management"))
    expect(JSON.parse(JSON.stringify(view))).toEqual(view)
    expect(again).toEqual(view)
  })
})

describe("patternRelationships", () => {
  const root = pattern("pattern:page.data-management")
  const edges = (v: unknown): string[] =>
    ((v as Row).edges as Row[]).map(
      (e) => `${e.from.replace(/^[a-z]+:/, "")} ${e.type} ${e.to.replace(/^[a-z]+:/, "")}`
    )

  it("follows outgoing edges one step by default and marks composition parts", () => {
    const v = patternRelationships(ds, root, { direction: "out" }) as Row
    expect(edges(v)).toEqual(
      [
        "page.data-management composes composition.table-toolbar",
        "page.data-management composes layout.application-shell",
        "page.data-management part component:data-table",
        "page.data-management part component:empty-state",
        "page.data-management part component:page-header",
        "page.data-management part component:pagination",
        "page.data-management part composition.table-toolbar",
        "page.data-management uses component:button",
        "page.data-management uses interaction.destructive-confirmation"
      ].map((e) => e.replace(/component:/g, ""))
    )
    expect(v.edges.find((e: Row) => e.id === "table")).toMatchObject({ via: "composition", role: "required" })
    expect(v.edges.find((e: Row) => e.id === "delete")).toMatchObject({ status: "inferred" })
  })

  it("reports who points at a pattern, and walks deeper on request", () => {
    const toolbar = pattern("pattern:composition.table-toolbar")
    const incoming = patternRelationships(ds, toolbar, { direction: "in" }) as Row
    expect(incoming.edges.map((e: Row) => e.from)).toEqual([
      "pattern:page.data-management",
      "pattern:page.data-management"
    ])
    const shallow = patternRelationships(ds, root, { direction: "out", depth: 1 }) as Row
    const deep = patternRelationships(ds, root, { direction: "out", depth: 2 }) as Row
    expect(deep.edges.length).toBeGreaterThan(shallow.edges.length)
    expect(deep.edges.some((e: Row) => e.from === "pattern:composition.table-toolbar")).toBe(true)
  })

  it("filters by relationship type", () => {
    const v = patternRelationships(ds, root, { direction: "out", types: ["composes"] }) as Row
    expect(v.edges.map((e: Row) => e.type)).toEqual(["composes", "composes"])
  })

  it("marks the root, names every node, and clamps the depth", () => {
    const v = patternRelationships(ds, root, { depth: 99 }) as Row
    expect(v.depth).toBe(5)
    expect(v.nodes.find((n: Row) => n.root)).toMatchObject({ id: root.id, category: "page" })
    expect(v.nodes.every((n: Row) => typeof n.name === "string")).toBe(true)
  })

  it("terminates on a cycle that the contract allows (`uses` may be cyclic)", () => {
    const cyclic = load((c) => {
      const shell = must(c.patterns.find((p) => p.id === "pattern:layout.application-shell"))
      shell.relationships = [{ id: "back", type: "uses", target: "pattern:page.data-management" }]
    })
    const v = patternRelationships(cyclic, must(cyclic.pattern("pattern:page.data-management")), {
      direction: "out",
      depth: 5
    }) as Row
    expect(v.edges.some((e: Row) => e.id === "back")).toBe(true)
    expect(v.truncated).toBe(false)
  })

  it("says so when there is nothing to report and never invents an edge", () => {
    const lonely = pattern("pattern:form.login")
    const v = patternRelationships(ds, lonely) as Row
    expect(v.edges).toEqual([])
    expect(v.notes[0]).toMatch(/no relationships/)
  })
})

describe("search over patterns", () => {
  it("finds patterns by name, intent, part, region and state, and says what matched", () => {
    const hit = (q: string) => search(ds, q, ["pattern"]).hits[0]
    expect(hit("toolbar")).toMatchObject({ id: "pattern:composition.table-toolbar", matchedOn: ["name"] })
    expect(hit("results region")?.id).toBe("pattern:page.data-management")
    expect(hit("confirming")?.matchedOn).toContain("state")
    expect(hit("accidental data loss")?.id).toBe("pattern:interaction.destructive-confirmation")
  })

  it("is included by default, tolerates plurals and typos, and can be left out", () => {
    expect(search(ds, "toolbars").hits.map((h) => h.id)).toContain("pattern:composition.table-toolbar")
    expect(search(ds, "toolbarr").hits.map((h) => h.id)).toContain("pattern:composition.table-toolbar")
    expect(search(ds, "toolbar", ["component"]).hits.some((h) => h.kind === "pattern")).toBe(false)
  })
})
