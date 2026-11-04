import { effectiveParts, isPatternConstraintKind, type Pattern } from "@invariant/contract"
import type { JsonValue } from "@invariant/shared"
import { patternStatus } from "./patterns.js"
import { cmp, type DesignSystem } from "./system.js"

type Json = Record<string, JsonValue>

const MAX_DEPTH = 6
const COMPOSING = new Set(["composes", "contains", "uses", "requires"])

export type ArchetypeResult = { ok: true; view: Json } | { ok: false; message: string; variations: string[] }

const kindOf = (id: string): string => id.slice(0, Math.max(0, id.indexOf(":")))

function describe(ds: DesignSystem, id: string): Json {
  const name = ds.component(id)?.name ?? ds.pattern(id)?.name
  return { id, kind: kindOf(id), ...(name ? { name } : {}) }
}

function summary(p: Pattern): Json {
  const s = patternStatus(p)
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    status: s.overall,
    approved: s.overall === "approved"
  }
}

/**
 * A pattern read as a page blueprint: what it is made of, followed through the patterns it composes to any depth,
 * its regions, variations, required interaction states, responsive expectations and prohibited combinations, and
 * how much of it is approved. A variation, when named, is applied to the pattern's own composition (patterns it
 * composes contribute their base composition).
 */
export function archetypeView(
  ds: DesignSystem,
  root: Pattern,
  options: { variation?: string | undefined } = {}
): ArchetypeResult {
  const names = (root.variations ?? []).map((v) => v.name)
  if (options.variation !== undefined && !names.includes(options.variation))
    return {
      ok: false,
      message: `${root.id} has no variation "${options.variation}"${names.length > 0 ? `; its variations are ${names.join(", ")}` : " (it has none)"}`,
      variations: names
    }

  const members = new Map<string, { pattern: Pattern; depth: number; via: string }>()
  const missing = new Set<string>()
  let truncated = false

  const node = (p: Pattern, variation: string | undefined, trail: readonly string[], depth: number): Json => {
    const parts = effectiveParts(p, variation)
    const seen = new Set<string>()
    const expand = (ref: string, via: string): Json | undefined => {
      if (!ref.startsWith("pattern:")) return undefined
      const n = ds.pattern(ref)
      if (!n) {
        missing.add(ref)
        return undefined
      }
      if (trail.includes(ref) || ref === p.id) return { cycle: true }
      if (depth + 1 >= MAX_DEPTH) {
        truncated = true
        return { truncated: true }
      }
      const known = members.get(ref)
      if (!known || known.depth > depth + 1) members.set(ref, { pattern: n, depth: depth + 1, via })
      return node(n, undefined, [...trail, p.id], depth + 1)
    }
    const rendered = parts.map((x) => {
      seen.add(x.ref)
      const expanded = x.role === "prohibited" ? undefined : expand(x.ref, `${p.id} part ${x.name}`)
      return {
        name: x.name,
        role: x.role,
        ...(x.region ? { region: x.region } : {}),
        ref: describe(ds, x.ref),
        ...(expanded ? { expanded } : {})
      } as Json
    })
    const related = (p.relationships ?? [])
      .filter((r) => COMPOSING.has(r.type))
      .map((r) => {
        const expanded = seen.has(r.target) ? undefined : expand(r.target, `${p.id} ${r.type}`)
        return {
          id: r.id,
          type: r.type,
          target: describe(ds, r.target),
          ...(expanded ? { expanded } : {})
        } as Json
      })
    return { pattern: summary(p), parts: rendered, related }
  }

  members.set(root.id, { pattern: root, depth: 0, via: "the archetype itself" })
  const tree = node(root, options.variation, [], 0)
  const set = [...members.values()].sort((a, b) => a.depth - b.depth || cmp(a.pattern.id, b.pattern.id))

  const constraints = set.flatMap(({ pattern }) =>
    (pattern.constraints ?? []).flatMap((id) => {
      const c = ds.contract.constraints.find((x) => x.id === id)
      if (!c) return []
      const enforcedBy = ds.contract.policies.filter((p) => p.basedOn.includes(c.id)).map((p) => p.id)
      return [{ pattern, constraint: c, enforcedBy }]
    })
  )
  const requiredStates = constraints
    .filter((x) => x.constraint.kind === "required-state")
    .map(({ pattern, constraint, enforcedBy }) => {
      const d = (constraint.details ?? {}) as { workflow?: string; state?: string; minimum?: string }
      return {
        pattern: pattern.id,
        constraint: constraint.id,
        workflow: d.workflow ?? null,
        state: d.state ?? null,
        minimum: d.minimum ?? "structural",
        enforced: enforcedBy.length > 0,
        enforcedBy
      } as Json
    })
  const structural = constraints
    .filter((x) => x.constraint.kind !== "required-state" && isPatternConstraintKind(x.constraint.kind))
    .map(({ pattern, constraint, enforcedBy }) => ({
      pattern: pattern.id,
      constraint: constraint.id,
      kind: constraint.kind,
      enforced: enforcedBy.length > 0,
      enforcedBy
    }))

  const responsive = set.flatMap(({ pattern }) =>
    (pattern.layout?.regions ?? []).flatMap((r) =>
      (r.responsive ?? []).map((x) => ({
        pattern: pattern.id,
        region: r.name,
        breakpoint: x.breakpoint,
        behavior: x.behavior
      }))
    )
  )
  const parts = effectiveParts(root, options.variation)
  const regions = (root.layout?.regions ?? []).map((r) => ({
    name: r.name,
    required: r.required,
    ...(r.parent ? { parent: r.parent } : {}),
    parts: parts.filter((x) => x.region === r.name && x.role !== "prohibited").map((x) => x.name),
    ...(r.responsive ? { responsive: r.responsive } : {})
  }))
  const variations = (root.variations ?? []).map((v) => ({
    name: v.name,
    ...(v.description ? { description: v.description } : {}),
    ...(v.when ? { when: v.when } : {}),
    roles: (v.roles ?? []) as unknown as JsonValue,
    addedParts: (v.parts ?? []).map((x) => ({ name: x.name, role: x.role, ref: describe(ds, x.ref) })),
    fact: (ds.factView(root.facts, `variations.${v.name}`) as unknown as JsonValue) ?? null
  }))
  const inSet = new Set(set.map((x) => x.pattern.id as string))
  const prohibitedTogether = set.flatMap(({ pattern }) =>
    (pattern.relationships ?? [])
      .filter((r) => r.type === "prohibited-with")
      .map((r) => ({ pattern: pattern.id, with: r.target, composedHere: inSet.has(r.target) }))
  )

  const unapproved = set.filter((x) => !summary(x.pattern).approved)
  const rootStatus = patternStatus(root)
  const notes: string[] = []
  if (rootStatus.overall !== "approved")
    notes.push(`This archetype is not fully approved (${rootStatus.overall}). Treat it as a proposal.`)
  const nested = unapproved.filter((x) => x.pattern.id !== root.id)
  if (rootStatus.overall === "approved" && nested.length > 0)
    notes.push(
      `This archetype is approved, but ${nested.length} pattern(s) it builds on are not: ${nested.map((x) => x.pattern.id).join(", ")}. Approval of the archetype does not approve them.`
    )
  if (missing.size > 0)
    notes.push(`It refers to pattern(s) the contract does not have: ${[...missing].sort(cmp).join(", ")}.`)
  if (truncated) notes.push(`Composition was followed ${MAX_DEPTH} levels deep and then stopped.`)
  const unenforced =
    requiredStates.filter((x) => x.enforced !== true).length + structural.filter((x) => !x.enforced).length
  if (constraints.length > 0 && unenforced > 0)
    notes.push(`${unenforced} constraint(s) have no approved policy, so \`validate\` does not enforce them.`)
  if (options.variation)
    notes.push(`Showing the "${options.variation}" variation. Patterns it composes are shown as written.`)

  return {
    ok: true,
    view: {
      id: root.id,
      name: root.name,
      category: root.category,
      ...(root.intent ? { intent: root.intent } : {}),
      ...(options.variation ? { variation: options.variation } : {}),
      status: { overall: rootStatus.overall, counts: rootStatus.counts as Json, total: rootStatus.total },
      approved: rootStatus.overall === "approved",
      regions,
      composition: tree,
      patterns: set.map((x) => ({ ...summary(x.pattern), depth: x.depth, via: x.via })),
      unapproved: unapproved.map((x) => x.pattern.id),
      variations,
      prohibited: {
        parts: parts
          .filter((x) => x.role === "prohibited")
          .map((x) => ({ name: x.name, ref: describe(ds, x.ref) })),
        patterns: prohibitedTogether
      },
      requiredStates,
      constraints: structural,
      responsive,
      notes
    } as Json
  }
}
