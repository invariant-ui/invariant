import { describe, expect, it } from "vitest"
import { type CodeSpec, codeDoc, type GroupSpec, storyDoc } from "../test/ir.ts"
import { reconcileStorybook } from "./index.js"

const button: CodeSpec = {
  ref: "react:src/Button.tsx#Button",
  name: "Button",
  file: "src/Button.tsx",
  localName: "Button",
  props: {
    variant: { allowedValues: ["primary", "secondary", "ghost"], default: "primary" },
    size: { allowedValues: ["sm", "md"], default: "md" },
    label: {},
    plain: { deprecated: true },
    children: { role: "children" },
    onPress: { role: "event-handler" }
  }
}
const group = (g: Partial<GroupSpec> = {}): GroupSpec => ({
  file: "src/Button.stories.tsx",
  title: "Button",
  component: { file: "src/Button.tsx", name: "Button" },
  stories: [{ name: "Primary" }],
  ...g
})
const run = (code: CodeSpec[], groups: GroupSpec[]) =>
  reconcileStorybook([codeDoc("react-ui", code), storyDoc("stories", groups)])
const codes = (r: ReturnType<typeof run>) =>
  r.discrepancies.map((d) => d.code.replace("reconcile.storybook.", ""))

describe("linking", () => {
  it("links a group to the component with the same file and local name, regardless of display name", () => {
    const r = run([{ ...button, name: "Fancy Button" }], [group()])
    expect(r.links).toEqual([
      {
        group: "storybook:src/Button.stories.tsx",
        storySourceId: "stories",
        stories: ["storybook:src/Button.stories.tsx#Primary"],
        component: "react:src/Button.tsx#Button",
        componentSourceId: "react-ui",
        via: "component",
        matchedBy: "file+localName"
      }
    ])
  })

  it("does not link on a matching display name alone", () => {
    const r = run([button], [group({ component: { file: "src/Other.tsx", name: "Button" } })])
    expect(r.links).toEqual([])
    expect(codes(r)).toEqual(["component-unlinked"])
    expect(r.discrepancies[0]?.severity).toBe("info")
  })

  it("skips groups without a resolved component, and records type-argument links", () => {
    const r = run(
      [button],
      [
        group({ component: undefined }),
        group({
          file: "src/B.stories.tsx",
          component: { file: "src/Button.tsx", name: "Button", via: "type-argument" }
        })
      ]
    )
    expect(r.links).toHaveLength(1)
    expect(r.links[0]?.via).toBe("type-argument")
  })

  it("links across frameworks using the neutral key", () => {
    const vue: CodeSpec = {
      ref: "vue:Btn.vue#Btn",
      name: "Btn",
      file: "Btn.vue",
      localName: "Btn",
      framework: "vue",
      props: { tone: { allowedValues: ["a", "b"] } }
    }
    const r = reconcileStorybook([
      codeDoc("vue-ui", [vue]),
      storyDoc("stories", [
        group({
          file: "Btn.stories.ts",
          component: { file: "Btn.vue", name: "Btn" },
          stories: [{ name: "S", args: { tone: "c" } }]
        })
      ])
    ])
    expect(r.links[0]?.componentSourceId).toBe("vue-ui")
    expect(codes(r)).toContain("arg-value-not-allowed")
  })
})

describe("args", () => {
  it("flags a literal arg outside the declared values, citing evidence from both sides and the story location", () => {
    const r = run([button], [group({ stories: [{ name: "Danger", args: { variant: "danger" } }] })])
    const d = r.discrepancies.find((x) => x.code.endsWith("arg-value-not-allowed"))
    expect(d).toMatchObject({
      severity: "warning",
      prop: "variant",
      sourceId: "stories",
      entityId: "storybook:src/Button.stories.tsx#Danger",
      location: { path: "src/Button.stories.tsx" }
    })
    expect(d?.message).toContain('"danger"')
    expect(d?.storybookEvidence).toHaveLength(1)
    expect(d?.codeEvidence).toHaveLength(1)
  })

  it("accepts declared values and numeric or boolean literals correctly", () => {
    const code: CodeSpec = {
      ...button,
      props: { n: { allowedValues: [1, 2] }, b: { allowedValues: [true, false] } }
    }
    expect(
      codes(run([code], [group({ stories: [{ name: "S", args: { n: 2, b: false } }] })])).filter(
        (c) => c === "arg-value-not-allowed"
      )
    ).toEqual([])
    expect(codes(run([code], [group({ stories: [{ name: "S", args: { n: 3 } }] })]))).toContain(
      "arg-value-not-allowed"
    )
  })

  it("does not check args that an argTypes mapping redefines, nor non-literal values", () => {
    const g = group({
      argTypes: { variant: { mappingKeys: ["danger"] } },
      stories: [{ name: "S", args: { variant: "danger", size: { a: 1 } } }]
    })
    expect(codes(run([button], [g]))).not.toContain("arg-value-not-allowed")
  })

  it("claims an undeclared arg only when the implementation's props are fully known", () => {
    const g = group({ stories: [{ name: "S", args: { bogus: 1 } }] })
    expect(codes(run([button], [g]))).toContain("arg-undeclared")
    const open = run([{ ...button, propsComplete: false }], [g])
    expect(codes(open)).not.toContain("arg-undeclared")
    expect(open.discrepancies.find((d) => d.code.endsWith("unverifiable-names"))?.message).toContain("bogus")
  })

  it("treats variant and slot names, and children, as declared", () => {
    const code: CodeSpec = { ...button, props: {}, variants: ["tone"], slots: ["default", "icon"] }
    const g = group({ stories: [{ name: "S", args: { tone: "a", children: "x" } }] })
    expect(codes(run([code], [g]))).not.toContain("arg-undeclared")
  })

  it("flags args for deprecated props and demonstration of a deprecated component", () => {
    const r = run(
      [{ ...button, deprecated: true }],
      [group({ stories: [{ name: "S", args: { plain: true } }] })]
    )
    expect(codes(r).filter((c) => c === "deprecated-demonstrated")).toHaveLength(2)
    expect(
      r.discrepancies.filter((d) => d.code.endsWith("deprecated-demonstrated")).map((d) => d.prop)
    ).toContain("plain")
  })

  it("makes no arg claims for a story with a custom render: its args may belong to another component", () => {
    const g = group({ stories: [{ name: "Custom", render: true, args: { bogus: 1, variant: "danger" } }] })
    const r = run([button], [g])
    expect(codes(r)).not.toContain("arg-undeclared")
    expect(codes(r)).not.toContain("arg-value-not-allowed")
    expect(r.discrepancies.find((d) => d.code.endsWith("unverifiable-names"))?.message).toContain(
      "custom render"
    )
  })

  it("claims meta-level args only when some story uses the default render", () => {
    const meta = { args: { variant: "danger" } }
    expect(
      codes(
        run(
          [button],
          [
            group({
              ...meta,
              stories: [
                { name: "A", render: true },
                { name: "B", render: true }
              ]
            })
          ]
        )
      )
    ).not.toContain("arg-value-not-allowed")
    expect(
      codes(
        run([button], [group({ ...meta, stories: [{ name: "A", render: true }, { name: "B" }] })])
      ).filter((c) => c === "arg-value-not-allowed")
    ).toHaveLength(1)
  })

  it("still checks controls for a custom-render story, since controls describe the meta component's props", () => {
    const g = group({ argTypes: { ghost: {} }, stories: [{ name: "Custom", render: true }] })
    expect(codes(run([button], [g]))).toContain("control-undeclared")
  })

  it("checks meta-level args once, not once per story", () => {
    const r = run(
      [button],
      [group({ args: { variant: "danger" }, stories: [{ name: "A" }, { name: "B" }, { name: "C" }] })]
    )
    expect(codes(r).filter((c) => c === "arg-value-not-allowed")).toHaveLength(1)
  })
})

describe("controls", () => {
  it("flags control options the component does not declare, unless options are mapped or unresolved", () => {
    const flagged = run([button], [group({ argTypes: { variant: { options: ["primary", "danger"] } } })])
    expect(
      flagged.discrepancies.find((d) => d.code.endsWith("control-option-not-allowed"))?.message
    ).toContain('"danger"')
    expect(
      codes(
        run([button], [group({ argTypes: { variant: { options: ["danger"], mappingKeys: ["danger"] } } })])
      )
    ).not.toContain("control-option-not-allowed")
    expect(
      codes(run([button], [group({ argTypes: { variant: { options: ["danger"], optionsPartial: true } } })]))
    ).not.toContain("control-option-not-allowed")
  })

  it("flags a control for an undeclared prop only when props are complete and the row is visible", () => {
    expect(codes(run([button], [group({ argTypes: { ghost: {} } })]))).toContain("control-undeclared")
    expect(codes(run([button], [group({ argTypes: { ghost: { hidden: true } } })]))).not.toContain(
      "control-undeclared"
    )
    expect(
      codes(run([{ ...button, propsComplete: false }], [group({ argTypes: { ghost: {} } })]))
    ).not.toContain("control-undeclared")
  })

  it("compares documented defaults with code defaults, ignoring quoting and type spelling", () => {
    const mismatch = (summary: string, code: string | boolean | number) =>
      codes(
        run(
          [{ ...button, props: { p: { default: code } } }],
          [group({ argTypes: { p: { defaultSummary: summary } } })]
        )
      ).includes("default-mismatch")
    expect(mismatch("'md'", "md")).toBe(false)
    expect(mismatch('"md"', "md")).toBe(false)
    expect(mismatch("md", "md")).toBe(false)
    expect(mismatch("false", false)).toBe(false)
    expect(mismatch("16", 16)).toBe(false)
    expect(mismatch("lg", "md")).toBe(true)
    expect(mismatch("true", false)).toBe(true)
  })

  it("makes no default claim when the code has no known default", () => {
    expect(codes(run([button], [group({ argTypes: { label: { defaultSummary: "x" } } })]))).not.toContain(
      "default-mismatch"
    )
  })

  it("flags controls for deprecated props", () => {
    expect(codes(run([button], [group({ argTypes: { plain: {} } })]))).toContain("deprecated-demonstrated")
    expect(codes(run([button], [group({ argTypes: { plain: { hidden: true } } })]))).not.toContain(
      "deprecated-demonstrated"
    )
  })
})

describe("coverage", () => {
  it("reports props no story demonstrates, skipping children, refs and handlers", () => {
    const r = run([button], [group({ stories: [{ name: "S", args: { variant: "primary" } }] })])
    const d = r.discrepancies.find((x) => x.code.endsWith("prop-not-demonstrated"))
    expect(d?.severity).toBe("info")
    expect(d?.message).toContain("label, plain, size")
    expect(d?.message).not.toContain("children")
    expect(d?.message).not.toContain("onPress")
    expect(d?.sourceId).toBe("react-ui")
  })

  it("counts argTypes and unresolved args as demonstrating a prop", () => {
    const r = run(
      [button],
      [
        group({
          argTypes: { size: {}, label: {}, plain: {} },
          stories: [{ name: "S", args: { variant: "primary" } }]
        })
      ]
    )
    expect(codes(r)).not.toContain("prop-not-demonstrated")
    const unresolved = run(
      [button],
      [
        group({
          stories: [
            { name: "S", args: { variant: "primary", size: "sm" }, unresolvedArgs: ["label", "plain"] }
          ]
        })
      ]
    )
    expect(codes(unresolved)).not.toContain("prop-not-demonstrated")
  })

  it("reports declared values never shown by an arg or a control", () => {
    const r = run(
      [button],
      [
        group({
          argTypes: { variant: { options: ["primary", "secondary"] } },
          stories: [{ name: "S", args: { size: "sm" } }]
        })
      ]
    )
    const messages = r.discrepancies
      .filter((d) => d.code.endsWith("value-not-demonstrated"))
      .map((d) => d.message)
    expect(
      messages.some((m) => m.includes("Button.variant") && m.includes('"ghost"') && !m.includes('"primary"'))
    ).toBe(true)
    expect(messages.some((m) => m.includes("Button.size") && m.includes('"md"'))).toBe(true)
  })

  it("makes no value-coverage claim when the story side is uncertain", () => {
    const r = run(
      [button],
      [
        group({
          argTypes: { variant: { options: ["primary"], optionsPartial: true } },
          stories: [{ name: "S", args: { size: "sm" }, unresolvedArgs: ["size"] }]
        })
      ]
    )
    expect(codes(r)).not.toContain("value-not-demonstrated")
  })

  it("reports nothing for a component with no stories", () => {
    expect(codes(run([button], [group({ stories: [] })]))).not.toContain("prop-not-demonstrated")
  })
})

describe("output", () => {
  it("converts findings to diagnostics with source, entity and location", () => {
    const r = run([button], [group({ stories: [{ name: "Danger", args: { variant: "danger" } }] })])
    const d = r.diagnostics.find((x) => x.code === "reconcile.storybook.arg-value-not-allowed")
    expect(d).toMatchObject({
      severity: "warning",
      sourceId: "stories",
      entityId: "storybook:src/Button.stories.tsx#Danger",
      location: { path: "src/Button.stories.tsx" }
    })
  })

  it("is deterministic regardless of input order", () => {
    const code = codeDoc("react-ui", [
      button,
      { ...button, ref: "react:src/B2.tsx#B2", name: "B2", file: "src/B2.tsx", localName: "B2" }
    ])
    const stories = storyDoc("stories", [
      group({ stories: [{ name: "Danger", args: { variant: "danger", bogus: 1 } }] }),
      group({
        file: "src/B2.stories.tsx",
        title: "B2",
        component: { file: "src/B2.tsx", name: "B2" },
        stories: [{ name: "X", args: { size: "xl" } }]
      })
    ])
    const a = reconcileStorybook([code, stories])
    const b = reconcileStorybook([stories, code])
    expect(b).toEqual(a)
    expect(a.discrepancies.length).toBeGreaterThan(2)
  })

  it("ignores non-storybook documents and documents with no linkable components", () => {
    expect(reconcileStorybook([codeDoc("react-ui", [button])])).toEqual({
      links: [],
      discrepancies: [],
      diagnostics: []
    })
  })
})
