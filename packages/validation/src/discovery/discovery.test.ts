import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { evidenceFileSchema, parseContract } from "@invariant/contract"
import { DesignSystem } from "@invariant/contract-query"
import { describe, expect, it } from "vitest"
import {
  type Candidate,
  type CandidatesFile,
  candidatesFileSchema,
  discover,
  emptyReviews,
  recordReview,
  toDefinition
} from "./index.js"

const golden = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../../fixtures/contract-golden/acme-ui/${name}`, import.meta.url)),
      "utf8"
    )
  )
const ds = (): DesignSystem => {
  const parsed = parseContract(golden("invariant.contract.json"))
  if (!parsed.ok) throw new Error("fixture invalid")
  return new DesignSystem(parsed.value, evidenceFileSchema.parse(golden("invariant.evidence.json")))
}

const HEAD = 'import { Badge, Button, Card, Link, Modal, Stack, Text } from "@acme/ui"\n'
const file = (name: string, body: string) => ({ file: name, code: `${HEAD}export const X = () => (${body})` })
const CARD =
  "<Card><Card.Header><Text>t</Text></Card.Header><Card.Body><Button>go</Button></Card.Body></Card>"
const run = (files: ReturnType<typeof file>[], options = {}, reviews = undefined as never) =>
  discover({ ds: ds(), files, options, reviews })
const arrangements = (r: CandidatesFile): Candidate[] => r.candidates.filter((c) => c.kind === "arrangement")

describe("recurring arrangements", () => {
  const three = [1, 2, 3].map((i) => file(`app/p${i}.tsx`, `<Stack>${CARD}</Stack>`))

  it("finds an arrangement written the same way in enough files, with its evidence and why", () => {
    const top = arrangements(run(three)).find((c) => c.structure.key.startsWith("card("))
    expect(top).toBeDefined()
    expect(top?.structure.key).toBe("card(card.header(text),card.body(button))")
    expect(top?.support).toEqual({ files: 3, occurrences: 3 })
    expect(top?.evidence.map((e) => e.file)).toEqual(["app/p1.tsx", "app/p2.tsx", "app/p3.tsx"])
    expect(top?.evidence.every((e) => e.line > 0 && e.column > 0)).toBe(true)
    expect(top?.explanation.join(" ")).toMatch(/does not show it is intended/)
  })

  it("is only ever a proposed, inferred candidate, never an approved fact", () => {
    const result = run(three)
    expect(result.candidates.length).toBeGreaterThan(0)
    for (const c of result.candidates) {
      expect(c.status).toBe("proposed")
      expect(c.basis).toBe("inferred")
      expect(c.equivalence).toBe("not-established")
      expect(c.evidence.length).toBeGreaterThan(0)
      expect(JSON.stringify(c.definition)).not.toMatch(/approv/i)
    }
    expect(candidatesFileSchema.safeParse(result).success).toBe(true)
  })

  it("needs enough files and enough uses", () => {
    expect(arrangements(run(three.slice(0, 2)))).toEqual([])
    const oneFile = [file("app/a.tsx", `<Stack>${CARD}${CARD}${CARD}</Stack>`)]
    expect(arrangements(run(oneFile))).toEqual([])
    expect(arrangements(run(three, { minFiles: 4 }))).toEqual([])
    expect(arrangements(run(three.slice(0, 2), { minFiles: 2, minUses: 2 })).length).toBeGreaterThan(0)
  })

  it("does not treat different arrangements as one, even when they use the same parts", () => {
    const flipped =
      "<Card><Card.Body><Button>go</Button></Card.Body><Card.Header><Text>t</Text></Card.Header></Card>"
    const mixed = [
      file("app/a.tsx", CARD),
      file("app/b.tsx", CARD),
      file("app/c.tsx", flipped),
      file("app/d.tsx", flipped)
    ]
    expect(
      arrangements(run(mixed, { minFiles: 2, minUses: 2 }))
        .filter((c) => c.structure.key.startsWith("card("))
        .map((c) => c.support.occurrences)
    ).toEqual([2, 2])
  })

  it("marks elements that may not render or may repeat, so they are not confused with fixed ones", () => {
    const conditional = [1, 2, 3].map((i) =>
      file(
        `app/c${i}.tsx`,
        "<Card>{show && <Badge>new</Badge>}{rows.map((r) => <Link key={r}>l</Link>)}</Card>"
      )
    )
    const found = arrangements(run(conditional))
    const card = found.find((c) => c.structure.key.startsWith("card("))
    expect(card?.structure.key).toBe("card(badge?,link?*)")
    expect(card?.definition.composition.parts.map((p) => [p.ref, p.role])).toEqual([
      ["component:card", "required"],
      ["component:badge", "optional"],
      ["component:link", "optional"]
    ])
  })

  it("ignores markup between design-system elements, and says so", () => {
    const wrapped = [1, 2, 3].map((i) => file(`app/w${i}.tsx`, "<Card><div><Button>x</Button></div></Card>"))
    const card = arrangements(run(wrapped)).find((c) => c.structure.key === "card(button)")
    expect(card).toBeDefined()
    expect(card?.explanation.join(" ")).toMatch(/Markup and components from elsewhere/)
  })

  it("ignores components that are not in the contract", () => {
    const foreign = [1, 2, 3].map((i) => ({
      file: `app/f${i}.tsx`,
      code: 'import { Card } from "other-lib"\nexport const X = () => <Card><Card.Header/></Card>'
    }))
    const result = run(foreign)
    expect(result.candidates).toEqual([])
    expect(result.diagnostics.map((d) => d.code)).toContain("discovery-nothing-to-analyze")
  })

  it("keeps an arrangement that sits inside a larger one, and says which", () => {
    const result = run([1, 2, 3].map((i) => file(`app/q${i}.tsx`, CARD)))
    const inner = arrangements(result).find((c) => c.structure.key === "card.body(button)")
    const outer = arrangements(result).find((c) => c.structure.key.startsWith("card("))
    expect(inner?.subsumedBy).toBe(outer?.id)
    expect(outer?.subsumedBy).toBeUndefined()
  })

  it("names parts legally and uniquely", () => {
    const top = arrangements(run(three)).find((c) => c.structure.key.startsWith("card("))
    const names = top?.definition.composition.parts.map((p) => p.name) ?? []
    expect(new Set(names).size).toBe(names.length)
    for (const n of names) expect(n).toMatch(/^[a-z0-9][a-z0-9_-]*$/)
  })
})

describe("similar files", () => {
  const base = (i: number, extra = "") =>
    file(`app/page${i}.tsx`, `<Stack>${CARD}<Link>back</Link>${extra}</Stack>`)
  const group = [1, 2, 3].map((i) => base(i))

  it("groups files built from much the same parts, with measured consistency and what varies", () => {
    const files = [
      ...group,
      base(4, "<Badge>beta</Badge>"),
      file("app/other.tsx", "<Modal><Text>x</Text></Modal>")
    ]
    const similar = run(files).candidates.find((c) => c.kind === "similar-files")
    expect(similar?.support.files).toBe(4)
    expect(similar?.evidence.map((e) => e.file)).not.toContain("app/other.tsx")
    expect(similar?.consistency?.minimumPairwise).toBeGreaterThan(0.7)
    expect(similar?.structure.common).toContain("^stack")
    expect(similar?.structure.variable.map((v) => v.feature).join(" ")).toMatch(/badge/)
    expect(similar?.explanation.join(" ")).toMatch(/not evidence that the files serve the same purpose/)
    expect(similar?.equivalence).toBe("not-established")
  })

  it("does not group files below the overlap threshold, however many there are", () => {
    const apart = [
      file("app/a.tsx", `<Stack>${CARD}</Stack>`),
      file("app/b.tsx", "<Modal><Text>x</Text><Button>y</Button><Link>z</Link></Modal>"),
      file("app/c.tsx", "<Stack><Badge>x</Badge><Text>y</Text><Link>z</Link><Button>w</Button></Stack>")
    ]
    expect(run(apart).candidates.filter((c) => c.kind === "similar-files")).toEqual([])
  })

  it("leaves out files too small to say anything", () => {
    const tiny = [1, 2, 3].map((i) => file(`app/t${i}.tsx`, "<Stack><Text>x</Text></Stack>"))
    expect(run(tiny).candidates.filter((c) => c.kind === "similar-files")).toEqual([])
  })
})

describe("determinism and diagnostics", () => {
  const files = [1, 2, 3, 4].map((i) => file(`app/p${i}.tsx`, `<Stack>${CARD}<Link>b</Link></Stack>`))

  it("gives the same result for the same input, in any order", () => {
    const a = JSON.stringify(run(files))
    expect(JSON.stringify(run(files))).toBe(a)
    expect(JSON.stringify(run([...files].reverse()))).toBe(a)
  })

  it("keeps a candidate's id when unrelated files change", () => {
    const before = run(files).candidates.map((c) => c.id)
    const after = run([...files, file("app/z.tsx", "<Modal><Text>x</Text></Modal>")]).candidates.map(
      (c) => c.id
    )
    expect(after).toEqual(before)
  })

  it("says what it skipped", () => {
    const result = run([
      ...files,
      { file: "app/Thing.vue", code: "<template><div/></template>" },
      { file: "app/plain.tsx", code: "export const y = <div/>" }
    ])
    const codes = result.diagnostics.map((d) => d.code)
    expect(codes).toContain("discovery-unsupported-files")
    expect(codes).toContain("discovery-no-design-system-elements")
    expect(result.summary).toMatchObject({ files: 6, filesAnalyzed: 4 })
  })
})

describe("review decisions", () => {
  const files = [1, 2, 3].map((i) => file(`app/p${i}.tsx`, `<Stack>${CARD}</Stack>`))
  const at = "2026-11-03T12:00:00.000Z"

  it("applies the latest recorded decision, and the earlier ones stay in the history", () => {
    const [first] = run(files).candidates as [Candidate]
    let reviews = recordReview(emptyReviews(), {
      candidate: first.id,
      decision: "deferred",
      decidedBy: "ana",
      decidedAt: at
    })
    reviews = recordReview(reviews, {
      candidate: first.id,
      decision: "accepted",
      decidedBy: "ben",
      decidedAt: at,
      reason: "matches our cards"
    })
    const result = run(files, {}, reviews)
    const found = result.candidates.find((c) => c.id === first.id)
    expect(found?.status).toBe("accepted")
    expect(found?.review?.decidedBy).toBe("ben")
    expect(reviews.reviews).toHaveLength(2)
    expect(result.candidates.filter((c) => c.id !== first.id).every((c) => c.status === "proposed")).toBe(
      true
    )
  })

  it("keeps a decision attached when the files change but the structure does not", () => {
    const [first] = run(files).candidates as [Candidate]
    const reviews = recordReview(emptyReviews(), {
      candidate: first.id,
      decision: "rejected",
      decidedBy: "ana",
      decidedAt: at
    })
    const more = run([...files, file("app/p4.tsx", `<Stack>${CARD}</Stack>`)], {}, reviews)
    expect(more.candidates.find((c) => c.id === first.id)?.status).toBe("rejected")
  })

  it("reports a decision about a structure that is gone, and does not drop it", () => {
    const reviews = recordReview(emptyReviews(), {
      candidate: "candidate:arrangement.deadbeef",
      decision: "accepted",
      decidedBy: "ana",
      decidedAt: at
    })
    const result = run(files, {}, reviews)
    expect(result.diagnostics.map((d) => d.code)).toContain("discovery-stale-review")
    expect(reviews.reviews).toHaveLength(1)
  })
})

describe("promotion", () => {
  it("makes a definition with no approval, intent or constraints, and records where it came from", () => {
    const files = [1, 2, 3].map((i) => file(`app/p${i}.tsx`, `<Stack>${CARD}</Stack>`))
    const [first] = run(files).candidates as [Candidate]
    const accepted: Candidate = {
      ...first,
      status: "accepted",
      review: {
        candidate: first.id,
        decision: "accepted",
        decidedBy: "ana",
        decidedAt: "2026-11-03T12:00:00.000Z",
        reference: "DS-9"
      }
    }
    const def = toDefinition(accepted, { id: "composition.card-block" })
    expect(def).not.toHaveProperty("approval")
    expect(def).not.toHaveProperty("intent")
    expect(def).not.toHaveProperty("constraints")
    expect(def).toMatchObject({
      id: "composition.card-block",
      category: "composition",
      origin: { candidate: first.id, acceptedBy: "ana", reference: "DS-9" }
    })
  })
})
