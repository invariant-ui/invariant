import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { angularAdapter } from "@invariant/compiler-angular"
import { compile, nodeFs, type SourceAdapter } from "@invariant/compiler-core"
import { FIXED_CLOCK } from "@invariant/compiler-core/testing"
import { reactAdapter } from "@invariant/compiler-react"
import { storybookAdapter } from "@invariant/compiler-storybook"
import { designTokensAdapter } from "@invariant/compiler-tokens"
import { vueAdapter } from "@invariant/compiler-vue"
import { serializeContract, serializeEvidenceFile } from "@invariant/contract"
import { buildReviewQueue, finalizeAndVerify, reconcile } from "@invariant/reconciliation"
import { enrich } from "@invariant/semantic-engine"
import { describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("..", import.meta.url))
const goldenRoot = join(root, "fixtures/contract-golden")

async function pipeline(project: string, adapters: SourceAdapter[], reverse = false) {
  const result = await compile({ fs: nodeFs(join(root, project)), adapters, clock: FIXED_CLOCK })
  const docs = reverse ? [...result.irDocuments].reverse() : result.irDocuments
  const reconciled = reconcile(docs, { name: "Fixture DS", compilerVersion: "0.0.0", clock: FIXED_CLOCK })
  const enriched = enrich({ contract: reconciled.contract, evidence: reconciled.evidence, docs })
  const final = finalizeAndVerify(enriched.contract, enriched.evidence)
  const review = buildReviewQueue(enriched.contract)
  return {
    result,
    reconciled,
    enriched,
    final,
    review,
    files: {
      "invariant.contract.json": serializeContract(final.contract),
      "invariant.evidence.json": serializeEvidenceFile(final.evidenceFile),
      "invariant.review.json": `${JSON.stringify(review, null, 2)}\n`
    }
  }
}

function checkGolden(name: string, files: Record<string, string>): void {
  const dir = join(goldenRoot, name)
  if (process.env.UPDATE_GOLDEN === "1" || !existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text)
  }
  for (const [file, text] of Object.entries(files)) expect(readFileSync(join(dir, file), "utf8")).toBe(text)
}

const cross = [reactAdapter, vueAdapter, angularAdapter] as SourceAdapter[]
const acme = [reactAdapter, storybookAdapter, designTokensAdapter] as SourceAdapter[]

describe("Phase 7 exit criterion: one contract from several sources, with meaningful disagreements and evidence", () => {
  it("unifies one conceptual Button across React, Vue and Angular, with explained identity", async () => {
    const p = await pipeline("fixtures/cross-framework/demo", cross)
    expect(p.final.diagnostics).toEqual([])
    expect(p.enriched.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    const [button] = p.final.contract.components
    expect(p.final.contract.components).toHaveLength(1)
    expect(button?.id).toBe("component:button")
    expect(button?.implementations.map((i) => i.framework)).toEqual(["angular", "react", "vue"])
    for (const impl of button?.implementations ?? []) {
      expect(button?.facts[`implementations.${impl.id}`]).toMatchObject({
        status: "inferred",
        derivation: { rule: "name-match.stripped-prefix" }
      })
    }
    expect(button?.props.find((x) => x.name === "variant")).toMatchObject({
      required: false,
      default: "primary",
      allowedValues: ["primary", "secondary", "ghost"]
    })
    // The frameworks agree on every semantic path; the only disagreement is how the payload type is spelled.
    expect(p.final.contract.conflicts.map((c) => [c.type, c.path, c.severity])).toEqual([
      ["value-mismatch", "events.press.payload.text", "info"]
    ])
  })

  it("finds the disagreements between stories and code in a design system, citing evidence on both sides", async () => {
    const p = await pipeline("fixtures/storybook/acme-ui", acme)
    expect(p.final.diagnostics).toEqual([])
    const conflicts = p.final.contract.conflicts
    expect(conflicts.map((c) => `${c.type}:${c.subject}:${c.path}`)).toEqual([
      "deprecation-mismatch:component:button:props.plain.deprecated",
      "existence-mismatch:component:card:props.shadow",
      "value-mismatch:component:button:props.variant.allowedValues",
      "value-mismatch:component:button:props.variant.default",
      "value-mismatch:component:modal:props.size.allowedValues",
      "value-mismatch:component:modal:props.size.default"
    ])
    const evidenceById = new Map(p.final.evidenceFile.evidence.map((e) => [e.id, e]))
    for (const c of conflicts) {
      expect(c.resolution).toEqual({ state: "open" })
      expect(new Set(c.claims.map((x) => x.sourceId)).size).toBeGreaterThanOrEqual(2)
      for (const claim of c.claims) {
        expect(claim.evidenceIds.length).toBeGreaterThan(0)
        for (const id of claim.evidenceIds) expect(evidenceById.has(id)).toBe(true)
      }
    }
    const variant = conflicts.find((c) => c.path === "props.variant.allowedValues")
    const sides = Object.fromEntries(
      (variant?.claims ?? []).map((c) => [c.sourceId, evidenceById.get(c.evidenceIds[0] as string)?.location])
    )
    expect(sides["react-acme-ui"]).toMatchObject({
      type: "file",
      path: expect.stringMatching(/Button\.tsx$/)
    })
    expect(sides["stories-root"]).toMatchObject({ type: "file", path: expect.stringMatching(/\.stories\./) })
    // The contract keeps the code's value; the story's claim is preserved in the conflict, not applied.
    const button = p.final.contract.components.find((c) => c.id === "component:button")
    expect(button?.props.find((x) => x.name === "variant")?.allowedValues).toEqual([
      "primary",
      "secondary",
      "ghost"
    ])
  })

  it("never presents inferred information as fact, never approves, never creates policies", async () => {
    for (const [project, adapters] of [
      ["fixtures/cross-framework/demo", cross],
      ["fixtures/storybook/acme-ui", acme]
    ] as const) {
      const p = await pipeline(project, adapters as SourceAdapter[])
      const c = p.final.contract
      expect(c.policies).toEqual([])
      const entities = [...c.components, ...c.tokens, ...c.guidelines]
      let inferred = 0
      for (const e of entities)
        for (const f of Object.values(e.facts)) {
          expect(f.status).not.toBe("approved")
          if (f.status === "inferred") {
            inferred++
            expect(f.confidence).toBeGreaterThan(0)
            expect(f.confidence).toBeLessThan(1)
            expect(f.derivation?.rule).toBeTruthy()
            expect(f.evidenceIds.length).toBeGreaterThan(0)
          } else expect(f.derivation).toBeUndefined()
        }
      expect(inferred).toBeGreaterThan(0)
      const queue = p.review
      expect(queue.filter((q) => q.kind === "inferred-fact")).toHaveLength(inferred)
      expect(queue.filter((q) => q.kind === "conflict")).toHaveLength(c.conflicts.length)
      expect(queue.every((q) => q.approvalRequired)).toBe(true)
    }
  })

  it("is reproducible, whatever order the IR documents arrive in", async () => {
    const a = await pipeline("fixtures/storybook/acme-ui", acme)
    const b = await pipeline("fixtures/storybook/acme-ui", acme, true)
    expect(b.files).toEqual(a.files)
  })

  it("matches the committed golden contracts", async () => {
    checkGolden("cross-framework", (await pipeline("fixtures/cross-framework/demo", cross)).files)
    checkGolden("acme-ui", (await pipeline("fixtures/storybook/acme-ui", acme)).files)
  })
})
