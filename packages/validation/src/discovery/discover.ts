import type { DesignSystem } from "@invariant/contract-query"
import { buildTree } from "../validate-code.js"
import { findArrangements } from "./arrangements.js"
import {
  CANDIDATES_FILE_VERSION,
  type CandidatesFile,
  type DiscoveryDiagnostic,
  type ReviewsFile
} from "./model.js"
import { applyReviews } from "./reviews.js"
import { type FileShape, shapeOf } from "./shapes.js"
import { findSimilarFiles } from "./similar-files.js"

export interface DiscoverOptions {
  /** A candidate must recur in at least this many files. */
  minFiles: number
  /** An arrangement must occur at least this many times. */
  minUses: number
  /** Overlap every pair of similar files must reach, 0 to 1. */
  similarity: number
  /** How many levels of an arrangement are compared. */
  maxDepth: number
}

export const DEFAULT_OPTIONS: DiscoverOptions = { minFiles: 3, minUses: 3, similarity: 0.7, maxDepth: 3 }

export interface DiscoverInput {
  ds: DesignSystem
  files: ReadonlyArray<{ file: string; code: string }>
  options?: Partial<DiscoverOptions>
  reviews?: ReviewsFile | undefined
}

const READABLE = /\.(tsx|jsx)$/i

/**
 * Finds structures that recur in application code, as candidates for people to review. It reads React JSX by
 * syntax and runs nothing. It resolves elements to the contract's components, so it needs a compiled contract.
 * The result is the same for the same files, contract and options. Nothing it produces is approved or enforced.
 */
export function discover(input: DiscoverInput): CandidatesFile {
  const options = { ...DEFAULT_OPTIONS, ...input.options }
  const diagnostics: DiscoveryDiagnostic[] = []
  const files = [...input.files].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))

  const shapes: FileShape[] = []
  let unreadable = 0
  let empty = 0
  for (const { file, code } of files) {
    if (!READABLE.test(file)) {
      unreadable++
      continue
    }
    const shape = shapeOf(file, buildTree(input.ds, code, file))
    if (shape.designSystemElements === 0) empty++
    else shapes.push(shape)
  }
  if (unreadable > 0)
    diagnostics.push({
      code: "discovery-unsupported-files",
      severity: "info",
      message: `${unreadable} file(s) were skipped: discovery reads .tsx and .jsx files only. Vue, Angular, HTML and plain script files are not analyzed.`
    })
  if (empty > 0)
    diagnostics.push({
      code: "discovery-no-design-system-elements",
      severity: "info",
      message: `${empty} file(s) use no component from the contract, so they say nothing about how the design system is composed.`
    })
  if (shapes.length === 0)
    diagnostics.push({
      code: "discovery-nothing-to-analyze",
      severity: "warning",
      message:
        "No file used a component from the contract, so there is nothing to compare. Check the paths and that the contract's components are imported from the packages it names."
    })

  const found = [
    ...findArrangements(shapes, options),
    ...findSimilarFiles(shapes, { minFiles: options.minFiles, similarity: options.similarity })
  ]
  const applied = applyReviews(found, input.reviews)
  for (const r of applied.stale)
    diagnostics.push({
      code: "discovery-stale-review",
      severity: "info",
      message: `${r.candidate} was ${r.decision} by ${r.decidedBy}, but discovery no longer finds that structure. The decision is kept in the reviews file.`
    })

  return {
    version: CANDIDATES_FILE_VERSION,
    contract: { contentHash: input.ds.contract.integrity.contentHash },
    parameters: options,
    summary: { files: files.length, filesAnalyzed: shapes.length, candidates: applied.candidates.length },
    candidates: applied.candidates,
    diagnostics
  }
}
