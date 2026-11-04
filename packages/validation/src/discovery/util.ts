import { sha256Hex } from "@invariant/shared"
import type { CandidateKind, Occurrence } from "./model.js"

export const MAX_EVIDENCE = 25
export const MAX_VARIABLE = 30

/** A stable id from what the candidate is, so the same finding keeps its id from run to run and reviews stay attached. */
export function candidateId(kind: CandidateKind, key: string, taken: Set<string>): string {
  const base = `candidate:${kind}.${sha256Hex(`${kind}\n${key}`).slice(0, 8)}`
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  taken.add(id)
  return id
}

/** `CardHeader` and `Card.Header` become `card-header`: a legal part name, readable, and the same every time. */
export function slug(name: string): string {
  const out = name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "")
  return (out === "" ? "part" : out).slice(0, 56)
}

/** Part names must be unique in a pattern; a repeat gets a number. */
export function uniqueName(base: string, used: Set<string>): string {
  let name = base
  for (let n = 2; used.has(name); n++) name = `${base}-${n}`
  used.add(name)
  return name
}

export const byPosition = (a: Occurrence, b: Occurrence): number =>
  a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.column - b.column

/** Evidence capped to a fixed number, always the same ones (the first in file order), with a flag saying so. */
export function capEvidence(all: Occurrence[]): { evidence: Occurrence[]; truncated: boolean } {
  const sorted = [...all].sort(byPosition)
  return { evidence: sorted.slice(0, MAX_EVIDENCE), truncated: sorted.length > MAX_EVIDENCE }
}

export const round3 = (n: number): number => Math.round(n * 1000) / 1000

export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("")
  const shown = names.slice(0, 3)
  const more = names.length - shown.length
  const head = shown.slice(0, -1).join(", ")
  const last = shown[shown.length - 1]
  return more > 0 ? `${shown.join(", ")} and ${more} more` : `${head} and ${last}`
}
