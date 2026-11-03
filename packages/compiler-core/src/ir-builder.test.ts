import { verifyIrDocument } from "@invariant/compiler-ir"
import { describe, expect, it } from "vitest"
import { IrBuilder } from "./ir-builder.js"

const make = () =>
  new IrBuilder({
    source: {
      id: "s",
      type: "npm",
      location: ".",
      inputHash: "0".repeat(64),
      adapter: { name: "a", version: "1" }
    },
    extractor: { name: "x", version: "1" },
    capabilities: ["p.*"],
    clock: () => "2026-01-01T00:00:00.000Z"
  })

describe("IrBuilder", () => {
  it("builds valid, canonical IR and deduplicates identical evidence", () => {
    const b = make()
    const e1 = b.entity("z", "package", "Z")
    const e2 = b.entity("a", "package", "A")
    const ev = b.evidence({
      sourceRef: "r",
      location: { type: "file", path: "f.ts", line: 1 },
      method: "ast"
    })
    const same = b.evidence({
      sourceRef: "r",
      location: { type: "file", path: "f.ts", line: 1 },
      method: "ast"
    })
    expect(same.id).toBe(ev.id)
    b.fact(e1, "p.b", 1, ev)
    b.fact(e2, "p.a", [1], [ev, same])
    const doc = b.build("complete")
    expect(doc.evidence).toHaveLength(1)
    expect(doc.entities.map((e) => e.ref)).toEqual(["a", "z"])
    expect(doc.facts.map((f) => f.subject)).toEqual(["a", "z"])
    expect(doc.facts[0]?.evidenceIds).toEqual([ev.id])
    expect(verifyIrDocument(doc)).toEqual([])
  })

  it("bounds evidence excerpts and stamps the source id on diagnostics", () => {
    const b = make()
    const ev = b.evidence({
      sourceRef: "r",
      location: { type: "file", path: "f.ts" },
      method: "ast",
      original: "x".repeat(5000)
    })
    expect(ev.original).toHaveLength(2000)
    b.diagnostic({ code: "a.b", severity: "info", message: "m" })
    expect(b.build("partial").diagnostics[0]?.sourceId).toBe("s")
  })
})
