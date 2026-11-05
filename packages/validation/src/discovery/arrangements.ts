import type { Candidate, Occurrence, ShapeTree } from "./model.js"
import { type FileShape, type ShapeNode, walk } from "./shapes.js"
import { candidateId, capEvidence, listNames, slug, uniqueName } from "./util.js"

export interface ArrangementOptions {
  minFiles: number
  minUses: number
  maxDepth: number
}

const flags = (n: ShapeNode): string =>
  `${n.conditional ? "?" : ""}${n.repeated ? "*" : ""}${n.opaque ? "~" : ""}`
const bare = (id: string): string => id.replace(/^component:/, "")

/**
 * The canonical form of a node and what is inside it, to a fixed depth: `card(card.header,card.body*)`.
 * `?` marks an element that may not render, `*` one that may render many times, `~` one whose children may be
 * incomplete. Two nodes with the same form have the same shape of design-system elements and nothing more.
 */
export function keyOf(node: ShapeNode, depth: number, maxDepth: number): string {
  const head = `${bare(node.id)}${flags(node)}`
  if (node.children.length === 0) return head
  if (depth >= maxDepth) return `${head}(…)`
  return `${head}(${node.children.map((c) => keyOf(c, depth + 1, maxDepth)).join(",")})`
}

function treeOf(node: ShapeNode, depth: number, maxDepth: number): ShapeTree {
  return {
    id: node.id,
    name: node.name,
    optional: node.conditional || node.repeated,
    opaque: node.opaque || (depth >= maxDepth && node.children.length > 0),
    children: depth >= maxDepth ? [] : node.children.map((c) => treeOf(c, depth + 1, maxDepth))
  }
}

interface Group {
  key: string
  nodes: Array<{ file: string; node: ShapeNode }>
}

const pos = (file: string, n: { line: number; column: number }): string => `${file}:${n.line}:${n.column}`

function parts(root: ShapeNode, maxDepth: number): Candidate["definition"]["composition"]["parts"] {
  const used = new Set<string>()
  const seen = new Map<string, "required" | "optional">()
  const order: ShapeNode[] = []
  const visit = (n: ShapeNode, depth: number): void => {
    const role = n.conditional || n.repeated ? "optional" : "required"
    const held = seen.get(n.id)
    if (held === undefined) {
      seen.set(n.id, role)
      order.push(n)
    } else if (role === "required") seen.set(n.id, "required")
    if (depth < maxDepth) for (const c of n.children) visit(c, depth + 1)
  }
  visit(root, 0)
  return order.map((n) => ({
    name: uniqueName(slug(n.name), used),
    ref: n.id,
    role: seen.get(n.id) as "required" | "optional"
  }))
}

/**
 * Method: exact structure. Every design-system element with something inside it is an arrangement; arrangements
 * with the same canonical form are grouped. A group that recurs in enough files and enough places is a
 * candidate. Nothing here compares meaning, so two arrangements are the same only if they are written the same.
 */
export function findArrangements(files: readonly FileShape[], options: ArrangementOptions): Candidate[] {
  const groups = new Map<string, Group>()
  for (const f of files)
    for (const node of walk(f.roots)) {
      if (node.children.length === 0) continue
      const key = keyOf(node, 0, options.maxDepth)
      const group = groups.get(key) ?? { key, nodes: [] }
      group.nodes.push({ file: f.file, node })
      groups.set(key, group)
    }

  const kept = [...groups.values()]
    .filter(
      (g) => g.nodes.length >= options.minUses && new Set(g.nodes.map((n) => n.file)).size >= options.minFiles
    )
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  const inside = new Map<string, Set<string>>()
  for (const g of kept) {
    const set = new Set<string>()
    for (const { file, node } of g.nodes) for (const d of walk(node.children)) set.add(pos(file, d))
    inside.set(g.key, set)
  }

  const taken = new Set<string>()
  const out: Candidate[] = kept.map((g) => {
    const first = g.nodes[0] as { file: string; node: ShapeNode }
    const fileCount = new Set(g.nodes.map((n) => n.file)).size
    const root = first.node
    const children = [...new Set(walk(root.children).map((c) => c.name))]
    const name = `${root.name} with ${listNames(children)}`
    const evidence: Occurrence[] = g.nodes.map(({ file, node }) => ({
      file,
      line: node.line,
      column: node.column,
      detail: `<${node.name}> containing ${listNames([...new Set(node.children.map((c) => c.name))])}`
    }))
    const capped = capEvidence(evidence)
    const guarded = g.key.includes("~")
    return {
      id: candidateId("arrangement", g.key, taken),
      kind: "arrangement",
      status: "proposed",
      basis: "inferred",
      equivalence: "not-established",
      suggestedName: name,
      nameSource: "derived",
      summary: `${root.name} containing ${listNames(children)}, written the same way ${g.nodes.length} times in ${fileCount} files.`,
      explanation: [
        `Every design-system element with something inside it was compared with the others by its canonical form, to a depth of ${options.maxDepth}. This form, ${g.key}, appears ${g.nodes.length} times in ${fileCount} files.`,
        "The form counts design-system elements only. Markup and components from elsewhere between them are ignored, so an element inside another may not be its direct child.",
        "This shows the arrangement recurs. It does not show it is intended, correct, or a standard anyone chose.",
        ...(guarded
          ? [
              "Some elements take their children from elsewhere (marked ~), so what is inside them may be incomplete."
            ]
          : [])
      ],
      support: { files: fileCount, occurrences: g.nodes.length },
      structure: {
        key: g.key,
        common: [],
        frequent: [],
        variable: [],
        variableTruncated: false,
        tree: treeOf(root, 0, options.maxDepth)
      },
      evidence: capped.evidence,
      evidenceTruncated: capped.truncated,
      definition: {
        name,
        category: "composition",
        description: `A recurring arrangement of ${listNames([root.name, ...children])}, found ${g.nodes.length} times in ${fileCount} files by invariant discover. Review before relying on it.`,
        composition: { parts: parts(root, options.maxDepth) }
      },
      derivation: {
        method: "exact-structure",
        version: 1,
        parameters: { minFiles: options.minFiles, minUses: options.minUses, maxDepth: options.maxDepth }
      }
    } satisfies Candidate
  })

  // A candidate whose every occurrence lies inside another's is the same finding seen from lower down. Say so,
  // and keep it.
  const byKey = new Map(kept.map((g, i) => [g.key, out[i] as Candidate]))
  for (const [i, g] of kept.entries()) {
    const mine = g.nodes.map((n) => pos(n.file, n.node))
    let best: Candidate | undefined
    for (const other of kept) {
      if (other.key === g.key) continue
      const set = inside.get(other.key) as Set<string>
      if (!mine.every((p) => set.has(p))) continue
      const candidate = byKey.get(other.key) as Candidate
      if (
        !best ||
        candidate.support.occurrences > best.support.occurrences ||
        (candidate.support.occurrences === best.support.occurrences && candidate.id < best.id)
      )
        best = candidate
    }
    if (best) (out[i] as Candidate).subsumedBy = best.id
  }
  return out.sort(
    (a, b) =>
      b.support.files - a.support.files ||
      b.support.occurrences - a.support.occurrences ||
      (a.structure.key < b.structure.key ? -1 : 1)
  )
}
