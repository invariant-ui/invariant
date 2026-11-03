import { compile, memoryFs, type SourceAdapter } from "@invariant/compiler-core"
import {
  checkAdapterConformance,
  checkCompileDeterminism,
  FIXED_CLOCK
} from "@invariant/compiler-core/testing"
import { verifyIrDocument } from "@invariant/compiler-ir"
import { describe, expect, it } from "vitest"
import { reactAdapter } from "./index.js"

const adapter = reactAdapter as SourceAdapter
const manifest = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: "lib",
    version: "1.0.0",
    exports: "./src/index.ts",
    peerDependencies: { react: "^18" },
    ...extra
  })

async function run(files: Record<string, string>, extra: Record<string, unknown> = {}) {
  const result = await compile({
    fs: memoryFs({ "package.json": manifest(extra), ...files }),
    adapters: [adapter],
    clock: FIXED_CLOCK
  })
  const ir = result.irDocuments[0]
  const names = ir?.entities.map((e) => e.name) ?? []
  const facts = (name: string): Record<string, unknown> => {
    const entity = ir?.entities.find((e) => e.name === name)
    return Object.fromEntries(
      (ir?.facts ?? []).filter((f) => f.subject === entity?.ref).map((f) => [f.path, f.value])
    )
  }
  const codes = result.diagnostics.map((d) => d.code)
  return { result, ir, names, facts, codes }
}

describe("component detection", () => {
  it("detects function, arrow, forwardRef, memo, class, React.FC and styled components and rejects non-components", async () => {
    const { names } = await run({
      "src/index.ts": `export * from "./all"`,
      "src/all.tsx": `
        import { forwardRef, memo, Component, PureComponent } from "react"
        import styled from "styled-components"
        export function Fn() { return <div /> }
        export const Arrow = () => <span />
        export const Fwd = forwardRef<HTMLDivElement, { a?: string }>((props, ref) => <div ref={ref} />)
        export const Mem = memo(function Mem() { return <i /> })
        export const MemFwd = memo(forwardRef<HTMLDivElement, {}>(function MemFwd(_p, ref) { return <div ref={ref} /> }))
        export class Cls extends Component<{ x: number }> { render() { return <b /> } }
        export class Pure extends React.PureComponent<{}> { render() { return null } }
        export const Fc: React.FC<{ y?: boolean }> = () => <p />
        export const Styled = styled.div\`color: red;\`
        export const Cond = ({ on }: { on: boolean }) => on ? <a /> : null
        export const And = ({ on }: { on: boolean }) => on && <a />
        export const Elem = () => React.createElement("div")
        export const Cloned = ({ child }: { child: React.ReactElement }) => React.cloneElement(child, {})
        export const Ported = ({ node }: { node: Element }) => ReactDOM.createPortal(<div />, node)
        export const Annotated: React.FC<{ z?: number }> = ({ z }) => helper(z)
        export const NotAnnotated = ({ z }: { z?: number }) => helper(z)
        declare function helper(z?: number): null
        // Not components:
        export function useThing() { return <div /> }
        export const lower = () => <div />
        export function NoJsx() { return 1 }
        export const VALUE = 1
        export class NotReact { render() { return <div /> } }
      `
    })
    expect(names.sort()).toEqual(
      [
        "And",
        "Annotated",
        "Arrow",
        "Cloned",
        "Cls",
        "Cond",
        "Elem",
        "Fc",
        "Fn",
        "Fwd",
        "Mem",
        "MemFwd",
        "Ported",
        "Pure",
        "Styled"
      ].sort()
    )
  })

  it("records wrappers, kind, ref type, and display names", async () => {
    const { facts } = await run({
      "src/index.ts": `export * from "./c"`,
      "src/c.tsx": `
        import { forwardRef, memo } from "react"
        export const Both = memo(forwardRef<HTMLButtonElement, { a?: 1 }>(function Inner(_p, ref) { return <button ref={ref} /> }))
        Both.displayName = "FancyBoth"
      `
    })
    const f = facts("Both")
    expect(f["implementations.react.extensions.react.kind"]).toBe("memo")
    expect(f["implementations.react.extensions.react.wrappers"]).toEqual(["memo", "forwardRef"])
    expect(f["implementations.react.extensions.react.forwardRef"]).toBe(true)
    expect(f["implementations.react.extensions.react.memo"]).toBe(true)
    expect(f["implementations.react.extensions.react.refType"]).toBe("HTMLButtonElement")
    expect(f["implementations.react.extensions.react.displayName"]).toBe("FancyBoth")
    expect(f.name).toBe("Both")
  })

  it("follows default exports, renamed exports and export-star barrels, and names anonymous defaults from the file", async () => {
    const { names, facts } = await run({
      "src/index.ts": `export { default as Named } from "./Named"\nexport { default } from "./anon"\nexport * from "./barrel"\nexport { Real as Alias } from "./real"`,
      "src/Named.tsx": `const Local = () => <div />\nexport default Local`,
      "src/anon.tsx": `export default function () { return <div /> }`,
      "src/barrel.ts": `export { Deep } from "./deep"`,
      "src/deep.tsx": `export const Deep = () => <div />`,
      "src/real.tsx": `export const Real = () => <div />`
    })
    expect(names.sort()).toEqual(["Anon", "Deep", "Local", "Real"])
    expect(facts("Real")["implementations.react.extensions.react.exports"]).toEqual([
      { subpath: ".", name: "Alias" }
    ])
    expect(facts("Local")["implementations.react.extensions.react.exports"]).toEqual([
      { subpath: ".", name: "Named" }
    ])
  })

  it("only reports components reachable from entry points, not internal ones", async () => {
    const { names } = await run({
      "src/index.ts": `export { Public } from "./p"`,
      "src/p.tsx": `function Private() { return <i /> }\nexport const Public = () => <Private />`
    })
    expect(names).toEqual(["Public"])
  })

  it("reports factory-made components it cannot classify, but not constants or hooks", async () => {
    const { names, codes, result } = await run({
      "src/index.ts": `export * from "./f"`,
      "src/f.tsx": `
        declare function createSlot(n: string): unknown
        declare function makeConfig(): object
        export const Slot = createSlot("x")
        export const SOME_CONSTANT = makeConfig()
        export const config = makeConfig()
      `
    })
    expect(names).toEqual([])
    expect(codes.filter((c) => c === "react.unclassified-export")).toHaveLength(1)
    expect(result.diagnostics.find((d) => d.code === "react.unclassified-export")?.message).toContain("Slot")
  })

  it("reports higher-order components without analyzing them", async () => {
    const { names, codes } = await run({
      "src/index.ts": `export { withX } from "./h"`,
      "src/h.tsx": `export function withX<P extends object>(W: React.ComponentType<P>) { return function X(p: P) { return <W {...p} /> } }`
    })
    expect(names).toEqual([])
    expect(codes).toContain("react.higher-order-component")
  })

  it("treats Object.assign and Root.Child assignments as compound components", async () => {
    const { names, facts } = await run({
      "src/index.ts": `export * from "./m"`,
      "src/m.tsx": `
        function ARoot({ x }: { x?: number }) { return <div /> }
        function AItem() { return <li /> }
        export const A = Object.assign(ARoot, { Item: AItem })
        function BRoot() { return <div /> }
        function BPart() { return <p /> }
        export const B = BRoot as typeof BRoot & { Part: typeof BPart }
        B.Part = BPart
      `
    })
    expect(names.sort()).toEqual(["A", "A.Item", "B", "B.Part"])
    expect(facts("A.Item")["implementations.react.extensions.react.compoundParent"]).toMatch(/#A$/)
    expect(facts("A")["composition.subcomponents"]).toEqual([
      { key: "Item", ref: expect.stringMatching(/#AItem$/) }
    ])
  })
})

describe("props", () => {
  const props = async (source: string) =>
    (await run({ "src/index.ts": `export { C } from "./c"`, "src/c.tsx": source })).facts("C")

  it("captures type, kind, required, defaults (destructuring and defaultProps) and literal domains in declared order", async () => {
    const f = await props(`
      type Size = "xl" | "sm" | "md"
      interface P { size?: Size; n?: 1 | 2; flag: boolean; label?: string; tags?: string[]; cb?: () => void }
      export function C({ size = "md", label = "x", n = -1 }: P) { return <div /> }
    `)
    expect(f["props.size.allowedValues"]).toEqual(["xl", "sm", "md"])
    expect(f["props.size.default"]).toBe("md")
    expect(f["props.size.type.kind"]).toBe("enum")
    expect(f["props.n.allowedValues"]).toEqual([1, 2])
    expect(f["props.n.default"]).toBe(-1)
    expect(f["props.flag.required"]).toBe(true)
    expect(f["props.flag.type.kind"]).toBe("boolean")
    expect(f["props.label.default"]).toBe("x")
    expect(f["props.tags.type.kind"]).toBe("array")
    expect(f["props.cb.type.kind"]).toBe("function")
    expect(f["props.cb.extensions.react.role"]).toBe("prop")
  })

  it("resolves props types imported through a tsconfig paths alias", async () => {
    const { facts } = await run({
      "tsconfig.json": `{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }`,
      "src/types.ts": `export interface SharedProps { shared?: "a" | "b" }`,
      "src/index.ts": `export { C } from "./c"`,
      "src/c.tsx": `import type { SharedProps } from "@/types"\nexport function C(p: SharedProps & { own?: number }) { return <div /> }`
    })
    expect(facts("C")["props.shared.allowedValues"]).toEqual(["a", "b"])
    expect(facts("C")["implementations.react.extensions.react.propsComplete"]).toBe(true)
  })

  it("keeps non-literal defaults as expressions instead of values", async () => {
    const f = await props(
      `export function C({ a = compute(), b = [1, 2], c = { k: 1 } }: { a?: number; b?: number[]; c?: object }) { return <div /> }\ndeclare function compute(): number`
    )
    expect(f["props.a.default"]).toBeUndefined()
    expect(f["props.a.extensions.react.defaultExpression"]).toBe("compute()")
    expect(f["props.b.default"]).toEqual([1, 2])
    expect(f["props.c.default"]).toEqual({ k: 1 })
  })

  it("reads class static defaultProps and assigned defaultProps, unwrapping as const", async () => {
    const klass = await props(
      `export class C extends React.Component<{ s?: "a" | "b"; t?: number }> { static defaultProps = { s: "a" as const, t: 3 }; render() { return <div /> } }`
    )
    expect(klass["props.s.default"]).toBe("a")
    expect(klass["props.t.default"]).toBe(3)
    const assigned = await props(
      `export function C(p: { t?: number }) { return <div /> }\nC.defaultProps = { t: 5 }`
    )
    expect(assigned["props.t.default"]).toBe(5)
  })

  it("resolves intersections, Omit/Pick/Partial and generics, and records inheritance from local bases", async () => {
    const f = await props(`
      interface Base { id: string; tone?: "a" | "b" }
      interface Mid extends Base { mid?: number }
      type P = Omit<Mid, "id"> & { extra: string }
      export function C<T>(p: P & { item?: T }) { return <div /> }
    `)
    expect(
      Object.keys(f)
        .filter((k) => k.endsWith(".type.text"))
        .sort()
    ).toEqual([
      "props.extra.type.text",
      "props.item.type.text",
      "props.mid.type.text",
      "props.tone.type.text"
    ])
    expect(f["props.tone.extensions.react.inheritedFrom"]).toBe("Base")
    expect(f["props.mid.extensions.react.inheritedFrom"]).toBe("Mid")
    expect(f["implementations.react.extensions.react.generics"]).toEqual(["T"])
    expect(f["implementations.react.extensions.react.propsComplete"]).toBe(true)
  })

  it("reports external bases as inherited rather than enumerating them, and marks props incomplete", async () => {
    const f = await props(`
      interface P extends React.HTMLAttributes<HTMLDivElement>, Local { own?: string }
      interface Local { local?: number }
      export function C(p: P) { return <div /> }
    `)
    expect(f["implementations.react.extensions.react.inheritedPropsFrom"]).toEqual([
      "React.HTMLAttributes<HTMLDivElement>"
    ])
    expect(f["implementations.react.extensions.react.propsComplete"]).toBe(false)
    expect(f["props.own.type.text"]).toBe("string")
    expect(f["props.local.extensions.react.inheritedFrom"]).toBe("Local")
  })

  it("separates authored JSDoc from extracted structure and captures deprecations", async () => {
    const { ir } = await run({
      "src/index.ts": `export { C } from "./c"`,
      "src/c.tsx": `
        interface P {
          /** The label. */
          label?: string
          /** @deprecated Use label. */
          title?: string
        }
        /** A component.\n * @deprecated Gone soon. */
        export function C(p: P) { return <div /> }
      `
    })
    const by = (path: string) => ir?.facts.find((f) => f.path === path)
    expect(by("props.label.description")).toMatchObject({ value: "The label.", origin: "authored" })
    expect(by("props.title.deprecated")).toMatchObject({
      value: { reason: "Use label." },
      origin: "authored"
    })
    expect(by("props.label.type.text")?.origin).toBe("extracted")
    expect(by("description")).toMatchObject({ origin: "authored" })
    expect(by("lifecycle")).toMatchObject({ value: "deprecated", origin: "authored" })
  })

  it("skips props whose names cannot be addressed by a fact path, with a diagnostic", async () => {
    const { facts, codes } = await run({
      "src/index.ts": `export { C } from "./c"`,
      "src/c.tsx": `export function C(p: { ok?: 1; $transient?: 1; "a.b"?: 1 }) { return <div /> }`
    })
    expect(Object.keys(facts("C")).filter((k) => k.endsWith(".required"))).toEqual(["props.ok.required"])
    expect(codes).toContain("react.unsupported-prop-name")
    expect(facts("C")["implementations.react.extensions.react.propsComplete"]).toBe(false)
  })

  it("flags unresolvable props instead of inventing them", async () => {
    const { facts, codes } = await run({
      "src/index.ts": `export { C, L } from "./c"`,
      "src/c.tsx": `import { lazy } from "react"\nexport const C = ({ a }) => <div />\nexport const L = lazy(() => import("./x"))`
    })
    expect(Object.keys(facts("C")).some((k) => k.startsWith("props."))).toBe(false)
    expect(facts("C")["implementations.react.extensions.react.propsComplete"]).toBe(false)
    expect(codes).toContain("react.props-unresolved")
    expect(facts("L")["implementations.react.extensions.react.kind"]).toBe("lazy")
  })

  it("maps children, renderable props and render props to slots, with handlers staying props", async () => {
    const f = await props(`
      export function C(p: { children: React.ReactNode; header?: React.ReactElement; row?: (r: number) => React.ReactNode; onPick?: (n: number) => void }) { return <div /> }
    `)
    expect(f["slots.default.required"]).toBe(true)
    expect(f["slots.header.extensions.react.prop"]).toBe("header")
    expect(f["slots.row.extensions.react.renderProp"]).toBe(true)
    expect(f["slots.onPick.required"]).toBeUndefined()
    expect(f["props.onPick.extensions.react.role"]).toBe("event-handler")
  })
})

describe("variants", () => {
  it("derives variants from string-literal unions only, and from cva configs the component calls", async () => {
    const { facts } = await run({
      "src/index.ts": `export { C } from "./c"`,
      "src/c.tsx": `
        import { cva } from "class-variance-authority"
        const v = cva("base", { variants: { tone: { a: "x", b: "y" }, big: { true: "t", false: "f" } }, defaultVariants: { tone: "a", big: false }, compoundVariants: [] })
        const unused = cva("u", { variants: { never: { x: "1" } } })
        export function C(p: { kind?: "k1" | "k2"; count?: 1 | 2; one?: "solo"; on?: boolean }) { return <div className={v({})} /> }
      `
    })
    const keys = Object.keys(facts("C")).filter((k) => k.startsWith("variants.") && k.endsWith(".values"))
    expect(keys.sort()).toEqual(["variants.big.values", "variants.kind.values", "variants.tone.values"])
    expect(facts("C")["variants.tone.default"]).toBe("a")
    expect(facts("C")["variants.tone.extensions.react.source"]).toBe("cva")
    expect(facts("C")["variants.tone.extensions.react.via"]).toBe("v")
    expect(facts("C")["variants.big.values"]).toEqual(["true", "false"])
    expect(facts("C")["variants.big.default"]).toBe("false")
  })
})

describe("accessibility, styling and composition", () => {
  it("records static roles and aria attributes on intrinsic elements only", async () => {
    const { facts } = await run({
      "src/index.ts": `export { C, D } from "./c"`,
      "src/c.tsx": `
        export function C({ r }: { r: string }) { return <div role="dialog" aria-modal="true" aria-label={r}><Other role="ignored" aria-x="1" /></div> }
        export function D({ r }: { r: string }) { return <div role={r} /> }
        const Other = (_p: object) => <i />
      `
    })
    expect(facts("C")["accessibility.role"]).toBe("dialog")
    expect(facts("C")["accessibility.attributes"]).toEqual(["aria-label", "aria-modal"])
    expect(facts("D")["accessibility.role"]).toBeUndefined()
  })

  it("collects CSS-module variables, inline var() references, class names, and libraries", async () => {
    const { facts } = await run(
      {
        "src/index.ts": `export { C, E } from "./c"`,
        "src/c.module.css": `.a { color: var(--c-one); }\n.b { margin: var(--c-two, 1px); }`,
        "src/c.tsx": `
          import s from "./c.module.css"
          import "@emotion/react"
          export function C() { return <div className={cn("p-2", { x: 1 }, cond ? "a" : "b")} style={{ color: "var(--inline)" }} data-s={s.a} /> }
          export function E() { return <div css={{}} /> }
          declare const cond: boolean
          declare function cn(...a: unknown[]): string
        `
      },
      { devDependencies: { tailwindcss: "^3" } }
    )
    expect(facts("C")["styling.cssModules"]).toEqual(["src/c.module.css"])
    expect(facts("C")["styling.cssVariables"]).toEqual(["--c-one", "--c-two", "--inline"])
    expect(facts("C")["styling.classNames"]).toEqual(["a", "b", "p-2"])
    expect(facts("C")["styling.tailwind"]).toBe(true)
    expect(facts("E")["styling.libraries"]).toEqual(["emotion"])
  })

  it("does not claim Tailwind without a Tailwind dependency or config", async () => {
    const { facts } = await run({
      "src/index.ts": `export { C } from "./c"`,
      "src/c.tsx": `export const C = () => <div className="p-2" />`
    })
    expect(facts("C")["styling.classNames"]).toEqual(["p-2"])
    expect(facts("C")["styling.tailwind"]).toBeUndefined()
  })
})

describe("usage", () => {
  const files = {
    "src/index.ts": `export { A, B } from "./c"`,
    "src/c.tsx": `
      export const A = ({ v }: { v?: "x" | "y"; k?: number }) => <div />
      export const B = () => <><A v="x" k={1} /><A v="y" /><A v={dyn} /><A {...rest} /><A bogus /></>
      declare const dyn: "x"
      declare const rest: object
    `,
    "src/c.stories.tsx": `import { A } from "./c"\nexport const S = () => <A v="story" />`,
    "src/c.test.tsx": `import { A } from "./c"\nexport const T = () => <A v="test" />`
  }

  it("counts sites, observed literal values, dynamic values, combinations, and undeclared props, ignoring stories and tests", async () => {
    const { facts } = await run(files)
    const a = facts("A")
    expect(a["usage.sites"]).toBe(5)
    expect(a["usage.props.v.observedValues"]).toEqual(["x", "y"])
    expect(a["usage.props.v.dynamicCount"]).toBe(1)
    expect(a["usage.props.k.observedValues"]).toEqual([1])
    expect(a["usage.undeclaredProps"]).toEqual(["bogus"])
    expect(a["usage.combinations"]).toEqual(
      expect.arrayContaining([
        { props: ["k", "v"], count: 1 },
        { props: ["v"], count: 2 },
        { props: ["bogus"], count: 1 }
      ])
    )
  })

  it("records which component renders which", async () => {
    const { facts } = await run(files)
    expect(facts("B")["composition.renders"]).toEqual([{ target: expect.stringMatching(/#A$/), count: 5 }])
  })

  it("does not call a prop undeclared when a spread could supply it or the props set is open", async () => {
    const { facts } = await run({
      "src/index.ts": `export { A, O } from "./c"`,
      "src/c.tsx": `
        export const A = (_p: { a?: 1 }) => <div />
        export const O = (_p: React.HTMLAttributes<HTMLDivElement> & { a?: 1 }) => <div />
        export const X = () => <><A {...rest} extra /><O extra /></>
        declare const rest: object
      `
    })
    expect(facts("A")["usage.undeclaredProps"]).toBeUndefined()
    expect(facts("O")["usage.undeclaredProps"]).toBeUndefined()
    expect(facts("O")["usage.props.extra.declared"]).toBeUndefined()
  })
})

describe("evidence and locations", () => {
  it("cites file and line evidence for every fact, with extracted structure from the compiler or AST", async () => {
    const { ir } = await run({
      "src/index.ts": `export { C } from "./c"`,
      "src/c.tsx": `\n\ninterface P {\n  size?: "a" | "b"\n}\nexport function C({ size = "a" }: P) { return <div /> }`
    })
    const evidenceById = new Map(ir?.evidence.map((e) => [e.id, e]))
    for (const fact of ir?.facts ?? [])
      expect(fact.evidenceIds.every((id) => evidenceById.has(id))).toBe(true)
    const typeFact = ir?.facts.find((f) => f.path === "props.size.type.text")
    const ev = evidenceById.get(typeFact?.evidenceIds[0] ?? "")
    expect(ev).toMatchObject({
      location: { type: "file", path: "src/c.tsx", line: 4 },
      method: "compiler-api"
    })
    expect(ev?.original).toContain('size?: "a" | "b"')
  })
})

describe("adapter behavior", () => {
  it("discovers only packages that declare React, excluding nested workspace packages from the parent", async () => {
    const fs = memoryFs({
      "package.json": JSON.stringify({
        name: "root",
        workspaces: ["packages/*"],
        dependencies: { react: "^18" },
        exports: "./src/index.ts"
      }),
      "src/index.ts": `export { R } from "./r"`,
      "src/r.tsx": `export const R = () => <div />`,
      "packages/a/package.json": JSON.stringify({
        name: "a",
        peerDependencies: { react: "^18" },
        exports: "./src/index.ts"
      }),
      "packages/a/src/index.ts": `export { A } from "./a"`,
      "packages/a/src/a.tsx": `export const A = () => <div />`,
      "packages/vue/package.json": JSON.stringify({ name: "v", dependencies: { vue: "^3" } })
    })
    const result = await compile({ fs, adapters: [adapter], clock: FIXED_CLOCK })
    expect(result.sources.map((s) => s.id)).toEqual(["react-a", "react-root"])
    const names = Object.fromEntries(
      result.irDocuments.map((d) => [d.source.id, d.entities.map((e) => e.name)])
    )
    expect(names).toEqual({ "react-a": ["A"], "react-root": ["R"] })
  })

  it("never executes analyzed code", async () => {
    const { names, result } = await run({
      "src/index.ts": `throw new Error("executed")\nexport { C } from "./c"\nprocess.exit(1)`,
      "src/c.tsx": `throw new Error("executed")\nexport const C = () => <div />`
    })
    expect(names).toEqual(["C"])
    expect(result.ok).toBe(true)
  })

  it("warns when a React package exposes no components, and when an entry cannot be analyzed", async () => {
    const none = await run({ "src/index.ts": `export const x = 1` })
    expect(none.codes).toContain("react.no-components")
    expect(none.result.diagnostics.find((d) => d.code === "react.no-components")?.severity).toBe("info")
    expect(none.result.ok).toBe(true)
    const css = await run({ "src/index.ts": `export const x = 1` }, { exports: { ".": "./src/style.css" } })
    expect(css.codes).toEqual(expect.arrayContaining(["react.no-components"]))
  })

  it("emits valid, conformant, deterministic IR with source versions", async () => {
    const files = {
      "package.json": manifest(),
      "src/index.ts": `export { C } from "./c"`,
      "src/c.tsx": `export const C = (p: { a?: "x" | "y" }) => <div role="note" />`
    }
    expect(await checkAdapterConformance(adapter, { fs: memoryFs(files) })).toEqual([])
    expect(await checkCompileDeterminism({ fs: memoryFs(files), adapters: [adapter] })).toEqual([])
    const result = await compile({ fs: memoryFs(files), adapters: [adapter], clock: FIXED_CLOCK })
    expect(verifyIrDocument(result.irDocuments[0] as never)).toEqual([])
    expect(result.irDocuments[0]?.source).toMatchObject({
      type: "react",
      version: { kind: "package-version", value: "1.0.0" }
    })
    expect(
      result.irDocuments[0]?.facts.every((f) => f.origin === "extracted" || f.origin === "authored")
    ).toBe(true)
    expect(result.irDocuments[0]?.evidence.some((e) => e.method === "llm-assisted")).toBe(false)
  })
})
