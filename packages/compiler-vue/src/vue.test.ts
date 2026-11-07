import { compile, memoryFs, type SourceAdapter } from "@invariant/compiler-core"
import {
  checkAdapterConformance,
  checkCompileDeterminism,
  FIXED_CLOCK
} from "@invariant/compiler-core/testing"
import { verifyIrDocument } from "@invariant/compiler-ir"
import { describe, expect, it } from "vitest"
import { analyzeTemplate, parseSfc, sfcLocalName, vueAdapter } from "./index.js"

const adapter = vueAdapter as SourceAdapter
const manifest = JSON.stringify({
  name: "ui",
  version: "1.0.0",
  exports: "./src/index.ts",
  peerDependencies: { vue: "^3.5.0" }
})

async function run(sfcs: Record<string, string>, extra: Record<string, string> = {}) {
  const names = Object.keys(sfcs)
  const index = names.map((n) => `export { default as ${n} } from "./${n}.vue"`).join("\n")
  const files: Record<string, string> = { "package.json": manifest, "src/index.ts": index, ...extra }
  for (const [n, source] of Object.entries(sfcs)) files[`src/${n}.vue`] = source
  const result = await compile({ fs: memoryFs(files), adapters: [adapter], clock: FIXED_CLOCK })
  const ir = result.irDocuments[0]
  const facts = (name: string): Record<string, unknown> => {
    const entity = ir?.entities.find((e) => e.name === name)
    return Object.fromEntries(
      (ir?.facts ?? []).filter((f) => f.subject === entity?.ref).map((f) => [f.path, f.value])
    )
  }
  return { result, ir, facts, codes: result.diagnostics.map((d) => d.code) }
}
const one = (script: string, template = "<div />") => ({
  C: `<script setup lang="ts">\n${script}\n</script>\n<template>${template}</template>`
})

describe("component discovery", () => {
  it("finds components exported as re-exports, local export lists, barrels, and defineComponent in TS, but not internal ones", async () => {
    const { ir } = await run(
      {
        A: "<template><i /></template>",
        B: "<template><i /></template>",
        Hidden: "<template><i /></template>"
      },
      {
        "src/index.ts": `import B from "./B.vue"\nexport { default as A } from "./A.vue"\nexport { B }\nexport * from "./barrel"\nexport { Ts } from "./ts"`,
        "src/barrel.ts": `export { default as C } from "./C.vue"`,
        "src/C.vue": "<template><i /></template>",
        "src/ts.ts": `import { defineComponent } from "vue"\nexport const Ts = defineComponent({ props: { x: Number } })`
      }
    )
    expect(ir?.entities.map((e) => e.name).sort()).toEqual(["A", "B", "C", "Ts"])
  })

  it("names SFC components after the PascalCase file name, and links on file plus that name", async () => {
    expect(sfcLocalName("src/button-group.vue")).toBe("ButtonGroup")
    const { facts } = await run(
      { "button-group": "<template><i /></template>" },
      { "src/index.ts": `export { default as Group } from "./button-group.vue"` }
    )
    const f = facts("ButtonGroup")
    expect(f["implementations.vue.extensions.vue.file"]).toBe("src/button-group.vue")
    expect(f["implementations.vue.extensions.vue.localName"]).toBe("ButtonGroup")
    expect(f["implementations.vue.extensions.vue.exports"]).toEqual([{ subpath: ".", name: "Group" }])
  })
})

describe("props", () => {
  it("reads type-based props with required, defaults from withDefaults, literal domains and JSDoc", async () => {
    const { facts } = await run(
      one(`withDefaults(defineProps<{
  /** Visual weight. */
  variant?: "primary" | "ghost"
  count: number
  /** @deprecated Gone. */
  old?: boolean
  list?: string[]
}>(), { variant: "primary", list: () => ["a"] })`)
    )
    const f = facts("C")
    expect(f["props.variant.allowedValues"]).toEqual(["primary", "ghost"])
    expect(f["props.variant.default"]).toBe("primary")
    expect(f["props.variant.description"]).toBe("Visual weight.")
    expect(f["props.count.required"]).toBe(true)
    expect(f["props.old.deprecated"]).toEqual({ reason: "Gone." })
    expect(f["props.list.default"]).toBeUndefined()
    expect(f["props.list.extensions.vue.defaultExpression"]).toBe('() => ["a"]')
    expect(f["variants.variant.values"]).toEqual(["primary", "ghost"])
  })

  it("reads reactive props destructure defaults (Vue 3.5)", async () => {
    const { facts } = await run(
      one(`const { size = "md", n = 3 } = defineProps<{ size?: "sm" | "md"; n?: number }>()`)
    )
    expect(facts("C")["props.size.default"]).toBe("md")
    expect(facts("C")["props.n.default"]).toBe(3)
  })

  it("reads imported and interface-based prop types, with inheritance from a local base", async () => {
    const { facts } = await run(
      {
        C: `<script setup lang="ts">\nimport type { Shared } from "./types"\ninterface Own extends Shared { own?: string }\ndefineProps<Own>()\n</script>\n<template><i /></template>`
      },
      { "src/types.ts": `export interface Shared { shared: number }` }
    )
    expect(
      Object.keys(facts("C"))
        .filter((k) => k.endsWith(".required"))
        .sort()
    ).toEqual(["props.own.required", "props.shared.required"])
    expect(facts("C")["implementations.vue.extensions.vue.propsComplete"]).toBe(true)
  })

  it("resolves a props interface exported from another SFC's <script>, through a relative import and a tsconfig paths alias", async () => {
    const { facts } = await run(
      {
        Base: `<script lang="ts">\nexport interface BaseProps { as?: string; shared?: boolean }\n</script>\n<template><i /></template>`,
        Direct: `<script setup lang="ts">\nimport type { BaseProps } from "./Base.vue"\ninterface P extends BaseProps { own?: number }\ndefineProps<P>()\n</script>\n<template><i /></template>`,
        Aliased: `<script setup lang="ts">\nimport type { BaseProps } from "@/index"\ndefineProps<BaseProps>()\n</script>\n<template><i /></template>`
      },
      {
        "tsconfig.json": `{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }`,
        "src/index.ts": `export { default as Base, type BaseProps } from "./Base.vue"\nexport { default as Direct } from "./Direct.vue"\nexport { default as Aliased } from "./Aliased.vue"`
      }
    )
    for (const name of ["Direct", "Aliased"]) {
      expect(facts(name)["props.shared.type.text"]).toBe("boolean")
      expect(facts(name)["implementations.vue.extensions.vue.propsComplete"]).toBe(true)
    }
    expect(
      Object.keys(facts("Direct"))
        .filter((k) => k.endsWith(".required"))
        .sort()
    ).toEqual(["props.as.required", "props.own.required", "props.shared.required"])
    expect(facts("Aliased")["props.as.type.text"]).toBe("string")
  })

  it("marks props incomplete for external bases (including import types) and unresolved types", async () => {
    const external = await run(one(`defineProps<{ a?: 1 } & import("vue").InputHTMLAttributes>()`))
    expect(external.facts("C")["implementations.vue.extensions.vue.propsComplete"]).toBe(false)
    expect(external.facts("C")["implementations.vue.extensions.vue.inheritedPropsFrom"]).toEqual([
      'import("vue").InputHTMLAttributes'
    ])
    const unresolved = await run(one(`import type { Nowhere } from "elsewhere"\ndefineProps<Nowhere>()`))
    expect(unresolved.facts("C")["implementations.vue.extensions.vue.propsComplete"]).toBe(false)
  })

  it("reads runtime object props with PropType casts, required, defaults, and unions of constructors", async () => {
    const { facts } = await run(
      one(`import type { PropType } from "vue"
defineProps({
  tone: { type: String as PropType<"a" | "b">, default: "a", validator: (v: string) => true },
  n: { type: Number, required: true },
  mixed: [String, Number],
  items: Array as PropType<string[]>,
  flag: Boolean
})`)
    )
    const f = facts("C")
    expect(f["props.tone.type.kind"]).toBe("enum")
    expect(f["props.tone.allowedValues"]).toEqual(["a", "b"])
    expect(f["props.tone.default"]).toBe("a")
    expect(f["props.n.required"]).toBe(true)
    expect(f["props.mixed.type.text"]).toBe("string | number")
    expect(f["props.items.type.text"]).toBe("string[]")
    expect(f["props.flag.type.kind"]).toBe("boolean")
    expect(f["props.tone.extensions.vue.source"]).toBe("runtime")
  })

  it("reads array props and Options API props with defineComponent", async () => {
    const array = await run({
      C: `<script>\nexport default { props: ["a", "b"] }\n</script>\n<template><i /></template>`
    })
    expect(
      Object.keys(array.facts("C"))
        .filter((k) => k.endsWith(".type.kind"))
        .sort()
    ).toEqual(["props.a.type.kind", "props.b.type.kind"])
    expect(array.facts("C")["props.a.extensions.vue.source"]).toBe("array")
    expect(array.facts("C")["implementations.vue.extensions.vue.optionsApi"]).toBe(true)
    const defined = await run({
      C: `<script lang="ts">\nimport { defineComponent } from "vue"\nexport default defineComponent({ name: "X", props: { a: String } })\n</script>\n<template><i /></template>`
    })
    expect(defined.facts("C")["implementations.vue.extensions.vue.options.name"]).toBe("X")
  })

  it("merges a normal <script> block with <script setup>, so types declared in one are visible in the other", async () => {
    const { facts } = await run({
      C: `<script lang="ts">\nexport interface Props { shared?: string }\nexport default { inheritAttrs: false }\n</script>\n<script setup lang="ts">\ndefineProps<Props>()\ndefineOptions({ name: "Both" })\n</script>\n<template><i /></template>`
    })
    expect(facts("C")["props.shared.type.text"]).toBe("string")
    expect(facts("C")["implementations.vue.extensions.vue.options.inheritAttrs"]).toBe(false)
    expect(facts("C")["implementations.vue.extensions.vue.options.name"]).toBe("Both")
  })

  it("works for plain JavaScript SFCs", async () => {
    const { facts } = await run({
      C: `<script setup>\ndefineProps({ tone: { type: String, default: "info" } })\ndefineEmits(["done"])\n</script>\n<template><i /></template>`
    })
    expect(facts("C")["props.tone.default"]).toBe("info")
    expect(facts("C")["events.done.declared"]).toBe(true)
  })
})

describe("events, models, slots, expose", () => {
  it("reads both defineEmits type forms and runtime forms, with payload text", async () => {
    const calls = await run(
      one(`defineEmits<{ (e: "save", id: number, force?: boolean): void; (e: "cancel"): void }>()`)
    )
    expect(calls.facts("C")["events.save.payload.text"]).toBe("id: number, force: boolean | undefined")
    expect(calls.facts("C")["events.cancel.declared"]).toBe(true)
    expect(calls.facts("C")["events.cancel.payload.text"]).toBeUndefined()
    const tuple = await run(one(`defineEmits<{ change: [id: number]; close: [] }>()`))
    expect(tuple.facts("C")["events.change.payload.text"]).toBe("[id: number]")
    expect(tuple.facts("C")["events.close.declared"]).toBe(true)
    const runtime = await run(one(`defineEmits({ done: (v: string) => true })`))
    expect(runtime.facts("C")["events.done.extensions.vue.source"]).toBe("runtime")
  })

  it("turns defineModel into a prop plus an update event, with default and named models", async () => {
    const { facts } = await run(
      one(
        `const a = defineModel<string>({ required: true })\nconst b = defineModel<boolean>("open", { default: false })\nconst c = defineModel("count", { type: Number })`
      )
    )
    const f = facts("C")
    expect(f["props.modelValue.required"]).toBe(true)
    expect(f["props.modelValue.extensions.vue.kind"]).toBe("model")
    expect(f["events.update:modelValue.payload.text"]).toBe("string")
    expect(f["props.open.default"]).toBe(false)
    expect(f["events.update:open.extensions.vue.kind"]).toBe("model")
    expect(f["props.count.type.kind"]).toBe("number")
  })

  it("merges defineSlots with template slots, records scoped slot props, and flags dynamic slot names", async () => {
    const { facts, codes } = await run({
      C: `<script setup lang="ts">\ndefineSlots<{ default(): unknown; item(props: { id: number }): unknown }>()\nconst dyn = "x"\n</script>\n<template>\n  <div>\n    <slot />\n    <slot name="item" :id="1" label="x" />\n    <slot name="footer" :open="true" />\n    <slot :name="dyn" />\n  </div>\n</template>`
    })
    const f = facts("C")
    expect(f["slots.item.extensions.vue.source"]).toBe("both")
    expect(f["slots.item.extensions.vue.props"]).toBe("{ id: number; }")
    expect(f["slots.item.extensions.vue.propNames"]).toEqual(["id", "label"])
    expect(f["slots.footer.extensions.vue.source"]).toBe("template")
    expect(f["slots.default.extensions.vue.source"]).toBe("both")
    expect(f["implementations.vue.extensions.vue.dynamicSlots"]).toBe(1)
    expect(
      Object.keys(f)
        .filter((k) => /^slots\.[^.]+\.declared$/.test(k))
        .sort()
    ).toEqual(["slots.default.declared", "slots.footer.declared", "slots.item.declared"])
    expect(codes).toContain("vue.dynamic-slot-name")
  })

  it("records defineExpose names and defineOptions metadata", async () => {
    const { facts } = await run(
      one(
        `const a = 1\nfunction b() {}\ndefineExpose({ a, b })\ndefineOptions({ name: "N", inheritAttrs: false })`
      )
    )
    expect(facts("C")["implementations.vue.extensions.vue.exposed"]).toEqual(["a", "b"])
    expect(facts("C")["implementations.vue.extensions.vue.options.name"]).toBe("N")
  })
})

describe("template, styling and composition", () => {
  it("reads static role and aria attributes on native elements only, including bound aria attributes", async () => {
    const { facts } = await run(
      one(
        `import Other from "./Other.vue"`,
        `<div role="dialog" :aria-modal="true" aria-label="x"><Other role="ignored" aria-x="1" /></div>`
      ),
      { "src/Other.vue": "<template><i /></template>" }
    )
    expect(facts("C")["accessibility.role"]).toBe("dialog")
    expect(facts("C")["accessibility.attributes"]).toEqual(["aria-label", "aria-modal"])
  })

  it("resolves component tags (PascalCase and kebab-case) through imports to other public components", async () => {
    const { facts } = await run(
      {
        Parent: `<script setup lang="ts">\nimport Child from "./Child.vue"\nimport Other from "./Other.vue"\n</script>\n<template><div><Child /><child-component /><Child /><Other /><Unimported /></div></template>`,
        Child: "<template><i /></template>"
      },
      { "src/Other.vue": "<template><i /></template>" }
    )
    expect(facts("Parent")["composition.renders"]).toEqual([{ target: "vue:src/Child.vue#Child", count: 2 }])
  })

  it("collects style blocks: scoped, module, preprocessors, and var() references with file lines", async () => {
    const { facts, ir } = await run({
      C: `<template><i /></template>\n<style scoped lang="scss">\n.a { color: var(--one); }\n</style>\n<style module>\n.b {\n  margin: var(--two, 1px);\n}\n</style>`
    })
    const f = facts("C")
    expect(f["styling.scoped"]).toBe(true)
    expect(f["styling.cssModules"]).toEqual(["src/C.vue"])
    expect(f["styling.preprocessors"]).toEqual(["scss"])
    expect(f["styling.cssVariables"]).toEqual(["--one", "--two"])
    const fact = ir?.facts.find((x) => x.path === "styling.cssVariables")
    const lines = ir?.evidence
      .filter((e) => fact?.evidenceIds.includes(e.id))
      .map((e) => (e.location.type === "file" ? e.location.line : 0))
      .sort()
    expect(lines).toEqual([3, 7])
  })

  it("skips non-HTML templates and external blocks without guessing, and says so", () => {
    const pug = parseSfc("a.vue", `<template lang="pug">\np hi\n</template>`)
    expect(analyzeTemplate(pug.descriptor).skipped).toContain("pug")
    const external = parseSfc("a.vue", `<template src="./t.html"></template>`)
    expect(analyzeTemplate(external.descriptor).skipped).toContain("external")
  })

  it("reports a script loaded from another file as incomplete props", async () => {
    const { facts, codes } = await run({
      C: `<script lang="ts" src="./x.ts"></script>\n<template><i /></template>`
    })
    expect(facts("C")["implementations.vue.extensions.vue.propsComplete"]).toBe(false)
    expect(codes).toContain("vue.external-block")
  })

  it("flags generic components as incomplete", async () => {
    const { facts } = await run({
      C: `<script setup lang="ts" generic="T">\ndefineProps<{ items: T[] }>()\n</script>\n<template><i /></template>`
    })
    expect(facts("C")["implementations.vue.extensions.vue.generic"]).toBe("T")
    expect(facts("C")["implementations.vue.extensions.vue.propsComplete"]).toBe(false)
  })
})

describe("evidence", () => {
  it("maps virtual script lines back to the .vue file for props, emits and slots", async () => {
    const { ir } = await run({
      C: `<template>\n  <div><slot name="head" /></div>\n</template>\n\n<script setup lang="ts">\n// comment\ndefineProps<{\n  size?: "a" | "b"\n}>()\ndefineEmits<{ (e: "go"): void }>()\n</script>`
    })
    const line = (path: string): number | undefined => {
      const fact = ir?.facts.find((f) => f.path === path)
      const ev = ir?.evidence.find((e) => fact?.evidenceIds.includes(e.id))
      return ev?.location.type === "file" ? ev.location.line : undefined
    }
    expect(line("props.size.type.text")).toBe(8)
    expect(line("events.go.declared")).toBe(10)
    expect(line("slots.head.declared")).toBe(2)
    expect(
      ir?.evidence.every(
        (e) =>
          (e.location.type === "file" && e.location.path.endsWith(".vue")) ||
          e.location.type !== "file" ||
          e.location.path.endsWith(".ts")
      )
    ).toBe(true)
  })

  it("reports SFC parse errors without failing the source", async () => {
    const { result, codes } = await run({ C: `<template><div></template>` })
    expect(codes).toContain("vue.sfc-parse-error")
    expect(result.irDocuments[0]?.completeness).not.toBe("failed")
  })
})

describe("adapter behavior", () => {
  it("only reads packages that declare Vue, and never executes the analyzed code", async () => {
    const files = {
      "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
      "packages/a/package.json": JSON.stringify({
        name: "a",
        peerDependencies: { vue: "^3" },
        exports: "./src/index.ts"
      }),
      "packages/a/src/index.ts": `throw new Error("executed")\nexport { default as A } from "./A.vue"\nprocess.exit(1)`,
      "packages/a/src/A.vue": `<script setup lang="ts">\nthrow new Error("executed")\ndefineProps<{ x?: 1 }>()\n</script>\n<template><i /></template>`,
      "packages/b/package.json": JSON.stringify({ name: "b", dependencies: { react: "^18" } })
    }
    const result = await compile({ fs: memoryFs(files), adapters: [adapter], clock: FIXED_CLOCK })
    expect(result.sources.map((s) => s.id)).toEqual(["vue-a"])
    expect(result.irDocuments[0]?.entities.map((e) => e.name)).toEqual(["A"])
    expect(result.ok).toBe(true)
  })

  it("warns informationally when a Vue package exposes no components", async () => {
    const { codes, result } = await run({}, { "src/index.ts": "export const x = 1" })
    expect(codes).toContain("vue.no-components")
    expect(result.ok).toBe(true)
  })

  it("passes conformance, is deterministic, and emits valid evidence-backed IR", async () => {
    const files = {
      "package.json": manifest,
      "src/index.ts": `export { default as A } from "./A.vue"`,
      "src/A.vue": `<script setup lang="ts">\ndefineProps<{ s?: "a" | "b" }>()\n</script>\n<template><button role="button"><slot /></button></template>`
    }
    expect(await checkAdapterConformance(adapter, { fs: memoryFs(files) })).toEqual([])
    expect(await checkCompileDeterminism({ fs: memoryFs(files), adapters: [adapter] })).toEqual([])
    const result = await compile({ fs: memoryFs(files), adapters: [adapter], clock: FIXED_CLOCK })
    const ir = result.irDocuments[0]
    expect(ir && verifyIrDocument(ir)).toEqual([])
    const ids = new Set(ir?.evidence.map((e) => e.id))
    expect(ir?.facts.every((f) => f.evidenceIds.length > 0 && f.evidenceIds.every((id) => ids.has(id)))).toBe(
      true
    )
  })
})

describe("declaration files", () => {
  const dts: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "@acme/ui",
      version: "1.0.0",
      types: "./dist/index.d.ts",
      peerDependencies: { vue: "^3.5.0" }
    }),
    "dist/index.d.ts": `export { default as Button } from "./Button.vue";
export { default as Card } from "./Card.vue";
import type { DefineComponent, PropType, ExtractPropTypes } from "vue";
declare const Tag: DefineComponent<ExtractPropTypes<{
  tone: { type: PropType<"info" | "warn">; required: true };
  label: StringConstructor;
  count: { type: NumberConstructor; default: number };
}>, {}, {}, {}, {}, any, any, { close: (id: number) => void }, string>;
export { Tag };
export declare function useThing(): string;
export declare const VERSION: string;
`,
    "dist/Button.vue.d.ts": `import type { DefineComponent, PublicProps } from "vue";
interface Props {
  /** Visual style. */
  variant: "primary" | "ghost";
  size?: "sm" | "md";
}
declare const _default: import("vue").DefineComponent<Props, {}, {}, {}, {}, any, any, { click: [e: MouseEvent]; open: () => void }, string, PublicProps, Readonly<Props>, {}, {}>;
export default _default;
`,
    "dist/Card.vue.d.ts": `import type { DefineComponent } from "vue";
declare const __VLS_component: DefineComponent<{ title?: string }, {}, {}, {}, {}, any, any, {}, string>;
declare const _default: __VLS_WithTemplateSlots<typeof __VLS_component, { default?(_: {}): any; footer?(_: { close: () => void }): any }>;
export default _default;
type __VLS_WithTemplateSlots<T, S> = T & { new (): { $slots: S } };
`
  }

  async function runDts() {
    const root = "node_modules/@acme/ui"
    const result = await compile({
      fs: memoryFs({
        "package.json": JSON.stringify({ name: "app", dependencies: { "@acme/ui": "1.0.0" } }),
        ...Object.fromEntries(Object.entries(dts).map(([path, text]) => [`${root}/${path}`, text]))
      }),
      adapters: [adapter],
      clock: FIXED_CLOCK,
      discovery: { declarationRoots: [root] }
    })
    const ir = result.irDocuments[0]
    const facts = (name: string): Record<string, unknown> => {
      const entity = ir?.entities.find((e) => e.name === name)
      return Object.fromEntries(
        (ir?.facts ?? []).filter((f) => f.subject === entity?.ref).map((f) => [f.path, f.value])
      )
    }
    return { ir, facts, codes: result.diagnostics.map((d) => d.code) }
  }

  it("reads props, events and slots from DefineComponent types, and not functions or constants", async () => {
    const { ir, facts, codes } = await runDts()
    expect(ir?.entities.map((e) => e.name).sort()).toEqual(["Button", "Card", "Tag"])
    const button = facts("Button")
    expect(button["props.variant.allowedValues"]).toEqual(["primary", "ghost"])
    expect(button["props.variant.required"]).toBe(true)
    expect(button["props.variant.description"]).toBe("Visual style.")
    expect(button["props.size.required"]).toBe(false)
    expect(Object.keys(button).some((p) => p.startsWith("events.click"))).toBe(true)
    expect(Object.keys(button).some((p) => p.startsWith("events.open"))).toBe(true)
    const card = facts("Card")
    expect(Object.keys(card).some((p) => p.startsWith("slots.default"))).toBe(true)
    expect(Object.keys(card).some((p) => p.startsWith("slots.footer"))).toBe(true)
    // A declaration file has types, not default values, and says so once.
    expect(codes).toContain("vue.declaration-defaults-unavailable")
  })

  it("reads runtime-style props: constructors, PropType, required, and a default makes no claim of its value", async () => {
    const { facts } = await runDts()
    const tag = facts("Tag")
    expect(tag["props.tone.allowedValues"]).toEqual(["info", "warn"])
    expect(tag["props.tone.required"]).toBe(true)
    expect(tag["props.label.type.kind"]).toBe("string")
    expect(tag["props.count.type.kind"]).toBe("number")
    expect(Object.keys(tag).some((p) => p.startsWith("props.count.default"))).toBe(false)
    expect(Object.keys(tag).some((p) => p.startsWith("events.close"))).toBe(true)
  })
})

describe("declaration files: library wrapper types", () => {
  // No `vue` peer dependency, like PrimeVue: the configured source type says it is a Vue package.
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "@acme/wrapped", version: "1.0.0", types: "./index.d.ts" }),
    "index.d.ts": `import type { DefineComponent, CreateComponentPublicInstanceWithMixins } from "vue";
type SFCWithInstall<T> = T & { install(app: unknown): void };
declare const _default: DefineComponent<{ tone?: "info" | "warn" }, {}, {}, {}, {}, any, any, {}, string>;
export declare const ElAlert: SFCWithInstall<typeof _default>;
export declare const VChip: {
  new (...args: any[]): CreateComponentPublicInstanceWithMixins<{ size: "sm" | "md" } & { label?: string }, {}, {}, {}, {}, any, any, {}, string>;
};
export declare const VERSION: string;
export {};
`
  }

  async function runWrapped(declaredFrameworks?: Record<string, "vue">) {
    const root = "node_modules/@acme/wrapped"
    const result = await compile({
      fs: memoryFs({
        "package.json": JSON.stringify({ name: "app", dependencies: { "@acme/wrapped": "1.0.0" } }),
        ...Object.fromEntries(Object.entries(files).map(([path, text]) => [`${root}/${path}`, text]))
      }),
      adapters: [adapter],
      clock: FIXED_CLOCK,
      discovery: { declarationRoots: [root], ...(declaredFrameworks ? { declaredFrameworks } : {}) }
    })
    const ir = result.irDocuments[0]
    const facts = (name: string): Record<string, unknown> => {
      const entity = ir?.entities.find((e) => e.name === name)
      return Object.fromEntries(
        (ir?.facts ?? []).filter((f) => f.subject === entity?.ref).map((f) => [f.path, f.value])
      )
    }
    return { ir, facts }
  }

  it("finds nothing in a package that names no framework unless the source type is configured", async () => {
    expect((await runWrapped()).ir).toBeUndefined()
  })

  it("reads a component behind SFCWithInstall<typeof X> and a construct-signature component", async () => {
    const { ir, facts } = await runWrapped({ "node_modules/@acme/wrapped": "vue" })
    expect(ir?.entities.map((e) => e.name).sort()).toEqual(["ElAlert", "VChip"])
    expect(facts("ElAlert")["props.tone.allowedValues"]).toEqual(["info", "warn"])
    expect(facts("VChip")["props.size.allowedValues"]).toEqual(["sm", "md"])
  })
})
