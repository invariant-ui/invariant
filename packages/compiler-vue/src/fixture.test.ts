import { fileURLToPath } from "node:url"
import { compile, nodeFs, type SourceAdapter } from "@invariant/compiler-core"
import { checkAdapterConformance, FIXED_CLOCK } from "@invariant/compiler-core/testing"
import { verifyIrDocument } from "@invariant/compiler-ir"
import { beforeAll, describe, expect, it } from "vitest"
import { vueAdapter } from "./index.js"

const root = fileURLToPath(new URL("../../../fixtures/vue/design-system", import.meta.url))
const adapter = vueAdapter as SourceAdapter
let result: Awaited<ReturnType<typeof compile>>
let facts: (name: string) => Record<string, unknown>

beforeAll(async () => {
  result = await compile({ fs: nodeFs(root), adapters: [adapter], clock: FIXED_CLOCK })
  const ir = result.irDocuments[0]
  facts = (name) => {
    const entity = ir?.entities.find((e) => e.name === name)
    return Object.fromEntries(
      (ir?.facts ?? []).filter((f) => f.subject === entity?.ref).map((f) => [f.path, f.value])
    )
  }
})

describe("Vue design-system fixture", () => {
  it("finds every public component form and no internal ones", () => {
    expect(result.irDocuments[0]?.entities.map((e) => e.name).sort()).toEqual(
      [
        "Badge",
        "Button",
        "Card",
        "Dialog",
        "GenericList",
        "Legacy",
        "Modal",
        "Spinner",
        "Tabs",
        "TextField"
      ].sort()
    )
    expect(result.ok).toBe(true)
  })

  it("extracts Button: withDefaults, call-signature emits, defineSlots merged with the template, accessibility, composition, styling", () => {
    const b = facts("Button")
    expect(b["props.variant.allowedValues"]).toEqual(["primary", "secondary", "ghost"])
    expect(b["props.size.default"]).toBe("md")
    expect(b["props.plain.deprecated"]).toEqual({ reason: 'Use `variant="ghost"` instead.' })
    expect(b["events.press.payload.text"]).toBe("event: MouseEvent")
    expect(b["events.focus-change.payload.text"]).toBe("focused: boolean")
    expect(b["slots.icon.extensions.vue.props"]).toBe("{ size: string; }")
    expect(b["slots.icon.extensions.vue.propNames"]).toEqual(["size"])
    expect(b["accessibility.role"]).toBe("button")
    expect(b["composition.renders"]).toEqual([{ target: "vue:src/Spinner.vue#Spinner", count: 1 }])
    expect(b["styling.cssVariables"]).toEqual(["--color-action", "--space-lg", "--space-md"])
    expect(b["implementations.vue.extensions.vue.exports"]).toEqual([
      { subpath: ".", name: "Button" },
      { subpath: "./button", name: "Button" }
    ])
  })

  it("covers destructure defaults and expose (Card), models (TextField), Options API (Modal, Legacy), both script blocks (Tabs), generics, JS, defineComponent in TS", () => {
    expect(facts("Card")["props.elevated.default"]).toBe(false)
    expect(facts("Card")["implementations.vue.extensions.vue.exposed"]).toEqual(["open", "toggle"])
    expect(facts("Card")["implementations.vue.extensions.vue.dynamicSlots"]).toBe(1)
    expect(facts("TextField")["events.update:modelValue.payload.text"]).toBe("string")
    expect(facts("TextField")["props.focused.default"]).toBe(false)
    expect(facts("TextField")["implementations.vue.extensions.vue.propsComplete"]).toBe(false)
    expect(facts("Modal")["props.size.allowedValues"]).toEqual(["sm", "lg"])
    expect(facts("Modal")["props.tags.type.text"]).toBe("string[]")
    expect(facts("Modal")["composition.renders"]).toEqual([{ target: "vue:src/Button.vue#Button", count: 1 }])
    expect(facts("Legacy")["props.a.extensions.vue.source"]).toBe("array")
    expect(facts("Tabs")["implementations.vue.extensions.vue.options.inheritAttrs"]).toBe(false)
    expect(facts("Tabs")["implementations.vue.extensions.vue.options.name"]).toBe("Tabs")
    expect(facts("GenericList")["implementations.vue.extensions.vue.propsComplete"]).toBe(false)
    expect(facts("Badge")["props.tone.default"]).toBe("info")
    expect(facts("Badge")["styling.cssModules"]).toEqual(["src/Badge.vue"])
    expect(facts("Dialog")["implementations.vue.extensions.vue.kind"]).toBe("defineComponent")
    expect(facts("Dialog")["props.label.default"]).toBe("Dialog")
  })

  it("passes conformance and produces valid IR with evidence on every fact", async () => {
    expect(await checkAdapterConformance(adapter, { fs: nodeFs(root) })).toEqual([])
    const ir = result.irDocuments[0]
    expect(ir && verifyIrDocument(ir)).toEqual([])
    const ids = new Set(ir?.evidence.map((e) => e.id))
    expect(ir?.facts.every((f) => f.evidenceIds.length > 0 && f.evidenceIds.every((id) => ids.has(id)))).toBe(
      true
    )
  })
})
