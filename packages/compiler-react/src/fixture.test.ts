import { fileURLToPath } from "node:url"
import { compile, nodeFs, type SourceAdapter } from "@invariant/compiler-core"
import { checkAdapterConformance, FIXED_CLOCK } from "@invariant/compiler-core/testing"
import { verifyIrDocument } from "@invariant/compiler-ir"
import { beforeAll, describe, expect, it } from "vitest"
import { reactAdapter } from "./index.js"

const root = fileURLToPath(new URL("../../../fixtures/react/design-system", import.meta.url))
const adapter = reactAdapter as SourceAdapter

type Result = Awaited<ReturnType<typeof compile>>
let result: Result
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

describe("design-system fixture (difficult React patterns)", () => {
  it("extracts the public catalog and nothing internal", () => {
    expect(result.irDocuments[0]?.entities.map((e) => e.name).sort()).toEqual(
      [
        "Badge",
        "Button",
        "Card",
        "Card.Body",
        "Card.Header",
        "Icon",
        "IconButton",
        "LazyChart",
        "Link",
        "Modal",
        "Select",
        "Stack",
        "Text",
        "Tooltip"
      ].sort()
    )
    expect(result.irDocuments[0]?.completeness).toBe("partial")
    expect(result.ok).toBe(true)
  })

  it("handles inherited props, forwardRef, JSDoc, deprecation, defaults and slots on Button", () => {
    const b = facts("Button")
    expect(b["implementations.react.extensions.react.kind"]).toBe("forwardRef")
    expect(b["implementations.react.extensions.react.refType"]).toBe("HTMLButtonElement")
    expect(b["implementations.react.extensions.react.inheritedPropsFrom"]).toEqual([
      "React.ButtonHTMLAttributes<HTMLButtonElement>"
    ])
    expect(b["implementations.react.extensions.react.propsComplete"]).toBe(false)
    expect(b["implementations.react.importPath"]).toBe("@acme/ui")
    expect(b["implementations.react.extensions.react.exports"]).toEqual([
      { subpath: ".", name: "Button" },
      { subpath: "./button", name: "Button" }
    ])
    expect(b["props.variant.allowedValues"]).toEqual(["primary", "secondary", "ghost"])
    expect(b["props.variant.default"]).toBe("primary")
    expect(b["props.plain.deprecated"]).toEqual({ reason: 'Use `variant="ghost"` instead.' })
    expect(b["props.data-testid.extensions.react.inheritedFrom"]).toBe("BaseProps")
    expect(b["props.onPress.extensions.react.role"]).toBe("event-handler")
    expect(b["slots.icon.required"]).toBe(false)
    expect(b["slots.default.required"]).toBe(true)
    expect(b["examples.example-1.code"]).toBe('<Button variant="primary">Save</Button>')
    expect(b["accessibility.role"]).toBe("button")
    expect(b["styling.cssVariables"]).toEqual(["--color-action", "--color-brand", "--space-lg", "--space-md"])
    expect(b["styling.tailwind"]).toBeUndefined()
  })

  it("resolves Omit over an inherited interface (IconButton) and records composition", () => {
    const i = facts("IconButton")
    expect(i["implementations.react.extensions.react.kind"]).toBe("memo")
    expect(i["props.children.type.text"]).toBeUndefined()
    expect(i["props.icon.type.text"]).toBeUndefined()
    expect(i["props.name.type.text"]).toBe("string")
    expect(i["props.label.required"]).toBe(true)
    expect(i["props.variant.extensions.react.inheritedFrom"]).toBe("ButtonProps")
    expect(i["composition.renders"]).toEqual([
      { target: "react:src/Button.tsx#Button", count: 1 },
      { target: "react:src/Icon.tsx#Icon", count: 1 }
    ])
  })

  it("models compound, generic, class, cva, styled, default-export and lazy components", () => {
    expect(facts("Card")["composition.subcomponents"]).toEqual([
      { key: "Header", ref: "react:src/Card.tsx#CardHeader" },
      { key: "Body", ref: "react:src/Card.tsx#CardBody" }
    ])
    expect(facts("Card.Header")["implementations.react.extensions.react.compoundParent"]).toBe(
      "react:src/Card.tsx#Card"
    )
    expect(facts("Select")["implementations.react.extensions.react.generics"]).toEqual(["T"])
    expect(facts("Select")["slots.renderOption.extensions.react.renderProp"]).toBe(true)
    expect(facts("Modal")["props.size.default"]).toBe("sm")
    expect(facts("Modal")["implementations.react.extensions.react.kind"]).toBe("class")
    expect(facts("Text")["variants.tone.values"]).toEqual(["neutral", "danger"])
    expect(facts("Text")["variants.tone.default"]).toBe("neutral")
    expect(facts("Text")["implementations.react.extensions.react.propsComplete"]).toBe(false)
    expect(facts("Badge")["implementations.react.extensions.react.styledLibrary"]).toBe("styled-components")
    expect(facts("Badge")["styling.cssVariables"]).toEqual(["--color-brand", "--space-md"])
    expect(facts("Link")["implementations.react.extensions.react.exports"]).toEqual([
      { subpath: ".", name: "Link" }
    ])
    expect(facts("LazyChart")["implementations.react.extensions.react.kind"]).toBe("lazy")
    expect(facts("Stack")["styling.classNames"]).toEqual(["flex", "flex-col", "gap-4"])
    expect(facts("Stack")["styling.tailwind"]).toBe(true)
    expect(facts("Tooltip")["accessibility.role"]).toBe("tooltip")
  })

  it("compares declared APIs with actual usage and ignores stories and tests", () => {
    const button = facts("Button")
    expect(button["usage.sites"]).toBe(4)
    expect(button["usage.props.variant.observedValues"]).toEqual(["primary", "danger", "ghost"])
    expect(button["usage.props.variant.dynamicCount"]).toBe(1)
    expect(facts("Card")["usage.undeclaredProps"]).toEqual(["shadow"])
    expect(facts("Text")["usage.props.tone.declared"]).toBe(true)
    expect(JSON.stringify(result.irDocuments[0]?.facts)).not.toContain("never-counted")
    expect(JSON.stringify(result.irDocuments[0]?.facts)).not.toContain("also-not-counted")
  })

  it("reports what it skipped", () => {
    expect(result.diagnostics.map((d) => d.code).sort()).toEqual([
      "react.higher-order-component",
      "react.props-unresolved"
    ])
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
