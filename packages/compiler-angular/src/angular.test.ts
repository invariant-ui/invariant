import { compile, createAnalysis, memoryFs, type SourceAdapter } from "@invariant/compiler-core"
import {
  checkAdapterConformance,
  checkCompileDeterminism,
  FIXED_CLOCK
} from "@invariant/compiler-core/testing"
import { verifyIrDocument } from "@invariant/compiler-ir"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import { angularAdapter, matchesSelector, parseSelector, readClass, scanTemplate, slotName } from "./index.js"

const adapter = angularAdapter as SourceAdapter
const manifest = JSON.stringify({
  name: "ng",
  version: "1.0.0",
  peerDependencies: { "@angular/core": "^18.0.0" }
})

async function run(files: Record<string, string>, pkg = manifest) {
  const names = Object.keys(files)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.replace(/\.ts$/, ""))
  const api = names.map((n) => `export * from "./lib/${n}"`).join("\n")
  const all: Record<string, string> = { "package.json": pkg, "src/public-api.ts": api }
  for (const [name, content] of Object.entries(files)) all[`src/lib/${name}`] = content
  const result = await compile({ fs: memoryFs(all), adapters: [adapter], clock: FIXED_CLOCK })
  const ir = result.irDocuments[0]
  const facts = (name: string): Record<string, unknown> => {
    const entity = ir?.entities.find((e) => e.name === name)
    return Object.fromEntries(
      (ir?.facts ?? []).filter((f) => f.subject === entity?.ref).map((f) => [f.path, f.value])
    )
  }
  return { result, ir, facts, codes: result.diagnostics.map((d) => d.code) }
}
const cmp = (
  body: string,
  meta = `selector: "x-c", standalone: true, template: ""`,
  imports = "Component, Input, Output, EventEmitter, input, output, model, booleanAttribute"
) => `import { ${imports} } from "@angular/core"\n@Component({ ${meta} })\nexport class C {\n${body}\n}`

describe("class metadata", () => {
  it("reads selector, standalone only when written, exportAs, change detection and encapsulation", async () => {
    const { facts } = await run({
      "c.ts": `import { Component, ChangeDetectionStrategy, ViewEncapsulation } from "@angular/core"\n@Component({ selector: "a-b, button[a-b]", standalone: true, exportAs: "ab", changeDetection: ChangeDetectionStrategy.OnPush, encapsulation: ViewEncapsulation.None, template: "" })\nexport class C {}`
    })
    const f = facts("C")
    expect(f["implementations.angular.extensions.angular.selector"]).toBe("a-b, button[a-b]")
    expect(f["implementations.angular.extensions.angular.standalone"]).toBe(true)
    expect(f["implementations.angular.extensions.angular.exportAs"]).toBe("ab")
    expect(f["implementations.angular.extensions.angular.changeDetection"]).toBe("OnPush")
    expect(f["implementations.angular.extensions.angular.encapsulation"]).toBe("None")
  })

  it("does not assert a standalone default when the option is absent", async () => {
    const { facts } = await run({ "c.ts": cmp("", `selector: "x", template: ""`) })
    expect(facts("C")["implementations.angular.extensions.angular.standalone"]).toBeUndefined()
    const explicit = await run({ "c.ts": cmp("", `selector: "x", standalone: false, template: ""`) })
    expect(explicit.facts("C")["implementations.angular.extensions.angular.standalone"]).toBe(false)
  })

  it("recognizes aliased and namespace imports of the decorators, and ignores look-alikes", async () => {
    const aliased = await run({
      "c.ts": `import { Component as Cmp } from "@angular/core"\n@Cmp({ selector: "x", template: "" })\nexport class C {}`
    })
    expect(aliased.ir?.entities.map((e) => e.name)).toEqual(["C"])
    const ns = await run({
      "c.ts": `import * as core from "@angular/core"\n@core.Component({ selector: "x", template: "" })\nexport class C {}`
    })
    expect(ns.ir?.entities.map((e) => e.name)).toEqual(["C"])
    const fake = await run({
      "c.ts": `import { Component } from "not-angular"\n@Component({ selector: "x" })\nexport class C {}`
    })
    expect(fake.ir?.entities ?? []).toEqual([])
  })

  it("separates components from directives and reports only public classes", async () => {
    const { ir, facts } = await run({
      "a.ts": `import { Component, Directive } from "@angular/core"\n@Component({ selector: "a", template: "" })\nexport class A {}\n@Directive({ selector: "[b]" })\nexport class B {}\n@Component({ selector: "h", template: "" })\nclass Hidden {}`
    })
    expect(ir?.entities.map((e) => e.name).sort()).toEqual(["A", "B"])
    expect(facts("A")["implementations.angular.extensions.angular.kind"]).toBe("component")
    expect(facts("B")["implementations.angular.extensions.angular.kind"]).toBe("directive")
  })

  it("keeps the link key and records imports, host metadata, host directives and queries", async () => {
    const { facts } = await run({
      "d.ts": `import { Directive } from "@angular/core"\n@Directive({ selector: "[d]", standalone: true })\nexport class D {}`,
      "c.ts": `import { Component, HostBinding, HostListener, ViewChild, contentChild } from "@angular/core"\nimport { D } from "./d"\n@Component({ selector: "c", standalone: true, imports: [D], hostDirectives: [D], host: { "[class.on]": "x", "(click)": "go()", role: "button" }, template: "" })\nexport class C {\n  @HostBinding("attr.title") t = ""\n  @HostListener("window:resize") r() {}\n  @ViewChild("ref") ref!: unknown\n  child = contentChild("tpl")\n}`
    })
    const f = facts("C")
    const ext = "implementations.angular.extensions.angular"
    expect(f[`${ext}.file`]).toBe("src/lib/c.ts")
    expect(f[`${ext}.localName`]).toBe("C")
    expect(f[`${ext}.imports`]).toEqual([{ name: "D", file: "src/lib/d.ts", localName: "D" }])
    expect(f[`${ext}.host.bindings`]).toEqual(["attr.title", "class.on"])
    expect(f[`${ext}.host.listeners`]).toEqual(["click", "window:resize"])
    expect(f[`${ext}.hostDirectives`]).toEqual(["D"])
    expect(f[`${ext}.queries`]).toEqual([
      { kind: "ViewChild", property: "ref", selector: "ref" },
      { kind: "contentChild", property: "child", selector: "tpl" }
    ])
    // Host directives contribute inputs and outputs that are not enumerated.
    expect(f[`${ext}.propsComplete`]).toBe(false)
  })
})

describe("inputs and outputs", () => {
  it("reads signal inputs: generics, inferred types, required, alias, transform and write types", async () => {
    const { facts } = await run({
      "c.ts": cmp(`  a = input<"x" | "y">("x")
  b = input(false, { transform: booleanAttribute })
  c = input.required<number>({ alias: "cc" })
  d = input<string, string | number>("s", { transform: String })
  e = input()
  f = input(compute())`)
    })
    const f = facts("C")
    const prop = (n: string, k: string): unknown => f[`props.${n}.${k}`]
    expect(prop("a", "allowedValues")).toEqual(["x", "y"])
    expect(prop("a", "default")).toBe("x")
    expect(prop("a", "extensions.angular.typeInferred")).toBeUndefined()
    expect(prop("b", "type.text")).toBe("boolean")
    expect(prop("b", "extensions.angular.typeInferred")).toBe(true)
    expect(prop("b", "extensions.angular.transform")).toBe("booleanAttribute")
    expect(prop("cc", "required")).toBe(true)
    expect(prop("cc", "extensions.angular.property")).toBe("c")
    expect(prop("cc", "extensions.angular.alias")).toBe("cc")
    expect(prop("d", "extensions.angular.writeType")).toBe("string | number")
    expect(prop("e", "type.kind")).toBe("unknown")
    expect(prop("f", "default")).toBeUndefined()
    expect(prop("f", "extensions.angular.defaultExpression")).toBe("compute()")
  })

  it("reads decorator inputs: alias forms, required, transform, setters, inferred types and JSDoc", async () => {
    const { facts } = await run({
      "c.ts": cmp(`  /** The label. */
  @Input() label = "x"
  @Input("renamed") original = 1
  @Input({ required: true, alias: "req" }) r!: string
  @Input({ transform: booleanAttribute }) flag = false
  @Input() set value(v: "a" | "b") {}
  /** @deprecated Use label. */
  @Input() old: string | undefined`)
    })
    const f = facts("C")
    expect(f["props.label.type.text"]).toBe("string")
    expect(f["props.label.extensions.angular.typeInferred"]).toBe(true)
    expect(f["props.label.description"]).toBe("The label.")
    expect(f["props.renamed.extensions.angular.property"]).toBe("original")
    expect(f["props.req.required"]).toBe(true)
    expect(f["props.flag.extensions.angular.transform"]).toBe("booleanAttribute")
    expect(f["props.value.allowedValues"]).toEqual(["a", "b"])
    expect(f["props.old.deprecated"]).toEqual({ reason: "Use label." })
  })

  it("infers a decorator input's type from the project's own declarations when none is written", async () => {
    const { facts } = await run({
      "cfg.ts": `export class Config { animation = true\n label = "x" }`,
      "c.ts": `import { Component, Input } from "@angular/core"\nimport { Config } from "./cfg"\n@Component({ selector: "x", template: "" })\nexport class C {\n  private cfg = new Config()\n  @Input() animation = this.cfg.animation\n  @Input() mystery = unknownCall()\n}\ndeclare function unknownCall(): unknown`
    })
    const f = facts("C")
    expect(f["props.animation.type.text"]).toBe("boolean")
    expect(f["props.animation.type.kind"]).toBe("boolean")
    expect(f["props.animation.extensions.angular.typeInferred"]).toBe(true)
    expect(f["props.animation.extensions.angular.defaultExpression"]).toBe("this.cfg.animation")
    expect(f["props.mystery.type.kind"]).toBe("unknown")
  })

  it("treats model() as an input plus a Change output, and rejects nothing silently", async () => {
    const { facts } = await run({
      "c.ts": cmp(`  value = model<string>("")\n  open = model.required<boolean>({ alias: "isOpen" })`)
    })
    const f = facts("C")
    expect(f["props.value.extensions.angular.kind"]).toBe("model")
    expect(f["events.valueChange.extensions.angular.kind"]).toBe("model")
    expect(f["events.valueChange.payload.text"]).toBe("string")
    expect(f["props.isOpen.required"]).toBe(true)
    expect(f["events.isOpenChange.declared"]).toBe(true)
  })

  it("reads outputs: output(), EventEmitter payloads, aliases, and notes outputFromObservable", async () => {
    const { facts, codes } = await run({
      "c.ts": `import { Component, EventEmitter, Output, output, outputFromObservable } from "@angular/core"
@Component({ selector: "x", template: "" })
export class C {
  a = output<MouseEvent>()
  b = output<void>({ alias: "bb" })
  @Output() c = new EventEmitter<number>()
  @Output("dd") d = new EventEmitter<string>()
  e = outputFromObservable(source)
}
declare const source: unknown`
    })
    const f = facts("C")
    expect(f["events.a.payload.text"]).toBe("MouseEvent")
    expect(f["events.a.extensions.angular.kind"]).toBe("signal-output")
    expect(f["events.bb.extensions.angular.property"]).toBe("b")
    expect(f["events.c.payload.text"]).toBe("number")
    expect(f["events.dd.extensions.angular.alias"]).toBe("dd")
    expect(Object.keys(f).some((k) => k.startsWith("events.e."))).toBe(false)
    expect(codes).toContain("angular.unsupported")
  })

  it("reads decorator metadata inputs and outputs for names without members, with aliases", async () => {
    const { facts } = await run({
      "c.ts": cmp("", `selector: "x", template: "", inputs: ["a", "b: bee"], outputs: ["done", "gone: went"]`)
    })
    const f = facts("C")
    expect(f["props.a.extensions.angular.kind"]).toBe("input")
    expect(f["props.bee.extensions.angular.property"]).toBe("b")
    expect(f["events.done.declared"]).toBe(true)
    expect(f["events.went.extensions.angular.property"]).toBe("gone")
  })

  it("inherits members from a project base class and reports an external base as incomplete", async () => {
    const { facts, codes } = await run({
      "base.ts": `import { Input, Output, EventEmitter } from "@angular/core"\nexport abstract class Base {\n  /** Base label. */\n  @Input() label = ""\n  @Output() blurred = new EventEmitter<void>()\n}`,
      "c.ts": `import { Component, input } from "@angular/core"\nimport { Base } from "./base"\n@Component({ selector: "x", template: "" })\nexport class C extends Base { size = input<"a" | "b">("a") }`,
      "d.ts": `import { Component } from "@angular/core"\nimport { Foreign } from "foreign-lib"\n@Component({ selector: "y", template: "" })\nexport class D extends Foreign {}`
    })
    expect(facts("C")["props.label.extensions.angular.inheritedFrom"]).toBe("Base")
    expect(facts("C")["props.label.description"]).toBe("Base label.")
    expect(facts("C")["events.blurred.extensions.angular.inheritedFrom"]).toBe("Base")
    expect(facts("C")["implementations.angular.extensions.angular.propsComplete"]).toBe(true)
    expect(facts("D")["implementations.angular.extensions.angular.propsComplete"]).toBe(false)
    expect(facts("D")["implementations.angular.extensions.angular.inheritedPropsFrom"]).toEqual(["Foreign"])
    expect(codes).toContain("angular.base-class-external")
  })

  it("derives variants from string-literal union inputs", async () => {
    const { facts } = await run({
      "c.ts": cmp(`  tone = input<"a" | "b">("a")\n  n = input<1 | 2>(1)\n  one = input<"solo">("solo")`)
    })
    expect(Object.keys(facts("C")).filter((k) => k.startsWith("variants.") && k.endsWith(".values"))).toEqual(
      ["variants.tone.values"]
    )
  })
})

describe("templates", () => {
  it("scans start tags with attributes, skipping comments, interpolations, quoted '>' and control flow", () => {
    const info = scanTemplate(
      `<!-- <fake /> -->
<div role="dialog" [class.a]="x > y" (click)="go()" *ngIf="ok">{{ a<b }} text</div>
@if (a < b && c<d) {
  <span aria-label="x"></span>
} @else if (e<f) {
  <i></i>
}
<ng-content select="[slot=icon]" />
<input disabled>`,
      1
    )
    expect(info.elements.map((e) => [e.tag, e.line])).toEqual([
      ["div", 2],
      ["span", 4],
      ["i", 6],
      ["ng-content", 8],
      ["input", 9]
    ])
    const div = info.elements[0]
    expect(div?.attributes.map((a) => [a.name, a.bound, a.value])).toEqual([
      ["role", false, "dialog"],
      ["class.a", true, "x > y"],
      ["click", true, "go()"],
      ["ngIf", true, "ok"]
    ])
    expect(info.elements[4]?.attributes).toEqual([{ name: "disabled", bound: false }])
  })

  it("names ng-content slots from their selectors and keeps the raw selector", () => {
    expect(slotName("[slot=icon]")).toBe("icon")
    expect(slotName('[slot="icon"]')).toBe("icon")
    expect(slotName("[icon]")).toBe("icon")
    expect(slotName(".footer")).toBe("footer")
    expect(slotName("acme-badge")).toBe("acme-badge")
    expect(slotName("button:not([x])")).toBe("button_not_x")
    const info = scanTemplate(
      `<ng-content /><ng-content select="[slot=a]" /><ng-content select=".a" /><ng-content select="[slot=a]" />`,
      1
    )
    expect(info.slots.map((s) => [s.name, s.select])).toEqual([
      ["default", undefined],
      ["a", "[slot=a]"],
      ["a_2", ".a"],
      ["a_3", "[slot=a]"]
    ])
  })

  it("parses simple selectors and matches elements and attributes, ignoring :not and descendant forms", () => {
    const selectors = parseSelector("acme-button, button[acme-button], [tip], x[a][b], a:not(.b), a b")
    expect(selectors).toEqual([
      { element: "acme-button", attributes: [] },
      { element: "button", attributes: ["acme-button"] },
      { attributes: ["tip"] },
      { element: "x", attributes: ["a", "b"] }
    ])
    const el = (tag: string, ...attrs: string[]) => ({
      tag,
      line: 1,
      attributes: attrs.map((name) => ({ name, bound: false }))
    })
    expect(matchesSelector(el("acme-button"), selectors)).toBe(true)
    expect(matchesSelector(el("button", "acme-button"), selectors)).toBe(true)
    expect(matchesSelector(el("button"), selectors)).toBe(false)
    expect(matchesSelector(el("div", "tip"), selectors)).toBe(true)
    expect(matchesSelector(el("x", "a"), selectors)).toBe(false)
  })

  it("emits slots, accessibility and composition from inline templates", async () => {
    const { facts } = await run({
      "a.ts": cmp(
        "",
        `selector: "x-a", standalone: true, template: \`<div role="group" aria-label="g"><x-b /><button x-tip></button><x-b /></div><ng-content /><ng-content select="[slot=icon]" />\``
      ),
      "b.ts": `import { Component } from "@angular/core"\n@Component({ selector: "x-b", template: "" })\nexport class B {}`,
      "tip.ts": `import { Directive } from "@angular/core"\n@Directive({ selector: "[x-tip]" })\nexport class Tip {}`
    })
    const f = facts("C")
    expect(f["slots.default.declared"]).toBe(true)
    expect(f["slots.icon.extensions.angular.select"]).toBe("[slot=icon]")
    expect(f["accessibility.role"]).toBe("group")
    expect(f["accessibility.attributes"]).toEqual(["aria-label"])
    expect(f["composition.renders"]).toEqual([
      { target: "angular:src/lib/b.ts#B", count: 2 },
      { target: "angular:src/lib/tip.ts#Tip", count: 1 }
    ])
  })

  it("reads templateUrl and style files, reports missing ones, and extracts var() references with lines", async () => {
    const all = {
      "package.json": manifest,
      "src/public-api.ts": `export * from "./lib/c"`,
      "src/lib/c.ts": `import { Component } from "@angular/core"\n@Component({ selector: "x", templateUrl: "./c.html", styleUrls: ["./c.scss", "./missing.css"], styles: [".a { color: var(--inline); }"] })\nexport class C {}`,
      "src/lib/c.html": `<ng-content select="[slot=head]" />\n<div role="note"></div>`,
      "src/lib/c.scss": `.a {\n  color: var(--from-file);\n}`
    }
    const result = await compile({ fs: memoryFs(all), adapters: [adapter], clock: FIXED_CLOCK })
    const ir = result.irDocuments[0]
    const f = Object.fromEntries((ir?.facts ?? []).map((x) => [x.path, x.value]))
    expect(f["slots.head.declared"]).toBe(true)
    expect(f["accessibility.role"]).toBe("note")
    expect(f["styling.cssFiles"]).toEqual(["src/lib/c.scss"])
    expect(f["styling.cssVariables"]).toEqual(["--from-file", "--inline"])
    expect(f["styling.preprocessors"]).toEqual(["scss"])
    expect(result.diagnostics.map((d) => d.code)).toContain("angular.styleurl-missing")
    const fact = ir?.facts.find((x) => x.path === "styling.cssVariables")
    const ev = ir?.evidence.find(
      (e) =>
        fact?.evidenceIds.includes(e.id) && e.location.type === "file" && e.location.path.endsWith("c.scss")
    )
    expect(ev?.location).toMatchObject({ path: "src/lib/c.scss", line: 2 })
  })

  it("reports a missing templateUrl without failing", async () => {
    const { codes, result } = await run({ "c.ts": cmp("", `selector: "x", templateUrl: "./nope.html"`) })
    expect(codes).toContain("angular.templateurl-missing")
    expect(result.ok).toBe(true)
  })
})

describe("modules and evidence", () => {
  it("emits NgModules as module entities and links components to the modules that declare or export them", async () => {
    const { ir, facts } = await run({
      "c.ts": cmp("", `selector: "x", standalone: false, template: ""`),
      "m.ts": `import { NgModule } from "@angular/core"\nimport { C } from "./c"\n@NgModule({ declarations: [C], exports: [C], imports: [] })\nexport class UiModule {}`
    })
    const module = ir?.entities.find((e) => e.kind === "module")
    expect(module?.name).toBe("UiModule")
    const mf = Object.fromEntries(
      (ir?.facts ?? []).filter((f) => f.subject === module?.ref).map((f) => [f.path, f.value])
    )
    expect(mf["module.public"]).toBe(true)
    expect(mf["module.declarations"]).toEqual([{ name: "C", file: "src/lib/c.ts", localName: "C" }])
    expect(facts("C")["implementations.angular.extensions.angular.declaredIn"]).toEqual(["UiModule"])
    expect(facts("C")["implementations.angular.extensions.angular.exportedBy"]).toEqual(["UiModule"])
  })

  it("discovers the entry through ng-package.json or the public-api convention", async () => {
    const files = {
      "package.json": manifest,
      "ng-package.json": JSON.stringify({ lib: { entryFile: "src/main.ts" } }),
      "src/main.ts": `export * from "./lib/c"`,
      "src/lib/c.ts": cmp("")
    }
    const result = await compile({ fs: memoryFs(files), adapters: [adapter], clock: FIXED_CLOCK })
    expect(result.irDocuments[0]?.entities.map((e) => e.name)).toEqual(["C"])
  })

  it("cites file and line evidence at the written declarations", async () => {
    const { ir } = await run({
      "c.ts": `import { Component, input } from "@angular/core"\n\n@Component({ selector: "x", template: "" })\nexport class C {\n  size = input<"a" | "b">("a")\n}`
    })
    const fact = ir?.facts.find((f) => f.path === "props.size.type.text")
    const ev = ir?.evidence.find((e) => fact?.evidenceIds.includes(e.id))
    expect(ev).toMatchObject({ location: { type: "file", path: "src/lib/c.ts", line: 5 } })
    expect(ev?.original).toContain("size = input")
  })
})

describe("adapter behavior", () => {
  it("reads only packages that declare @angular/core and never executes the analyzed code", async () => {
    const files = {
      "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
      "packages/a/package.json": JSON.stringify({ name: "a", peerDependencies: { "@angular/core": "^18" } }),
      "packages/a/src/public-api.ts": `throw new Error("executed")\nexport * from "./c"\nprocess.exit(1)`,
      "packages/a/src/c.ts": `import { Component } from "@angular/core"\nthrow new Error("executed")\n@Component({ selector: "x", template: "" })\nexport class C {}`,
      "packages/b/package.json": JSON.stringify({ name: "b", dependencies: { vue: "^3" } })
    }
    const result = await compile({ fs: memoryFs(files), adapters: [adapter], clock: FIXED_CLOCK })
    expect(result.sources.map((s) => s.id)).toEqual(["angular-a"])
    expect(result.irDocuments[0]?.entities.map((e) => e.name)).toEqual(["C"])
    expect(result.ok).toBe(true)
  })

  it("reads classes through the public readClass entry point", () => {
    const analysis = createAnalysis(
      new Map([
        [
          "c.ts",
          `import { Component } from "@angular/core"\n@Component({ selector: "x", template: "" })\nexport class C {}`
        ]
      ])
    )
    const sf = analysis.sourceFile("c.ts") as ts.SourceFile
    const decl = sf.statements.find(ts.isClassDeclaration) as ts.ClassDeclaration
    expect(readClass(analysis, decl)?.selector).toBe("x")
  })

  it("passes conformance, is deterministic, and emits valid evidence-backed IR", async () => {
    const files = {
      "package.json": manifest,
      "src/public-api.ts": `export * from "./lib/c"`,
      "src/lib/c.ts": cmp(
        `  s = input<"a" | "b">("a")`,
        `selector: "x", standalone: true, template: "<ng-content />"`
      )
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
