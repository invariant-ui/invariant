import type { IR_VERSION } from "@invariant/compiler-ir"
import { describe, expect, it } from "vitest"
import type { SourceAdapter } from "./adapter.js"
import { compile } from "./compile.js"
import { memoryFs } from "./fs.js"
import { IrBuilder } from "./ir-builder.js"
import { checkAdapterConformance, checkCompileDeterminism, FIXED_CLOCK } from "./testing/index.js"

const files = {
  "package.json": JSON.stringify({
    name: "lib",
    peerDependencies: { react: "^18" },
    exports: "./src/index.ts"
  }),
  "src/index.ts": "export const A = 1",
  "README.md": "# Lib",
  "src/t.css": ":root{--a:1}"
}

function fakeAdapter(id: string, overrides: Partial<SourceAdapter> = {}): SourceAdapter {
  return {
    id,
    version: "1.0.0",
    type: "npm",
    async discover() {
      return {
        sources: [{ id: `${id}-src`, type: "npm", location: ".", config: {}, inputHash: "1".repeat(64) }],
        diagnostics: []
      }
    },
    async extract({ source, clock }) {
      const b = new IrBuilder({
        source: {
          id: source.id,
          type: source.type,
          location: source.location,
          inputHash: source.inputHash,
          adapter: { name: id, version: "1.0.0" }
        },
        extractor: { name: id, version: "1" },
        capabilities: ["x"],
        clock
      })
      const ref = b.entity("e", "package", "E")
      b.fact(
        ref,
        "x",
        1,
        b.evidence({ sourceRef: "r", location: { type: "file", path: "a.ts" }, method: "ast" })
      )
      return { ir: b.build("complete") }
    },
    async validate() {
      return []
    },
    ...overrides
  }
}

describe("compile", () => {
  it("runs discovery and every inventory adapter into valid IR with no framework adapter", async () => {
    const result = await compile({ fs: memoryFs(files), clock: FIXED_CLOCK })
    expect(result.ok).toBe(true)
    expect(result.sources.map((s) => `${s.type}:${s.id}`)).toEqual([
      "markdown:docs-lib",
      "npm:npm-lib",
      "tokens:tokens-lib"
    ])
    expect(result.irDocuments.map((d) => d.source.type).sort()).toEqual(["markdown", "npm", "tokens"])
    expect(result.project.packages[0]?.frameworks[0]?.name).toBe("react")
    const npm = result.irDocuments.find((d) => d.source.type === "npm")
    expect(npm?.entities.map((e) => `${e.kind}:${e.name}`)).toEqual(
      expect.arrayContaining(["package:lib", "export:A"])
    )
    // An export is never labelled a component: the inventory only knows names.
    expect(result.irDocuments.flatMap((d) => d.entities).some((e) => e.kind === "component")).toBe(false)
  })

  it("sorts sources by adapter then source id, independent of adapter registration order", async () => {
    const a = fakeAdapter("a")
    const b = fakeAdapter("b")
    const one = await compile({ fs: memoryFs(files), adapters: [b, a], only: ["a", "b"], clock: FIXED_CLOCK })
    const two = await compile({ fs: memoryFs(files), adapters: [a, b], only: ["a", "b"], clock: FIXED_CLOCK })
    expect(one.sources.map((s) => s.id)).toEqual(["a-src", "b-src"])
    expect(one.sources).toEqual(two.sources)
  })

  it("turns an extraction failure into a failed IR document instead of aborting, never implying absence", async () => {
    const bad = fakeAdapter("bad", {
      async extract() {
        throw new Error("boom")
      }
    })
    const good = fakeAdapter("good")
    const result = await compile({ fs: memoryFs(files), adapters: [bad, good], clock: FIXED_CLOCK })
    expect(result.ok).toBe(false)
    expect(result.irDocuments.map((d) => [d.source.id, d.completeness])).toEqual([
      ["bad-src", "failed"],
      ["good-src", "complete"]
    ])
    expect(result.diagnostics.find((d) => d.code === "compile.adapter-failed")).toMatchObject({
      severity: "error",
      sourceId: "bad-src"
    })
  })

  it("reports a discovery failure per adapter and continues with the rest", async () => {
    const result = await compile({
      fs: memoryFs(files),
      adapters: [
        fakeAdapter("bad", {
          async discover() {
            throw new Error("nope")
          }
        }),
        fakeAdapter("good")
      ],
      clock: FIXED_CLOCK
    })
    expect(result.sources.map((s) => s.id)).toEqual(["good-src"])
    expect(result.diagnostics.map((d) => d.code)).toContain("compile.adapter-failed")
  })

  it("rejects duplicate source ids and invalid IR from an adapter", async () => {
    const dup = fakeAdapter("dup", {
      async discover() {
        return {
          sources: [{ id: "a-src", type: "npm", location: ".", config: {}, inputHash: "1".repeat(64) }],
          diagnostics: []
        }
      }
    })
    const result = await compile({
      fs: memoryFs(files),
      adapters: [fakeAdapter("a"), dup],
      clock: FIXED_CLOCK
    })
    expect(result.diagnostics.map((d) => d.code)).toContain("compile.duplicate-source-id")
    expect(result.sources).toHaveLength(1)

    const invalid = fakeAdapter("inv", {
      async extract(ctx) {
        const r = await fakeAdapter("inv").extract(ctx, undefined)
        return { ir: { ...r.ir, irVersion: "9.9.9" as typeof IR_VERSION } }
      }
    })
    const bad = await compile({ fs: memoryFs(files), adapters: [invalid], clock: FIXED_CLOCK })
    expect(bad.diagnostics.map((d) => d.code)).toContain("compile.invalid-ir")
    expect(bad.irDocuments[0]?.completeness).toBe("failed")
  })

  it("surfaces IR verification errors from adapters (for example LLM evidence)", async () => {
    const llm = fakeAdapter("llm", {
      async extract(ctx) {
        const r = await fakeAdapter("llm").extract(ctx, undefined)
        const ev = r.ir.evidence[0]
        if (!ev) throw new Error("fixture")
        return { ir: { ...r.ir, evidence: [{ ...ev, method: "llm-assisted" }] } }
      }
    })
    const result = await compile({ fs: memoryFs(files), adapters: [llm], clock: FIXED_CLOCK })
    expect(result.diagnostics.map((d) => d.code)).toContain("ir.llm-evidence")
    expect(result.ok).toBe(false)
  })

  it("surfaces validate() diagnostics and tolerates a throwing validate()", async () => {
    const warns = fakeAdapter("warns", {
      async validate() {
        return [{ code: "x.warn", severity: "warning", message: "careful" }]
      }
    })
    const throws = fakeAdapter("throws", {
      async validate() {
        throw new Error("v")
      }
    })
    const result = await compile({ fs: memoryFs(files), adapters: [warns, throws], clock: FIXED_CLOCK })
    expect(result.diagnostics.map((d) => d.code)).toEqual(
      expect.arrayContaining(["x.warn", "compile.adapter-failed"])
    )
  })

  it("honours cancellation", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(compile({ fs: memoryFs(files), signal: controller.signal })).rejects.toThrow()
  })
})

describe("determinism and conformance", () => {
  it("compiles identically across runs with different clocks (modulo capture times)", async () => {
    expect(await checkCompileDeterminism({ fs: memoryFs(files) })).toEqual([])
  })

  it("passes adapter conformance for every inventory adapter", async () => {
    const { INVENTORY_ADAPTERS } = await import("./adapters/inventory.js")
    for (const adapter of INVENTORY_ADAPTERS)
      expect(await checkAdapterConformance(adapter, { fs: memoryFs(files) })).toEqual([])
  })

  it("conformance catches a non-deterministic adapter and a mutating one", async () => {
    let n = 0
    const flaky = fakeAdapter("flaky", {
      async discover() {
        n++
        return {
          sources: [{ id: `flaky-${n}`, type: "npm", location: ".", config: {}, inputHash: "1".repeat(64) }],
          diagnostics: []
        }
      }
    })
    expect(await checkAdapterConformance(flaky, { fs: memoryFs(files) })).toContain(
      "discover() is not deterministic"
    )
    const mutator = fakeAdapter("mut", {
      async extract(ctx) {
        ctx.project.packages.pop()
        return fakeAdapter("mut").extract(ctx, undefined)
      }
    })
    expect(await checkAdapterConformance(mutator, { fs: memoryFs(files) })).toContain(
      "an adapter mutated the shared project discovery"
    )
  })
})
