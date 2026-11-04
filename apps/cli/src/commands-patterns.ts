import {
  archetypeView,
  DesignSystem,
  patternRelationships,
  patternsView,
  patternView,
  search
} from "@invariant/contract-query"
import type { JsonValue } from "@invariant/shared"
import { type Context, json, outputDir, print } from "./commands.js"
import { CliError } from "./errors.js"
import { shortValue, table } from "./format.js"
import { loadCompiled } from "./store.js"
import { CLI_NAME } from "./version.js"

type Row = Record<string, JsonValue>

const CATEGORIES = [
  "layout",
  "navigation",
  "form",
  "data-table",
  "card",
  "dialog",
  "workflow",
  "composition",
  "interaction",
  "page",
  "other"
]
const STATUSES = ["approved", "documented", "discovered", "inferred", "mixed", "none"]
const DIRECTIONS = ["out", "in", "both"]

const USAGE = `usage: ${CLI_NAME} patterns <list|inspect|resolve|search|relationships> ...
  patterns list [--category c] [--status s]
  patterns inspect <name|id> [--evidence]
  patterns resolve <name|id> [--variation name]
  patterns search <query>
  patterns relationships <name|id> [--direction out|in|both] [--depth 1-5]`

const rows = (value: JsonValue | undefined): Row[] => (Array.isArray(value) ? (value as Row[]) : [])
const text = (value: JsonValue | undefined): string =>
  value === undefined || value === null ? "" : typeof value === "string" ? value : String(value)

function choice(name: string, value: string | undefined, allowed: readonly string[]): string | undefined {
  if (value === undefined) return undefined
  if (!allowed.includes(value)) throw new CliError(`--${name} must be one of: ${allowed.join(", ")}`)
  return value
}

function resolve(
  ds: DesignSystem,
  query: string | undefined
): NonNullable<ReturnType<DesignSystem["pattern"]>> {
  if (!query) throw new CliError(USAGE)
  const found = ds.findPattern(query)
  if (found.match) return found.match
  const names = found.candidates.map((p) => p.id).join(", ")
  throw new CliError(
    found.candidates.length > 1
      ? `"${query}" matches several patterns: ${names}. Use the id.`
      : `no pattern matches "${query}"${names ? `. Did you mean: ${names}?` : ""}`
  )
}

function statusText(status: Row): string {
  const counts = Object.entries((status.counts ?? {}) as Row)
    .map(([k, v]) => `${k} ${text(v)}`)
    .join(", ")
  return `${text(status.overall)}${counts ? ` (${counts})` : ""}`
}

function inspect(c: Context, ds: DesignSystem, query: string | undefined): void {
  const pattern = resolve(ds, query)
  const view = patternView(ds, pattern) as Row
  if (c.args.values.json) {
    json(c, view)
    return
  }
  const status = view.status as Row
  print(c, `${text(view.name)}  (${text(view.id)})`)
  print(
    c,
    `category: ${text(view.category)}   status: ${statusText(status)}${view.approved ? "" : "   NOT APPROVED"}`
  )
  if (view.intent) print(c, `intent: ${text(view.intent)}`)
  print(c, text(view.description))
  const scope = view.scope as Row | undefined
  if (scope) {
    const paths = (scope.paths as string[] | undefined)?.join(", ") ?? "any file"
    const inherits = scope.inheritsConstraints
      ? scope.inheritanceActive
        ? "inherits constraints of what it composes"
        : "opts in to inheriting constraints (not approved, so off)"
      : "does not inherit constraints"
    print(c, `applies to: ${paths}   ${inherits}`)
  }
  const parts = rows(((view.composition as Row | undefined)?.parts as JsonValue) ?? [])
  if (parts.length > 0) {
    print(c, "\ncomposition")
    print(
      c,
      table(
        ["part", "role", "ref", "region", "status"],
        parts.map((p) => [
          text(p.name),
          text(p.role),
          text((p.ref as Row).name ?? (p.ref as Row).id),
          text(p.region),
          text((p.fact as Row | null)?.status)
        ])
      )
    )
  }
  const regions = rows(((view.layout as Row | undefined)?.regions as JsonValue) ?? [])
  if (regions.length > 0) {
    print(c, "\nlayout regions")
    print(
      c,
      table(
        ["region", "required", "parent", "accepts"],
        regions.map((r) => [text(r.name), r.required ? "yes" : "", text(r.parent), shortValue(r.accepts, 40)])
      )
    )
  }
  const behavior = view.behavior as Row | undefined
  if (behavior) {
    print(c, `\nbehavior (initial state: ${text(behavior.initial)})`)
    print(
      c,
      table(
        ["transition", "from", "to", "trigger", "verifiable by"],
        rows(behavior.transitions).map((t) => [
          text(t.id),
          text(t.from),
          text(t.to),
          text(t.trigger),
          text(t.verifiableBy)
        ])
      )
    )
    const feedback = rows(behavior.states).filter((s) => s.feedback)
    if (feedback.length > 0)
      print(c, `required feedback: ${feedback.map((s) => `${text(s.name)}: ${text(s.feedback)}`).join("; ")}`)
  }
  const reqs = rows(((view.accessibility as Row | undefined)?.requirements as JsonValue) ?? [])
  if (reqs.length > 0) {
    print(c, "\naccessibility")
    for (const r of reqs)
      print(c, `  ${text(r.id)}: ${text(r.statement)}${r.verifiableBy ? ` [${text(r.verifiableBy)}]` : ""}`)
  }
  const constraints = rows(view.constraints)
  if (constraints.length > 0) {
    print(c, "\nconstraints")
    print(
      c,
      table(
        ["id", "kind", "details"],
        constraints.map((k) => [text(k.id), text(k.kind), shortValue(k.details, 60)])
      )
    )
  }
  const relationships = rows(view.relationships)
  if (relationships.length > 0) {
    print(c, "\nrelationships")
    print(
      c,
      table(
        ["id", "type", "target", "status"],
        relationships.map((r) => [
          text(r.id),
          text(r.type),
          text((r.target as Row).name ?? (r.target as Row).id),
          text((r.fact as Row | null)?.status)
        ])
      )
    )
  }
  const enforced = rows(view.enforcedBy)
  print(
    c,
    enforced.length === 0
      ? "\nenforced by: no approved policy"
      : `\nenforced by: ${enforced.map((e) => `${text(e.policy)} (${text(e.enforcement)})`).join(", ")}`
  )
  if (c.args.values.evidence) {
    print(c, "\nevidence")
    for (const f of rows(view.facts)) {
      const where = rows(f.evidence)
        .map((e) => `${text(e.location)} [${text(e.method)}]`)
        .join("; ")
      print(
        c,
        `  ${text(f.path)}  ${text(f.status)}${f.confidence !== undefined ? ` ${text(f.confidence)}` : ""}  ${where}`
      )
    }
  }
  for (const note of (view.notes as string[]) ?? []) print(c, `note: ${note}`)
}

function tree(parts: Row[], related: Row[], indent: string, lines: string[]): void {
  for (const p of parts) {
    const ref = p.ref as Row
    lines.push(
      `${indent}${text(p.name)}  ${text(p.role)}${p.region ? `, region ${text(p.region)}` : ""}  ${text(ref.name ?? ref.id)}${ref.kind === "pattern" ? " (pattern)" : ""}`
    )
    nest(p.expanded as Row | undefined, indent, lines)
  }
  for (const r of related) {
    const target = r.target as Row
    lines.push(`${indent}${text(r.type)}  ${text(target.name ?? target.id)}`)
    nest(r.expanded as Row | undefined, indent, lines)
  }
}

function nest(expanded: Row | undefined, indent: string, lines: string[]): void {
  if (!expanded) return
  if (expanded.cycle) {
    lines.push(`${indent}  (already shown above)`)
    return
  }
  if (expanded.truncated) {
    lines.push(`${indent}  (not followed further)`)
    return
  }
  const p = expanded.pattern as Row
  lines.push(`${indent}  ${text(p.name)}  [${text(p.status)}${p.approved ? "" : " *"}]`)
  tree(rows(expanded.parts), rows(expanded.related), `${indent}    `, lines)
}

function resolveView(c: Context, ds: DesignSystem, query: string | undefined): void {
  const pattern = resolve(ds, query)
  const result = archetypeView(ds, pattern, { variation: c.args.values.variation })
  if (!result.ok) throw new CliError(result.message)
  const view = result.view as Row
  if (c.args.values.json) {
    json(c, view)
    return
  }
  const status = view.status as Row
  print(
    c,
    `${text(view.name)}  (${text(view.id)})${view.variation ? `  variation: ${text(view.variation)}` : ""}`
  )
  print(
    c,
    `category: ${text(view.category)}   status: ${statusText(status)}${view.approved ? "" : "   NOT APPROVED"}`
  )
  if (view.intent) print(c, `intent: ${text(view.intent)}`)
  const regions = rows(view.regions)
  if (regions.length > 0) {
    print(c, "\nregions")
    print(
      c,
      table(
        ["region", "required", "parts"],
        regions.map((r) => [
          text(r.name),
          r.required ? "yes" : "",
          ((r.parts as JsonValue[]) ?? []).join(", ")
        ])
      )
    )
  }
  const lines: string[] = []
  const root = view.composition as Row
  tree(rows(root.parts), rows(root.related), "  ", lines)
  print(c, `\ncomposition  (* not approved)\n${lines.join("\n")}`)
  const variations = rows(view.variations)
  if (variations.length > 0) {
    print(c, "\nvariations")
    print(
      c,
      table(
        ["name", "when", "changes", "adds"],
        variations.map((v) => [
          text(v.name),
          shortValue(v.when, 40),
          rows(v.roles)
            .map((x) => `${text(x.part)}: ${text(x.role)}`)
            .join(", "),
          rows(v.addedParts)
            .map((x) => text(x.name))
            .join(", ")
        ])
      )
    )
  }
  const states = rows(view.requiredStates)
  if (states.length > 0) {
    print(c, "\nrequired interaction states")
    print(
      c,
      table(
        ["pattern", "workflow", "state", "minimum", "enforced"],
        states.map((s) => [
          text(s.pattern),
          text(s.workflow),
          text(s.state),
          text(s.minimum),
          s.enforced ? "yes" : "no"
        ])
      )
    )
  }
  const constraints = rows(view.constraints)
  if (constraints.length > 0) {
    print(c, "\nconstraints")
    print(
      c,
      table(
        ["pattern", "kind", "enforced"],
        constraints.map((k) => [text(k.pattern), text(k.kind), k.enforced ? "yes" : "no"])
      )
    )
  }
  const responsive = rows(view.responsive)
  if (responsive.length > 0) {
    print(c, "\nresponsive")
    for (const x of responsive) print(c, `  ${text(x.region)}: ${text(x.behavior)} at ${text(x.breakpoint)}`)
  }
  const prohibited = view.prohibited as Row
  const parts = rows(prohibited.parts)
  if (parts.length > 0) print(c, `\nprohibited parts: ${parts.map((p) => text(p.name)).join(", ")}`)
  const pairs = rows(prohibited.patterns)
  if (pairs.length > 0)
    print(
      c,
      `\nprohibited together: ${pairs.map((p) => `${text(p.pattern)} with ${text(p.with)}${p.composedHere ? " (BOTH COMPOSED HERE)" : ""}`).join("; ")}`
    )
  for (const note of (view.notes as string[]) ?? []) print(c, `note: ${note}`)
}

function relationships(c: Context, ds: DesignSystem, query: string | undefined): void {
  const pattern = resolve(ds, query)
  const direction = choice("direction", c.args.values.direction, DIRECTIONS) as
    | "out"
    | "in"
    | "both"
    | undefined
  const rawDepth = c.args.values.depth
  const depth = rawDepth === undefined ? undefined : Number(rawDepth)
  if (depth !== undefined && (!Number.isInteger(depth) || depth < 1 || depth > 5))
    throw new CliError("--depth must be a whole number from 1 to 5")
  const view = patternRelationships(ds, pattern, { direction, depth }) as Row
  if (c.args.values.json) {
    json(c, view)
    return
  }
  const names = new Map(rows(view.nodes).map((n) => [text(n.id), text(n.name) || text(n.id)]))
  const edges = rows(view.edges)
  print(
    c,
    `${pattern.name}  (${pattern.id})   direction: ${text(view.direction)}, depth: ${text(view.depth)}`
  )
  if (edges.length === 0) {
    print(c, "no relationships in this direction")
    return
  }
  print(
    c,
    table(
      ["from", "type", "to", "status"],
      edges.map((e) => [
        names.get(text(e.from)) ?? text(e.from),
        `${text(e.type)}${e.role ? ` (${text(e.role)})` : ""}`,
        names.get(text(e.to)) ?? text(e.to),
        text(e.status)
      ])
    )
  )
  if (view.truncated) print(c, "note: the walk was cut off at 200 nodes")
}

export async function patterns(c: Context): Promise<number> {
  const [, sub, ...rest] = c.args.positionals
  if (!sub || !["list", "inspect", "resolve", "search", "relationships"].includes(sub))
    throw new CliError(USAGE)
  const { contract, evidence } = loadCompiled(await outputDir(c))
  const ds = new DesignSystem(contract, evidence)
  if (sub === "inspect") inspect(c, ds, rest[0])
  else if (sub === "resolve") resolveView(c, ds, rest[0])
  else if (sub === "relationships") relationships(c, ds, rest[0])
  else if (sub === "search") {
    const query = rest.join(" ").trim()
    if (!query) throw new CliError(`usage: ${CLI_NAME} patterns search <query>`)
    const hits = search(ds, query, ["pattern"], 20).hits
    if (c.args.values.json) json(c, hits as unknown as JsonValue)
    else
      print(
        c,
        hits.length === 0
          ? `no pattern matches "${query}"`
          : table(
              ["id", "name", "score", "matched on"],
              hits.map((h) => [h.id, h.name, h.score, h.matchedOn.join(", ")])
            )
      )
  } else {
    const category = choice("category", c.args.values.category, CATEGORIES)
    const status = choice("status", c.args.values.status, STATUSES)
    const view = patternsView(ds, { category, status, limit: 200 }) as Row
    if (c.args.values.json) {
      // Unchanged shape: the matching patterns as written in the contract.
      const ids = new Set(rows(view.patterns).map((p) => text(p.id)))
      json(
        c,
        contract.patterns.filter((p) => ids.has(p.id))
      )
    } else if (rows(view.patterns).length === 0)
      print(
        c,
        contract.patterns.length === 0
          ? "no patterns. Invariant does not infer patterns from code yet, and no source documents one."
          : `no pattern matches these filters (${contract.patterns.length} in the contract)`
      )
    else {
      print(
        c,
        table(
          ["id", "name", "category", "status", "components"],
          rows(view.patterns).map((p) => [
            text(p.id),
            text(p.name),
            text(p.category),
            `${text((p.status as Row).overall)}${p.approved ? "" : " *"}`,
            (p.components as JsonValue[]).length
          ])
        )
      )
      if (rows(view.patterns).some((p) => !p.approved)) print(c, "\n* not approved: treat as a proposal")
    }
  }
  return 0
}
