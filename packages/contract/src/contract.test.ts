import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { acmeDraft, acmeEvidence, buildAcme } from "../test/acme.ts"
import {
  computeContentHash,
  computeEvidenceId,
  contractJsonSchemas,
  createEvidenceFile,
  evidenceFileSchema,
  finalizeContract,
  parseContract,
  resolveFactPath,
  serializeContract,
  serializeEvidenceFile,
  verifyContract
} from "./index.js"

type AjvInstance = { compile(schema: object): ((data: unknown) => boolean) & { errors?: unknown } }
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as new (options: object) => AjvInstance

const fixture = (name: string): string => fileURLToPath(new URL(`../fixtures/acme/${name}`, import.meta.url))
const schemaFile = (name: string): string => fileURLToPath(new URL(`../schema/${name}`, import.meta.url))

function codes(diagnostics: ReturnType<typeof verifyContract>): string[] {
  return diagnostics.map((d) => d.code)
}

describe("Acme sample contract", () => {
  const { contract, evidence } = buildAcme()

  it("represents one conceptual component across React, Angular and Vue without framework fields in the core model", () => {
    const button = contract.components.find((c) => c.id === "component:button")
    expect(button?.implementations.map((i) => i.framework)).toEqual(["angular", "react", "vue"])
    // Framework-specific data is confined to namespaced extensions.
    expect(
      button?.implementations.every((i) => Object.keys(i.extensions ?? {}).every((k) => k === i.framework))
    ).toBe(true)
    expect(button?.props.find((p) => p.name === "size")?.extensions).toEqual({
      angular: { kind: "input" },
      react: { kind: "prop" },
      vue: { kind: "prop" }
    })
  })

  it("passes structural and semantic validation", () => {
    expect(parseContract(JSON.parse(serializeContract(contract)))).toEqual({ ok: true, value: contract })
    expect(verifyContract(contract, evidence)).toEqual([])
    expect(evidenceFileSchema.safeParse(evidence).success).toBe(true)
  })

  it("keeps all four fact statuses distinguishable, with approval layered over its prior status", () => {
    const facts = contract.components.find((c) => c.id === "component:button")?.facts ?? {}
    expect(facts["props.size.default"]?.status).toBe("discovered")
    expect(facts["composition.0"]?.status).toBe("inferred")
    expect(facts["props.size.allowedValues"]).toMatchObject({
      status: "approved",
      approval: { priorStatus: "discovered" }
    })
    const guideline = contract.guidelines[0]
    expect(guideline?.facts.statement?.status).toBe("documented")
  })

  it("matches the committed golden files", () => {
    const golden = [
      [fixture("invariant.contract.json"), serializeContract(contract)],
      [fixture("invariant.evidence.json"), serializeEvidenceFile(evidence)]
    ] as const
    for (const [path, expected] of golden) {
      if (process.env.UPDATE_GOLDEN === "1" || !existsSync(path)) writeFileSync(path, expected)
      expect(readFileSync(path, "utf8")).toBe(expected)
    }
  })
})

describe("serialization and determinism", () => {
  it("round-trips and is idempotent", () => {
    const { contract } = buildAcme()
    const text = serializeContract(contract)
    const parsed = parseContract(JSON.parse(text))
    expect(parsed.ok && serializeContract(parsed.value)).toBe(text)
  })

  it("produces the same hash and bytes regardless of object key order", () => {
    const { contract } = buildAcme()
    const reversed = JSON.parse(JSON.stringify(contract), (_k, v: unknown) =>
      v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v
    )
    const parsed = parseContract(reversed)
    expect(parsed.ok && serializeContract(parsed.value)).toBe(serializeContract(contract))
  })

  it("excludes volatile timestamps from the content hash but not real content", () => {
    const base = acmeDraft()
    const retimed = acmeDraft()
    retimed.metadata.compiledAt = "2027-01-01T00:00:00.000Z"
    for (const source of retimed.sources) source.lastSyncedAt = "2027-01-01T00:00:00.000Z"
    const changed = acmeDraft()
    changed.components[0] = { ...changed.components[0]!, name: "Button v2" }
    expect(computeContentHash(retimed)).toBe(computeContentHash(base))
    expect(computeContentHash(changed)).not.toBe(computeContentHash(base))
  })

  it("derives evidence ids only from immutable observation fields", () => {
    const e = acmeEvidence.reactSize
    expect(computeEvidenceId({ ...e, original: "other" })).not.toBe(e.id)
    expect(computeEvidenceId({ ...e })).toBe(e.id)
    expect(e.id).toMatch(/^ev_[0-9a-f]{24}$/)
  })
})

describe("structural rules", () => {
  const roundTrip = (mutate: (c: Record<string, any>) => void) => {
    const json = JSON.parse(serializeContract(buildAcme().contract))
    mutate(json)
    return parseContract(json)
  }

  it("rejects unsupported major versions with a dedicated diagnostic", () => {
    const result = roundTrip((c) => {
      c.contractVersion = "2.0.0"
    })
    expect(result.ok === false && result.diagnostics[0]?.code).toBe("contract.unsupported-version")
  })

  it("rejects credentials and unknown fields on sources", () => {
    const result = roundTrip((c) => {
      c.sources[3].authentication.token = "secret"
    })
    expect(result.ok).toBe(false)
  })

  it("rejects approved facts without approval, inferred facts without derivation or confidence, and evidence-free facts", () => {
    const bad = [
      (c: Record<string, any>) => {
        delete c.components[0].facts["props.size.allowedValues"].approval
      },
      (c: Record<string, any>) => {
        delete c.components[0].facts["composition.0"].derivation
      },
      (c: Record<string, any>) => {
        delete c.components[0].facts["composition.0"].confidence
      },
      (c: Record<string, any>) => {
        c.components[0].facts["props.size.default"].evidenceIds = []
      },
      (c: Record<string, any>) => {
        c.components[0].facts["props.size.default"].approval =
          c.components[0].facts["props.size.allowedValues"].approval
      }
    ]
    for (const mutate of bad) expect(roundTrip(mutate).ok).toBe(false)
  })

  it("requires policies to carry approval metadata", () => {
    expect(
      roundTrip((c) => {
        delete c.policies[0].approval
      }).ok
    ).toBe(false)
  })

  it("requires tokens to hold exactly one of value or aliasOf", () => {
    expect(
      roundTrip((c) => {
        c.tokens[0].value = { value: "x", aliasOf: "token:color.brand.primary" }
      }).ok
    ).toBe(false)
  })

  it("rejects absolute and parent-relative evidence paths", () => {
    const base = acmeEvidence.reactSize
    for (const path of ["/abs/Button.tsx", "../Button.tsx", "C:\\x.tsx", "a\\b.tsx"]) {
      const result = evidenceFileSchema.safeParse({
        evidenceVersion: "1.0.0",
        contractContentHash: "0".repeat(64),
        evidence: [{ ...base, location: { type: "file", path } }]
      })
      expect(result.success).toBe(false)
    }
  })
})

describe("semantic verification", () => {
  const verify = (mutate: (c: ReturnType<typeof acmeDraft>) => void, withEvidence = true) => {
    const draft = acmeDraft()
    mutate(draft)
    const contract = finalizeContract(draft)
    const evidence = createEvidenceFile(contract.integrity.contentHash, Object.values(acmeEvidence))
    return codes(verifyContract(contract, withEvidence ? evidence : undefined))
  }

  it("detects dangling entity references and unknown sources", () => {
    expect(
      verify((c) => {
        c.patterns[0]!.components = ["component:missing"]
      })
    ).toContain("contract.dangling-reference")
    expect(
      verify((c) => {
        c.components[0]!.implementations[0]!.sourceId = "nope"
      })
    ).toContain("contract.unknown-source")
  })

  it("detects unsorted and duplicate ids", () => {
    expect(
      verify((c) => {
        c.components.reverse()
      })
    ).toContain("contract.unsorted")
    expect(
      verify((c) => {
        c.tokens.push(c.tokens[2]!)
      })
    ).toContain("contract.duplicate-id")
  })

  it("detects fact paths that do not resolve", () => {
    expect(
      verify((c) => {
        c.components[0]!.facts["props.nope.default"] = c.components[0]!.facts["props.size.default"]!
      })
    ).toContain("contract.unresolvable-fact-path")
  })

  it("invalidates an approval when the approved value changes", () => {
    expect(
      verify((c) => {
        c.components[0]!.props[1]!.allowedValues = ["sm", "md", "lg", "xl"]
      })
    ).toContain("contract.approval-stale")
  })

  it("detects token alias cycles, including per-theme cycles", () => {
    expect(
      verify((c) => {
        c.tokens[1]!.value = { aliasOf: "token:color.action.primary" }
      })
    ).toContain("contract.token-alias-cycle")
    expect(
      verify((c) => {
        c.tokens[0]!.modes = { "theme:dark": { aliasOf: "token:color.action.primary" } }
      })
    ).toContain("contract.token-alias-cycle")
  })

  it("detects hash mismatches and framework metadata drift", () => {
    const { contract } = buildAcme()
    const tampered = {
      ...contract,
      components: [{ ...contract.components[0]!, name: "Changed" }, contract.components[1]!]
    }
    expect(codes(verifyContract(tampered))).toContain("contract.hash-mismatch")
    expect(
      verify((c) => {
        c.metadata.frameworks = ["react"]
      })
    ).toContain("contract.framework-mismatch")
  })

  it("detects evidence file problems", () => {
    const { contract, evidence } = buildAcme()
    const withoutOne = { ...evidence, evidence: evidence.evidence.slice(1) }
    expect(codes(verifyContract(contract, withoutOne))).toContain("contract.unknown-evidence")
    expect(codes(verifyContract(contract, { ...evidence, contractContentHash: "1".repeat(64) }))).toContain(
      "contract.evidence-hash-mismatch"
    )
    const forged = {
      ...evidence,
      evidence: evidence.evidence.map((e, i) => (i === 0 ? { ...e, original: "forged" } : e))
    }
    expect(codes(verifyContract(contract, forged))).toContain("contract.evidence-id-mismatch")
  })
})

describe("resolveFactPath", () => {
  const entity = {
    props: [{ name: "size", type: { text: "x" } }],
    composition: [{ target: "a" }],
    items: [{ id: "i1", v: 1 }]
  }

  it("addresses keyed array items by name or id, and others by index", () => {
    expect(resolveFactPath(entity, "props.size.type.text")).toEqual({ found: true, value: "x" })
    expect(resolveFactPath(entity, "items.i1.v")).toEqual({ found: true, value: 1 })
    expect(resolveFactPath(entity, "composition.0.target")).toEqual({ found: true, value: "a" })
  })

  it("does not resolve missing members or inherited properties", () => {
    expect(resolveFactPath(entity, "props.other").found).toBe(false)
    expect(resolveFactPath(entity, "props.size.toString").found).toBe(false)
    expect(resolveFactPath(entity, "composition.1").found).toBe(false)
  })
})

describe("JSON Schema", () => {
  const schemas = contractJsonSchemas()

  it("matches the committed schema files", () => {
    for (const [name, schema] of Object.entries(schemas)) {
      const expected = `${JSON.stringify(schema, null, 2)}\n`
      if (process.env.UPDATE_GOLDEN === "1" || !existsSync(schemaFile(name)))
        writeFileSync(schemaFile(name), expected)
      expect(readFileSync(schemaFile(name), "utf8")).toBe(expected)
    }
  })

  it("validates the golden fixtures and rejects a corrupted one", () => {
    const ajv = new Ajv2020({ strict: false })
    const validateContract = ajv.compile(schemas["contract-v1.schema.json"] as object)
    const validateEvidence = ajv.compile(schemas["evidence-v1.schema.json"] as object)
    const contract = JSON.parse(readFileSync(fixture("invariant.contract.json"), "utf8"))
    expect(validateContract(contract), JSON.stringify(validateContract.errors)).toBe(true)
    expect(validateEvidence(JSON.parse(readFileSync(fixture("invariant.evidence.json"), "utf8")))).toBe(true)
    contract.components[0].id = "Button"
    expect(validateContract(contract)).toBe(false)
  })

  it("has no framework names in core property names", () => {
    const names = new Set<string>()
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk)
        return
      }
      if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
          if (key === "properties" && value && typeof value === "object")
            for (const name of Object.keys(value)) names.add(name)
          walk(value)
        }
      }
    }
    walk(schemas)
    expect([...names].filter((n) => /react|angular|vue|jsx|ngmodule/i.test(n))).toEqual([])
  })
})
