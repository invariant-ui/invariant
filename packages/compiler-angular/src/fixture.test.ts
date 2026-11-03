import { fileURLToPath } from "node:url"
import { compile, nodeFs, type SourceAdapter } from "@invariant/compiler-core"
import { checkAdapterConformance, FIXED_CLOCK } from "@invariant/compiler-core/testing"
import { verifyIrDocument } from "@invariant/compiler-ir"
import { beforeAll, describe, expect, it } from "vitest"
import { angularAdapter } from "./index.js"

const root = fileURLToPath(new URL("../../../fixtures/angular/design-system", import.meta.url))
const adapter = angularAdapter as SourceAdapter
const ext = "implementations.angular.extensions.angular"
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

describe("Angular design-system fixture", () => {
  it("finds public components and directives, the module, and no internal component", () => {
    const ir = result.irDocuments[0]
    expect(
      ir?.entities
        .filter((e) => e.kind === "component")
        .map((e) => e.name)
        .sort()
    ).toEqual(["AcmeButton", "AcmeCard", "AcmeSelect", "AcmeSpinner", "AcmeTextField", "AcmeTooltip"])
    expect(ir?.entities.filter((e) => e.kind === "module").map((e) => e.name)).toEqual(["UiModule"])
    expect(facts("AcmeTooltip")[`${ext}.kind`]).toBe("directive")
  })

  it("extracts AcmeButton: signal and decorator inputs, outputs, host metadata, slots, accessibility, styling", () => {
    const b = facts("AcmeButton")
    expect(b["props.buttonSize.allowedValues"]).toEqual(["sm", "md", "lg"])
    expect(b["props.buttonSize.extensions.angular.property"]).toBe("size")
    expect(b["props.disabled.extensions.angular.transform"]).toBe("booleanAttribute")
    expect(b["props.label.required"]).toBe(true)
    expect(b["props.kind.required"]).toBe(true)
    expect(b["props.plain.deprecated"]).toEqual({ reason: 'Use variant="ghost".' })
    expect(b["props.plain.type.text"]).toBe("boolean")
    expect(b["events.pressed.extensions.angular.kind"]).toBe("signal-output")
    expect(b["events.focusChange.extensions.angular.property"]).toBe("focusChanged")
    expect(b[`${ext}.host.bindings`]).toEqual(["attr.aria-busy", "class.is-loading"])
    expect(b[`${ext}.host.listeners`]).toEqual(["click", "keydown.enter"])
    expect(b[`${ext}.changeDetection`]).toBe("OnPush")
    expect(b[`${ext}.selector`]).toBe("acme-button, button[acme-button]")
    expect(
      Object.keys(b)
        .filter((k) => /^slots\.[^.]+\.declared$/.test(k))
        .sort()
    ).toEqual(["slots.acme-badge.declared", "slots.default.declared", "slots.icon.declared"])
    expect(b["accessibility.attributes"]).toEqual(["aria-busy", "aria-live"])
    expect(b["styling.cssVariables"]).toEqual(["--color-action", "--space-lg", "--space-md"])
    expect(b["styling.preprocessors"]).toEqual(["scss"])
    expect(b["composition.renders"]).toEqual([
      { target: "angular:src/lib/spinner.component.ts#AcmeSpinner", count: 1 }
    ])
  })

  it("covers metadata inputs (AcmeCard), models and inheritance (AcmeTextField), external bases (AcmeSelect), directives, and modules", () => {
    expect(facts("AcmeCard")["props.cardTone.extensions.angular.property"]).toBe("tone")
    expect(facts("AcmeCard")["events.closed.declared"]).toBe(true)
    expect(facts("AcmeCard")[`${ext}.standalone`]).toBe(false)
    expect(facts("AcmeCard")[`${ext}.declaredIn`]).toEqual(["UiModule"])
    expect(facts("AcmeCard")["slots.footer.extensions.angular.select"]).toBe(".footer")
    expect(facts("AcmeTextField")["events.valueChange.extensions.angular.kind"]).toBe("model")
    expect(facts("AcmeTextField")["props.label.extensions.angular.inheritedFrom"]).toBe("BaseField")
    expect(facts("AcmeTextField")["composition.renders"]).toEqual([
      { target: "angular:src/lib/button.component.ts#AcmeButton", count: 1 },
      { target: "angular:src/lib/tooltip.directive.ts#AcmeTooltip", count: 1 }
    ])
    expect(facts("AcmeSelect")[`${ext}.propsComplete`]).toBe(false)
    expect(facts("AcmeSelect")[`${ext}.inheritedPropsFrom`]).toEqual(["ExternalBase"])
    expect(facts("AcmeTooltip")["props.acmeTooltip.extensions.angular.property"]).toBe("text")
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
