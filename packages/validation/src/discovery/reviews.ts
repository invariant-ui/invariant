import type { Candidate, Decision, Review, ReviewsFile } from "./model.js"
import { REVIEWS_FILE_VERSION, reviewsFileSchema } from "./model.js"

export type ParsedReviews = { ok: true; value: ReviewsFile } | { ok: false; message: string }

export function parseReviews(text: string, file: string): ParsedReviews {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      message: `${file} is not valid JSON: ${error instanceof Error ? error.message : error}`
    }
  }
  const parsed = reviewsFileSchema.safeParse(raw)
  if (parsed.success) return { ok: true, value: parsed.data }
  const first = parsed.error.issues[0]
  return {
    ok: false,
    message: `${file}: ${first ? `${first.path.join(".") || "(root)"}: ${first.message}` : "invalid"}`
  }
}

export function emptyReviews(): ReviewsFile {
  return { version: REVIEWS_FILE_VERSION, reviews: [] }
}

/**
 * Adds a decision to the history. Earlier decisions stay: the file is a record of who decided what and when,
 * and the latest one for a candidate is the one that counts.
 */
export function recordReview(file: ReviewsFile, review: Review): ReviewsFile {
  return { ...file, reviews: [...file.reviews, review] }
}

/** The decision in force for a candidate: its latest review. */
export function latestReview(file: ReviewsFile, id: string): Review | undefined {
  for (let i = file.reviews.length - 1; i >= 0; i--) {
    const r = file.reviews[i] as Review
    if (r.candidate === id) return r
  }
  return undefined
}

export interface AppliedReviews {
  candidates: Candidate[]
  /** Reviews of candidates that discovery no longer finds. Reported, never dropped. */
  stale: Review[]
}

/**
 * Sets each candidate's status from its latest review. A candidate is identified by what it is, not by where it
 * was found, so a decision keeps applying as files change, and stops applying when the structure itself does.
 */
export function applyReviews(
  candidates: readonly Candidate[],
  file: ReviewsFile | undefined
): AppliedReviews {
  if (!file) return { candidates: [...candidates], stale: [] }
  const known = new Set(candidates.map((c) => c.id))
  const latest = new Map<string, Review>()
  for (const r of file.reviews) latest.set(r.candidate, r)
  return {
    candidates: candidates.map((c) => {
      const r = latest.get(c.id)
      return r ? { ...c, status: r.decision satisfies Decision, review: r } : c
    }),
    stale: [...latest.values()].filter((r) => !known.has(r.candidate))
  }
}

export function serializeReviews(file: ReviewsFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}
