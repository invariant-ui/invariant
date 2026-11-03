import { compile, memoryFs, type SourceAdapter } from "@invariant/compiler-core"
import { checkAdapterConformance, FIXED_CLOCK } from "@invariant/compiler-core/testing"
import { verifyIrDocument } from "@invariant/compiler-ir"
import { describe, expect, it } from "vitest"
import {
  classifyScope,
  designTokensAdapter,
  extractJsonTokens,
  parseJsonWithLines,
  valueKind
} from "./index.js"

const adapter = designTokensAdapter as SourceAdapter
const run = async (files: Record<string, string>) => {
  const result = await compile({
    fs: memoryFs({ "package.json": '{"name":"t"}', ...files }),
    adapters: [adapter],
    clock: FIXED_CLOCK
  })
  return { result, ir: result.irDocuments[0] }
}
const facts = (ir: Awaited<ReturnType<typeof run>>["ir"], subjectName: string) => {
  const entity = ir?.entities.find((e) => e.name === subjectName)
  return Object.fromEntries(
    (ir?.facts ?? []).filter((f) => f.subject === entity?.ref).map((f) => [f.path, f.value])
  )
}

describe("classifyScope", () => {
  it("recognizes root, attribute/class themes and prefers-color-scheme", () => {
    expect(classifyScope([":root"])).toEqual({ kind: "root" })
    expect(classifyScope(["html"])).toEqual({ kind: "root" })
    expect(classifyScope(['[data-theme="dark"]'])).toEqual({ kind: "theme", mode: "dark", via: "selector" })
    expect(classifyScope([":root[data-theme=dim]"])).toEqual({ kind: "theme", mode: "dim", via: "selector" })
    expect(classifyScope(["html.dark"])).toEqual({ kind: "theme", mode: "dark", via: "selector" })
    expect(classifyScope([".theme-contrast"])).toEqual({ kind: "theme", mode: "contrast", via: "selector" })
    expect(classifyScope(["@media (prefers-color-scheme: dark)", ":root"])).toEqual({
      kind: "theme",
      mode: "dark",
      via: "media"
    })
  })

  it("treats everything else, including component classes and mixed lists, as other", () => {
    expect(classifyScope([".root"])).toEqual({ kind: "other" })
    expect(classifyScope([".card .title"])).toEqual({ kind: "other" })
    expect(classifyScope([":root, .dark"])).toEqual({ kind: "other" })
    expect(classifyScope(["@media (min-width: 1px)", ".x"])).toEqual({ kind: "other" })
    expect(classifyScope([])).toEqual({ kind: "other" })
  })

  it("ignores unrelated at-rules around a root selector", () => {
    expect(classifyScope(["@layer base", ":root"])).toEqual({ kind: "root" })
  })
})

describe("valueKind", () => {
  it("classifies by syntax only", () => {
    expect(valueKind("#0057ff")).toBe("color")
    expect(valueKind("rgb(0 0 0 / 12%)")).toBe("color")
    expect(valueKind("16px")).toBe("length")
    expect(valueKind("0.5rem")).toBe("length")
    expect(valueKind("200ms")).toBe("time")
    expect(valueKind("1.5")).toBe("number")
    expect(valueKind("var(--a)")).toBe("reference")
    expect(valueKind("calc(1px + 2px)")).toBe("expression")
    expect(valueKind('"Inter", sans-serif')).toBe("string")
    expect(valueKind("0 1px 2px black")).toBe("other")
  })
})

describe("CSS token extraction", () => {
  const css = `/* tokens */
:root {
  --color-brand: #0057ff;
  --color-action: var(--color-brand);
  --space-md: 16px;
}
[data-theme="dark"] { --color-brand: #4d8dff; --color-action: var(--color-brand-dark); }
@media (prefers-color-scheme: dark) { :root { --space-md: 18px; } }
.card { --card-pad: var(--space-md); }
`

  it("puts root values, theme modes and aliases on one token, with line evidence", async () => {
    const { ir } = await run({ "tokens.css": css })
    expect(facts(ir, "color-brand")).toMatchObject({
      name: "color-brand",
      "extensions.css.name": "--color-brand",
      "value.value": "#0057ff",
      "modes.dark.value": "#4d8dff",
      "extensions.css.root.valueKind": "color",
      "extensions.css.modes.dark.rawValue": "#4d8dff"
    })
    expect(facts(ir, "color-action")).toMatchObject({
      "value.aliasOf": "color-brand",
      "modes.dark.aliasOf": "color-brand-dark"
    })
    expect(facts(ir, "space-md")).toMatchObject({ "value.value": "16px", "modes.dark.value": "18px" })
    const brand = ir?.entities.find((e) => e.name === "color-brand")
    const evidence = ir?.evidence.filter((e) =>
      ir.facts.some((f) => f.subject === brand?.ref && f.evidenceIds.includes(e.id))
    )
    expect(evidence?.map((e) => (e.location.type === "file" ? e.location.line : 0)).sort()).toEqual([3, 7])
  })

  it("keeps component-private variables as separate, clearly flagged tokens without a value or mode", async () => {
    const { ir } = await run({ "tokens.css": css })
    const priv = ir?.entities.filter((e) => e.name === "card-pad") ?? []
    expect(priv).toHaveLength(1)
    const f = Object.fromEntries(
      (ir?.facts ?? []).filter((x) => x.subject === priv[0]?.ref).map((x) => [x.path, x.value])
    )
    expect(f).toMatchObject({ "extensions.css.scopeKind": "other", "extensions.css.scope": ".card" })
    expect(f["value.value"]).toBeUndefined()
    expect(f["value.aliasOf"]).toBeUndefined()
  })

  it("does not decide token categories or semantic names", async () => {
    const { ir } = await run({ "tokens.css": css })
    expect(ir?.facts.some((f) => f.path === "category")).toBe(false)
  })

  it("reports a source that defines the same token twice with different values instead of dropping one", async () => {
    const { result } = await run({ "tokens.css": ":root{--a:1px}\n:root{--a:2px}" })
    expect(result.diagnostics.map((d) => d.code)).toContain("ir.conflicting-facts")
  })
})

describe("JSON token extraction", () => {
  const dtcg = `{
  "color": {
    "$type": "color",
    "brand": { "$value": "#0057ff", "$description": "Primary brand" },
    "action": { "$value": "{color.brand}" },
    "old": { "$value": "#000", "$deprecated": "use brand" },
    "legacy": { "$value": "#111", "$deprecated": true }
  },
  "space": { "md": { "$value": "16px", "$type": "dimension" } },
  "shadow": { "card": { "$value": { "offsetX": "0", "blur": "2px" }, "$type": "shadow" } }
}`

  it("reads W3C-shaped tokens with inherited types, aliases, composites, descriptions and deprecations", () => {
    const tokens = extractJsonTokens(parseJsonWithLines(dtcg))
    const by = Object.fromEntries(tokens.map((t) => [t.name, t]))
    expect(Object.keys(by)).toEqual([
      "color.brand",
      "color.action",
      "color.old",
      "color.legacy",
      "space.md",
      "shadow.card"
    ])
    expect(by["color.brand"]).toMatchObject({
      value: "#0057ff",
      type: "color",
      description: "Primary brand",
      line: 4,
      format: "dtcg"
    })
    expect(by["color.action"]).toMatchObject({ aliasOf: "color.brand", type: "color" })
    expect(by["color.action"]?.value).toBeUndefined()
    expect(by["color.old"]?.deprecated).toEqual({ reason: "use brand" })
    expect(by["color.legacy"]?.deprecated).toEqual({})
    expect(by["space.md"]?.type).toBe("dimension")
    expect(by["shadow.card"]?.value).toEqual({ offsetX: "0", blur: "2px" })
  })

  it("reads Style Dictionary-shaped tokens", () => {
    const tokens = extractJsonTokens(
      parseJsonWithLines(
        '{ "size": { "base": { "value": "16px", "type": "dimension", "comment": "Base" } } }'
      )
    )
    expect(tokens).toEqual([
      {
        name: "size.base",
        line: 1,
        format: "style-dictionary",
        value: "16px",
        type: "dimension",
        description: "Base"
      }
    ])
  })

  it("produces IR with authored descriptions and deprecations", async () => {
    const { ir } = await run({ "tokens/core.json": dtcg })
    expect(facts(ir, "color.brand")).toMatchObject({
      "value.value": "#0057ff",
      "extensions.dtcg.type": "color",
      description: "Primary brand"
    })
    expect(ir?.facts.find((f) => f.path === "description")?.origin).toBe("authored")
    expect(facts(ir, "color.action")).toMatchObject({ "value.aliasOf": "color.brand" })
    expect(facts(ir, "color.old")).toMatchObject({ deprecated: { reason: "use brand" } })
  })

  it("parses line numbers and rejects invalid JSON", () => {
    const node = parseJsonWithLines('{\n  "a": 1,\n\n  "b": [true, null]\n}')
    expect(node.type === "object" && node.members.map((m) => [m.key, m.line])).toEqual([
      ["a", 2],
      ["b", 4]
    ])
    expect(() => parseJsonWithLines("{ nope")).toThrow(SyntaxError)
    expect(() => parseJsonWithLines('{"a":1} x')).toThrow(/trailing/)
  })
})

describe("adapter contract", () => {
  const files = {
    "package.json": '{"name":"t"}',
    "tokens.css": ":root{--a:1px}\n[data-theme=dark]{--a:2px}",
    "tokens/core.json": '{"c":{"$value":"#fff","$type":"color"}}',
    "tokens/other.json": '{"hello":"world"}'
  }

  it("passes the shared conformance suite and emits valid IR", async () => {
    expect(await checkAdapterConformance(adapter, { fs: memoryFs(files) })).toEqual([])
    const { result } = await run(files)
    expect(result.ok).toBe(true)
    for (const ir of result.irDocuments) expect(verifyIrDocument(ir)).toEqual([])
    expect(result.irDocuments[0]?.source.type).toBe("tokens")
  })

  it("ignores JSON that is not token-shaped and warns when nothing is extracted", async () => {
    const empty = await run({ "tokens/other.json": '{"hello":"world"}', "x.css": ".x{--local:1}" })
    expect(empty.ir?.entities.map((e) => e.name)).toEqual(["local"])
    const none = await compile({
      fs: memoryFs({ "package.json": '{"name":"t"}', "tokens/other.json": '{"hello":"world"}' }),
      adapters: [adapter],
      clock: FIXED_CLOCK
    })
    expect(none.sources).toEqual([])
  })
})
