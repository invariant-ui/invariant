import type { Evidence, FactRecord, Pattern, Policy } from "@invariant/contract"
import type { JsonValue } from "@invariant/shared"
import { search } from "./search.js"
import { cmp, type DesignSystem, type FactView } from "./system.js"
import { page } from "./views.js"

type Json = Record<string, JsonValue>

export type PatternStatus = FactRecord["status"] | "mixed" | "none"

/**
 * What is known about a pattern, derived from its facts. There is no stored pattern status (ADR 0002): a single
 * field could disagree with the facts it summarizes. A pattern with no facts has no stated basis (`none`); one
 * whose facts share a status has that status; otherwise it is `mixed`. Only `approved` means every fact is.
 */
export function patternStatus(p: Pick<Pattern, "facts">): {
  overall: PatternStatus
  counts: Partial<Record<FactRecord["status"], number>>
  total: number
} {
  const counts: Partial<Record<FactRecord["status"], number>> = {}
  for (const f of Object.values(p.facts)) counts[f.status] = (counts[f.status] ?? 0) + 1
  const present = Object.keys(counts) as Array<FactRecord["status"]>
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  const overall: PatternStatus =
    present.length === 0 ? "none" : present.length === 1 ? (present[0] as PatternStatus) : "mixed"
  return { overall, counts, total }
}

const kindOf = (id: string): string => id.slice(0, Math.max(0, id.indexOf(":")))

function describe(ds: DesignSystem, id: string): Json {
  const name =
    ds.component(id)?.name ??
    ds.pattern(id)?.name ??
    ds.contract.tokens.find((t) => t.id === id)?.name ??
    ds.contract.constraints.find((c) => c.id === id)?.name
  return { id, kind: kindOf(id), ...(name ? { name } : {}) }
}

/** Policies that make a pattern enforceable: they name it in their scope, or are based on a constraint it owns. */
function enforcement(ds: DesignSystem, p: Pattern): Json[] {
  const owned = new Set(p.constraints ?? [])
  return ds.contract.policies
    .flatMap((policy: Policy) => {
      const via = policy.basedOn.filter((id) => owned.has(id as never))
      const scoped = (policy.scope.entities ?? []).includes(p.id)
      if (via.length === 0 && !scoped) return []
      return [
        {
          policy: policy.id,
          name: policy.name,
          severity: policy.severity,
          enforcement: policy.enforcement,
          approvedBy: policy.approval.approvedBy,
          ...(via.length > 0 ? { constraints: via } : {})
        } as Json
      ]
    })
    .sort((a, b) => cmp(String(a.policy), String(b.policy)))
}

const evidenceEntry = (ds: DesignSystem, e: Evidence): Json => ({
  id: e.id,
  sourceId: e.sourceId,
  method: e.method,
  location: ds.location([e.id]) ?? e.sourceRef,
  ...(e.original ? { original: e.original.length > 200 ? `${e.original.slice(0, 199)}…` : e.original } : {})
})

function summary(ds: DesignSystem, p: Pattern): Json {
  const status = patternStatus(p)
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    description: p.description,
    ...(p.intent ? { intent: p.intent } : {}),
    components: p.components,
    status: { overall: status.overall, counts: status.counts as Json, total: status.total },
    approved: status.overall === "approved",
    enforcedBy: enforcement(ds, p).map((e) => e.policy as string)
  }
}

export interface PatternFilters {
  category?: string | undefined
  status?: string | undefined
  query?: string | undefined
  offset?: number | undefined
  limit?: number | undefined
}

/** The pattern catalog, filterable by category, derived status and text. Ordered by relevance, else by id. */
export function patternsView(ds: DesignSystem, filters: PatternFilters = {}): Json {
  const all = ds.contract.patterns
  let rows: readonly Pattern[] = all
  if (filters.query?.trim()) {
    const hits = search(ds, filters.query, ["pattern"], 100).hits
    const byId = new Map(all.map((p) => [p.id as string, p]))
    rows = hits.flatMap((h) => byId.get(h.id) ?? [])
  } else rows = [...all].sort((a, b) => cmp(a.id, b.id))
  rows = rows.filter(
    (p) =>
      (!filters.category || p.category === filters.category) &&
      (!filters.status || patternStatus(p).overall === filters.status)
  )
  const view = page(rows, filters.offset, filters.limit)
  const notes: string[] = []
  if (all.length === 0)
    notes.push(
      "No patterns are defined. Invariant does not infer patterns from code, and no source documents one yet."
    )
  else if (rows.length === 0)
    notes.push(`No pattern matches these filters; the contract has ${all.length} pattern(s).`)
  const unapproved = view.items.filter((p) => patternStatus(p).overall !== "approved").length
  if (unapproved > 0)
    notes.push(
      `${unapproved} of ${view.items.length} pattern(s) are not fully approved. Each shows its status: treat documented, inferred or mixed patterns as proposals, not organizational standards.`
    )
  return {
    total: view.total,
    offset: view.offset,
    limit: view.limit,
    truncated: view.truncated,
    patterns: view.items.map((p) => summary(ds, p)),
    notes
  }
}

function factEntries(ds: DesignSystem, p: Pattern): Json[] {
  return Object.keys(p.facts)
    .sort(cmp)
    .map((path) => {
      const fact = p.facts[path] as FactRecord
      const view = ds.factView(p.facts, path) as FactView
      return {
        path,
        ...view,
        evidence: ds.evidenceEntries(fact.evidenceIds).map((e) => evidenceEntry(ds, e))
      } as unknown as Json
    })
}

/** One pattern in full: what it is made of, what is required of it, how sure we are, and where that comes from. */
export function patternView(ds: DesignSystem, p: Pattern): Json {
  const status = patternStatus(p)
  const fact = (path: string): JsonValue => (ds.factView(p.facts, path) as unknown as JsonValue) ?? null
  const constraints = (p.constraints ?? []).map((id) => {
    const c = ds.contract.constraints.find((x) => x.id === id)
    return c
      ? ({
          id: c.id,
          name: c.name,
          kind: c.kind,
          description: c.description,
          ...(c.details ? { details: c.details } : {}),
          status: (ds.factView(c.facts, "description")?.status ?? null) as JsonValue
        } as Json)
      : ({ id, missing: true } as Json)
  })
  const notes: string[] = []
  if (status.overall !== "approved")
    notes.push(
      status.overall === "none"
        ? "This pattern states no basis (no facts), so it is not approved."
        : `This pattern is not fully approved (${status.overall}). Treat it as a proposal until it is approved.`
    )
  if ((status.counts.inferred ?? 0) > 0)
    notes.push(
      `${status.counts.inferred} fact(s) are inferred, with a confidence; confirm them before relying on them.`
    )
  if (constraints.length === 0)
    notes.push("No constraints are attached, so validation cannot enforce anything from this pattern.")
  const open = ds.conflictsFor(p.id).filter((c) => c.resolution.state === "open")
  if (open.length > 0) notes.push(`${open.length} open conflict(s) concern this pattern.`)
  const inheritanceActive =
    p.inheritsConstraints === true &&
    p.appliesTo?.paths !== undefined &&
    p.facts.appliesTo?.status === "approved" &&
    p.facts.inheritsConstraints?.status === "approved"
  if (p.inheritsConstraints === true && !inheritanceActive)
    notes.push(
      "This pattern opts in to inheriting the constraints of what it composes, but inheritance is off until its paths and the opt-in are approved."
    )
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    description: p.description,
    ...(p.intent ? { intent: p.intent } : {}),
    ...(p.appliesTo || p.inheritsConstraints !== undefined
      ? {
          scope: {
            ...(p.appliesTo?.paths ? { paths: p.appliesTo.paths } : {}),
            ...(p.appliesTo?.frameworks ? { frameworks: p.appliesTo.frameworks } : {}),
            inheritsConstraints: p.inheritsConstraints === true,
            inheritanceActive
          } as Json
        }
      : {}),
    status: { overall: status.overall, counts: status.counts as Json, total: status.total },
    approved: status.overall === "approved",
    components: p.components.map((id) => describe(ds, id)),
    guidelines: p.guidelines.map((id) => ({
      id,
      name: ds.contract.guidelines.find((g) => g.id === id)?.name ?? null
    })),
    ...(p.composition
      ? {
          composition: {
            parts: p.composition.parts.map((part) => ({
              name: part.name,
              role: part.role,
              ref: describe(ds, part.ref),
              ...(part.region ? { region: part.region } : {}),
              ...(part.description ? { description: part.description } : {}),
              fact: fact(`composition.parts.${part.name}`)
            }))
          } as Json
        }
      : {}),
    ...(p.layout ? { layout: p.layout as unknown as JsonValue } : {}),
    ...(p.behavior ? { behavior: p.behavior as unknown as JsonValue } : {}),
    ...(p.accessibility ? { accessibility: p.accessibility as unknown as JsonValue } : {}),
    relationships: (p.relationships ?? []).map((r) => ({
      id: r.id,
      type: r.type,
      target: describe(ds, r.target),
      ...(r.description ? { description: r.description } : {}),
      fact: fact(`relationships.${r.id}`)
    })),
    constraints,
    enforcedBy: enforcement(ds, p),
    facts: factEntries(ds, p),
    conflicts: ds.conflictsFor(p.id).map((c) => ({ id: c.id, type: c.type, state: c.resolution.state })),
    notes
  }
}

export interface RelationshipOptions {
  direction?: "out" | "in" | "both" | undefined
  depth?: number | undefined
  types?: readonly string[] | undefined
}

interface Edge {
  from: string
  to: string
  type: string
  via: "relationship" | "composition"
  id: string
  role?: string
  fact?: string
}

const MAX_NODES = 200

function outgoing(p: Pattern): Edge[] {
  return [
    ...(p.relationships ?? []).map((r) => ({
      from: p.id,
      to: r.target as string,
      type: r.type as string,
      via: "relationship" as const,
      id: r.id,
      fact: `relationships.${r.id}`
    })),
    ...(p.composition?.parts ?? []).map((part) => ({
      from: p.id,
      to: part.ref as string,
      type: "part",
      via: "composition" as const,
      id: part.name,
      role: part.role,
      fact: `composition.parts.${part.name}`
    }))
  ]
}

/**
 * The relationships around a pattern, walked breadth-first to `depth` (default 1, at most 5). Components are
 * leaves. A node is expanded once, so cycles (`uses` may be cyclic) cannot loop. Composition parts appear as
 * `part` edges with their role.
 */
export function patternRelationships(
  ds: DesignSystem,
  root: Pattern,
  options: RelationshipOptions = {}
): Json {
  const direction = options.direction ?? "both"
  const depth = Math.max(1, Math.min(options.depth ?? 1, 5))
  const wanted = options.types && options.types.length > 0 ? new Set(options.types) : undefined
  const everyEdge = ds.contract.patterns.flatMap(outgoing)
  const edges = new Map<string, Edge>()
  const seen = new Set<string>([root.id])
  let frontier = [root.id as string]
  let truncated = false
  for (let level = 0; level < depth && frontier.length > 0; level++) {
    const next: string[] = []
    for (const id of frontier) {
      const found = [
        ...(direction !== "in" ? everyEdge.filter((e) => e.from === id) : []),
        ...(direction !== "out" ? everyEdge.filter((e) => e.to === id) : [])
      ].filter((e) => !wanted || wanted.has(e.type))
      for (const e of found) {
        edges.set(`${e.from}|${e.type}|${e.id}|${e.to}`, e)
        for (const end of [e.from, e.to]) {
          if (seen.has(end)) continue
          if (seen.size >= MAX_NODES) {
            truncated = true
            continue
          }
          seen.add(end)
          if (end.startsWith("pattern:")) next.push(end)
        }
      }
    }
    frontier = next
  }
  const nodes = [...seen].sort(cmp).map((id) => {
    const p = ds.pattern(id)
    return {
      ...describe(ds, id),
      ...(p ? { category: p.category, status: patternStatus(p).overall } : {}),
      ...(id === root.id ? { root: true } : {})
    } as Json
  })
  const list = [...edges.values()].sort(
    (a, b) => cmp(a.from, b.from) || cmp(a.type, b.type) || cmp(a.to, b.to) || cmp(a.id, b.id)
  )
  return {
    pattern: { id: root.id, name: root.name },
    direction,
    depth,
    edges: list.map((e) => {
      const from = ds.pattern(e.from)
      const view = from && e.fact ? ds.factView(from.facts, e.fact) : undefined
      return {
        from: e.from,
        to: e.to,
        type: e.type,
        via: e.via,
        id: e.id,
        ...(e.role ? { role: e.role } : {}),
        status: (view?.status ?? null) as JsonValue,
        ...(view?.source ? { source: view.source } : {})
      } as Json
    }),
    nodes,
    truncated,
    notes:
      list.length === 0
        ? ["This pattern has no relationships in the requested direction."]
        : [
            "Relationships are only what the contract states; none is inferred from name similarity. Each edge shows the status of the fact behind it."
          ]
  }
}
