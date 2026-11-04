import type { Tree } from "../pattern-rules.js"

/**
 * One design-system element in a file, placed under the nearest design-system element that encloses it. Markup
 * and components from elsewhere between the two are ignored, so an edge means "is inside", not "is the direct
 * child of". That is a deliberate simplification and every candidate says so.
 */
export interface ShapeNode {
  /** The contract's component id. */
  id: string
  name: string
  line: number
  column: number
  /** Inside a `{...}` expression that its design-system parent is not: it may not render. */
  conditional: boolean
  /** Inside a callback its design-system parent is not: it may render any number of times. */
  repeated: boolean
  /** Something other than the elements seen here may supply its children, so the list below may be incomplete. */
  opaque: boolean
  children: ShapeNode[]
}

export interface FileShape {
  file: string
  roots: ShapeNode[]
  /** Every JSX element in the file. */
  elements: number
  /** Elements the contract resolved to a design-system component. */
  designSystemElements: number
}

/** The design-system elements of one scanned file as a forest. Reads the scan only; nothing is evaluated. */
export function shapeOf(file: string, tree: Tree): FileShape {
  const nodes = new Map<number, ShapeNode>()
  const roots: ShapeNode[] = []
  const nearest = (index: number): number | undefined => {
    for (let p = tree.uses[index]?.parent; p !== undefined; p = tree.uses[p]?.parent)
      if (nodes.has(p)) return p
    return undefined
  }
  tree.uses.forEach((use, i) => {
    const component = tree.components[i]
    if (tree.kinds[i] !== "component" || !component) return
    const anchor = nearest(i)
    const above = anchor === undefined ? undefined : tree.uses[anchor]
    const node: ShapeNode = {
      id: component.id,
      name: component.name,
      line: use.line,
      column: use.column,
      conditional: above !== undefined && (use.exprDepth ?? 0) > (above.exprDepth ?? 0),
      repeated: above !== undefined && (use.loopDepth ?? 0) > (above.loopDepth ?? 0),
      opaque: use.opaque === true,
      children: []
    }
    nodes.set(i, node)
    if (anchor === undefined) roots.push(node)
    else nodes.get(anchor)?.children.push(node)
  })
  return { file, roots, elements: tree.uses.length, designSystemElements: nodes.size }
}

/** Every node of a forest, parents before children, in source order. */
export function walk(roots: readonly ShapeNode[]): ShapeNode[] {
  const out: ShapeNode[] = []
  const visit = (n: ShapeNode): void => {
    out.push(n)
    for (const c of n.children) visit(c)
  }
  for (const r of roots) visit(r)
  return out
}
