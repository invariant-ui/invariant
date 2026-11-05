import type { ShapeTree } from "@invariant/validation"

export interface StarterRule {
  id: string
  kind: "required-child" | "ordering"
  description: string
  details: Record<string, string>
  enforce: { severity: "warning"; enforcement: "warn" }
}

const MAX_RULES = 6

const slug = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

const idOf = (...parts: string[]): string => parts.join("-").slice(0, 60).replace(/-+$/, "")

/**
 * Rules that restate what an observed arrangement already does every time, so they are true of the code that was
 * observed and can be checked against the rest: a parent contains the children it always had, and its children come in
 * the order they always did. Optional children, repeated children and parents whose children may come from elsewhere
 * give no rule, because their absence or order was never consistent. All rules are warnings: they annotate, they do not
 * fail a build, until a person raises them.
 */
export function starterRules(tree: ShapeTree | undefined): StarterRule[] {
  if (!tree) return []
  const rules: StarterRule[] = []
  const seen = new Set<string>()
  const add = (rule: StarterRule): void => {
    if (seen.has(rule.id) || rules.length >= MAX_RULES) return
    seen.add(rule.id)
    rules.push(rule)
  }
  const visit = (node: ShapeTree): void => {
    if (!node.opaque) {
      const fixed = node.children.filter((c) => !c.optional)
      for (const child of fixed)
        add({
          id: idOf(slug(node.name), "has", slug(child.name)),
          kind: "required-child",
          description: `A ${node.name} contains a ${child.name}.`,
          details: { parent: node.id, child: child.id },
          enforce: { severity: "warning", enforcement: "warn" }
        })
      for (let i = 0; i + 1 < fixed.length; i++) {
        const before = fixed[i] as ShapeTree
        const after = fixed[i + 1] as ShapeTree
        if (before.id === after.id) continue
        add({
          id: idOf(slug(before.name), "before", slug(after.name)),
          kind: "ordering",
          description: `In a ${node.name}, ${before.name} comes before ${after.name}.`,
          details: { before: before.id, after: after.id, within: node.id },
          enforce: { severity: "warning", enforcement: "warn" }
        })
      }
    }
    for (const child of node.children) visit(child)
  }
  visit(tree)
  return rules
}
