import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { angularButtonIr, reactButtonIr } from "../test/fixtures.ts"
import {
  canonicalizeIrDocument,
  computeIrContentHash,
  IR_VERSION,
  type IrDocument,
  irJsonSchemas,
  matchesCapability,
  parseIrDocument,
  serializeIrDocument,
  verifyIrDocument
} from "./index.js"

type AjvInstance = { compile(schema: object): ((data: unknown) => boolean) & { errors?: unknown } }
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as new (options: object) => AjvInstance

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))
const codes = (doc: IrDocument): string[] => verifyIrDocument(doc).map((d) => d.code)
const shuffled = <T>(items: T[]): T[] => [...items].reverse()

describe("IR documents from different frameworks", () => {
  it("are valid and match golden files", () => {
    for (const [name, doc] of [
      ["react-button.ir.json", reactButtonIr()],
      ["angular-button.ir.json", angularButtonIr()]
    ] as const) {
      expect(verifyIrDocument(doc)).toEqual([])
      const path = here(`../fixtures/${name}`)
      const expected = serializeIrDocument(doc)
      if (process.env.UPDATE_GOLDEN === "1" || !existsSync(path)) writeFileSync(path, expected)
      expect(readFileSync(path, "utf8")).toBe(expected)
    }
  })

  it("use the same neutral paths for the same concept, keeping framework detail under extensions", () => {
    const neutral = (doc: IrDocument): string[] =>
      doc.facts.map((f) => f.path).filter((p) => p.startsWith("props.") && !p.includes("extensions"))
    expect(neutral(angularButtonIr())).toEqual(neutral(reactButtonIr()))
    const detail = angularButtonIr().facts.filter((f) => f.path.includes("extensions"))
    expect(detail.every((f) => f.path.includes("extensions.angular"))).toBe(true)
  })

  it("carry an incompleteness marker and diagnostics instead of implying absence", () => {
    const angular = angularButtonIr()
    expect(angular.completeness).toBe("partial")
    expect(angular.diagnostics[0]?.code).toBe("extract.unsupported-syntax")
  })
})

describe("parseIrDocument", () => {
  it("round-trips through JSON", () => {
    const doc = reactButtonIr()
    const parsed = parseIrDocument(JSON.parse(serializeIrDocument(doc)))
    expect(parsed).toEqual({ ok: true, value: canonicalizeIrDocument(doc) })
  })

  it("rejects unknown fields, empty evidence lists, inferred origins, and unsupported versions", () => {
    const base = JSON.parse(serializeIrDocument(reactButtonIr()))
    const mutate = (fn: (d: Record<string, any>) => void) => {
      const copy = structuredClone(base)
      fn(copy)
      return parseIrDocument(copy)
    }
    expect(
      mutate((d) => {
        d.extra = 1
      }).ok
    ).toBe(false)
    expect(
      mutate((d) => {
        d.facts[0].evidenceIds = []
      }).ok
    ).toBe(false)
    expect(
      mutate((d) => {
        d.facts[0].origin = "inferred"
      }).ok
    ).toBe(false)
    const unsupported = mutate((d) => {
      d.irVersion = "2.0.0"
    })
    expect(unsupported.ok === false && unsupported.diagnostics[0]?.code).toBe("ir.unsupported-version")
  })
})

describe("determinism", () => {
  it("serializes identically regardless of collection order", () => {
    const doc = angularButtonIr()
    const reordered: IrDocument = {
      ...doc,
      capabilities: shuffled(doc.capabilities),
      entities: shuffled(doc.entities),
      facts: shuffled(doc.facts),
      evidence: shuffled(doc.evidence)
    }
    expect(serializeIrDocument(reordered)).toBe(serializeIrDocument(doc))
  })
})

describe("computeIrContentHash", () => {
  it("ignores evidence capture times but not content", () => {
    const doc = reactButtonIr()
    const retimed: IrDocument = {
      ...doc,
      evidence: doc.evidence.map((e) => ({ ...e, capturedAt: "2030-01-01T00:00:00.000Z" }))
    }
    expect(computeIrContentHash(retimed)).toBe(computeIrContentHash(doc))
    expect(computeIrContentHash({ ...doc, completeness: "partial" })).not.toBe(computeIrContentHash(doc))
  })
})

describe("verifyIrDocument", () => {
  it("rejects LLM-assisted evidence, since adapters must be deterministic", () => {
    const doc = reactButtonIr()
    const [first, ...rest] = doc.evidence
    if (!first) throw new Error("fixture")
    // Re-derive the id so only the method rule trips.
    const llm = { ...first, method: "llm-assisted" as const }
    expect(codes({ ...doc, evidence: [llm, ...rest] })).toContain("ir.llm-evidence")
  })

  it("detects broken references and mismatched evidence", () => {
    const doc = reactButtonIr()
    expect(codes({ ...doc, entities: [] })).toContain("ir.unknown-subject")
    expect(codes({ ...doc, evidence: doc.evidence.slice(1) })).toContain("ir.unknown-evidence")
    expect(codes({ ...doc, entities: [...doc.entities, ...doc.entities] })).toContain(
      "ir.duplicate-entity-ref"
    )
    const forged = doc.evidence.map((e, i) => (i === 0 ? { ...e, original: "forged" } : e))
    expect(codes({ ...doc, evidence: forged })).toContain("ir.evidence-id-mismatch")
    expect(codes({ ...doc, source: { ...doc.source, id: "other" } })).toContain("ir.evidence-source-mismatch")
  })

  it("reports a source that disagrees with itself instead of dropping a value", () => {
    const doc = reactButtonIr()
    const original = doc.facts.find((f) => f.path === "props.size.default")
    if (!original) throw new Error("fixture")
    expect(codes({ ...doc, facts: [...doc.facts, { ...original, value: "lg" }] })).toContain(
      "ir.conflicting-facts"
    )
    expect(codes({ ...doc, facts: [...doc.facts, { ...original }] })).not.toContain("ir.conflicting-facts")
  })

  it("warns when facts fall outside declared capabilities", () => {
    expect(codes({ ...reactButtonIr(), capabilities: ["props.*.type"] })).toContain(
      "ir.undeclared-capability"
    )
  })
})

describe("matchesCapability", () => {
  it("lets * match exactly one segment and covers subtrees", () => {
    expect(matchesCapability("props.*.default", "props.size.default")).toBe(true)
    expect(matchesCapability("props.*.default", "props.size.default.text")).toBe(true)
    expect(matchesCapability("props.*.default", "props.size.extra.default")).toBe(false)
    expect(matchesCapability("props.*.default", "events.size.default")).toBe(false)
    expect(matchesCapability("props.*.default", "props.size")).toBe(false)
  })
})

describe("IR JSON Schema", () => {
  it("matches the committed file and validates the golden IR", () => {
    const [name, schema] = Object.entries(irJsonSchemas())[0] ?? []
    if (!name) throw new Error("no schema")
    const path = here(`../schema/${name}`)
    const expected = `${JSON.stringify(schema, null, 2)}\n`
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(path)) writeFileSync(path, expected)
    expect(readFileSync(path, "utf8")).toBe(expected)
    const validate = new Ajv2020({ strict: false }).compile(schema as object)
    for (const file of ["react-button.ir.json", "angular-button.ir.json"]) {
      expect(validate(JSON.parse(readFileSync(here(`../fixtures/${file}`), "utf8")))).toBe(true)
    }
    expect(validate({ irVersion: IR_VERSION })).toBe(false)
  })
})
