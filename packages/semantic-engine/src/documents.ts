import type { IrDocument, IrFact } from "@invariant/compiler-ir"
import type { Component, Evidence, FactRecord, Guideline } from "@invariant/contract"
import { cmp, type Inference, inferredFact, slugSegment, words } from "./infer.js"

type Kind = Guideline["kind"]

const KIND_RULES: Array<{ kind: Kind; pattern: RegExp; confidence: number }> = [
  {
    kind: "accessibility",
    pattern: /\ba11y\b|accessib|\bwcag\b|\baria\b|screen[- ]reader|keyboard/,
    confidence: 0.7
  },
  {
    kind: "do-dont",
    pattern: /do and don'?t|dos and don'?ts|do'?s? ?& ?don'?ts?|do\/don'?t/,
    confidence: 0.7
  },
  { kind: "composition", pattern: /composition|compos(?:e|ing)\b|layout/, confidence: 0.6 },
  {
    kind: "visual-principle",
    pattern: /principle|philosophy|foundations?|brand|voice and tone|visual/,
    confidence: 0.6
  },
  {
    kind: "usage",
    pattern: /usage|guidelines?|how to use|when to use|best practices?|getting started|overview/,
    confidence: 0.6
  }
]

function classify(text: string): { kind: Kind; confidence: number; matched?: string } {
  for (const rule of KIND_RULES) {
    const m = rule.pattern.exec(text)
    if (m) return { kind: rule.kind, confidence: rule.confidence, matched: m[0] }
  }
  return { kind: "reference", confidence: 0.4 }
}

function containsWords(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || (needle.length === 1 && (needle[0] as string).length <= 2)) return false
  for (let i = 0; i + needle.length <= haystack.length; i++)
    if (needle.every((w, j) => haystack[i + j] === w)) return true
  return false
}

export interface DocumentResult {
  guidelines: Guideline[]
  /** Evidence the guidelines cite, from the documents. */
  evidence: Evidence[]
  skipped: Array<{ ref: string; sourceId: string; reason: string }>
}

/**
 * One guideline per documentation page. The IR carries a page's title and headings, not its prose, so the
 * statement is the title and the kind comes from keywords: a page that matches none stays a `reference`.
 * `appliesTo` links a page to a component only when the file name or title names it.
 */
export function classifyDocuments(
  docs: readonly IrDocument[],
  components: readonly Component[]
): DocumentResult {
  const guidelines: Guideline[] = []
  const evidence = new Map<string, Evidence>()
  const skipped: DocumentResult["skipped"] = []
  const used = new Set<string>()

  for (const doc of [...docs].sort((a, b) => cmp(a.source.id, b.source.id))) {
    const byId = new Map(doc.evidence.map((e) => [e.id, e]))
    const bySubject = new Map<string, IrFact[]>()
    for (const f of doc.facts) bySubject.set(f.subject, [...(bySubject.get(f.subject) ?? []), f])
    for (const entity of doc.entities
      .filter((e) => e.kind === "doc-page")
      .sort((a, b) => cmp(a.ref, b.ref))) {
      const facts = bySubject.get(entity.ref) ?? []
      const find = (path: string): IrFact | undefined => facts.find((f) => f.path === path)
      const titleFact = find("doc.title") ?? facts[0]
      if (!titleFact) {
        skipped.push({ ref: entity.ref, sourceId: doc.source.id, reason: "the page has no facts to cite" })
        continue
      }
      const title =
        typeof find("doc.title")?.value === "string" ? (find("doc.title")?.value as string) : entity.name
      const documentId = entity.ref.replace(/^doc:/, "")
      const stem = (documentId.split("/").pop() ?? documentId).replace(/\.[^.]*$/, "")
      const cite = (ids: readonly string[]): void => {
        for (const id of ids) {
          const found = byId.get(id)
          if (found) evidence.set(id, found)
        }
      }

      const text = [title, stem].join(" \n ").toLowerCase()
      const kind = classify(text)
      const segments = documentId
        .replace(/\.[^./]*$/, "")
        .split("/")
        .map(slugSegment)
      let id = `guideline:${segments.join("/")}`
      for (let n = 2; used.has(id); n++) id = `guideline:${segments.join("/")}-${n}`
      used.add(id)

      const facts_: Record<string, FactRecord> = {}
      const status = titleFact.origin === "extracted" ? ("discovered" as const) : ("documented" as const)
      facts_.name = { status, evidenceIds: titleFact.evidenceIds }
      facts_.statement = { status, evidenceIds: titleFact.evidenceIds }
      facts_["references.0"] = { status: "discovered", evidenceIds: titleFact.evidenceIds }
      cite(titleFact.evidenceIds)
      const kindEvidence = [...titleFact.evidenceIds]
      const kindInference: Inference = {
        rule: kind.kind === "reference" ? "document.classify.fallback" : "document.classify.keyword",
        confidence: kind.confidence,
        reasoning:
          kind.kind === "reference"
            ? "No keyword in the title or file name identifies a more specific kind of page"
            : `The title or file name contains "${kind.matched}", which marks a ${kind.kind} page`,
        inputs: ["doc.title"],
        evidenceIds: kindEvidence
      }
      facts_.kind = inferredFact(kindInference)
      cite(kindEvidence)

      const stemWords = words(stem)
      const titleWords = words(title)
      const applies: Array<{ id: string; confidence: number; reason: string }> = []
      for (const c of [...components].sort((a, b) => cmp(a.id, b.id))) {
        const cw = words(c.name)
        if (stemWords.join(" ") === cw.join(" ") && cw.length > 0)
          applies.push({
            id: c.id,
            confidence: 0.8,
            reason: `The file name "${stem}" is the component name "${c.name}"`
          })
        else if (containsWords(titleWords, cw))
          applies.push({
            id: c.id,
            confidence: 0.6,
            reason: `The title "${title}" names the component "${c.name}"`
          })
      }
      const exact = applies
        .filter((a) => a.confidence === 0.8)
        .map((a) => words(components.find((c) => c.id === a.id)?.name ?? ""))
      const covered = (id: string): boolean => {
        const cw = words(components.find((c) => c.id === id)?.name ?? "")
        return exact.some((e) => e.length > cw.length && containsWords(e, cw))
      }
      const kept = applies.filter((a) => a.confidence === 0.8 || !covered(a.id))
      kept.forEach((a, index) => {
        facts_[`appliesTo.${index}`] = inferredFact({
          rule: "document.names-component",
          confidence: a.confidence,
          reasoning: a.reason,
          inputs: ["doc.title"],
          evidenceIds: titleFact.evidenceIds
        })
      })

      guidelines.push({
        id: id as Guideline["id"],
        name: title,
        kind: kind.kind,
        statement: title,
        appliesTo: kept.map((a) => a.id as Guideline["appliesTo"][number]),
        examples: [],
        references: [{ sourceId: doc.source.id, documentId, title }],
        facts: Object.fromEntries(Object.entries(facts_).sort((a, b) => cmp(a[0], b[0])))
      })
    }
  }
  return {
    guidelines: guidelines.sort((a, b) => cmp(a.id, b.id)),
    evidence: [...evidence.values()].sort((a, b) => cmp(a.id, b.id)),
    skipped
  }
}
