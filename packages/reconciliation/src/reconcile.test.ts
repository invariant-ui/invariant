import { parseContract, serializeContract } from "@invariant/contract"
import { describe, expect, it } from "vitest"
import { type ComponentSpec, component, type RawEntity, rawDoc, token } from "../test/raw.ts"
import { buildReviewQueue, finalizeAndVerify, reconcile, sharedPrefix } from "./index.js"

const options = { name: "Acme DS", compilerVersion: "1.0.0", clock: () => "2026-01-01T00:00:00.000Z" }
const react = (specs: ComponentSpec[], id = "react-ui") => rawDoc(id, "react", specs.map(component))
const vue = (specs: ComponentSpec[]) =>
  rawDoc(
    "vue-ui",
    "vue",
    specs.map((s) => component({ framework: "vue", file: `src/${s.name}.vue`, ...s }))
  )
const prop = (name: string, extra: RawEntity["facts"] = []): RawEntity["facts"] => [
  [`props.${name}.type.text`, "string"],
  [`props.${name}.required`, false],
  ...extra
]
const run = (docs: Parameters<typeof reconcile>[0]) => {
  const result = reconcile(docs, options)
  return { ...result, final: finalizeAndVerify(result.contract, result.evidence) }
}
const conflictTypes = (r: ReturnType<typeof run>) =>
  r.contract.conflicts.map((c) => `${c.type}:${c.path ?? ""}`)

describe("contract assembly", () => {
  it("builds a valid contract with evidence, sources and per-field facts", () => {
    const r = run([
      react([
        {
          name: "Button",
          packageName: "@acme/ui",
          extra: [
            ...prop("size", [
              ["props.size.allowedValues", ["sm", "md"]],
              ["props.size.default", "md"]
            ]),
            ["description", "A button.", "authored"]
          ]
        }
      ])
    ])
    expect(r.final.diagnostics).toEqual([])
    expect(parseContract(JSON.parse(serializeContract(r.final.contract))).ok).toBe(true)
    const c = r.contract.components[0]
    expect(c?.id).toBe("component:button")
    expect(c?.props[0]).toMatchObject({
      name: "size",
      required: false,
      default: "md",
      allowedValues: ["sm", "md"]
    })
    expect(c?.facts["props.size.default"]?.status).toBe("discovered")
    expect(c?.facts.description?.status).toBe("documented")
    expect(c?.implementations[0]).toMatchObject({
      id: "react",
      framework: "react",
      packageName: "@acme/ui",
      sourceId: "react-ui"
    })
    expect(r.contract.sources.map((s) => [s.id, s.health.status])).toEqual([["react-ui", "ok"]])
    expect(r.evidence.length).toBeGreaterThan(0)
  })

  it("is deterministic and independent of document order", () => {
    const a = react([{ name: "Button" }, { name: "Card" }])
    const b = vue([{ name: "Button" }])
    const one = serializeContract(run([a, b]).final.contract)
    const two = serializeContract(run([b, a]).final.contract)
    expect(one).toBe(two)
  })

  it("keeps unmapped neutral facts under extensions.invariant, with their facts", () => {
    const r = run([
      react([
        {
          name: "Button",
          extra: [
            ["styling.cssVariables", ["--a"]],
            ["usage.combinations", []]
          ]
        }
      ])
    ])
    const c = r.contract.components[0]
    expect(c?.extensions?.invariant).toMatchObject({
      styling: { cssVariables: ["--a"] },
      usage: { combinations: [] }
    })
    expect(c?.facts["extensions.invariant.styling.cssVariables"]?.status).toBe("discovered")
    expect(r.final.diagnostics).toEqual([])
  })

  it("reports components without a link key instead of placing them", () => {
    const doc = rawDoc("react-ui", "react", [
      { ref: "react:x", kind: "component", name: "Loose", facts: [["name", "Loose"]] }
    ])
    const r = run([doc])
    expect(r.contract.components).toEqual([])
    expect(r.diagnostics.map((d) => d.code)).toEqual(["reconcile.component-skipped"])
  })

  it("maps composition facts to contains relationships and drops unresolved targets with a diagnostic", () => {
    const card = component({
      name: "Card",
      extra: [
        ["composition.subcomponents", [{ key: "Header", ref: "react:src/CardHeader.tsx#CardHeader" }]],
        ["composition.renders", [{ target: "react:src/Hidden.tsx#Hidden", count: 1 }]]
      ]
    })
    const header = component({ name: "CardHeader" })
    const r = run([rawDoc("react-ui", "react", [card, header])])
    const c = r.contract.components.find((x) => x.id === "component:card")
    expect(c?.composition).toEqual([{ type: "contains", target: "component:cardheader" }])
    expect(c?.facts["composition.0"]?.status).toBe("discovered")
    expect(r.diagnostics.map((d) => d.code)).toContain("reconcile.composition-target-unresolved")
    expect(r.final.diagnostics).toEqual([])
  })
})

describe("entity resolution", () => {
  it("merges same-named components across frameworks as an inferred, explained link", () => {
    const r = run([react([{ name: "Button" }]), vue([{ name: "Button" }])])
    expect(r.contract.components.map((c) => c.id)).toEqual(["component:button"])
    const c = r.contract.components[0]
    expect(c?.implementations.map((i) => i.id)).toEqual(["react", "vue"])
    for (const id of ["react", "vue"]) {
      const fact = c?.facts[`implementations.${id}`]
      expect(fact).toMatchObject({
        status: "inferred",
        confidence: 0.9,
        derivation: { rule: "name-match.exact" }
      })
      expect(fact?.derivation?.inputs).toHaveLength(2)
    }
    expect(r.final.diagnostics).toEqual([])
    expect(r.contract.metadata.frameworks).toEqual(["react", "vue"])
  })

  it("records a single implementation as discovered, never inferred", () => {
    const r = run([react([{ name: "Button" }])])
    expect(r.contract.components[0]?.facts["implementations.react"]?.status).toBe("discovered")
  })

  it("does not merge on a similar name, or two components of one framework", () => {
    const r = run([
      react([{ name: "Button" }, { name: "Button", file: "src/legacy/Button.tsx", packageName: "legacy" }]),
      vue([{ name: "ButtonGroup" }])
    ])
    expect(r.contract.components).toHaveLength(3)
    expect(r.contract.components.every((c) => c.implementations.length === 1)).toBe(true)
  })

  it("reports an ambiguity instead of guessing when a framework has several candidates", () => {
    const r = run([
      react([
        { name: "Button", packageName: "a" },
        { name: "Button", file: "src/legacy/Button.tsx", packageName: "b" }
      ]),
      vue([{ name: "Button" }])
    ])
    expect(r.contract.components).toHaveLength(3)
    expect(conflictTypes(r)).toEqual(["identity-ambiguity:"])
    expect(r.contract.conflicts[0]?.claims).toHaveLength(3)
    expect(new Set(r.contract.components.map((c) => c.id)).size).toBe(3)
    expect(r.final.diagnostics).toEqual([])
  })

  it("strips a design-system prefix shared by most components of a source, and says so", () => {
    const lds = react([{ name: "LdsButton" }, { name: "LdsCard" }, { name: "LdsIcon" }])
    const r = run([lds, vue([{ name: "Button" }])])
    const merged = r.contract.components.find((c) => c.implementations.length === 2)
    expect(merged?.id).toBe("component:button")
    expect(merged?.facts["implementations.react"]).toMatchObject({
      confidence: 0.75,
      derivation: { rule: "name-match.stripped-prefix" }
    })
    expect(merged?.name).toBe("Button")
  })

  it("derives prefixes conservatively", () => {
    expect(sharedPrefix(["LdsButton", "LdsCard", "LdsIcon"])).toBe("Lds")
    expect(sharedPrefix(["LdsButton", "LdsCard"])).toBeUndefined()
    expect(sharedPrefix(["Button", "ButtonGroup", "ButtonIcon", "Badge"])).toBeUndefined()
    expect(sharedPrefix(["LdsButton", "LdsCard", "Icon", "Badge"])).toBeUndefined()
    expect(sharedPrefix(["Lds", "LdsCard", "LdsIcon", "LdsBadge"])).toBeUndefined()
    expect(sharedPrefix(["Designsystem1Button", "Designsystem1Card", "Designsystem1Icon"])).toBeUndefined()
  })

  it("uses an Angular selector prefix to match a class name", () => {
    const ng = rawDoc("ng-ui", "angular", [
      component({
        name: "DemoButton",
        framework: "angular",
        extra: [["implementations.angular.extensions.angular.selector", "demo-button"]]
      })
    ])
    const r = run([ng, react([{ name: "Button" }])])
    expect(r.contract.components.map((c) => c.id)).toEqual(["component:button"])
    expect(r.contract.components[0]?.implementations.map((i) => i.framework)).toEqual(["angular", "react"])
  })
})

describe("conflicts", () => {
  const merged = (
    a: RawEntity["facts"],
    b: RawEntity["facts"],
    aSpec: Partial<ComponentSpec> = {},
    bSpec: Partial<ComponentSpec> = {}
  ) => run([react([{ name: "Button", extra: a, ...aSpec }]), vue([{ name: "Button", extra: b, ...bSpec }])])

  it("keeps one value and records every claim when implementations disagree", () => {
    const r = merged(
      prop("size", [["props.size.default", "md"]]),
      prop("size", [["props.size.default", "lg"]])
    )
    expect(conflictTypes(r)).toEqual(["value-mismatch:props.size.default"])
    const conflict = r.contract.conflicts[0]
    expect(conflict?.severity).toBe("warning")
    expect(conflict?.claims.map((c) => [c.sourceId, c.value])).toEqual([
      ["react-ui", "md"],
      ["vue-ui", "lg"]
    ])
    expect(conflict?.resolution).toEqual({ state: "open" })
    expect(r.contract.components[0]?.props[0]?.default).toBe("md")
    expect(r.final.diagnostics).toEqual([])
  })

  it("prefers a discovered value over a documented one, whatever the source order", () => {
    const r = merged(
      [...prop("size"), ["props.size.default", "md", "authored"]],
      [...prop("size"), ["props.size.default", "lg"]]
    )
    expect(r.contract.components[0]?.props[0]?.default).toBe("lg")
    expect(r.contract.components[0]?.facts["props.size.default"]?.status).toBe("discovered")
    expect(r.contract.conflicts[0]?.claims.map((c) => c.status).sort()).toEqual(["discovered", "documented"])
  })

  it("treats value domains as sets, and agreeing implementations share one fact with both pieces of evidence", () => {
    const r = merged(
      prop("v", [["props.v.allowedValues", ["a", "b"]]]),
      prop("v", [["props.v.allowedValues", ["b", "a"]]])
    )
    expect(r.contract.conflicts).toEqual([])
    expect(r.contract.components[0]?.facts["props.v.allowedValues"]?.evidenceIds).toHaveLength(2)
  })

  it("reports a prop missing from an implementation only when that implementation's props are fully known", () => {
    const complete = merged(prop("tone"), [])
    expect(conflictTypes(complete)).toEqual(["existence-mismatch:props.tone"])
    expect(complete.contract.conflicts[0]?.severity).toBe("info")
    expect(complete.contract.conflicts[0]?.claims.map((c) => c.value)).toEqual([true, undefined])
    expect(complete.final.diagnostics).toEqual([])
    const incomplete = merged(prop("tone"), [], {}, { propsComplete: false })
    expect(incomplete.contract.conflicts).toEqual([])
  })

  it("does not call React handlers and children missing props elsewhere", () => {
    const r = merged([...prop("onPress"), ["props.onPress.extensions.react.role", "event-handler"]], [])
    expect(r.contract.conflicts).toEqual([])
  })

  it("records a lifecycle disagreement as a deprecation mismatch", () => {
    const r = merged([["lifecycle", "deprecated"]], [["lifecycle", "stable"]])
    expect(conflictTypes(r)).toEqual(["deprecation-mismatch:lifecycle"])
  })

  it("never compares framework extensions across implementations", () => {
    const r = merged(
      [["implementations.react.extensions.react.kind", "styled"]],
      [["implementations.vue.extensions.vue.kind", "sfc"]]
    )
    expect(r.contract.conflicts).toEqual([])
    expect(r.contract.components[0]?.implementations.map((i) => i.extensions)).toEqual([
      { react: expect.objectContaining({ kind: "styled" }) },
      { vue: expect.objectContaining({ kind: "sfc" }) }
    ])
  })
})

describe("tokens", () => {
  const css = (...tokens: RawEntity[]) => rawDoc("tokens-css", "tokens", tokens)
  const dtcg = (...tokens: RawEntity[]) => rawDoc("tokens-json", "tokens", tokens, {})
  const brand = (name: string, value: string, ref?: string) => token(name, [["value.value", value]], ref)

  it("builds tokens with literal and alias values, modes and themes", () => {
    const r = run([
      css(
        token("color-brand", [
          ["value.value", "#00f"],
          ["modes.dark.value", "#44f"]
        ]),
        token("color-action", [["value.aliasOf", "color-brand"]])
      )
    ])
    expect(r.final.diagnostics).toEqual([])
    const byId = Object.fromEntries(r.contract.tokens.map((t) => [t.id, t]))
    expect(byId["token:color-action"]?.value).toEqual({ aliasOf: "token:color-brand" })
    expect(byId["token:color-brand"]?.modes).toEqual({ "theme:dark": { value: "#44f" } })
    expect(byId["token:color-brand"]?.category).toBe("other")
    expect(byId["token:color-brand"]?.facts["modes.theme:dark.value"]?.status).toBe("discovered")
    expect(r.contract.themes).toEqual([{ id: "theme:dark", name: "dark" }])
  })

  it("ignores inventory token entries that state no value", () => {
    const r = run([css(token("--x", [["extensions.css.rawValue", "1px"]]))])
    expect(r.contract.tokens).toEqual([])
  })

  it("links differently spelled names as an inferred identity and flags differing values", () => {
    const same = run([
      css(brand("color-brand", "#00f")),
      dtcg(brand("color.brand", "#00f", "token:src/t.json#color.brand"))
    ])
    expect(same.contract.tokens.map((t) => t.id)).toEqual(["token:color.brand"])
    expect(same.contract.tokens[0]?.facts.name).toMatchObject({
      status: "inferred",
      derivation: { rule: "name-match.token" }
    })
    expect(same.contract.conflicts).toEqual([])
    const differ = run([
      css(brand("color-brand", "#00f")),
      dtcg(brand("color.brand", "#00e", "token:src/t.json#color.brand"))
    ])
    expect(differ.contract.conflicts.map((c) => [c.type, c.path])).toEqual([
      ["token-value-mismatch", "value"]
    ])
    expect(differ.contract.conflicts[0]?.claims).toHaveLength(2)
    expect(differ.final.diagnostics).toEqual([])
  })

  it("flags an alias disagreeing with a literal, and an unresolved alias target", () => {
    const r = run([
      css(brand("a", "#fff"), token("b", [["value.aliasOf", "a"]])),
      dtcg(brand("b", "#fff", "token:src/t.json#b"))
    ])
    expect(r.contract.conflicts.map((c) => c.type)).toEqual(["token-value-mismatch"])
    const dangling = run([
      css(
        token("x", [
          ["value.aliasOf", "nope"],
          ["extensions.css.rawValue", "var(--nope)"]
        ])
      )
    ])
    expect(dangling.diagnostics.map((d) => d.code)).toEqual(["reconcile.token-alias-unresolved"])
    expect(dangling.final.diagnostics).toEqual([])
  })
})

describe("review queue", () => {
  it("lists open conflicts and inferred facts, sorted, with an approval requirement", () => {
    const r = run([
      react([{ name: "Button", extra: prop("size", [["props.size.default", "md"]]) }]),
      vue([{ name: "Button", extra: prop("size", [["props.size.default", "lg"]]) }])
    ])
    const queue = buildReviewQueue(r.contract)
    expect(queue.map((q) => [q.kind, q.subject, q.path, q.priority])).toEqual([
      ["conflict", "component:button", "props.size.default", "medium"],
      ["inferred-fact", "component:button", "implementations.react", "low"],
      ["inferred-fact", "component:button", "implementations.vue", "low"]
    ])
    expect(queue.every((q) => q.approvalRequired)).toBe(true)
    expect(new Set(queue.map((q) => q.id)).size).toBe(3)
    expect(buildReviewQueue(r.contract)).toEqual(queue)
  })
})
