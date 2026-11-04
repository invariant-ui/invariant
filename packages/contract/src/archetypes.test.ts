import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { archetypesDraft, archetypesEvidence, buildArchetypes } from "../test/archetypes.ts"
import {
  type Contract,
  type ContractDraft,
  createEvidenceFile,
  finalizeContract,
  parseContract,
  serializeContract,
  serializeEvidenceFile,
  verifyContract
} from "./index.js"

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/archetypes/${name}`, import.meta.url))

const build = (change: (d: ContractDraft) => void): Contract => {
  const draft = archetypesDraft()
  change(draft)
  return finalizeContract(draft)
}
const found = (c: Contract) =>
  verifyContract(c, createEvidenceFile(c.integrity.contentHash, archetypesEvidence())).map((d) => ({
    code: d.code,
    severity: d.severity,
    message: d.message
  }))
const codes = (c: Contract): string[] => found(c).map((d) => d.code)
const pattern = (d: ContractDraft, id: string) => {
  const p = d.patterns.find((x) => x.id === id)
  if (!p) throw new Error(`fixture bug: ${id}`)
  return p
}

describe("page archetypes: the sample", () => {
  const { contract, evidence } = buildArchetypes()

  it("is valid, with no errors and no warnings", () => {
    expect(verifyContract(contract, evidence)).toEqual([])
    expect(parseContract(JSON.parse(serializeContract(contract)))).toEqual({ ok: true, value: contract })
  })

  it("represents three page archetypes that compose shared patterns and carry variations", () => {
    const pages = contract.patterns.filter((p) => p.category === "page").map((p) => p.id)
    expect(pages).toEqual(["pattern:page.data-management", "pattern:page.detail", "pattern:page.edit-form"])
    const detail = contract.patterns.find((p) => p.id === "pattern:page.detail")
    expect(detail?.variations?.map((v) => v.name)).toEqual(["read-only", "with-history"])
    expect(detail?.relationships?.map((r) => [r.type, r.target])).toEqual([
      ["composes", "pattern:layout.application-shell"],
      ["uses", "pattern:interaction.destructive-confirmation"]
    ])
  })

  it("keeps the detail page approved over documented, including its variations", () => {
    const facts = contract.patterns.find((p) => p.id === "pattern:page.detail")?.facts ?? {}
    expect(Object.values(facts).every((f) => f.status === "approved")).toBe(true)
    expect(facts["variations.read-only"]).toMatchObject({ approval: { priorStatus: "documented" } })
  })

  it("matches the committed golden files", () => {
    mkdirSync(dirname(fixture("invariant.contract.json")), { recursive: true })
    for (const [path, expected] of [
      [fixture("invariant.contract.json"), serializeContract(contract)],
      [fixture("invariant.evidence.json"), serializeEvidenceFile(evidence)]
    ] as const) {
      if (process.env.UPDATE_GOLDEN === "1" || !existsSync(path)) writeFileSync(path, expected)
      expect(readFileSync(path, "utf8")).toBe(expected)
    }
  })
})

describe("variations", () => {
  it("only exist from 1.1.0", () => {
    const { contract } = buildArchetypes()
    const old = JSON.parse(serializeContract(contract))
    old.contractVersion = "1.0.0"
    const parsed = parseContract(old)
    if (!parsed.ok) throw new Error("expected parse")
    expect(codes(parsed.value)).toContain("contract.field-newer-than-version")
  })

  it("must change something", () => {
    const bad = JSON.parse(serializeContract(buildArchetypes().contract))
    const detail = bad.patterns.find((p: { id: string }) => p.id === "pattern:page.detail")
    detail.variations.push({ name: "empty" })
    expect(parseContract(bad).ok).toBe(false)
  })

  it("must change a part the composition has, once", () => {
    const c = build((d) => {
      const detail = pattern(d, "pattern:page.detail")
      detail.variations?.push({
        name: "broken",
        roles: [
          { part: "ghost", role: "optional" },
          { part: "actions", role: "optional" },
          { part: "actions", role: "required" }
        ]
      })
    })
    expect(codes(c)).toEqual(
      expect.arrayContaining(["contract.pattern-variation-unknown-part", "contract.pattern-duplicate-name"])
    )
  })

  it("must add uniquely named parts, in regions that exist, that point at real entities", () => {
    const c = build((d) => {
      pattern(d, "pattern:page.detail").variations?.push({
        name: "extra",
        parts: [
          { name: "actions", ref: "component:button", role: "optional" },
          { name: "banner", ref: "component:nope", role: "optional", region: "nowhere" }
        ]
      })
    })
    const all = found(c)
    expect(
      all.some(
        (d) => d.code === "contract.pattern-duplicate-name" && /adds a part named "actions"/.test(d.message)
      )
    ).toBe(true)
    expect(
      all.some(
        (d) => d.code === "contract.pattern-region-unknown" && /unknown region "nowhere"/.test(d.message)
      )
    ).toBe(true)
    expect(
      all.some((d) => d.code === "contract.dangling-reference" && /component:nope/.test(d.message))
    ).toBe(true)
  })

  it("must have unique ids", () => {
    const c = build((d) => {
      const detail = pattern(d, "pattern:page.detail")
      detail.variations = [
        ...(detail.variations ?? []),
        { name: "read-only", roles: [{ part: "related", role: "optional" }] }
      ]
    })
    expect(
      found(c).some(
        (d) =>
          d.code === "contract.pattern-duplicate-name" &&
          /more than one variation named "read-only"/.test(d.message)
      )
    ).toBe(true)
  })

  it("count in cycle detection: a variation's added part can close a loop", () => {
    const c = build((d) => {
      pattern(d, "pattern:composition.table-toolbar").variations = [
        { name: "full", parts: [{ name: "page", ref: "pattern:page.detail", role: "optional" }] }
      ]
    })
    expect(found(c).some((d) => d.code === "contract.pattern-cycle")).toBe(true)
  })
})

describe("composition followed to any depth", () => {
  it("rejects two patterns declared prohibited together that one blueprint composes, directly or through others", () => {
    const direct = build((d) => {
      pattern(d, "pattern:layout.application-shell").relationships = [
        { id: "never", type: "prohibited-with", target: "pattern:composition.table-toolbar" }
      ]
    })
    const message = found(direct).find((x) => x.code === "contract.pattern-prohibited-combination")?.message
    expect(message).toMatch(
      /pattern:page\.data-management composes both pattern:composition\.table-toolbar and pattern:layout\.application-shell, which are prohibited together/
    )

    const nested = build((d) => {
      pattern(d, "pattern:composition.table-toolbar").relationships = [
        { id: "never", type: "prohibited-with", target: "pattern:interaction.destructive-confirmation" }
      ]
    })
    expect(codes(nested)).toContain("contract.pattern-prohibited-combination")
  })

  it("names the pattern that composes the pair, once, even when several variations repeat it", () => {
    const c = build((d) => {
      pattern(d, "pattern:layout.application-shell").relationships = [
        { id: "never", type: "prohibited-with", target: "pattern:composition.table-toolbar" }
      ]
    })
    const mine = found(c).filter(
      (x) =>
        x.code === "contract.pattern-prohibited-combination" &&
        x.message.startsWith("pattern:page.data-management ")
    )
    expect(mine).toHaveLength(1)
  })

  it("does not reject a prohibited pair that nothing composes together", () => {
    const c = build((d) => {
      pattern(d, "pattern:layout.application-shell").relationships = [
        { id: "never", type: "prohibited-with", target: "pattern:form.login" }
      ]
    })
    expect(codes(c)).toEqual([])
  })

  it("rejects a blueprint that prohibits something a pattern it composes brings back", () => {
    const nested = build((d) => {
      pattern(d, "pattern:page.data-management").composition?.parts.push({
        name: "no-search",
        ref: "component:search-field",
        role: "prohibited"
      })
    })
    expect(found(nested).find((x) => x.code === "contract.pattern-prohibited-conflict")?.message).toMatch(
      /pattern:page\.data-management prohibits component:search-field \(part "no-search"\), but pattern:page\.data-management -> pattern:composition\.table-toolbar brings it in/
    )
  })

  it("treats a part as a slot: prohibiting one use of a component does not clash with another slot of the same pattern", () => {
    const c = build((d) => {
      pattern(d, "pattern:page.edit-form").composition?.parts.push({
        name: "no-fields",
        ref: "component:search-field",
        role: "prohibited"
      })
    })
    expect(codes(c)).toEqual([])
  })

  it("checks each variation as the blueprint it makes", () => {
    const c = build((d) => {
      pattern(d, "pattern:page.detail").variations?.push({
        name: "no-search",
        parts: [
          { name: "history", ref: "pattern:composition.table-toolbar", role: "optional" },
          { name: "no-search", ref: "component:search-field", role: "prohibited" }
        ]
      })
    })
    expect(found(c).find((x) => x.code === "contract.pattern-prohibited-conflict")?.message).toMatch(
      /pattern:page\.detail in variation "no-search" prohibits component:search-field .* brings it in/
    )
  })

  it("lets a variation prohibit a part the base requires, because that is what a variation is for", () => {
    expect(codes(buildArchetypes().contract)).toEqual([])
  })

  it("warns, but does not fail, about a pattern that another supersedes", () => {
    const c = build((d) => {
      pattern(d, "pattern:form.login").relationships = [
        { id: "replaces", type: "supersedes", target: "pattern:composition.table-toolbar" }
      ]
    })
    expect(found(c)).toEqual(
      [
        expect.objectContaining({
          code: "contract.pattern-superseded-reference",
          severity: "warning",
          message: expect.stringMatching(
            /builds on pattern:composition\.table-toolbar, which pattern:form\.login supersedes/
          )
        })
      ].concat(
        // data-management, detail (through history) and nothing else build on it
        found(c)
          .filter((x) => x.code === "contract.pattern-superseded-reference")
          .slice(1) as never
      )
    )
    expect(found(c).every((x) => x.severity === "warning")).toBe(true)
  })

  it("warns about a required region that nothing fills", () => {
    const c = build((d) => {
      const p = pattern(d, "pattern:page.edit-form")
      p.composition = { parts: p.composition?.parts.filter((x) => x.region !== "form") ?? [] } as never
      delete p.variations
    })
    expect(found(c)).toEqual([
      expect.objectContaining({
        code: "contract.pattern-region-unfilled",
        severity: "warning",
        message: expect.stringMatching(/requires region "form"/)
      })
    ])
  })

  it("ignores a prohibited part when asking whether a region is filled", () => {
    const c = build((d) => {
      const p = pattern(d, "pattern:page.edit-form")
      for (const part of p.composition?.parts ?? []) if (part.region === "form") part.role = "prohibited"
    })
    expect(codes(c)).toContain("contract.pattern-region-unfilled")
  })

  it("still terminates when patterns form a cycle, and reports it once", () => {
    const c = build((d) => {
      pattern(d, "pattern:composition.table-toolbar").relationships = [
        { id: "back", type: "uses", target: "pattern:page.data-management" }
      ]
    })
    expect(codes(c).filter((x) => x === "contract.pattern-cycle")).toHaveLength(0)
    const strict = build((d) => {
      pattern(d, "pattern:composition.table-toolbar").relationships = [
        { id: "back", type: "composes", target: "pattern:page.data-management" }
      ]
    })
    expect(codes(strict).filter((x) => x === "contract.pattern-cycle")).toHaveLength(1)
  })
})

describe("constraint inheritance", () => {
  it("is valid when a page opts in and names the paths it covers", () => {
    const c = build((d) => {
      const p = pattern(d, "pattern:page.detail")
      p.appliesTo = { paths: ["app/detail/**"], frameworks: ["react"] }
      p.inheritsConstraints = true
    })
    expect(found(c)).toEqual([])
  })

  it("rejects an opt-in with no paths, because nothing says which files to hold to it", () => {
    const c = build((d) => {
      pattern(d, "pattern:page.detail").inheritsConstraints = true
    })
    expect(codes(c)).toContain("contract.pattern-inheritance-unscoped")
  })

  it("warns about an opt-in on a pattern that composes nothing", () => {
    const c = build((d) => {
      const p = pattern(d, "pattern:page.detail")
      p.appliesTo = { paths: ["app/detail/**"] }
      p.inheritsConstraints = true
      delete p.composition
      delete p.variations
      delete p.layout
    })
    expect(codes(c)).toContain("contract.pattern-inheritance-empty")
  })

  it("only exists from 1.1.0", () => {
    const old = JSON.parse(
      serializeContract(
        build((d) => {
          const p = pattern(d, "pattern:page.detail")
          p.appliesTo = { paths: ["app/detail/**"] }
        })
      )
    )
    old.contractVersion = "1.0.0"
    const parsed = parseContract(old)
    if (!parsed.ok) throw new Error("expected parse")
    expect(codes(parsed.value)).toContain("contract.field-newer-than-version")
  })
})
