import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { type Contract, evidenceFileSchema, parseContract } from "@invariant/contract"
import { describe, expect, it } from "vitest"
import { archetypeView, DesignSystem } from "./index.js"

const file = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../contract/fixtures/archetypes/${name}`, import.meta.url)), "utf8")

function load(change?: (c: Contract) => void): DesignSystem {
  const parsed = parseContract(JSON.parse(file("invariant.contract.json")))
  if (!parsed.ok) throw new Error("fixture contract invalid")
  const contract = structuredClone(parsed.value)
  change?.(contract)
  return new DesignSystem(contract, evidenceFileSchema.parse(JSON.parse(file("invariant.evidence.json"))))
}

const ds = load()
type Row = Record<string, any>
const view = (id: string, variation?: string, system = ds): Row => {
  const p = system.pattern(id)
  if (!p) throw new Error(`no ${id}`)
  const r = archetypeView(system, p, { variation })
  if (!r.ok) throw new Error(r.message)
  return r.view as Row
}

describe("archetypeView: composition followed to any depth", () => {
  const v = view("pattern:page.detail")

  it("shows the blueprint's regions with the parts placed in each", () => {
    expect(v.regions).toEqual([
      { name: "header", required: true, parts: ["header", "actions"] },
      { name: "summary", required: true, parts: ["summary"] },
      {
        name: "related",
        required: false,
        parts: ["related"],
        responsive: [{ breakpoint: "token:breakpoint.md", behavior: "stack" }]
      }
    ])
  })

  it("expands the patterns it composes and uses, each once in the list of patterns it builds on", () => {
    expect(v.patterns.map((p: Row) => [p.id, p.depth])).toEqual([
      ["pattern:page.detail", 0],
      ["pattern:interaction.destructive-confirmation", 1],
      ["pattern:layout.application-shell", 1]
    ])
    const related = (v.composition.related as Row[]).map((r) => [r.type, r.target.id, r.expanded?.pattern.id])
    expect(related).toEqual([
      ["composes", "pattern:layout.application-shell", "pattern:layout.application-shell"],
      ["uses", "pattern:interaction.destructive-confirmation", "pattern:interaction.destructive-confirmation"]
    ])
  })

  it("goes more than one level down", () => {
    const dm = view("pattern:page.data-management")
    const toolbar = (dm.composition.parts as Row[]).find((p) => p.name === "toolbar")
    expect(toolbar?.expanded.pattern.id).toBe("pattern:composition.table-toolbar")
    expect(((toolbar?.expanded.parts ?? []) as Row[]).map((p) => p.ref.id)).toEqual([
      "component:search-field",
      "component:button"
    ])
    expect(dm.patterns.map((p: Row) => p.id)).toContain("pattern:composition.table-toolbar")
  })

  it("says plainly which of the patterns it builds on are not approved", () => {
    expect(v.approved).toBe(true)
    expect(v.unapproved).toEqual([
      "pattern:interaction.destructive-confirmation",
      "pattern:layout.application-shell"
    ])
    expect(v.notes.join(" ")).toMatch(
      /This archetype is approved, but 2 pattern\(s\) it builds on are not: pattern:interaction\.destructive-confirmation, pattern:layout\.application-shell\. Approval of the archetype does not approve them/
    )
  })

  it("calls an archetype that is not approved a proposal", () => {
    const edit = view("pattern:page.edit-form")
    expect(edit.approved).toBe(false)
    expect(edit.notes.join(" ")).toMatch(/not fully approved \(documented\)\. Treat it as a proposal/)
  })

  it("lists the responsive expectations of everything it builds on", () => {
    expect(v.responsive).toEqual([
      {
        pattern: "pattern:page.detail",
        region: "related",
        breakpoint: "token:breakpoint.md",
        behavior: "stack"
      }
    ])
    const dm = view("pattern:page.data-management")
    expect(dm.responsive.map((r: Row) => r.region)).toEqual(["results"])
  })
})

describe("archetypeView: variations", () => {
  it("lists each variation with when to use it, what it changes, what it adds and its status", () => {
    const v = view("pattern:page.detail")
    expect(v.variations.map((x: Row) => x.name)).toEqual(["read-only", "with-history"])
    const history = v.variations.find((x: Row) => x.name === "with-history")
    expect(history).toMatchObject({
      when: "The record keeps an audit trail.",
      roles: [{ part: "related", role: "required" }],
      addedParts: [
        {
          name: "history",
          role: "optional",
          ref: { id: "pattern:composition.table-toolbar", kind: "pattern" }
        }
      ],
      fact: { status: "approved" }
    })
  })

  it("applies a named variation to the blueprint's own parts", () => {
    const base = view("pattern:page.detail")
    const readOnly = view("pattern:page.detail", "read-only")
    expect(readOnly.variation).toBe("read-only")
    expect(readOnly.regions[0].parts).toEqual(["header"])
    expect(readOnly.prohibited.parts).toEqual([
      { name: "actions", ref: { id: "component:button", kind: "component", name: "Button" } }
    ])
    expect(base.prohibited.parts).toEqual([])
    const withHistory = view("pattern:page.detail", "with-history")
    expect(withHistory.regions[2].parts).toEqual(["related", "history"])
    expect(withHistory.patterns.map((p: Row) => p.id)).toContain("pattern:composition.table-toolbar")
    expect(base.patterns.map((p: Row) => p.id)).not.toContain("pattern:composition.table-toolbar")
    expect(readOnly.notes.join(" ")).toMatch(/Showing the "read-only" variation/)
  })

  it("refuses an unknown variation and says which exist", () => {
    const r = archetypeView(ds, ds.pattern("pattern:page.detail") as never, { variation: "nope" })
    expect(r).toEqual({
      ok: false,
      message: 'pattern:page.detail has no variation "nope"; its variations are read-only, with-history',
      variations: ["read-only", "with-history"]
    })
    const none = archetypeView(ds, ds.pattern("pattern:layout.application-shell") as never, {
      variation: "x"
    })
    expect(none).toMatchObject({ ok: false, message: expect.stringMatching(/\(it has none\)/) })
  })
})

describe("archetypeView: required interaction states and constraints", () => {
  const edit = view("pattern:page.edit-form")

  it("collects the states required by the patterns it uses, with the level each asks for", () => {
    expect(edit.requiredStates).toEqual([
      expect.objectContaining({
        pattern: "pattern:interaction.form-workflow",
        workflow: "form-submission",
        state: "error",
        minimum: "structural",
        enforced: false
      }),
      expect.objectContaining({
        pattern: "pattern:interaction.form-workflow",
        workflow: "form-submission",
        state: "submitting",
        minimum: "static-inferred",
        enforced: false
      })
    ])
  })

  it("says that a constraint no approved policy is based on is not enforced, and shows one that is", () => {
    expect(edit.notes.join(" ")).toMatch(
      /2 constraint\(s\) have no approved policy, so `validate` does not enforce them/
    )
    const enforced = load((c) => {
      c.policies.push({
        id: "policy:form.error",
        name: "Form error",
        statement: "x",
        severity: "error",
        enforcement: "block",
        scope: { entities: ["pattern:interaction.form-workflow"] },
        basedOn: ["constraint:form.shows-error"],
        approval: { approvedBy: "owners", approvedAt: "2026-11-03T10:00:00.000Z" }
      })
    })
    const v = view("pattern:page.edit-form", undefined, enforced)
    expect(v.requiredStates.find((s: Row) => s.state === "error")).toMatchObject({
      enforced: true,
      enforcedBy: ["policy:form.error"]
    })
    expect(v.notes.join(" ")).toMatch(/1 constraint\(s\) have no approved policy/)
  })

  it("lists the structural constraints of what it builds on", () => {
    const detail = view("pattern:page.detail")
    expect(detail.constraints).toEqual([
      {
        pattern: "pattern:page.detail",
        constraint: "constraint:detail.summary-required",
        kind: "required-region",
        enforced: false,
        enforcedBy: []
      }
    ])
  })
})

describe("archetypeView: prohibited combinations and trouble", () => {
  it("lists what each pattern says is prohibited with it, and whether this blueprint composes both", () => {
    const v = view(
      "pattern:page.detail",
      undefined,
      load((c) => {
        const shell = c.patterns.find((p) => p.id === "pattern:layout.application-shell")
        if (shell)
          shell.relationships = [{ id: "never", type: "prohibited-with", target: "pattern:form.login" }]
      })
    )
    expect(v.prohibited.patterns).toEqual([
      { pattern: "pattern:layout.application-shell", with: "pattern:form.login", composedHere: false }
    ])
  })

  it("stops at a pattern it has already followed, so a cycle the contract allows cannot loop", () => {
    const system = load((c) => {
      const shell = c.patterns.find((p) => p.id === "pattern:layout.application-shell")
      if (shell) shell.relationships = [{ id: "back", type: "uses", target: "pattern:page.detail" }]
    })
    const v = view("pattern:page.detail", undefined, system)
    const frame = (v.composition.related as Row[]).find(
      (r) => r.target.id === "pattern:layout.application-shell"
    )
    expect(((frame?.expanded.related ?? []) as Row[])[0]?.expanded).toEqual({ cycle: true })
  })

  it("names a pattern the contract does not have, instead of dropping it", () => {
    const v = view(
      "pattern:page.detail",
      undefined,
      load((c) => {
        const detail = c.patterns.find((p) => p.id === "pattern:page.detail")
        detail?.relationships?.push({ id: "ghost", type: "uses", target: "pattern:nope" })
      })
    )
    expect(v.notes.join(" ")).toMatch(/refers to pattern\(s\) the contract does not have: pattern:nope/)
  })

  it("stops after six levels and says so", () => {
    const system = load((c) => {
      const chain = Array.from({ length: 9 }, (_, i) => `pattern:composition.chain-${i}`)
      for (const [i, id] of chain.entries())
        c.patterns.push({
          id,
          name: `Chain ${i}`,
          category: "composition",
          description: "x",
          components: [],
          guidelines: [],
          relationships:
            i < chain.length - 1 ? [{ id: "next", type: "composes", target: chain[i + 1] as never }] : [],
          facts: {}
        } as never)
      c.patterns.sort((a, b) => (a.id < b.id ? -1 : 1))
    })
    const v = view("pattern:composition.chain-0", undefined, system)
    expect(v.notes.join(" ")).toMatch(/followed 6 levels deep and then stopped/)
    expect(v.patterns).toHaveLength(6)
  })

  it("is plain JSON and the same every time", () => {
    const a = view("pattern:page.detail")
    expect(JSON.parse(JSON.stringify(a))).toEqual(a)
    expect(view("pattern:page.detail")).toEqual(a)
  })

  it("works for any pattern, not only pages", () => {
    const v = view("pattern:interaction.form-workflow")
    expect(v.category).toBe("interaction")
    expect(v.requiredStates).toHaveLength(2)
    expect(v.regions).toEqual([])
  })
})
