import type { JsonValue } from "@invariant/shared"
import { cmp, type DesignSystem, normalize } from "./system.js"

export type SearchKind = "component" | "token" | "guideline"

export interface SearchHit {
  kind: SearchKind
  id: string
  name: string
  score: number
  matchedOn: string[]
}

const words = (text: string): string[] =>
  text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

/** Plural and `-ing` endings only: `buttons` and `button`, `variants` and `variant`, `loading` and `load`. */
const stem = (w: string): string =>
  w.length > 4 && w.endsWith("ies")
    ? `${w.slice(0, -3)}y`
    : w.length > 4 && w.endsWith("ing")
      ? w.slice(0, -3)
      : w.length > 3 && w.endsWith("s") && !w.endsWith("ss")
        ? w.slice(0, -1)
        : w

/** True when two words differ by at most one inserted, deleted or substituted letter. */
function oneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  let j = 0
  let edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++
      j++
      continue
    }
    if (++edits > 1) return false
    if (a.length > b.length) i++
    else if (a.length < b.length) j++
    else {
      i++
      j++
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1
}

/**
 * Fixed, explainable ranking: name matches beat structure matches beat description matches. Matching is
 * lexical: exact words, plural and `-ing` stems, word prefixes and one-letter typos. There are no synonyms,
 * embeddings or models, so the same query always gives the same answer and every hit says what it matched.
 */
function score(
  query: string,
  fields: Array<{ label: string; text: string; weight: number }>
): { score: number; matchedOn: string[] } {
  const qn = normalize(query)
  const qw = words(query)
  let total = 0
  const matchedOn: string[] = []
  for (const f of fields) {
    if (!f.text) continue
    const tn = normalize(f.text)
    const tw = words(f.text)
    let s = 0
    if (tn === qn) s = 10
    else if (tn.startsWith(qn) && qn.length >= 2) s = 6
    else if (qw.length > 0 && qw.every((w) => tw.includes(w))) s = 5
    else if (qn.length >= 3 && tn.includes(qn)) s = 3
    else if (qw.length > 0 && qw.every((w) => tw.some((x) => stem(x) === stem(w)))) s = 4
    else if (qw.length > 0 && qw.every((w) => w.length >= 3 && tw.some((x) => x.startsWith(w)))) s = 2
    else if (qw.some((w) => w.length >= 3 && tw.includes(w))) s = 1
    else if (qw.length > 0 && qw.every((w) => w.length >= 5 && tw.some((x) => oneEdit(w, x)))) {
      total += f.weight * 0.5
      matchedOn.push(`${f.label} (approximate)`)
      continue
    }
    if (s > 0) {
      total += s * f.weight
      matchedOn.push(f.label)
    }
  }
  return { score: total, matchedOn }
}

export function search(
  ds: DesignSystem,
  query: string,
  kinds: readonly SearchKind[] = ["component", "token", "guideline"],
  limit = 20
): { total: number; hits: SearchHit[] } {
  const hits: SearchHit[] = []
  const add = (
    kind: SearchKind,
    id: string,
    name: string,
    r: { score: number; matchedOn: string[] }
  ): void => {
    if (r.score > 0) hits.push({ kind, id, name, score: r.score, matchedOn: r.matchedOn })
  }
  if (kinds.includes("component"))
    for (const c of ds.contract.components)
      add(
        "component",
        c.id,
        c.name,
        score(query, [
          { label: "name", text: c.name, weight: 10 },
          { label: "prop", text: c.props.map((p) => p.name).join(" "), weight: 3 },
          { label: "variant", text: c.variants.flatMap((v) => [v.name, ...v.values]).join(" "), weight: 3 },
          { label: "slot", text: c.slots.map((s) => s.name).join(" "), weight: 2 },
          { label: "event", text: c.events.map((e) => e.name).join(" "), weight: 2 },
          { label: "description", text: c.description ?? "", weight: 1 }
        ])
      )
  if (kinds.includes("token"))
    for (const t of ds.contract.tokens)
      add(
        "token",
        t.id,
        t.name,
        score(query, [
          { label: "name", text: t.name, weight: 10 },
          { label: "category", text: t.category, weight: 2 },
          { label: "value", text: typeof t.value.value === "string" ? t.value.value : "", weight: 2 },
          { label: "description", text: t.description ?? "", weight: 1 }
        ])
      )
  if (kinds.includes("guideline"))
    for (const g of ds.contract.guidelines)
      add(
        "guideline",
        g.id,
        g.name,
        score(query, [
          { label: "title", text: g.name, weight: 8 },
          { label: "kind", text: g.kind, weight: 1 }
        ])
      )
  hits.sort((a, b) => b.score - a.score || cmp(a.kind, b.kind) || cmp(a.id, b.id))
  return { total: hits.length, hits: hits.slice(0, Math.max(1, Math.min(limit, 100))) }
}

export const searchJson = (r: ReturnType<typeof search>): JsonValue => r as unknown as JsonValue
