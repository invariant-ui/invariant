import type { Contract } from "./contract.js"
import type { Pattern } from "./knowledge.js"

/*
 * Checks that read a pattern as a page blueprint: variations, and what it composes, followed through the
 * patterns it uses, to any depth. Cycles are reported separately (`contract.pattern-cycle`); the walks here
 * stop at a pattern they have already seen, so a cycle cannot make them loop.
 */

type Report = (code: string, message: string, entityId?: string) => void
type Warn = (code: string, message: string, entityId: string) => void
type Role = "required" | "optional" | "prohibited"

export interface EffectivePart {
  name: string
  ref: string
  role: Role
  region?: string | undefined
}

/** The parts of a pattern, with a variation's role changes and additions applied. */
export function effectiveParts(p: Pattern, variationId?: string): EffectivePart[] {
  const base: EffectivePart[] = (p.composition?.parts ?? []).map((x) => ({
    name: x.name,
    ref: x.ref,
    role: x.role,
    region: x.region
  }))
  const v = variationId === undefined ? undefined : p.variations?.find((x) => x.name === variationId)
  if (!v) return base
  const roles = new Map((v.roles ?? []).map((r) => [r.part, r.role]))
  return [
    ...base.map((x) => ({ ...x, role: roles.get(x.name) ?? x.role })),
    ...(v.parts ?? []).map((x) => ({ name: x.name, ref: x.ref, role: x.role, region: x.region }))
  ]
}

const COMPOSING = new Set(["composes", "contains", "uses", "requires"])

/** Patterns a pattern builds on: its non-prohibited parts that are patterns, and what it composes or contains. */
function uses(p: Pattern, parts: readonly EffectivePart[]): string[] {
  const out = new Set<string>()
  for (const x of parts) if (x.role !== "prohibited" && x.ref.startsWith("pattern:")) out.add(x.ref)
  for (const r of p.relationships ?? [])
    if (COMPOSING.has(r.type) && r.target.startsWith("pattern:")) out.add(r.target)
  return [...out].sort()
}

/**
 * Everything reachable from a pattern's effective parts, with the chain of patterns that leads to it. Patterns
 * (and the components their parts name) are both included. Nested patterns contribute their base composition.
 */
function reach(
  byId: ReadonlyMap<string, Pattern>,
  root: Pattern,
  parts: readonly EffectivePart[]
): { patterns: Map<string, string[]>; refs: Map<string, string[]> } {
  const patterns = new Map<string, string[]>()
  const refs = new Map<string, string[]>()
  const seen = new Set<string>([root.id])
  const walk = (p: Pattern, ps: readonly EffectivePart[], chain: string[]): void => {
    for (const x of ps) if (x.role !== "prohibited" && !refs.has(x.ref)) refs.set(x.ref, chain)
    for (const next of uses(p, ps)) {
      if (!refs.has(next)) refs.set(next, chain)
      if (seen.has(next)) continue
      seen.add(next)
      const n = byId.get(next)
      if (!n) continue
      patterns.set(next, [...chain, next])
      walk(n, effectiveParts(n), [...chain, next])
    }
  }
  walk(root, parts, [root.id])
  return { patterns, refs }
}

const label = (v: string | undefined): string => (v === undefined ? "" : ` in variation "${v}"`)

/** A variation changes real parts, adds uniquely named ones, and places them in real regions. */
export function checkVariations(p: Pattern, error: Report): void {
  const base = new Set((p.composition?.parts ?? []).map((x) => x.name))
  const regions = new Set((p.layout?.regions ?? []).map((r) => r.name))
  const names = (p.variations ?? []).map((v) => v.name)
  for (const name of new Set(names.filter((x, i) => names.indexOf(x) !== i)))
    error("contract.pattern-duplicate-name", `${p.id} has more than one variation named "${name}"`, p.id)
  for (const v of p.variations ?? []) {
    const changed = new Set<string>()
    for (const r of v.roles ?? []) {
      if (!base.has(r.part))
        error(
          "contract.pattern-variation-unknown-part",
          `${p.id} variation "${v.name}" changes part "${r.part}", which the composition does not have`,
          p.id
        )
      if (changed.has(r.part))
        error(
          "contract.pattern-duplicate-name",
          `${p.id} variation "${v.name}" changes part "${r.part}" twice`,
          p.id
        )
      changed.add(r.part)
    }
    const added = new Set<string>()
    for (const x of v.parts ?? []) {
      if (base.has(x.name) || added.has(x.name))
        error(
          "contract.pattern-duplicate-name",
          `${p.id} variation "${v.name}" adds a part named "${x.name}", which already exists`,
          p.id
        )
      added.add(x.name)
      if (x.region !== undefined && !regions.has(x.region))
        error(
          "contract.pattern-region-unknown",
          `${p.id} variation "${v.name}" places part "${x.name}" in unknown region "${x.region}"`,
          p.id
        )
    }
  }
}

/**
 * Follows what each pattern composes, through the patterns it uses, and reports what cannot hold together:
 * two patterns declared prohibited together that one blueprint composes, a part a blueprint prohibits that
 * something it composes brings back, a pattern that another supersedes, and a required region nothing fills.
 * Each pattern is checked as written and once per variation.
 */
export function checkArchetypes(contract: Contract, error: Report, warn: Warn): void {
  const byId = new Map<string, Pattern>(contract.patterns.map((p) => [p.id, p]))
  const supersededBy = new Map<string, string>()
  for (const p of contract.patterns)
    for (const r of p.relationships ?? []) if (r.type === "supersedes") supersededBy.set(r.target, p.id)
  const reported = new Set<string>()
  const once = (key: string, fn: () => void): void => {
    if (reported.has(key)) return
    reported.add(key)
    fn()
  }

  for (const p of contract.patterns) {
    const ids: Array<string | undefined> = [undefined, ...(p.variations ?? []).map((v) => v.name)]
    for (const variation of ids) {
      const parts = effectiveParts(p, variation)
      const { patterns, refs } = reach(byId, p, parts)
      const inside = new Set<string>([p.id, ...patterns.keys()])

      for (const id of inside) {
        const x = byId.get(id)
        for (const rel of x?.relationships ?? []) {
          if (rel.type !== "prohibited-with" || rel.target === id || !inside.has(rel.target)) continue
          const [a, b] = [id, rel.target].sort() as [string, string]
          // Base first: a pair already reported for the blueprint as written is not repeated for its variations.
          once(`${p.id}|${a}+${b}`, () =>
            error(
              "contract.pattern-prohibited-combination",
              `${p.id}${label(variation)} composes both ${a} and ${b}, which are prohibited together (${id} prohibited-with ${rel.target})`,
              p.id
            )
          )
        }
      }

      for (const part of parts) {
        if (part.role !== "prohibited") continue
        const chain = refs.get(part.ref)
        // A part is a slot: another slot of the same pattern using the same component is not a conflict. Only what
        // a composed pattern brings in is.
        if (chain === undefined || chain.length < 2) continue
        once(`${p.id}|prohibits|${part.ref}|${part.name}`, () =>
          error(
            "contract.pattern-prohibited-conflict",
            `${p.id}${label(variation)} prohibits ${part.ref} (part "${part.name}"), but ${chain.join(" -> ")} brings it in`,
            p.id
          )
        )
      }

      if (variation === undefined)
        for (const target of [...refs.keys()].filter((r) => r.startsWith("pattern:"))) {
          const by = supersededBy.get(target)
          if (by !== undefined && by !== p.id)
            once(`${p.id}|superseded|${target}`, () =>
              warn(
                "contract.pattern-superseded-reference",
                `${p.id} builds on ${target}, which ${by} supersedes`,
                p.id
              )
            )
        }
    }

    if (p.inheritsConstraints === true) {
      if (!p.appliesTo?.paths)
        error(
          "contract.pattern-inheritance-unscoped",
          `${p.id} inherits constraints but names no appliesTo.paths, so there is no way to know which files to hold to them`,
          p.id
        )
      if (!p.composition)
        warn(
          "contract.pattern-inheritance-empty",
          `${p.id} inherits constraints but composes nothing, so there is nothing to inherit`,
          p.id
        )
    }

    if (p.layout && p.composition)
      for (const r of p.layout.regions) {
        if (!r.required) continue
        if (!p.composition.parts.some((x) => x.role !== "prohibited" && x.region === r.name))
          warn(
            "contract.pattern-region-unfilled",
            `${p.id} requires region "${r.name}", but no composition part is placed in it`,
            p.id
          )
      }
  }
}
