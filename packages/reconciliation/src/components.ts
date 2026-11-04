import type { Component, Conflict, FactRecord } from "@invariant/contract"
import type { DiagnosticCollector, JsonValue } from "@invariant/shared"
import type { Implementation, ResolvedComponent } from "./resolve.js"
import { cmp, sameDomain, sameValue, setNested, slug, unique } from "./util.js"

export type ConflictDraft = Omit<Conflict, "id" | "resolution">
type Status = "discovered" | "documented"
type Collection = "props" | "events" | "slots" | "variants"

interface Claim {
  impl: Implementation
  value: JsonValue
  status: Status
  evidenceIds: string[]
}

type Target =
  | { t: "name" | "description" | "lifecycle" }
  | { t: "item"; collection: Collection; name: string; attr: string }
  | { t: "item-ext"; collection: Collection; name: string; ns: string; rest: string[] }
  | { t: "a11y"; attr: string }
  | { t: "impl"; attr: string }
  | { t: "impl-ext"; ns: string; rest: string[] }
  | { t: "example"; id: string; attr: string }
  | { t: "ext"; ns: string; rest: string[] }
  | { t: "composition"; attr: "subcomponents" | "renders" }
  | { t: "invariant"; path: string[] }

const ATTRS: Record<Collection, readonly string[]> = {
  props: ["type.text", "type.kind", "required", "default", "allowedValues", "description", "deprecated"],
  events: ["payload.text", "description", "deprecated", "declared"],
  slots: ["required", "description", "declared"],
  variants: ["values", "default", "description"]
}
const COLLECTIONS = Object.keys(ATTRS) as Collection[]
const IMPL_ATTRS = ["packageName", "exportName", "importPath"]
const NAMESPACE = /^[a-z0-9][a-z0-9._-]*$/
const FRAMEWORKS = new Set(["react", "angular", "vue"])

function translate(path: string, impl: Implementation): Target | undefined {
  const seg = path.split(".")
  const [head, second, ...tail] = seg
  const invariant: Target = { t: "invariant", path: seg }
  if (seg.length === 1 && (head === "name" || head === "description" || head === "lifecycle"))
    return { t: head }
  if (head && (COLLECTIONS as string[]).includes(head) && second) {
    const collection = head as Collection
    if (
      tail[0] === "extensions" &&
      tail.length >= 3 &&
      collection !== "variants" &&
      NAMESPACE.test(tail[1] as string)
    )
      return { t: "item-ext", collection, name: second, ns: tail[1] as string, rest: tail.slice(2) }
    return ATTRS[collection].includes(tail.join("."))
      ? { t: "item", collection, name: second, attr: tail.join(".") }
      : invariant
  }
  if (head === "accessibility" && seg.length === 2 && (second === "role" || second === "attributes"))
    return { t: "a11y", attr: second }
  if (head === "implementations" && second === impl.code.framework) {
    if (tail.length === 1 && IMPL_ATTRS.includes(tail[0] as string))
      return { t: "impl", attr: tail[0] as string }
    if (tail.length === 1 && tail[0] === "framework") return undefined
    if (tail[0] === "extensions" && tail.length >= 3 && NAMESPACE.test(tail[1] as string))
      return { t: "impl-ext", ns: tail[1] as string, rest: tail.slice(2) }
    return invariant
  }
  if (head === "examples" && second && tail.length === 1 && (tail[0] === "language" || tail[0] === "code"))
    return { t: "example", id: second, attr: tail[0] }
  if (head === "composition" && seg.length === 2 && (second === "subcomponents" || second === "renders"))
    return { t: "composition", attr: second }
  if (head === "extensions" && second && tail.length >= 1 && second !== "invariant" && NAMESPACE.test(second))
    return { t: "ext", ns: second, rest: tail }
  return invariant
}

export interface ComponentContext {
  /** IR ref of every implementation, to the contract id of the component it belongs to. */
  refToId: Map<string, string>
  diagnostics: DiagnosticCollector
  conflicts: ConflictDraft[]
}

interface Placed {
  cpath: string
  target: Target
  claim: Claim
}

function cpathOf(target: Target, impl: Implementation, exampleId: (raw: string) => string): string {
  switch (target.t) {
    case "name":
    case "description":
    case "lifecycle":
      return target.t
    case "item":
      return `${target.collection}.${target.name}.${target.attr}`
    case "item-ext":
      return `${target.collection}.${target.name}.extensions.${target.ns}.${target.rest.join(".")}`
    case "a11y":
      return `accessibility.${target.attr}`
    case "impl":
      return `implementations.${impl.id}.${target.attr}`
    case "impl-ext":
      return `implementations.${impl.id}.extensions.${target.ns}.${target.rest.join(".")}`
    case "example":
      return `examples.${exampleId(target.id)}.${target.attr}`
    case "ext":
      return `extensions.${target.ns}.${target.rest.join(".")}`
    case "composition":
      return `extensions.invariant.composition.${target.attr}`
    case "invariant":
      return `extensions.invariant.${target.path.join(".")}`
  }
}

/** Comparison rule for a path when implementations disagree. Unlisted paths are never compared. */
function comparison(
  target: Target
): { type: Conflict["type"]; severity: Conflict["severity"]; domain?: boolean } | undefined {
  switch (target.t) {
    case "description":
      return { type: "value-mismatch", severity: "info" }
    case "lifecycle":
      return { type: "deprecation-mismatch", severity: "warning" }
    case "a11y":
      return target.attr === "role"
        ? { type: "value-mismatch", severity: "warning" }
        : { type: "value-mismatch", severity: "info", domain: true }
    case "item": {
      const a = target.attr
      if (a === "required" || a === "default" || a === "values")
        return { type: "value-mismatch", severity: "warning", domain: a === "values" }
      if (a === "allowedValues") return { type: "value-mismatch", severity: "warning", domain: true }
      if (target.collection === "variants" && a === "default")
        return { type: "value-mismatch", severity: "warning" }
      if (a === "deprecated") return undefined
      return { type: "value-mismatch", severity: "info" }
    }
    default:
      return undefined
  }
}

const statusRank = (s: Status): number => (s === "discovered" ? 0 : 1)

function choose(claims: readonly Claim[]): Claim {
  return [...claims].sort(
    (a, b) =>
      statusRank(a.status) - statusRank(b.status) ||
      cmp(a.impl.code.sourceId, b.impl.code.sourceId) ||
      cmp(a.impl.id, b.impl.id)
  )[0] as Claim
}

const evidenceOfImpl = (impl: Implementation, path: string): string[] =>
  impl.facts.find((f) => f.path === path)?.evidenceIds ?? impl.facts[0]?.evidenceIds ?? []

/**
 * Builds one contract component from the implementations judged to be the same. Facts, evidence and status
 * come from the IR; nothing is added. Disagreeing implementations keep one value (see `choose`) and every
 * claim is recorded as a conflict.
 */
export function buildComponent(resolved: ResolvedComponent, ctx: ComponentContext): Component {
  const impls = resolved.implementations
  const multi = impls.length > 1
  const placed: Placed[] = []

  for (const impl of impls) {
    const exampleId = (raw: string): string => (multi ? slug(`${impl.id}-${raw}`) : raw)
    for (const fact of impl.facts) {
      const target = translate(fact.path, impl)
      if (!target) continue
      placed.push({
        cpath: cpathOf(target, impl, exampleId),
        target,
        claim: {
          impl,
          value: fact.value,
          status: fact.origin === "extracted" ? "discovered" : "documented",
          evidenceIds: fact.evidenceIds
        }
      })
    }
  }

  const byPath = new Map<string, Placed[]>()
  for (const p of placed) byPath.set(p.cpath, [...(byPath.get(p.cpath) ?? []), p])

  const facts: Record<string, FactRecord> = {}
  const chosen = new Map<string, Placed>()
  for (const [cpath, group] of [...byPath.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    const winner = choose(group.map((g) => g.claim))
    const first = group.find((g) => g.claim === winner) as Placed
    chosen.set(cpath, first)
    const rule = comparison(first.target)
    const same = rule?.domain ? sameDomain : sameValue
    const agreeing = group.filter((g) => same(g.claim.value, winner.value)).map((g) => g.claim)
    const status: Status = agreeing.some((c) => c.status === "discovered") ? "discovered" : "documented"
    facts[cpath] = { status, evidenceIds: unique(agreeing.flatMap((c) => c.evidenceIds)).sort() }

    const distinct = group.filter((g) => !same(g.claim.value, winner.value))
    if (rule && distinct.length > 0) {
      ctx.conflicts.push({
        type: rule.type,
        severity: rule.severity,
        subject: resolved.id as Conflict["subject"],
        path: cpath,
        claims: group
          .map((g) => ({
            sourceId: g.claim.impl.code.sourceId,
            value: g.claim.value,
            status: g.claim.status,
            evidenceIds: g.claim.evidenceIds
          }))
          .sort(
            (a, b) => cmp(a.sourceId, b.sourceId) || cmp(JSON.stringify(a.value), JSON.stringify(b.value))
          ),
        suggestedResolution: `Decide which ${cpath} is intended and align the other implementation, or accept the difference.`
      })
    }
  }

  const component = assemble(resolved, chosen, facts, ctx)
  findMissingProps(resolved, ctx)
  return component
}

interface ItemDraft {
  value: Record<string, JsonValue>
  ext: Record<string, Record<string, JsonValue>>
}

function assemble(
  resolved: ResolvedComponent,
  chosen: Map<string, Placed>,
  facts: Record<string, FactRecord>,
  ctx: ComponentContext
): Component {
  const items: Record<Collection, Map<string, ItemDraft>> = {
    props: new Map(),
    events: new Map(),
    slots: new Map(),
    variants: new Map()
  }
  const item = (c: Collection, name: string): ItemDraft => {
    const found = items[c].get(name)
    if (found) return found
    const created: ItemDraft = { value: {}, ext: {} }
    items[c].set(name, created)
    return created
  }
  const implementations = new Map<
    string,
    { value: Record<string, JsonValue>; ext: Record<string, Record<string, JsonValue>> }
  >(resolved.implementations.map((i) => [i.id, { value: {}, ext: {} }]))
  const a11y: Record<string, JsonValue> = {}
  const examples = new Map<string, Record<string, JsonValue>>()
  const extensions: Record<string, Record<string, JsonValue>> = {}
  let description: string | undefined
  let lifecycle: Component["lifecycle"]
  const place = (
    store: Record<string, Record<string, JsonValue>>,
    ns: string,
    rest: string[],
    value: JsonValue,
    cpath: string
  ): void => {
    store[ns] ??= {}
    if (!setNested(store[ns] as Record<string, JsonValue>, rest, value)) {
      delete facts[cpath]
      ctx.diagnostics.warning(
        "reconcile.extension-collision",
        `${resolved.id}: ${cpath} collides with another extension path and was not placed`,
        { entityId: resolved.id }
      )
    }
  }
  const implOf = (cpath: string): string => cpath.split(".")[1] as string

  for (const [cpath, p] of chosen) {
    const value = p.claim.value
    const t = p.target
    switch (t.t) {
      case "name":
        break
      case "description":
        if (typeof value === "string") description = value
        break
      case "lifecycle":
        if (value === "stable" || value === "experimental" || value === "deprecated") lifecycle = value
        break
      case "item": {
        const draft = item(t.collection, t.name)
        if (t.attr === "type.text" || t.attr === "type.kind") {
          const type = (draft.value.type ?? {}) as Record<string, JsonValue>
          type[t.attr === "type.text" ? "text" : "kind"] = value
          draft.value.type = type
        } else if (t.attr === "payload.text") {
          draft.value.payload = { text: value }
        } else if (t.attr === "declared") {
          facts[`${t.collection}.${t.name}`] = facts[cpath] as FactRecord
          delete facts[cpath]
        } else if (t.attr === "deprecated") {
          draft.value.deprecated =
            typeof value === "object" && value !== null && !Array.isArray(value) ? value : {}
        } else draft.value[t.attr] = value
        break
      }
      case "item-ext": {
        const draft = item(t.collection, t.name)
        place(draft.ext, t.ns, t.rest, value, cpath)
        break
      }
      case "a11y":
        a11y[t.attr] = value
        break
      case "impl":
        ;(implementations.get(implOf(cpath)) as { value: Record<string, JsonValue> }).value[t.attr] = value
        break
      case "impl-ext":
        place(
          (implementations.get(implOf(cpath)) as { ext: Record<string, Record<string, JsonValue>> }).ext,
          t.ns,
          t.rest,
          value,
          cpath
        )
        break
      case "example": {
        const id = cpath.split(".")[1] as string
        const ex = examples.get(id) ?? {}
        ex[t.attr] = value
        examples.set(id, ex)
        break
      }
      case "ext":
        place(extensions, t.ns, t.rest, value, cpath)
        break
      case "composition":
        place(extensions, "invariant", ["composition", t.attr], value, cpath)
        break
      case "invariant":
        place(extensions, "invariant", t.path, value, cpath)
        break
    }
  }

  const sources = new Map(resolved.implementations.map((i) => [i.id, i.code.sourceId]))
  const composition = relationships(resolved, ctx, facts)
  const sorted = <T extends { name: string }>(list: T[]): T[] => list.sort((a, b) => cmp(a.name, b.name))
  const withExt = (d: ItemDraft): Record<string, JsonValue> =>
    Object.keys(d.ext).length > 0 ? { ...d.value, extensions: d.ext } : d.value

  for (const name of items.events.keys())
    facts[`events.${name}`] ??= facts[`events.${name}.payload.text`] as FactRecord
  const component = {
    id: resolved.id,
    name: resolved.name,
    ...(description ? { description } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    implementations: resolved.implementations
      .map((i) => {
        const d = implementations.get(i.id) as {
          value: Record<string, JsonValue>
          ext: Record<string, Record<string, JsonValue>>
        }
        return {
          id: i.id,
          framework: FRAMEWORKS.has(i.code.framework) ? i.code.framework : "other",
          sourceId: sources.get(i.id) as string,
          ...d.value,
          ...(Object.keys(d.ext).length > 0 ? { extensions: d.ext } : {})
        }
      })
      .sort((a, b) => cmp(a.id, b.id)),
    props: sorted(
      [...items.props].map(([name, d]) => ({
        name,
        type: { text: "unknown" },
        required: false,
        ...withExt(d)
      }))
    ),
    events: sorted([...items.events].map(([name, d]) => ({ name, ...withExt(d) }))),
    slots: sorted([...items.slots].map(([name, d]) => ({ name, ...withExt(d) }))),
    variants: sorted(
      [...items.variants]
        .filter(([, d]) => Array.isArray(d.value.values) && d.value.values.length > 0)
        .map(([name, d]) => ({ name, ...d.value }))
    ),
    states: [],
    ...(Object.keys(a11y).length > 0 ? { accessibility: a11y } : {}),
    examples: [...examples]
      .filter(([, e]) => typeof e.code === "string" && e.code !== "" && typeof e.language === "string")
      .map(([id, e]) => ({ id, language: e.language, code: e.code, sourceId: [...sources.values()][0] }))
      .sort((a, b) => cmp(a.id, b.id)),
    composition,
    facts: sortedRecord(facts),
    ...(Object.keys(extensions).length > 0 ? { extensions } : {})
  }
  return component as unknown as Component
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort((a, b) => cmp(a[0], b[0])))
}

/** `contains` relationships from static composition facts, resolved to contract component ids. */
function relationships(
  resolved: ResolvedComponent,
  ctx: ComponentContext,
  facts: Record<string, FactRecord>
): Component["composition"] {
  const targets = new Map<string, string[]>()
  for (const impl of resolved.implementations) {
    for (const fact of impl.facts) {
      if (fact.path !== "composition.subcomponents" && fact.path !== "composition.renders") continue
      if (!Array.isArray(fact.value)) continue
      for (const entry of fact.value) {
        const ref =
          typeof entry === "object" && entry !== null && !Array.isArray(entry)
            ? (entry.ref ?? entry.target)
            : undefined
        if (typeof ref !== "string") continue
        const id = ctx.refToId.get(ref)
        if (!id) {
          ctx.diagnostics.info(
            "reconcile.composition-target-unresolved",
            `${resolved.id} refers to ${ref}, which is not a public component`,
            {
              entityId: resolved.id,
              sourceId: impl.code.sourceId
            }
          )
          continue
        }
        if (id === resolved.id) continue
        targets.set(id, unique([...(targets.get(id) ?? []), ...fact.evidenceIds]).sort())
      }
    }
  }
  const list = [...targets.entries()].sort((a, b) => cmp(a[0], b[0]))
  return list.map(([target, evidenceIds], index) => {
    facts[`composition.${index}`] = { status: "discovered", evidenceIds }
    return { type: "contains" as const, target: target as Component["composition"][number]["target"] }
  })
}

/** A prop one implementation declares and another, whose props are fully known, lacks. */
function findMissingProps(resolved: ResolvedComponent, ctx: ComponentContext): void {
  const impls = resolved.implementations
  if (impls.length < 2) return
  const names = unique(
    impls.flatMap((i) =>
      [...i.code.props.values()].filter((p) => !p.role || p.role === "prop").map((p) => p.name)
    )
  ).sort()
  for (const name of names) {
    const has = impls.filter((i) => i.code.props.has(name))
    const lacks = impls.filter((i) => !i.code.props.has(name) && i.code.propsComplete)
    if (lacks.length === 0) continue
    ctx.conflicts.push({
      type: "existence-mismatch",
      severity: "info",
      subject: resolved.id as Conflict["subject"],
      path: `props.${name}`,
      claims: [
        ...has.map((i) => ({
          sourceId: i.code.sourceId,
          value: true as JsonValue,
          status: "discovered" as const,
          evidenceIds: i.code.props.get(name)?.evidence.declared.length
            ? (i.code.props.get(name)?.evidence.declared as string[])
            : evidenceOfImpl(i, `props.${name}.type.text`)
        })),
        ...lacks.map((i) => ({
          sourceId: i.code.sourceId,
          status: "discovered" as const,
          evidenceIds: evidenceOfImpl(
            i,
            `implementations.${i.code.framework}.extensions.${i.code.framework}.propsComplete`
          )
        }))
      ].sort((a, b) => cmp(a.sourceId, b.sourceId)),
      suggestedResolution:
        "Frameworks may differ legitimately; confirm the prop is meant to exist in every implementation."
    })
  }
}
