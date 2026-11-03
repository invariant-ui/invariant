import type { IrDocument, IrFact } from "@invariant/compiler-ir"
import { type CodeComponent, codeComponents } from "./code.js"
import { cmp, normalizeName, slug, unique } from "./util.js"

/** One implementation of a component in one source, with every fact its source states about it. */
export interface Implementation {
  code: CodeComponent
  doc: IrDocument
  facts: IrFact[]
  /** Contract implementation id, unique within the resolved component. */
  id: string
  packageName?: string
}

export interface IdentityLink {
  rule: string
  confidence: number
  reasoning: string
  /** IR refs of the implementations judged to be the same component. */
  inputs: string[]
  evidenceIds: string[]
}

export interface ResolvedComponent {
  id: string
  name: string
  implementations: Implementation[]
  /** Present when several implementations were merged by a name rule; absent for a single implementation. */
  identity?: IdentityLink
}

export interface IdentityAmbiguity {
  key: string
  candidates: Implementation[]
}

export interface Resolution {
  components: ResolvedComponent[]
  ambiguities: IdentityAmbiguity[]
}

const MIN_PREFIX_COMPONENTS = 3
const MAX_PREFIX_LENGTH = 5
const PREFIX_SHARE = 0.8

/**
 * A design-system prefix such as `Lds` in `LdsButton`: a short capitalized word that most components of one
 * source start with. Components that are the prefix itself prove nothing about it, so it is rejected then.
 */
export function sharedPrefix(names: readonly string[]): string | undefined {
  if (names.length < MIN_PREFIX_COMPONENTS) return undefined
  const counts = new Map<string, number>()
  for (const name of names) {
    const word = /^[A-Z][a-z0-9]*/.exec(name)?.[0]
    if (word && word.length >= 2 && word.length <= MAX_PREFIX_LENGTH && name.length > word.length)
      counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0]
  if (!best || best[1] / names.length < PREFIX_SHARE) return undefined
  return names.includes(best[0]) ? undefined : best[0]
}

/** The leading word of an Angular class name, when it equals the first word of the component's selector. */
function selectorPrefix(impl: Implementation): string | undefined {
  const selector = impl.facts.find((f) =>
    /^implementations\.angular\.extensions\.angular\.selector$/.test(f.path)
  )?.value
  if (typeof selector !== "string") return undefined
  const first = /^[a-z][a-z0-9]*/.exec(selector)?.[0]
  if (!first || selector === first) return undefined
  const lead = first.charAt(0).toUpperCase() + first.slice(1)
  return impl.code.name.startsWith(lead) && impl.code.name.length > lead.length ? lead : undefined
}

interface Keyed {
  impl: Implementation
  key: string
  via: "name" | "shared-prefix" | "selector-prefix"
  prefix?: string
}

function evidenceOf(impl: Implementation): string[] {
  const named = impl.facts.find((f) => f.path === "name") ?? impl.facts[0]
  return named ? named.evidenceIds : []
}

/**
 * Groups implementations into conceptual components. Same-framework implementations are never merged. Across
 * frameworks a merge needs an equal normalized name where each framework has exactly one candidate; otherwise
 * the match is reported as an ambiguity and nothing is merged.
 */
export function resolveComponents(docs: readonly IrDocument[]): Resolution {
  const factsByDoc = new Map<IrDocument, Map<string, IrFact[]>>()
  for (const doc of docs) {
    const map = new Map<string, IrFact[]>()
    for (const f of doc.facts) map.set(f.subject, [...(map.get(f.subject) ?? []), f])
    factsByDoc.set(doc, map)
  }
  const implementations: Implementation[] = []
  for (const code of codeComponents(docs)) {
    const doc = docs.find((d) => d.source.id === code.sourceId && d.entities.some((e) => e.ref === code.ref))
    if (!doc) continue
    const packageName = code.index.value<string>(code.ref, `implementations.${code.framework}.packageName`)
    implementations.push({
      code,
      doc,
      facts: factsByDoc.get(doc)?.get(code.ref) ?? [],
      id: "",
      ...(packageName ? { packageName } : {})
    })
  }
  implementations.sort((a, b) => cmp(a.code.sourceId, b.code.sourceId) || cmp(a.code.ref, b.code.ref))

  const prefixBySource = new Map<string, string | undefined>()
  for (const sourceId of unique(implementations.map((i) => i.code.sourceId)))
    prefixBySource.set(
      sourceId,
      sharedPrefix(implementations.filter((i) => i.code.sourceId === sourceId).map((i) => i.code.name))
    )

  const keyed: Keyed[] = implementations.map((impl) => {
    const prefix = prefixBySource.get(impl.code.sourceId)
    if (prefix && impl.code.name.startsWith(prefix) && impl.code.name.length > prefix.length)
      return { impl, key: normalizeName(impl.code.name.slice(prefix.length)), via: "shared-prefix", prefix }
    const fromSelector = selectorPrefix(impl)
    if (fromSelector)
      return {
        impl,
        key: normalizeName(impl.code.name.slice(fromSelector.length)),
        via: "selector-prefix",
        prefix: fromSelector
      }
    return { impl, key: normalizeName(impl.code.name), via: "name" }
  })

  const groups = new Map<string, Keyed[]>()
  for (const k of keyed) groups.set(k.key, [...(groups.get(k.key) ?? []), k])

  const resolved: Array<{ name: string; members: Implementation[]; identity?: IdentityLink }> = []
  const ambiguities: IdentityAmbiguity[] = []
  for (const [key, members] of [...groups.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    const frameworks = unique(members.map((m) => m.impl.code.framework))
    const perFramework = frameworks.map((f) => members.filter((m) => m.impl.code.framework === f).length)
    if (frameworks.length === 1) {
      for (const m of members) resolved.push({ name: m.impl.code.name, members: [m.impl] })
      continue
    }
    if (perFramework.some((n) => n > 1)) {
      ambiguities.push({ key, candidates: members.map((m) => m.impl) })
      for (const m of members) resolved.push({ name: m.impl.code.name, members: [m.impl] })
      continue
    }
    const usedPrefix = members.some((m) => m.via !== "name")
    const rule = usedPrefix ? "name-match.stripped-prefix" : "name-match.exact"
    const confidence = usedPrefix ? 0.75 : 0.9
    const names = members.map((m) => m.impl.code.name)
    const display = [...members].sort(
      (a, b) => a.impl.code.name.length - b.impl.code.name.length || cmp(a.impl.code.ref, b.impl.code.ref)
    )[0]
    resolved.push({
      name: display?.impl.code.name ?? names[0] ?? key,
      members: members.map((m) => m.impl),
      identity: {
        rule,
        confidence,
        reasoning: usedPrefix
          ? `${names.join(", ")} are in different frameworks and share the name "${key}" once the prefix ${unique(members.flatMap((m) => (m.prefix ? [`"${m.prefix}"`] : []))).join(", ")} is removed`
          : `${names.join(", ")} are in different frameworks and share the name "${key}" ignoring case and separators`,
        inputs: members.map((m) => m.impl.code.ref).sort(),
        evidenceIds: unique(members.flatMap((m) => evidenceOf(m.impl))).sort()
      }
    })
  }

  return { components: assignIds(resolved), ambiguities }
}

function assignIds(
  resolved: Array<{ name: string; members: Implementation[]; identity?: IdentityLink }>
): ResolvedComponent[] {
  const byBase = new Map<string, number>()
  for (const r of resolved) byBase.set(slug(r.name), (byBase.get(slug(r.name)) ?? 0) + 1)
  const used = new Set<string>()
  const out: ResolvedComponent[] = []
  for (const r of [...resolved].sort((a, b) =>
    cmp(a.members[0]?.code.ref ?? "", b.members[0]?.code.ref ?? "")
  )) {
    const base = slug(r.name)
    const pkg = r.members.find((m) => m.packageName)?.packageName
    let id = `component:${(byBase.get(base) ?? 0) > 1 && pkg ? `${base}.${slug(pkg)}` : base}`
    for (let n = 2; used.has(id); n++) id = `component:${base}-${n}`
    used.add(id)
    out.push({
      id,
      name: r.name,
      implementations: assignImplementationIds(r.members),
      ...(r.identity ? { identity: r.identity } : {})
    })
  }
  return out.sort((a, b) => cmp(a.id, b.id))
}

function assignImplementationIds(members: Implementation[]): Implementation[] {
  const used = new Set<string>()
  return members.map((m) => {
    let id = slug(m.code.framework)
    if (used.has(id)) id = slug(`${m.code.framework}-${m.code.sourceId}`)
    for (let n = 2; used.has(id); n++) id = slug(`${m.code.framework}-${m.code.sourceId}-${n}`)
    used.add(id)
    return { ...m, id }
  })
}
