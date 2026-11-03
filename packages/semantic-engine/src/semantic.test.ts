import { IR_VERSION, type IrDocument } from "@invariant/compiler-ir"
import {
  CONTRACT_VERSION,
  type Component,
  type ContractDraft,
  computeEvidenceId,
  type Evidence,
  type FactRecord,
  finalizeContract,
  type Token,
  verifyContract
} from "@invariant/contract"
import { describe, expect, it } from "vitest"
import {
  assertAdditive,
  classifyDocuments,
  classifyTokens,
  enrich,
  inferCompounds,
  inferredFact
} from "./index.js"

const evidence = (ref: string): Evidence => {
  const base = {
    sourceId: "src",
    sourceRef: ref,
    location: { type: "file" as const, path: "a.ts", line: 1 },
    method: "ast" as const,
    extractor: { name: "t", version: "1" }
  }
  return {
    ...base,
    id: computeEvidenceId(base),
    verificationStatus: "unverified",
    capturedAt: "2026-01-01T00:00:00.000Z"
  }
}
const E = evidence("name")
const fact = (status: FactRecord["status"] = "discovered"): FactRecord => ({ status, evidenceIds: [E.id] })

const token = (name: string, extra: Partial<Token> = {}, factPaths: string[] = []): Token => ({
  id: `token:${name.toLowerCase()}` as Token["id"],
  name,
  category: "other",
  value: { value: "x" },
  facts: { name: fact(), ...Object.fromEntries(factPaths.map((p) => [p, fact()])) },
  ...extra
})

const component = (name: string, impl: { packageName?: string; file?: string } = {}): Component => ({
  id: `component:${name.toLowerCase()}` as Component["id"],
  name,
  implementations: [
    {
      id: "react",
      framework: "react",
      sourceId: "src",
      ...(impl.packageName ? { packageName: impl.packageName } : {}),
      ...(impl.file ? { extensions: { react: { file: impl.file } } } : {})
    }
  ],
  props: [],
  events: [],
  slots: [],
  variants: [],
  states: [],
  examples: [],
  composition: [],
  facts: { "implementations.react": fact() }
})

const draft = (parts: Partial<ContractDraft> = {}): ContractDraft => ({
  contractVersion: CONTRACT_VERSION,
  metadata: {
    contractId: "ds",
    name: "DS",
    compilerVersion: "1",
    frameworks: ["react"],
    compiledAt: "2026-01-01T00:00:00.000Z"
  },
  sources: [
    {
      id: "src",
      type: "react",
      location: ".",
      capabilities: [],
      health: { status: "ok", diagnosticCount: 0 }
    }
  ],
  themes: [],
  components: [],
  tokens: [],
  patterns: [],
  guidelines: [],
  constraints: [],
  policies: [],
  conflicts: [],
  ...parts
})

describe("inferredFact", () => {
  const ok = { rule: "r", confidence: 0.5, reasoning: "because", inputs: ["b", "a"], evidenceIds: [E.id] }
  it("builds a record with sorted inputs and the inferred status", () => {
    expect(inferredFact(ok)).toEqual({
      status: "inferred",
      evidenceIds: [E.id],
      confidence: 0.5,
      derivation: { rule: "r", reasoning: "because", inputs: ["a", "b"] }
    })
  })
  it("refuses evidence-free, reasoning-free or certain inferences", () => {
    expect(() => inferredFact({ ...ok, evidenceIds: [] })).toThrow(/evidence/)
    expect(() => inferredFact({ ...ok, reasoning: " " })).toThrow(/reasoning/)
    expect(() => inferredFact({ ...ok, confidence: 1 })).toThrow(/never certain/)
    expect(() => inferredFact({ ...ok, confidence: 0 })).toThrow(/never certain/)
  })
})

describe("token categories", () => {
  const category = (t: Token) => {
    const out = classifyTokens([t])[0] as Token
    return [out.category, out.facts.category?.derivation?.rule, out.facts.category?.confidence] as const
  }
  it("uses a declared DTCG type first", () => {
    expect(
      category(token("brand", { extensions: { dtcg: { type: "color" } } }, ["extensions.dtcg.type"]))
    ).toEqual(["color", "token-category.dtcg-type", 0.95])
    expect(
      category(token("space-md", { extensions: { dtcg: { type: "duration" } } }, ["extensions.dtcg.type"]))[0]
    ).toBe("motion")
  })
  it("falls through an ambiguous DTCG type to the name", () => {
    expect(
      category(token("space-md", { extensions: { dtcg: { type: "dimension" } } }, ["extensions.dtcg.type"]))
    ).toEqual(["spacing", "token-category.name-prefix", 0.7])
  })
  it("uses a colour CSS value kind before the name", () => {
    const t = token("primary", { extensions: { css: { root: { valueKind: "color" } } } }, [
      "extensions.css.root.valueKind"
    ])
    expect(category(t)).toEqual(["color", "token-category.value-kind", 0.9])
  })
  it("uses a conventional name prefix, across separators and case", () => {
    expect(category(token("--Shadow-card"))[0]).toBe("shadow")
    expect(category(token("font.family.sans"))[0]).toBe("typography")
    expect(category(token("radius-sm"))[0]).toBe("border")
    expect(category(token("breakpoint-md"))[0]).toBe("breakpoint")
  })
  it("keeps `other` with a low-confidence explanation when nothing identifies a category", () => {
    expect(category(token("zebra"))).toEqual(["other", "token-category.fallback", 0.2])
  })
  it("does not touch a token that already has a category fact, or a signal without evidence", () => {
    const t = token("color-x", {}, ["category"])
    expect(classifyTokens([t])[0]).toBe(t)
    expect(category(token("p", { extensions: { dtcg: { type: "color" } } }))[1]).toBe(
      "token-category.fallback"
    )
  })
})

describe("documentation pages", () => {
  const page = (path: string, title: string, headings: string[] = []): IrDocument => {
    const ev = evidence(path)
    return {
      irVersion: IR_VERSION,
      source: {
        id: "docs",
        type: "markdown",
        location: ".",
        inputHash: "0".repeat(64),
        adapter: { name: "md", version: "1" }
      },
      capabilities: ["*"],
      completeness: "complete",
      entities: [{ ref: `doc:${path}`, kind: "doc-page", name: title }],
      facts: [
        { subject: `doc:${path}`, path: "doc.title", value: title, origin: "authored", evidenceIds: [ev.id] },
        {
          subject: `doc:${path}`,
          path: "doc.headings",
          value: headings.map((text, i) => ({ level: 2, line: i + 1, text })),
          origin: "authored",
          evidenceIds: [ev.id]
        }
      ],
      evidence: [ev],
      diagnostics: []
    }
  }
  const run = (doc: IrDocument, components: Component[] = [component("Button"), component("Card")]) =>
    classifyDocuments([doc], components)

  it("creates a guideline with the title as statement, a reference, and an inferred kind", () => {
    const g = run(page("docs/intro.md", "Welcome")).guidelines[0]
    expect(g).toMatchObject({
      id: "guideline:docs/intro",
      name: "Welcome",
      statement: "Welcome",
      kind: "reference",
      appliesTo: []
    })
    expect(g?.references).toEqual([{ sourceId: "docs", documentId: "docs/intro.md", title: "Welcome" }])
    expect(g?.facts.statement?.status).toBe("documented")
    expect(g?.facts["references.0"]?.status).toBe("discovered")
    expect(g?.facts.kind).toMatchObject({
      status: "inferred",
      confidence: 0.4,
      derivation: { rule: "document.classify.fallback" }
    })
  })

  it("classifies by keyword in title, file name or headings", () => {
    const kind = (path: string, title: string, headings: string[] = []) =>
      run(page(path, title, headings)).guidelines[0]?.kind
    expect(kind("a.md", "Button accessibility")).toBe("accessibility")
    expect(kind("a11y.md", "Notes")).toBe("accessibility")
    expect(kind("a.md", "Do and don'ts")).toBe("do-dont")
    expect(kind("a.md", "Forms", ["Keyboard interactions", "Do and don'ts"])).toBe("reference")
    expect(kind("a.md", "Page layout")).toBe("composition")
    expect(kind("a.md", "Design principles")).toBe("visual-principle")
    expect(kind("a.md", "Button usage")).toBe("usage")
    expect(kind("a.md", "Changelog")).toBe("reference")
  })

  it("links a page to a component by file name (0.8) or title (0.6), never by substring", () => {
    const byStem = run(page("src/Button.mdx", "Anything")).guidelines[0]
    expect(byStem?.appliesTo).toEqual(["component:button"])
    expect(byStem?.facts["appliesTo.0"]?.confidence).toBe(0.8)
    const byTitle = run(page("docs/forms.md", "Using the Card in forms")).guidelines[0]
    expect(byTitle?.appliesTo).toEqual(["component:card"])
    expect(byTitle?.facts["appliesTo.0"]?.confidence).toBe(0.6)
    expect(run(page("docs/x.md", "Cardinality rules")).guidelines[0]?.appliesTo).toEqual([])
    expect(run(page("docs/x.md", "Buttons everywhere")).guidelines[0]?.appliesTo).toEqual([])
  })

  it("prefers an exact file-name match over a shorter component named inside the title", () => {
    const r = run(page("docs/color-swatch-picker.md", "Color swatch picker"), [
      component("ColorSwatch"),
      component("ColorSwatchPicker")
    ])
    expect(r.guidelines[0]?.appliesTo).toEqual(["component:colorswatchpicker"])
  })

  it("returns the evidence it cites, and skips pages with no facts", () => {
    const doc = page("a.md", "A")
    expect(run(doc).evidence.map((e) => e.id)).toEqual([doc.evidence[0]?.id])
    const empty: IrDocument = { ...doc, facts: [] }
    const r = run(empty)
    expect(r.guidelines).toEqual([])
    expect(r.skipped).toHaveLength(1)
  })

  it("gives colliding paths distinct ids", () => {
    const a = page("docs/Intro.md", "A")
    const b = page("docs/intro.md", "B")
    const ids = classifyDocuments([a, b], []).guidelines.map((g) => g.id)
    expect(new Set(ids).size).toBe(2)
  })
})

describe("compound components", () => {
  const dialog = (name: string, file = "src/Dialog.tsx") => component(name, { packageName: "@ds/ui", file })

  it("links a parent to same-package children that extend its name, with more confidence in the same file", () => {
    const out = inferCompounds([
      dialog("Dialog"),
      dialog("DialogTrigger"),
      dialog("DialogContent", "src/Content.tsx")
    ])
    const parent = out.find((c) => c.name === "Dialog") as Component
    expect(parent.composition).toEqual([
      { type: "contains", target: "component:dialogcontent" },
      { type: "contains", target: "component:dialogtrigger" }
    ])
    expect(parent.facts["composition.0"]).toMatchObject({
      status: "inferred",
      confidence: 0.4,
      derivation: { rule: "compound.name-prefix" }
    })
    expect(parent.facts["composition.1"]?.confidence).toBe(0.7)
    expect(out.find((c) => c.name === "DialogTrigger")?.composition).toEqual([])
  })

  it("needs two children, a capital letter after the parent name, and one package", () => {
    expect(
      inferCompounds([dialog("Dialog"), dialog("DialogTrigger")]).every((c) => c.composition.length === 0)
    ).toBe(true)
    expect(
      inferCompounds([dialog("Dialog"), dialog("Dialogue"), dialog("Dialogs")]).every(
        (c) => c.composition.length === 0
      )
    ).toBe(true)
    const other = component("DialogB", { packageName: "other" })
    expect(
      inferCompounds([dialog("Dialog"), dialog("DialogA"), other]).every((c) => c.composition.length === 0)
    ).toBe(true)
  })

  it("keeps existing relationships and does not repeat them", () => {
    const parent: Component = {
      ...dialog("Dialog"),
      composition: [{ type: "contains", target: "component:dialogtrigger" }],
      facts: { "implementations.react": fact(), "composition.0": fact() }
    }
    const out = inferCompounds([parent, dialog("DialogTrigger"), dialog("DialogContent")])
    const p = out.find((c) => c.name === "Dialog") as Component
    expect(p.composition.map((r) => r.target)).toEqual(["component:dialogtrigger", "component:dialogcontent"])
    expect(p.facts["composition.0"]?.status).toBe("discovered")
    expect(p.facts["composition.1"]?.status).toBe("inferred")
  })
})

describe("enrich and the additive guarantee", () => {
  it("adds inferences, keeps everything else byte-identical, and yields a valid contract", () => {
    const before = draft({
      components: [
        component("Dialog", { packageName: "p", file: "f" }),
        component("DialogA", { packageName: "p", file: "f" }),
        component("DialogB", { packageName: "p", file: "f" })
      ],
      tokens: [token("color-brand")]
    })
    const result = enrich({ contract: before, evidence: [E], docs: [] })
    expect(result.diagnostics).toEqual([])
    expect(assertAdditive(before, result.contract)).toEqual([])
    expect(result.contract.tokens[0]?.category).toBe("color")
    expect(result.contract.components.find((c) => c.name === "Dialog")?.composition).toHaveLength(2)
    const final = finalizeContract(result.contract)
    expect(verifyContract(final)).toEqual([])
    expect(result.contract.policies).toEqual([])
    expect(JSON.stringify(result.contract).includes('"approved"')).toBe(false)
  })

  it("is deterministic and idempotent", () => {
    const before = draft({ tokens: [token("color-brand"), token("space-md")] })
    const once = enrich({ contract: before, evidence: [E], docs: [] })
    expect(JSON.stringify(enrich({ contract: before, evidence: [E], docs: [] }).contract)).toBe(
      JSON.stringify(once.contract)
    )
    expect(
      JSON.stringify(enrich({ contract: once.contract, evidence: once.evidence, docs: [] }).contract)
    ).toBe(JSON.stringify(once.contract))
  })

  it("detects any change to existing data", () => {
    const before = draft({ components: [component("Button")], tokens: [token("color-x")] })
    const changed = (fn: (d: ContractDraft) => ContractDraft) =>
      assertAdditive(before, fn(structuredClone(before)))
    expect(
      changed((d) => ({ ...d, components: [{ ...(d.components[0] as Component), name: "Other" }] }))
    ).toEqual(["component component:button: name changed"])
    expect(changed((d) => ({ ...d, components: [] }))).toEqual(["component component:button was removed"])
    expect(
      changed((d) => ({
        ...d,
        components: [
          {
            ...(d.components[0] as Component),
            facts: { "implementations.react": { ...fact(), status: "documented" } }
          }
        ]
      }))
    ).toEqual(["component component:button: fact implementations.react changed"])
    expect(
      changed((d) => ({ ...d, tokens: [{ ...(d.tokens[0] as Token), value: { value: "y" } }] }))
    ).toEqual(["token token:color-x: value changed"])
    expect(changed((d) => ({ ...d, metadata: { ...d.metadata, name: "x" } }))).toEqual(["metadata changed"])
    expect(changed((d) => ({ ...d, tokens: [{ ...(d.tokens[0] as Token), category: "color" }] }))).toEqual([])
    const withCategoryFact = draft({ tokens: [token("color-x", {}, ["category"])] })
    expect(
      assertAdditive(withCategoryFact, {
        ...withCategoryFact,
        tokens: [{ ...(withCategoryFact.tokens[0] as Token), category: "color" }]
      })
    ).toEqual(["token token:color-x: category changed"])
  })
})
