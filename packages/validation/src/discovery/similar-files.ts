import type { Candidate, Occurrence } from "./model.js"
import { type FileShape, type ShapeNode, walk } from "./shapes.js"
import { candidateId, capEvidence, listNames, MAX_VARIABLE, round3, slug, uniqueName } from "./util.js"

export interface SimilarFilesOptions {
  minFiles: number
  /** Overlap (Jaccard) every pair in a group must reach. */
  similarity: number
}

/** A file with fewer design-system features than this is too small to say anything about its structure. */
export const MIN_FEATURES = 4
/** A feature in at least this share of a group, but not all of it, is reported as frequent. */
const FREQUENT_SHARE = 0.8

const bare = (id: string): string => id.replace(/^component:/, "")

/** What a file contains: its top-level design-system elements and each element-inside-element pair. */
function featuresOf(shape: FileShape): Set<string> {
  const out = new Set<string>()
  for (const r of shape.roots) out.add(`^${bare(r.id)}`)
  for (const n of walk(shape.roots)) for (const c of n.children) out.add(`${bare(n.id)} > ${bare(c.id)}`)
  return out
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let both = 0
  for (const x of a) if (b.has(x)) both++
  const all = a.size + b.size - both
  return all === 0 ? 0 : both / all
}

interface Member {
  shape: FileShape
  features: Set<string>
}

const idsIn = (feature: string): string[] =>
  feature.startsWith("^") ? [feature.slice(1)] : feature.split(" > ")

/**
 * Method: overlap of structure. Each file is described by the design-system elements at its top level and the
 * pairs of elements nested in each other. Files are put in a group when every pair in it overlaps by at least the
 * threshold, taking files in path order, so the result does not depend on how they were listed. A group says its
 * files are built from much the same parts. It does not say they do the same job.
 */
export function findSimilarFiles(files: readonly FileShape[], options: SimilarFilesOptions): Candidate[] {
  const members: Member[] = files
    .map((shape) => ({ shape, features: featuresOf(shape) }))
    .filter((m) => m.features.size >= MIN_FEATURES)
    .sort((a, b) => (a.shape.file < b.shape.file ? -1 : a.shape.file > b.shape.file ? 1 : 0))

  const clusters: Member[][] = []
  for (const m of members) {
    const home = clusters.find((c) => c.every((o) => jaccard(m.features, o.features) >= options.similarity))
    if (home) home.push(m)
    else clusters.push([m])
  }

  const names = new Map<string, string>()
  for (const f of files) for (const n of walk(f.roots)) names.set(bare(n.id), n.name)

  const taken = new Set<string>()
  const out: Candidate[] = []
  for (const cluster of clusters.filter((c) => c.length >= options.minFiles)) {
    const total = cluster.length
    const counts = new Map<string, number>()
    for (const m of cluster) for (const f of m.features) counts.set(f, (counts.get(f) ?? 0) + 1)
    const sorted = [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    const common = sorted.filter(([, n]) => n === total).map(([f]) => f)
    const frequent = sorted
      .filter(([, n]) => n < total && n / total >= FREQUENT_SHARE)
      .map(([feature, files]) => ({ feature, files }))
    const rest = sorted
      .filter(([, n]) => n / total < FREQUENT_SHARE)
      .map(([feature, files]) => ({ feature, files }))
      .sort((a, b) => b.files - a.files || (a.feature < b.feature ? -1 : 1))

    const pairs: number[] = []
    for (let i = 0; i < total; i++)
      for (let j = i + 1; j < total; j++)
        pairs.push(jaccard((cluster[i] as Member).features, (cluster[j] as Member).features))
    const key = common.join("|")

    const rolesById = new Map<string, "required" | "optional">()
    for (const f of common) for (const id of idsIn(f)) rolesById.set(id, "required")
    for (const { feature } of frequent)
      for (const id of idsIn(feature)) if (!rolesById.has(id)) rolesById.set(id, "optional")
    const used = new Set<string>()
    const parts = [...rolesById.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([id, role]) => ({
        name: uniqueName(slug(names.get(id) ?? id), used),
        ref: `component:${id}`,
        role
      }))
    if (parts.length === 0) continue
    const named = [...rolesById.keys()].sort().map((id) => names.get(id) ?? id)
    const topNames = common.filter((f) => f.startsWith("^")).map((f) => names.get(f.slice(1)) ?? f.slice(1))
    const label = listNames(topNames.length > 0 ? topNames : named)
    const evidence: Occurrence[] = cluster.map((m) => {
      const first = m.shape.roots[0] as ShapeNode
      return {
        file: m.shape.file,
        line: first.line,
        column: first.column,
        detail: `${m.features.size} design-system features, ${common.length} shared by the whole group`
      }
    })
    const capped = capEvidence(evidence)
    const minimum = Math.min(...pairs)
    const mean = pairs.reduce((a, b) => a + b, 0) / pairs.length

    out.push({
      id: candidateId("similar-files", key, taken),
      kind: "similar-files",
      status: "proposed",
      basis: "inferred",
      equivalence: "not-established",
      suggestedName: `Files built from ${label}`,
      nameSource: "derived",
      summary: `${total} files built from much the same design-system parts: ${listNames(named)}.`,
      explanation: [
        `Each file was described by the design-system elements at its top level and the pairs of elements nested in each other. These ${total} files were grouped because every pair of them overlaps by at least ${options.similarity}; the lowest overlap in the group is ${round3(minimum)}.`,
        `${common.length} features are in every file, ${frequent.length} in at least ${Math.round(FREQUENT_SHARE * 100)}% of them, and ${rest.length} in fewer.`,
        "Overlap of structure is measured here. It is not evidence that the files serve the same purpose or that one should look like another.",
        "Files are grouped in path order, one group at a time, so a group depends on the files present."
      ],
      support: { files: total, occurrences: total },
      consistency: { minimumPairwise: round3(minimum), meanPairwise: round3(mean) },
      structure: {
        key,
        common,
        frequent,
        variable: rest.slice(0, MAX_VARIABLE),
        variableTruncated: rest.length > MAX_VARIABLE
      },
      evidence: capped.evidence,
      evidenceTruncated: capped.truncated,
      definition: {
        name: `Files built from ${label}`,
        category: "composition",
        description: `The design-system parts shared by ${total} similar files, found by invariant discover. Parts in every file are required; parts in most are optional. Review before relying on it.`,
        composition: { parts }
      },
      derivation: {
        method: "complete-linkage-overlap",
        version: 1,
        parameters: { minFiles: options.minFiles, similarity: options.similarity, minFeatures: MIN_FEATURES }
      }
    })
  }
  return out.sort((a, b) => b.support.files - a.support.files || (a.structure.key < b.structure.key ? -1 : 1))
}
