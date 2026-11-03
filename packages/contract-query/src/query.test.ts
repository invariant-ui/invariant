import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  type Contract,
  type EvidenceFile,
  evidenceFileSchema,
  parseContract,
  type Token
} from "@invariant/contract"
import { describe, expect, it } from "vitest"
import {
  catalog,
  compositionView,
  DesignSystem,
  guidelinesView,
  overview,
  patternsView,
  search,
  tokensView,
  usageView
} from "./index.js"
import { componentView } from "./views.js"

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

describe("lookup", () => {
  it("finds components by id, bare id, or name ignoring case and separators", () => {
    const ds = acme()
    for (const q of ["component:button", "button", "BUTTON", "Button"])
      expect(ds.findComponent(q).match?.id).toBe("component:button")
    expect(ds.findComponent("card.header").match?.id).toBe("component:card.header")
    expect(ds.findComponent("Card Header").match?.id).toBe("component:card.header")
  })

  it("offers near names instead of guessing", () => {
    const r = acme().findComponent("butt")
    expect(r.match).toBeUndefined()
    expect(r.candidates.map((c) => c.id)).toContain("component:button")
    expect(acme().findComponent("zzzz").candidates).toEqual([])
  })

  it("resolves evidence to file locations", () => {
    const ds = acme()
    const button = ds.component("component:button")
    expect(ds.factView(button?.facts ?? {}, "props.variant.type.text")?.source).toMatch(
      /^src\/Button\.tsx:\d+$/
    )
  })
})

describe("views", () => {
  it("summarizes the design system with honest notes", () => {
    const o = overview(acme()) as Record<string, any>
    expect(o.counts.components).toBe(14)
    expect(o.counts.patterns).toBe(0)
    expect(o.openConflicts.total).toBe(6)
    expect(o.notes.join(" ")).toMatch(/No patterns/)
    expect(o.notes.join(" ")).toMatch(/No approved policies/)
    expect(o.notes.join(" ")).toMatch(/incomplete API/)
    expect(o.contentHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("describes a component with status, conflicts and an incompleteness warning", () => {
    const ds = acme()
    const v = componentView(ds, ds.component("component:button") as never) as Record<string, any>
    const variant = v.props.find((p: { name: string }) => p.name === "variant")
    expect(variant).toMatchObject({
      type: expect.stringContaining("primary"),
      allowedValues: ["primary", "secondary", "ghost"],
      status: { status: "discovered" }
    })
    expect(v.implementations[0]).toMatchObject({ framework: "react", apiComplete: false })
    expect(v.conflicts.length).toBe(3)
    expect(v.notes.join(" ")).toMatch(/incomplete/)
  })

  it("lists usage facts: required props, defaults, variants, deprecations, examples", () => {
    const ds = acme()
    const u = usageView(ds, ds.component("component:button") as never) as Record<string, any>
    expect(u.requiredProps).toEqual(["children"])
    expect(u.defaults).toMatchObject({ size: "md", variant: "primary" })
    expect(u.deprecatedProps.map((d: { name: string }) => d.name)).toEqual(["plain"])
    expect(u.examples[0].code).toContain("<Button")
    expect(u.observedUsage).toBeDefined()
  })

  it("shows composition both ways", () => {
    const ds = acme()
    const card = compositionView(ds, ds.component("component:card") as never) as Record<string, any>
    expect(card.contains.map((c: { id: string }) => c.id)).toEqual([
      "component:card.body",
      "component:card.header"
    ])
    const header = compositionView(ds, ds.component("component:card.header") as never) as Record<string, any>
    expect(header.containedBy.map((c: { id: string }) => c.id)).toEqual(["component:card"])
    expect(header.notes.join(" ")).toMatch(/does not mean/)
  })

  it("lists the catalog, guidelines with their limits, and says there are no patterns", () => {
    const ds = acme()
    expect(catalog(ds).length).toBe(14)
    const g = guidelinesView(ds, { component: "button" }) as Record<string, any>
    expect(g.guidelines.length).toBeGreaterThan(0)
    expect(g.notes.join(" ")).toMatch(/page title/)
    expect((guidelinesView(ds, { component: "nope" }) as Record<string, any>).notes.join(" ")).toMatch(
      /No component matches/
    )
    expect((patternsView(ds) as Record<string, any>).notes.join(" ")).toMatch(/No patterns/)
  })

  it("resolves token aliases and modes, and refuses to guess on cycles or missing targets", () => {
    const ds = withTokens([
      token("color-brand", { value: "#0057ff" }, { modes: { "theme:dark": { value: "#4d8dff" } } as never }),
      token("color-action", { aliasOf: "token:color-brand" } as never),
      token("loop-a", { aliasOf: "token:loop-b" } as never),
      token("loop-b", { aliasOf: "token:loop-a" } as never),
      token("dangling", { aliasOf: "token:nowhere" } as never)
    ])
    const out = tokensView(ds, {}) as Record<string, any>
    const by = Object.fromEntries(out.tokens.map((t: { id: string }) => [t.id, t]))
    expect(by["token:color-action"]).toMatchObject({
      aliasOf: "token:color-brand",
      resolvedValue: "#0057ff",
      aliasChain: ["token:color-action", "token:color-brand"]
    })
    expect(by["token:loop-a"].note).toBe("alias cycle")
    expect(by["token:loop-a"].resolvedValue).toBeUndefined()
    expect(by["token:dangling"].note).toMatch(/not in the contract/)
    const dark = tokensView(ds, { theme: "dark", query: "action" }) as Record<string, any>
    expect(dark.tokens[0].resolvedValue).toBe("#4d8dff")
    expect((tokensView(ds, { category: "spacing" }) as Record<string, any>).total).toBe(0)
  })

  it("pages long lists and says when it truncated", () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      token(`t${String(i).padStart(3, "0")}`, { value: "x" })
    )
    const out = tokensView(withTokens(many), { limit: 50 }) as Record<string, any>
    expect(out).toMatchObject({ total: 120, truncated: true })
    expect(out.tokens).toHaveLength(50)
    expect((tokensView(withTokens(many), { offset: 100, limit: 50 }) as Record<string, any>).truncated).toBe(
      false
    )
  })
})

describe("search", () => {
  const ds = acme()
  it("ranks a name match above structure matches, deterministically", () => {
    const r = search(ds, "button")
    expect(r.hits[0]).toMatchObject({ id: "component:button", kind: "component" })
    expect(search(ds, "button")).toEqual(r)
  })
  it("finds components by prop, variant value, and slot", () => {
    expect(search(ds, "elevated").hits.map((h) => h.id)).toContain("component:card")
    const byVariant = search(ds, "ghost")
    expect(byVariant.hits[0]?.id).toBe("component:button")
    expect(byVariant.hits[0]?.matchedOn).toContain("variant")
  })
  it("restricts kinds and limits results", () => {
    expect(search(ds, "button", ["token"]).hits).toEqual([])
    expect(search(ds, "a", ["component"], 3).hits.length).toBeLessThanOrEqual(3)
    expect(search(ds, "").hits).toEqual([])
  })

  it("matches plurals, prefixes and one-letter typos, and says when a match is approximate", () => {
    expect(search(ds, "buttons").hits.map((h) => h.id)).toContain("component:button")
    expect(search(ds, "varian").hits.length).toBeGreaterThan(0)
    const typo = search(ds, "buttton")
    expect(typo.hits.map((h) => h.id)).toContain("component:button")
    expect(typo.hits.find((h) => h.id === "component:button")?.matchedOn).toEqual(["name (approximate)"])
    // An exact match always outranks an approximate one.
    const exact = search(ds, "button").hits.find((h) => h.id === "component:button")
    expect((exact?.score ?? 0) > (typo.hits.find((h) => h.id === "component:button")?.score ?? 0)).toBe(true)
  })

  it("does not invent matches for unrelated words and stays deterministic", () => {
    expect(search(ds, "zzzzzz").hits).toEqual([])
    expect(search(ds, "buttons")).toEqual(search(ds, "buttons"))
  })
})
