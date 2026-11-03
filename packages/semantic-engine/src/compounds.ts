import type { Component } from "@invariant/contract"
import { cmp, inferredFact } from "./infer.js"

const SAME_FILE = 0.7
const SAME_PACKAGE = 0.4

interface View {
  component: Component
  impls: Array<{ id: string; framework: string; packageName?: string; file?: string }>
}

function view(component: Component): View {
  return {
    component,
    impls: component.implementations.map((i) => {
      const ext = i.extensions?.[i.framework] as { file?: unknown } | undefined
      return {
        id: i.id,
        framework: i.framework,
        ...(i.packageName ? { packageName: i.packageName } : {}),
        ...(typeof ext?.file === "string" ? { file: ext.file } : {})
      }
    })
  }
}

/**
 * Compound components by naming and location: `DialogTrigger` and `DialogContent` next to `Dialog` in one
 * package. A parent needs at least two such children, and a child in the parent's own file is more likely
 * than one elsewhere in the package. Existing `contains` relationships are never repeated or changed.
 */
export function inferCompounds(components: readonly Component[]): Component[] {
  const views = components.map(view)
  const additions = new Map<
    string,
    Array<{ target: string; confidence: number; reasoning: string; evidenceIds: string[]; inputs: string[] }>
  >()

  for (const parent of views) {
    const candidates: Array<{ child: View; sameFile: boolean; parentImpl: string; childImpl: string }> = []
    for (const child of views) {
      if (child === parent) continue
      const rest = child.component.name.slice(parent.component.name.length)
      if (!child.component.name.startsWith(parent.component.name) || !/^[A-Z]/.test(rest)) continue
      for (const p of parent.impls) {
        const match = child.impls.find(
          (c) => c.framework === p.framework && c.packageName && c.packageName === p.packageName
        )
        if (!match) continue
        candidates.push({
          child,
          sameFile: Boolean(p.file && p.file === match.file),
          parentImpl: p.id,
          childImpl: match.id
        })
        break
      }
    }
    if (candidates.length < 2) continue
    const known = new Set(parent.component.composition.map((r) => `${r.type}\u0000${r.target}`))
    for (const c of candidates) {
      if (known.has(`contains\u0000${c.child.component.id}`)) continue
      const list = additions.get(parent.component.id) ?? []
      list.push({
        target: c.child.component.id,
        confidence: c.sameFile ? SAME_FILE : SAME_PACKAGE,
        reasoning: `${c.child.component.name} is named ${parent.component.name} plus a suffix, in the same package${c.sameFile ? " and the same file" : ""}, and ${parent.component.name} has ${candidates.length} such components`,
        evidenceIds: [
          ...(parent.component.facts[`implementations.${c.parentImpl}`]?.evidenceIds ?? []),
          ...(c.child.component.facts[`implementations.${c.childImpl}`]?.evidenceIds ?? [])
        ],
        inputs: [`implementations.${c.parentImpl}`, c.child.component.id]
      })
      additions.set(parent.component.id, list)
    }
  }

  return components.map((component) => {
    const add = additions.get(component.id)
    if (!add || add.length === 0) return component
    const sorted = [...add].sort((a, b) => cmp(a.target, b.target))
    const facts = { ...component.facts }
    const composition = [...component.composition]
    for (const a of sorted) {
      facts[`composition.${composition.length}`] = inferredFact({
        rule: "compound.name-prefix",
        confidence: a.confidence,
        reasoning: a.reasoning,
        inputs: a.inputs,
        evidenceIds: a.evidenceIds
      })
      composition.push({ type: "contains", target: a.target as Component["composition"][number]["target"] })
    }
    return {
      ...component,
      composition,
      facts: Object.fromEntries(Object.entries(facts).sort((a, b) => cmp(a[0], b[0])))
    }
  })
}
