import type { Diagnostic } from "@invariant/shared"
import { checkArchetypes, checkVariations } from "./archetype-checks.js"
import type { Contract } from "./contract.js"
import type { Pattern } from "./knowledge.js"
import {
  ACYCLIC_RELATIONSHIPS,
  constraintDetailsSchemas,
  isPatternConstraintKind,
  PATTERN_CATEGORIES_1_1,
  PATTERN_CONSTRAINT_KINDS,
  PATTERN_ONLY_RELATIONSHIPS
} from "./patterns.js"

type Report = (code: string, message: string, entityId?: string) => void
const duplicates = (names: readonly string[]): string[] => [
  ...new Set(names.filter((n, i) => names.indexOf(n) !== i))
]

/** Where a constraint's `details` point at components and patterns, as entity ids (region refs are local). */
export function constraintReferences(contract: Contract): Array<{ from: string; to: string }> {
  const refs: Array<{ from: string; to: string }> = []
  for (const c of contract.constraints) {
    if (!isPatternConstraintKind(c.kind)) continue
    const parsed = constraintDetailsSchemas[c.kind].safeParse(c.details)
    if (!parsed.success) continue
    // Only component and pattern ids are references; other strings (a workflow name, a minimum) are not.
    for (const value of stringsIn(parsed.data))
      if (/^(?:component|pattern):/.test(value)) refs.push({ from: c.id, to: value })
  }
  return refs
}

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsIn)
  return []
}

/** Entity ids a pattern points at, with the fact path that holds the claim. */
export function patternReferences(contract: Contract): Array<{ from: string; to: string }> {
  const refs: Array<{ from: string; to: string }> = []
  for (const p of contract.patterns) {
    for (const part of p.composition?.parts ?? []) refs.push({ from: p.id, to: part.ref })
    for (const v of p.variations ?? [])
      for (const part of v.parts ?? []) refs.push({ from: p.id, to: part.ref })
    for (const rel of p.relationships ?? []) refs.push({ from: p.id, to: rel.target })
    for (const id of p.constraints ?? []) refs.push({ from: p.id, to: id })
    for (const region of p.layout?.regions ?? []) {
      for (const target of region.accepts ?? []) refs.push({ from: p.id, to: target })
      if (region.spacing) refs.push({ from: p.id, to: region.spacing })
      if (region.grid?.gap) refs.push({ from: p.id, to: region.grid.gap })
      for (const r of region.responsive ?? []) refs.push({ from: p.id, to: r.breakpoint })
    }
  }
  return refs
}

/** Things a 1.0.0 document cannot contain. Returns one reason per offending entity. */
export function newInOnePointOne(contract: Contract): Array<{ entityId: string; reason: string }> {
  const out: Array<{ entityId: string; reason: string }> = []
  const newCategories: readonly string[] = PATTERN_CATEGORIES_1_1
  const newKinds: readonly string[] = PATTERN_CONSTRAINT_KINDS
  for (const p of contract.patterns) {
    const fields = (
      [
        "intent",
        "composition",
        "layout",
        "behavior",
        "accessibility",
        "relationships",
        "constraints",
        "variations",
        "appliesTo",
        "inheritsConstraints"
      ] as const
    ).filter((f) => p[f] !== undefined)
    if (fields.length > 0) out.push({ entityId: p.id, reason: `uses ${fields.join(", ")}` })
    if (newCategories.includes(p.category))
      out.push({ entityId: p.id, reason: `has category "${p.category}"` })
  }
  for (const c of contract.constraints)
    if (newKinds.includes(c.kind)) out.push({ entityId: c.id, reason: `has kind "${c.kind}"` })
  return out
}

/**
 * Semantic checks for pattern contracts: unique names, region and state-machine integrity, relationship rules,
 * cycles, and the typed details of structural constraints. References to other entities are checked with the
 * rest of the contract by `entityReferences`.
 */
export function checkPatterns(contract: Contract, error: Report, found: Diagnostic[]): void {
  const warn = (code: string, message: string, entityId: string): void => {
    found.push({ code, severity: "warning", message, entityId })
  }
  const ownedConstraints = new Map<string, Pattern>()
  for (const p of contract.patterns) for (const id of p.constraints ?? []) ownedConstraints.set(id, p)

  for (const p of contract.patterns) {
    checkNames(p, error)
    checkRegions(p, error)
    checkBehavior(p, error, warn)
    checkRelationships(p, error)
    checkVariations(p, error)
  }
  checkConstraints(contract, ownedConstraints, error)
  checkCycles(contract, error)
  checkArchetypes(contract, error, warn)
}

function checkNames(p: Pattern, error: Report): void {
  const groups: Array<[string, string[]]> = [
    ["region", (p.layout?.regions ?? []).map((r) => r.name)],
    ["composition part", (p.composition?.parts ?? []).map((x) => x.name)],
    ["state", (p.behavior?.states ?? []).map((s) => s.name)],
    ["transition", (p.behavior?.transitions ?? []).map((t) => t.id)],
    ["relationship", (p.relationships ?? []).map((r) => r.id)],
    ["accessibility requirement", (p.accessibility?.requirements ?? []).map((r) => r.id)]
  ]
  for (const [what, names] of groups)
    for (const name of duplicates(names))
      error("contract.pattern-duplicate-name", `${p.id} has more than one ${what} named "${name}"`, p.id)
}

function checkRegions(p: Pattern, error: Report): void {
  const regions = p.layout?.regions ?? []
  const names = new Set(regions.map((r) => r.name))
  for (const r of regions) {
    if (r.parent !== undefined && !names.has(r.parent))
      error(
        "contract.pattern-region-unknown",
        `${p.id} region "${r.name}" has unknown parent "${r.parent}"`,
        p.id
      )
  }
  const parentOf = new Map(regions.map((r) => [r.name, r.parent]))
  for (const r of regions) {
    const seen = new Set<string>([r.name])
    for (let at = r.parent; at !== undefined; at = parentOf.get(at)) {
      if (seen.has(at)) {
        error("contract.pattern-region-cycle", `${p.id} region "${r.name}" is its own ancestor`, p.id)
        break
      }
      seen.add(at)
    }
  }
  for (const part of p.composition?.parts ?? []) {
    if (part.region !== undefined && !names.has(part.region))
      error(
        "contract.pattern-region-unknown",
        `${p.id} part "${part.name}" is placed in unknown region "${part.region}"`,
        p.id
      )
  }
}

function checkBehavior(p: Pattern, error: Report, warn: (c: string, m: string, id: string) => void): void {
  const b = p.behavior
  if (!b) return
  const states = new Set(b.states.map((s) => s.name))
  if (!states.has(b.initial))
    error("contract.pattern-state-unknown", `${p.id} initial state "${b.initial}" is not a state`, p.id)
  for (const t of b.transitions)
    for (const end of [t.from, t.to])
      if (!states.has(end))
        error(
          "contract.pattern-state-unknown",
          `${p.id} transition "${t.id}" uses unknown state "${end}"`,
          p.id
        )
  const reached = new Set<string>(states.has(b.initial) ? [b.initial] : [])
  for (let grew = true; grew; ) {
    grew = false
    for (const t of b.transitions)
      if (reached.has(t.from) && states.has(t.to) && !reached.has(t.to)) {
        reached.add(t.to)
        grew = true
      }
  }
  for (const name of states)
    if (!reached.has(name) && states.has(b.initial))
      warn(
        "contract.pattern-unreachable-state",
        `${p.id} state "${name}" cannot be reached from "${b.initial}"`,
        p.id
      )
}

function checkRelationships(p: Pattern, error: Report): void {
  const seen = new Set<string>()
  for (const rel of p.relationships ?? []) {
    if (rel.target === p.id)
      error("contract.pattern-self-relationship", `${p.id} has a ${rel.type} relationship to itself`, p.id)
    if (
      (PATTERN_ONLY_RELATIONSHIPS as readonly string[]).includes(rel.type) &&
      !rel.target.startsWith("pattern:")
    )
      error(
        "contract.pattern-relationship-target",
        `${p.id} relationship "${rel.id}" (${rel.type}) must target a pattern, not ${rel.target}`,
        p.id
      )
    const key = `${rel.type} ${rel.target}`
    if (seen.has(key))
      error("contract.pattern-duplicate-relationship", `${p.id} repeats ${rel.type} ${rel.target}`, p.id)
    seen.add(key)
  }
}

function checkConstraints(contract: Contract, owned: Map<string, Pattern>, error: Report): void {
  for (const c of contract.constraints) {
    if (!isPatternConstraintKind(c.kind)) continue
    const parsed = constraintDetailsSchemas[c.kind].safeParse(c.details)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      error(
        "contract.constraint-details-invalid",
        `${c.id} (${c.kind}) has invalid details at ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "schema error"}`,
        c.id
      )
      continue
    }
    const regions = stringsIn(parsed.data).filter((v) => v.startsWith("region:"))
    if (regions.length === 0) continue
    const pattern = owned.get(c.id)
    if (!pattern) {
      error(
        "contract.pattern-region-unknown",
        `${c.id} refers to ${regions.join(", ")}, but no pattern owns the constraint`,
        c.id
      )
      continue
    }
    const known = new Set((pattern.layout?.regions ?? []).map((r) => `region:${r.name}`))
    for (const region of regions)
      if (!known.has(region))
        error(
          "contract.pattern-region-unknown",
          `${c.id} refers to ${region}, which ${pattern.id} does not define`,
          c.id
        )
  }
}

/** Patterns pointing at patterns through the relationship types that nest or depend, and through composition parts. */
function edges(contract: Contract): Map<string, string[]> {
  const ids = new Set(contract.patterns.map((p) => p.id as string))
  const graph = new Map<string, string[]>()
  for (const p of contract.patterns) {
    const out = new Set<string>()
    for (const rel of p.relationships ?? [])
      if ((ACYCLIC_RELATIONSHIPS as readonly string[]).includes(rel.type) && ids.has(rel.target))
        out.add(rel.target)
    for (const part of [
      ...(p.composition?.parts ?? []),
      ...(p.variations ?? []).flatMap((v) => v.parts ?? [])
    ])
      if (part.role !== "prohibited" && ids.has(part.ref)) out.add(part.ref)
    graph.set(p.id, [...out].sort())
  }
  return graph
}

function checkCycles(contract: Contract, error: Report): void {
  const graph = edges(contract)
  const state = new Map<string, "open" | "done">()
  const reported = new Set<string>()
  const visit = (id: string, path: string[]): void => {
    state.set(id, "open")
    for (const next of graph.get(id) ?? []) {
      if (next === id) continue // reported as a self-relationship
      if (state.get(next) === "open") {
        const cycle = [...path.slice(path.indexOf(next)), id].filter((_, i, a) => i < a.length)
        const start = cycle.indexOf([...cycle].sort()[0] as string)
        const normal = [...cycle.slice(start), ...cycle.slice(0, start)]
        const key = normal.join(" > ")
        if (!reported.has(key)) {
          reported.add(key)
          error(
            "contract.pattern-cycle",
            `Patterns form a cycle: ${[...normal, normal[0]].join(" -> ")}`,
            normal[0]
          )
        }
      } else if (state.get(next) === undefined) visit(next, [...path, id])
    }
    state.set(id, "done")
  }
  for (const id of [...graph.keys()].sort()) if (state.get(id) === undefined) visit(id, [])
}
