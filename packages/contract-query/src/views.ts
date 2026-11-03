import type { Component, FactRecord, Token } from "@invariant/contract"
import type { JsonValue } from "@invariant/shared"
import { cmp, type DesignSystem, type FactView } from "./system.js"

type Json = Record<string, JsonValue>

const clamp = (n: number | undefined, fallback: number, max: number): number =>
  Math.max(1, Math.min(n ?? fallback, max))

const statusOf = (f: FactView | undefined): JsonValue => (f ? (f as unknown as JsonValue) : null)

export interface Page<T> {
  total: number
  offset: number
  limit: number
  truncated: boolean
  items: T[]
}

export function page<T>(all: readonly T[], offset = 0, limit?: number): Page<T> {
  const l = clamp(limit, 50, 200)
  const o = Math.max(0, offset)
  return { total: all.length, offset: o, limit: l, truncated: o + l < all.length, items: all.slice(o, o + l) }
}

export function overview(ds: DesignSystem): Json {
  const c = ds.contract
  const inferred = [...c.components, ...c.tokens, ...c.guidelines].reduce(
    (n, e) => n + Object.values(e.facts).filter((f) => f.status === "inferred").length,
    0
  )
  const open = c.conflicts.filter((x) => x.resolution.state === "open")
  const by = (key: (x: (typeof c.conflicts)[number]) => string): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const x of open) out[key(x)] = (out[key(x)] ?? 0) + 1
    return out
  }
  const perFramework: Record<string, number> = {}
  for (const comp of c.components)
    for (const fw of new Set(comp.implementations.map((i) => i.framework)))
      perFramework[fw] = (perFramework[fw] ?? 0) + 1
  const categories: Record<string, number> = {}
  for (const t of c.tokens) categories[t.category] = (categories[t.category] ?? 0) + 1
  const incomplete = c.components.filter((x) => !ds.propsComplete(x)).length
  const notes: string[] = []
  if (c.patterns.length === 0)
    notes.push("No patterns are defined: none are inferred from code and no source documents one.")
  if (c.policies.length === 0)
    notes.push(
      "No approved policies exist. Validation reports facts from the contract, not organizational rules."
    )
  if (incomplete > 0)
    notes.push(
      `${incomplete} component(s) have an incomplete API listing (inherited or generic props); a missing prop there is not proof it does not exist.`
    )
  if (inferred > 0)
    notes.push(
      `${inferred} fact(s) are inferred, not discovered; each carries a confidence and needs human approval.`
    )
  if (open.length > 0)
    notes.push(
      `${open.length} open conflict(s) between sources; the contract keeps one value and records every claim.`
    )
  return {
    name: c.metadata.name,
    contractId: c.metadata.contractId,
    contractVersion: c.contractVersion,
    contentHash: c.integrity.contentHash,
    compilerVersion: c.metadata.compilerVersion,
    frameworks: c.metadata.frameworks,
    sources: c.sources.map((s) => ({ id: s.id, type: s.type, health: s.health.status })),
    counts: {
      components: c.components.length,
      tokens: c.tokens.length,
      themes: c.themes.length,
      guidelines: c.guidelines.length,
      patterns: c.patterns.length,
      policies: c.policies.length,
      inferredFacts: inferred,
      componentsWithIncompleteApi: incomplete
    },
    componentsByFramework: perFramework,
    tokenCategories: categories,
    openConflicts: { total: open.length, bySeverity: by((x) => x.severity), byType: by((x) => x.type) },
    notes
  }
}

export function catalog(ds: DesignSystem): Json[] {
  return ds.contract.components.map((c) => ({
    id: c.id,
    name: c.name,
    frameworks: [...new Set(c.implementations.map((i) => i.framework))].sort(),
    ...(c.lifecycle ? { lifecycle: c.lifecycle } : {}),
    props: c.props.length,
    events: c.events.length,
    slots: c.slots.length,
    variants: c.variants.map((v) => v.name)
  }))
}

function roleOf(c: Component, prop: string): string | undefined {
  for (const ext of Object.values(c.props.find((p) => p.name === prop)?.extensions ?? {}))
    if (typeof ext.role === "string") return ext.role
  return undefined
}

export function componentView(ds: DesignSystem, c: Component): Json {
  const conflicts = ds.conflictsFor(c.id)
  const notes: string[] = []
  if (!ds.propsComplete(c))
    notes.push(
      "The prop list is incomplete for at least one implementation: do not conclude a prop is absent from this list alone; read the source."
    )
  if (c.lifecycle === "deprecated") notes.push("This component is deprecated.")
  const identity = c.implementations.find((i) => c.facts[`implementations.${i.id}`]?.status === "inferred")
  if (identity)
    notes.push(
      "Implementations in different frameworks were linked by name, which is inferred (see each implementation's status)."
    )
  return {
    id: c.id,
    name: c.name,
    ...(c.description ? { description: c.description } : {}),
    ...(c.lifecycle ? { lifecycle: c.lifecycle } : {}),
    implementations: c.implementations.map((i) => ({
      id: i.id,
      framework: i.framework,
      ...(i.packageName ? { package: i.packageName } : {}),
      ...(i.exportName ? { export: i.exportName } : {}),
      ...(i.importPath ? { importPath: i.importPath } : {}),
      apiComplete: ds.propsComplete(c, i.framework),
      status: statusOf(ds.factView(c.facts, `implementations.${i.id}`))
    })),
    props: c.props.map((p) => ({
      name: p.name,
      type: p.type.text,
      ...(p.type.kind ? { kind: p.type.kind } : {}),
      required: p.required,
      ...(p.default !== undefined ? { default: p.default } : {}),
      ...(p.allowedValues ? { allowedValues: p.allowedValues } : {}),
      ...(p.description ? { description: p.description } : {}),
      ...(p.deprecated ? { deprecated: p.deprecated as JsonValue } : {}),
      ...(roleOf(c, p.name) ? { role: roleOf(c, p.name) as string } : {}),
      status: statusOf(ds.factView(c.facts, `props.${p.name}.type.text`))
    })),
    events: c.events.map((e) => ({ name: e.name, ...(e.payload ? { payload: e.payload.text } : {}) })),
    slots: c.slots.map((s) => ({
      name: s.name,
      ...(s.required !== undefined ? { required: s.required } : {})
    })),
    variants: c.variants.map((v) => ({
      name: v.name,
      values: v.values,
      ...(v.default ? { default: v.default } : {})
    })),
    ...(c.accessibility ? { accessibility: c.accessibility as unknown as JsonValue } : {}),
    conflicts: conflicts.map((x) => ({
      type: x.type,
      severity: x.severity,
      ...(x.path ? { path: x.path } : {}),
      claims: x.claims.map((cl) => ({
        source: cl.sourceId,
        ...(cl.value === undefined ? {} : { value: cl.value }),
        status: cl.status
      }))
    })),
    guidelines: ds.contract.guidelines.filter((g) => g.appliesTo.includes(c.id)).map((g) => g.id),
    notes
  }
}

export function usageView(ds: DesignSystem, c: Component): Json {
  const required = c.props.filter((p) => p.required).map((p) => p.name)
  const deprecatedProps = c.props
    .filter((p) => p.deprecated)
    .map((p) => ({ name: p.name, ...(p.deprecated?.reason ? { reason: p.deprecated.reason } : {}) }))
  const usage = (c.extensions?.invariant as { usage?: JsonValue } | undefined)?.usage
  const notes: string[] = []
  if (!ds.propsComplete(c)) notes.push("API listing is incomplete; confirm unlisted props in the source.")
  if (usage === undefined)
    notes.push("No observed usage statistics for this component (only React usage is observed).")
  return {
    id: c.id,
    name: c.name,
    lifecycle: c.lifecycle ?? "unspecified",
    howToImport: c.implementations.map((i) => ({
      framework: i.framework,
      ...(i.packageName ? { package: i.packageName } : {}),
      ...(i.exportName ? { export: i.exportName } : {}),
      ...(i.importPath ? { from: i.importPath } : {})
    })),
    requiredProps: required,
    variants: c.variants.map((v) => ({
      name: v.name,
      values: v.values,
      ...(v.default ? { default: v.default } : {})
    })),
    defaults: Object.fromEntries(
      c.props.filter((p) => p.default !== undefined).map((p) => [p.name, p.default as JsonValue])
    ),
    events: c.events.map((e) => e.name),
    slots: c.slots.map((s) => s.name),
    deprecatedProps,
    examples: c.examples.map((e) => ({
      id: e.id,
      language: e.language,
      code: e.code,
      status: statusOf(ds.factView(c.facts, `examples.${e.id}.code`))
    })),
    ...(usage === undefined ? {} : { observedUsage: usage }),
    guidelines: ds.contract.guidelines
      .filter((g) => g.appliesTo.includes(c.id))
      .map((g) => ({ id: g.id, kind: g.kind, title: g.name })),
    notes
  }
}

export function compositionView(ds: DesignSystem, c: Component): Json {
  const staticRefs = (c.extensions?.invariant as { composition?: JsonValue } | undefined)?.composition
  const name = (id: string): string => ds.component(id)?.name ?? id
  const notes: string[] = []
  const contains = c.composition.map((r, i) => ({
    relation: r.type,
    id: r.target,
    name: name(r.target),
    status: statusOf(ds.factView(c.facts, `composition.${i}`))
  }))
  if (contains.some((x) => (x.status as { status?: string } | null)?.status === "inferred"))
    notes.push(
      "Some containment links are inferred from names and are low confidence; verify against the source."
    )
  if (contains.length === 0)
    notes.push(
      "No composition relationships were found; that does not mean the component cannot be composed."
    )
  return {
    id: c.id,
    name: c.name,
    contains,
    containedBy: ds.containedBy(c.id).map((x) => ({
      id: x.id,
      name: name(x.id),
      status: x.fact
        ? {
            status: x.fact.status,
            ...(x.fact.confidence === undefined ? {} : { confidence: x.fact.confidence })
          }
        : null
    })),
    slots: c.slots.map((s) => ({ name: s.name, ...(s.accepts ? { accepts: s.accepts } : {}) })),
    ...(staticRefs === undefined ? {} : { staticReferences: staticRefs }),
    notes
  }
}

export function tokenView(ds: DesignSystem, t: Token, theme?: string): Json {
  const resolved = ds.resolveToken(t, theme)
  return {
    id: t.id,
    name: t.name,
    category: t.category,
    categoryStatus: statusOf(ds.factView(t.facts, "category")),
    ...(t.description ? { description: t.description } : {}),
    ...(t.value.aliasOf ? { aliasOf: t.value.aliasOf } : { value: t.value.value as JsonValue }),
    ...(resolved.value !== undefined ? { resolvedValue: resolved.value } : {}),
    ...(resolved.chain.length > 1 ? { aliasChain: resolved.chain } : {}),
    ...(resolved.note ? { note: resolved.note } : {}),
    modes: Object.fromEntries(
      Object.entries(t.modes ?? {}).map(([k, v]) => [
        k,
        (v.aliasOf ? { aliasOf: v.aliasOf } : { value: v.value as JsonValue }) as JsonValue
      ])
    ),
    ...(t.deprecated ? { deprecated: t.deprecated as JsonValue } : {})
  }
}

export function tokensView(
  ds: DesignSystem,
  f: { category?: string; query?: string; theme?: string; offset?: number; limit?: number }
): Json {
  const q = f.query?.toLowerCase()
  const theme = f.theme ? (f.theme.startsWith("theme:") ? f.theme : `theme:${f.theme}`) : undefined
  const all = ds.contract.tokens
    .filter((t) => !f.category || t.category === f.category)
    .filter(
      (t) =>
        !q ||
        t.id.includes(q) ||
        t.name.toLowerCase().includes(q) ||
        JSON.stringify(t.value).toLowerCase().includes(q)
    )
    .sort((a, b) => cmp(a.id, b.id))
  const p = page(all, f.offset, f.limit)
  return {
    total: p.total,
    offset: p.offset,
    truncated: p.truncated,
    themes: ds.contract.themes.map((t) => t.id),
    tokens: p.items.map((t) => tokenView(ds, t, theme)),
    notes: all.some((t) => ds.factView(t.facts, "category")?.status === "inferred")
      ? ["Token categories marked inferred are guesses from names and value kinds, not declarations."]
      : []
  }
}

export function guidelinesView(
  ds: DesignSystem,
  f: { kind?: string; component?: string; query?: string; offset?: number; limit?: number }
): Json {
  const target = f.component ? ds.findComponent(f.component).match?.id : undefined
  const q = f.query?.toLowerCase()
  const all = ds.contract.guidelines
    .filter((g) => !f.kind || g.kind === f.kind)
    .filter((g) => !f.component || (target !== undefined && g.appliesTo.includes(target as never)))
    .filter((g) => !q || g.name.toLowerCase().includes(q) || g.id.includes(q))
  const p = page(all, f.offset, f.limit)
  return {
    total: p.total,
    offset: p.offset,
    truncated: p.truncated,
    guidelines: p.items.map((g) => ({
      id: g.id,
      title: g.name,
      kind: g.kind,
      kindStatus: statusOf(ds.factView(g.facts, "kind")),
      appliesTo: g.appliesTo,
      references: g.references.map((r) => ({ source: r.sourceId, document: r.documentId }))
    })),
    notes: [
      "Guideline text is the page title: Invariant does not read page bodies, so open the referenced document for the actual guidance.",
      ...(f.component && !target ? [`No component matches "${f.component}".`] : [])
    ]
  }
}

export function patternsView(ds: DesignSystem): Json {
  return {
    total: ds.contract.patterns.length,
    patterns: ds.contract.patterns.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      description: p.description,
      components: p.components
    })),
    notes:
      ds.contract.patterns.length === 0
        ? [
            "No patterns are defined. Invariant does not infer patterns from code, and no source documents one yet."
          ]
        : []
  }
}

export function factsOf(c: { facts: Record<string, FactRecord> }): number {
  return Object.keys(c.facts).length
}
