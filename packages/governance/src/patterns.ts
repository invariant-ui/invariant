import {
  type Constraint,
  type ContractDraft,
  computeEvidenceId,
  computeFactFingerprint,
  constraintDetailsSchemas,
  type Evidence,
  type FactRecord,
  type Pattern,
  type Policy,
  patternSchema,
  resolveFactPath,
  type Source
} from "@invariant/contract"
import { type Diagnostic, DiagnosticCollector, type JsonValue, sha256Hex } from "@invariant/shared"
import { nearest } from "@invariant/validation"
import type { PatternDefinition, PatternsFile } from "./patterns-file.js"

export const PATTERN_SOURCE_ID = "patterns"
const EXTRACTOR = { name: "pattern-definitions", version: "1.0.0" }

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const byId = (a: { id: string }, b: { id: string }): number => cmp(a.id, b.id)
const norm = (s: string): string =>
  s
    .replace(/^[a-z]+:/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")

type Resolved =
  | {
      ok: true
      id: string /** 0 for an exact id, 1 for a name or id, 2 for the part after the category. */
      tier: number
    }
  | { ok: false; code: string; message: string }

interface Named {
  id: string
  name: string
}

const bodyOf = (id: string): string => id.slice(id.indexOf(":") + 1)
const afterCategory = (id: string): string => {
  const body = bodyOf(id)
  return body.includes(".") ? body.slice(body.indexOf(".") + 1) : body
}

/**
 * Finds the entity a written reference means, or explains why it cannot. An exact id wins; then a name or id
 * (ignoring case and separators); then the part of an id after its category (`data-management`). A looser
 * match never competes with a stricter one, and several matches at the same level are ambiguous, not guessed.
 */
function lookup(kind: string, ref: string, universe: readonly Named[], code: string): Resolved {
  const text = ref.trim()
  const exact = universe.find((e) => e.id === text)
  if (exact) return { ok: true, id: exact.id, tier: 0 }
  // An explicit prefix names exactly one id: no fuzzy matching.
  if (text.startsWith(`${kind}:`)) return unknown(kind, text, universe, code)
  const n = norm(text)
  const tiers = [
    universe.filter((e) => norm(e.name) === n || norm(bodyOf(e.id)) === n),
    universe.filter((e) => norm(afterCategory(e.id)) === n)
  ]
  for (const [i, matches] of tiers.entries()) {
    if (matches.length === 1) return { ok: true, id: (matches[0] as Named).id, tier: i + 1 }
    if (matches.length > 1)
      return {
        ok: false,
        code: "governance.pattern-ambiguous-reference",
        message: `"${text}" matches several ${kind}s (${matches.map((m) => m.id).join(", ")}); write the full id`
      }
  }
  return unknown(kind, text, universe, code)
}

function unknown(kind: string, text: string, universe: readonly Named[], code: string): Resolved {
  const close = nearest(
    text.replace(/^[a-z]+:/, ""),
    universe.flatMap((e) => [e.name, e.id.slice(e.id.indexOf(":") + 1)])
  )
  return {
    ok: false,
    code,
    message: `there is no ${kind} "${text}"${close.length > 0 ? `; did you mean ${close.join(" or ")}?` : ""}`
  }
}

interface Universe {
  components: Named[]
  patterns: Named[]
  tokens: Named[]
  guidelines: Named[]
}

/** Resolves written references to ids. Problems are collected, never thrown, so one run reports them all. */
class References {
  readonly problems: Array<{ code: string; message: string }> = []
  private readonly universe: Universe
  private readonly owner: string

  constructor(universe: Universe, owner: string) {
    this.universe = universe
    this.owner = owner
  }

  private fail(where: string, r: Extract<Resolved, { ok: false }>): string {
    this.problems.push({ code: r.code, message: `${this.owner} ${where}: ${r.message}` })
    return ""
  }

  component(ref: string, where: string): string {
    const r = lookup("component", ref, this.universe.components, "governance.pattern-unknown-component")
    return r.ok ? r.id : this.fail(where, r)
  }

  pattern(ref: string, where: string): string {
    const r = lookup("pattern", ref, this.universe.patterns, "governance.pattern-unknown-pattern")
    return r.ok ? r.id : this.fail(where, r)
  }

  token(ref: string, where: string): string {
    const r = lookup("token", ref, this.universe.tokens, "governance.pattern-unknown-token")
    return r.ok ? r.id : this.fail(where, r)
  }

  guideline(ref: string, where: string): string {
    const r = lookup("guideline", ref, this.universe.guidelines, "governance.pattern-unknown-guideline")
    return r.ok ? r.id : this.fail(where, r)
  }

  /** A component or a pattern. An explicit prefix decides; otherwise exactly one must match. */
  target(ref: string, where: string): string {
    const text = ref.trim()
    if (text.startsWith("component:")) return this.component(text, where)
    if (text.startsWith("pattern:")) return this.pattern(text, where)
    const c = lookup("component", text, this.universe.components, "")
    const p = lookup("pattern", text, this.universe.patterns, "")
    if (c.ok && p.ok) {
      // A stricter match beats a looser one; only a tie is ambiguous.
      if (c.tier !== p.tier) return c.tier < p.tier ? c.id : p.id
      return this.fail(where, {
        ok: false,
        code: "governance.pattern-ambiguous-reference",
        message: `"${text}" is both a component (${c.id}) and a pattern (${p.id}); write the full id`
      })
    }
    if (c.ok) return c.id
    if (p.ok) return p.id
    const close = nearest(
      text,
      [...this.universe.components, ...this.universe.patterns].map((e) => e.name)
    )
    return this.fail(where, {
      ok: false,
      code: "governance.pattern-unknown-component",
      message: `there is no component or pattern "${text}"${close.length > 0 ? `; did you mean ${close.join(" or ")}?` : ""}`
    })
  }

  /** A component, a pattern, or a `region:<name>` of the pattern itself. */
  element(ref: string, where: string): string {
    return ref.startsWith("region:") ? ref : this.target(ref, where)
  }
}

function mapStrings(value: unknown, map: (s: string, key: string) => string, key = ""): unknown {
  if (typeof value === "string") return map(value, key)
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, map, key))
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, map, k)]))
  return value
}

const stringsIn = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(stringsIn)
      : value && typeof value === "object"
        ? Object.values(value).flatMap(stringsIn)
        : []

const localName = (id: string): string => id.slice(id.indexOf(":") + 1)

interface Built {
  pattern: Pattern
  constraints: Constraint[]
  policies: Policy[]
}

interface Context {
  def: PatternDefinition
  id: Pattern["id"]
  refs: References
  evidence: Evidence
  approved: boolean
  file: string
}

/** The pattern with every reference resolved, before facts and constraints are attached. */
function buildPattern(ctx: Context): Omit<Pattern, "facts"> {
  const { def, refs } = ctx
  const parts = def.composition?.parts.map((p) => ({
    ...p,
    ref: refs.target(p.ref, `composition.parts.${p.name}.ref`) as Pattern["components"][number]
  }))
  const regions = def.layout?.regions.map((r) => ({
    ...r,
    ...(r.accepts
      ? { accepts: r.accepts.map((a) => refs.target(a, `layout.regions.${r.name}.accepts`)) }
      : {}),
    ...(r.spacing ? { spacing: refs.token(r.spacing, `layout.regions.${r.name}.spacing`) } : {}),
    ...(r.grid
      ? {
          grid: {
            ...r.grid,
            ...(r.grid.gap ? { gap: refs.token(r.grid.gap, `layout.regions.${r.name}.grid.gap`) } : {})
          }
        }
      : {}),
    ...(r.responsive
      ? {
          responsive: r.responsive.map((x) => ({
            ...x,
            breakpoint: refs.token(x.breakpoint, `layout.regions.${r.name}.responsive`)
          }))
        }
      : {})
  }))
  const variations = def.variations?.map((v) => ({
    ...v,
    ...(v.parts
      ? {
          parts: v.parts.map((p) => ({
            ...p,
            ref: refs.target(p.ref, `variations.${v.name}.parts.${p.name}.ref`)
          }))
        }
      : {})
  }))
  const relationships = def.relationships?.map((r) => ({
    ...r,
    target:
      r.type === "contains" || r.type === "uses"
        ? refs.target(r.target, `relationships.${r.id}.target`)
        : refs.pattern(r.target, `relationships.${r.id}.target`)
  }))
  const guidelines = (def.guidelines ?? []).map((g, i) => refs.guideline(g, `guidelines.${i}`))
  const pattern = {
    id: ctx.id,
    name: def.name,
    category: def.category,
    description: def.description,
    ...(def.intent ? { intent: def.intent } : {}),
    components: [] as string[],
    guidelines: guidelines.sort(),
    ...(parts ? { composition: { parts } } : {}),
    ...(variations ? { variations } : {}),
    ...(regions ? { layout: { regions } } : {}),
    ...(def.behavior ? { behavior: def.behavior } : {}),
    ...(def.accessibility ? { accessibility: def.accessibility } : {}),
    ...(relationships ? { relationships } : {}),
    ...(def.appliesTo ? { appliesTo: def.appliesTo } : {}),
    ...(def.origin ? { extensions: { discovery: def.origin } } : {}),
    ...(def.inheritsConstraints === undefined ? {} : { inheritsConstraints: def.inheritsConstraints })
  }
  return pattern as unknown as Omit<Pattern, "facts">
}

function buildConstraints(ctx: Context): Constraint[] {
  const { def, refs } = ctx
  const body = localName(ctx.id)
  return (def.constraints ?? []).map((c) => {
    const where = `constraints.${c.id}.details`
    // A state requirement names a workflow and a state, not components, so there is nothing to resolve.
    const details = (
      c.kind === "required-state" ? c.details : mapStrings(c.details, (s) => refs.element(s, where))
    ) as Record<string, JsonValue>
    return {
      id: `constraint:${body}.${c.id}` as Constraint["id"],
      name: c.name ?? `${def.name}: ${c.id}`,
      kind: c.kind,
      description: c.description,
      subjects: [ctx.id],
      details,
      facts: {}
    }
  })
}

function validateDetails(
  ctx: Context,
  constraints: readonly Constraint[],
  regions: ReadonlySet<string>
): void {
  for (const c of constraints) {
    const local = c.id.slice(c.id.lastIndexOf(".") + 1)
    const parsed = constraintDetailsSchemas[c.kind as keyof typeof constraintDetailsSchemas].safeParse(
      c.details
    )
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      ctx.refs.problems.push({
        code: "governance.pattern-constraint-invalid",
        message: `${ctx.id} constraints.${local}: details do not fit a ${c.kind} constraint at ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "schema error"}`
      })
      continue
    }
    for (const s of stringsIn(parsed.data))
      if (s.startsWith("region:") && !regions.has(s))
        ctx.refs.problems.push({
          code: "governance.pattern-unknown-region",
          message: `${ctx.id} constraints.${local}: ${s} is not a region of this pattern${regions.size === 0 ? " (it defines no layout)" : `; its regions are ${[...regions].join(", ")}`}`
        })
  }
}

/** One fact per authored section, with the pattern's approval layered on when it has one. */
function factFor(ctx: Context, entity: { id: string }, path: string): FactRecord | undefined {
  const value = resolveFactPath(entity, path)
  if (!value.found) return undefined
  const base = { evidenceIds: [ctx.evidence.id] }
  const approval = ctx.def.approval
  if (!approval) return { status: "documented", ...base }
  return {
    status: "approved",
    ...base,
    approval: {
      approvedBy: approval.approvedBy,
      approvedAt: approval.approvedAt,
      ...(approval.role ? { role: approval.role } : {}),
      ...(approval.reference ? { reference: approval.reference } : {}),
      priorStatus: "documented",
      fingerprint: computeFactFingerprint({ entityId: entity.id, path, value: value.value })
    }
  }
}

function withFacts<T extends { id: string }>(
  ctx: Context,
  entity: T,
  paths: readonly string[]
): T & { facts: Record<string, FactRecord> } {
  const facts: Record<string, FactRecord> = {}
  for (const path of paths) {
    const f = factFor(ctx, entity, path)
    if (f) facts[path] = f
  }
  return { ...entity, facts }
}

function build(ctx: Context): Built {
  const constraints = buildConstraints(ctx)
  const draft = buildPattern(ctx)
  const regionRefs = new Set((draft.layout?.regions ?? []).map((r) => `region:${r.name}`))
  validateDetails(ctx, constraints, regionRefs)

  const components = new Set<string>()
  for (const s of [
    ...stringsIn(draft.composition),
    ...stringsIn(draft.layout),
    ...stringsIn(draft.variations),
    ...stringsIn(draft.relationships),
    ...constraints.flatMap((c) => stringsIn(c.details))
  ])
    if (s.startsWith("component:")) components.add(s)

  const entity = {
    ...draft,
    components: [...components].sort(),
    constraints: constraints.map((c) => c.id).sort(),
    ...(constraints.length === 0 ? { constraints: undefined } : {})
  } as Omit<Pattern, "facts"> & { constraints?: Pattern["constraints"] }
  if (entity.constraints === undefined) delete entity.constraints

  const paths = [
    "description",
    ...(entity.intent ? ["intent"] : []),
    ...(entity.composition ? ["composition"] : []),
    ...(entity.layout ? ["layout"] : []),
    ...(entity.behavior ? ["behavior"] : []),
    ...(entity.accessibility ? ["accessibility"] : []),
    ...(entity.appliesTo ? ["appliesTo"] : []),
    ...(entity.inheritsConstraints === undefined ? [] : ["inheritsConstraints"]),
    ...(entity.variations ?? []).map((v) => `variations.${v.name}`),
    ...(entity.relationships ?? []).map((r) => `relationships.${r.id}`)
  ]
  const pattern = withFacts(ctx, entity, paths) as Pattern
  const withConstraintFacts = constraints.map(
    (c) => withFacts(ctx, c, ["description", "details"]) as Constraint
  )

  const policies: Policy[] = []
  const body = localName(ctx.id)
  for (const [i, c] of (ctx.def.constraints ?? []).entries()) {
    if (!c.enforce) continue
    const approval = ctx.def.approval
    if (!approval) continue
    policies.push({
      id: `policy:${body}.${c.id}` as Policy["id"],
      name: (withConstraintFacts[i] as Constraint).name,
      statement: c.description,
      severity: c.enforce.severity,
      enforcement: c.enforce.enforcement ?? "block",
      scope: {
        entities: [ctx.id],
        ...(ctx.def.appliesTo?.frameworks ? { frameworks: ctx.def.appliesTo.frameworks } : {}),
        ...(ctx.def.appliesTo?.paths ? { paths: ctx.def.appliesTo.paths } : {})
      },
      basedOn: [`constraint:${body}.${c.id}` as Constraint["id"]],
      approval: {
        approvedBy: approval.approvedBy,
        approvedAt: approval.approvedAt,
        ...(approval.role ? { role: approval.role } : {}),
        ...(approval.reference ? { reference: approval.reference } : {})
      }
    })
  }
  return { pattern, constraints: withConstraintFacts, policies }
}

export interface PatternsSummary {
  /** Patterns added to the contract. */
  added: number
  /** Patterns left out because of a problem; each has an error diagnostic. */
  skipped: number
  constraints: number
  /** Policies generated for enforceable constraints of approved patterns. */
  policies: number
  /** Patterns whose facts are `documented` and wait for approval. */
  awaitingApproval: number
}

export interface CompiledPatterns {
  contract: ContractDraft
  /** Evidence for the facts added, to merge into the contract's evidence file. */
  evidence: Evidence[]
  diagnostics: Diagnostic[]
  summary: PatternsSummary
}

export interface CompilePatternsOptions {
  /** The definitions file's path as shown in diagnostics and evidence, relative to the project. */
  file: string
  /** The file's text, hashed into the source's version. */
  text: string
  clock: () => string
}

const SOURCE_CAPABILITIES = [
  "description",
  "intent",
  "composition",
  "layout",
  "behavior",
  "accessibility",
  "appliesTo",
  "inheritsConstraints",
  "variations.*",
  "relationships.*"
]

/**
 * Adds human-written pattern definitions to the contract: each becomes a pattern, its constraints, and (when
 * the pattern is approved and a constraint asks to be enforced) a policy. Facts are `documented`, or `approved`
 * when the definition carries an approval; nothing here infers or grants approval. A definition with an
 * unresolvable reference is left out whole and reported, so the contract never holds a half-resolved pattern.
 * Nothing already in the contract is changed.
 */
export function compilePatterns(
  draft: ContractDraft,
  file: PatternsFile,
  options: CompilePatternsOptions
): CompiledPatterns {
  const collector = new DiagnosticCollector()
  const summary: PatternsSummary = { added: 0, skipped: 0, constraints: 0, policies: 0, awaitingApproval: 0 }
  const at = { location: { path: options.file } }
  const idOf = (def: PatternDefinition): Pattern["id"] =>
    (def.id.startsWith("pattern:") ? def.id : `pattern:${def.id}`) as Pattern["id"]

  const taken = new Set([
    ...draft.patterns.map((p) => p.id as string),
    ...draft.constraints.map((c) => c.id as string),
    ...draft.policies.map((p) => p.id as string)
  ])
  const seen = new Set<string>()
  const eligible: PatternDefinition[] = []
  for (const def of file.patterns) {
    const id = idOf(def)
    if (seen.has(id)) {
      collector.add({
        code: "governance.pattern-duplicate-id",
        severity: "error",
        message: `${options.file}: ${id} is defined more than once; the first definition was used`,
        ...at
      })
      summary.skipped++
      continue
    }
    seen.add(id)
    if (draft.patterns.some((p) => p.id === id)) {
      collector.add({
        code: "governance.pattern-id-taken",
        severity: "error",
        message: `${options.file}: ${id} already exists in the contract (from another source) and was not added`,
        ...at
      })
      summary.skipped++
      continue
    }
    eligible.push(def)
  }

  const universe: Universe = {
    components: draft.components.map((c) => ({ id: c.id, name: c.name })),
    patterns: [
      ...draft.patterns.map((p) => ({ id: p.id as string, name: p.name })),
      ...eligible.map((d) => ({ id: idOf(d) as string, name: d.name }))
    ],
    tokens: draft.tokens.map((t) => ({ id: t.id, name: t.name })),
    guidelines: draft.guidelines.map((g) => ({ id: g.id, name: g.name }))
  }

  const patterns: Pattern[] = []
  const constraints: Constraint[] = []
  const policies: Policy[] = []
  const evidence: Evidence[] = []
  for (const def of eligible) {
    const id = idOf(def)
    const refs = new References(universe, id)
    const origin = {
      sourceId: PATTERN_SOURCE_ID,
      sourceRef: `${options.file}#${localName(id)}`,
      location: { type: "file" as const, path: options.file },
      method: "manual" as const,
      extractor: EXTRACTOR,
      original: `${def.name}: ${def.intent ?? def.description}`.slice(0, 2000)
    }
    const item: Evidence = {
      ...origin,
      id: computeEvidenceId(origin),
      verificationStatus: "unverified",
      capturedAt: options.clock()
    }
    const ctx: Context = {
      def,
      id,
      refs,
      evidence: item,
      approved: def.approval !== undefined,
      file: options.file
    }
    const built = build(ctx)
    // A reference that did not resolve is already reported; checking the half-built pattern would only repeat it.
    const structural = refs.problems.length === 0 ? patternSchema.safeParse(built.pattern) : undefined
    if (structural && !structural.success) {
      const issue = structural.error.issues[0]
      refs.problems.push({
        code: "governance.pattern-invalid",
        message: `${id} does not fit the contract at ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "schema error"}`
      })
    }
    const collisions = [
      ...built.constraints.map((c) => c.id as string),
      ...built.policies.map((p) => p.id as string)
    ].filter((x) => taken.has(x))
    for (const c of collisions)
      refs.problems.push({
        code: "governance.pattern-id-taken",
        message: `${id}: ${c} already exists in the contract`
      })
    for (const c of def.constraints ?? [])
      if (c.enforce && !def.approval)
        collector.add({
          code: "governance.pattern-policy-needs-approval",
          severity: "warning",
          message: `${options.file}: ${id} constraint "${c.id}" asks to be enforced, but the pattern has no approval; nothing infers one, so no policy was created. Add an approval block, or approve it and then add one.`,
          ...at
        })
    if (refs.problems.length > 0) {
      for (const p of refs.problems)
        collector.add({ code: p.code, severity: "error", message: `${options.file}: ${p.message}`, ...at })
      collector.add({
        code: "governance.pattern-skipped",
        severity: "error",
        message: `${options.file}: ${id} was not added to the contract because of the ${refs.problems.length} problem(s) above`,
        ...at
      })
      summary.skipped++
      continue
    }
    patterns.push(built.pattern)
    constraints.push(...built.constraints)
    policies.push(...built.policies)
    evidence.push(item)
    summary.added++
    summary.constraints += built.constraints.length
    summary.policies += built.policies.length
    if (!def.approval) summary.awaitingApproval++
  }

  const problems = collector.toArray().filter((d) => d.severity !== "info").length
  const sources: Source[] =
    summary.added + summary.skipped === 0
      ? draft.sources
      : [
          ...draft.sources.filter((s) => s.id !== PATTERN_SOURCE_ID),
          {
            id: PATTERN_SOURCE_ID,
            type: "patterns",
            location: options.file,
            version: { kind: "content-hash", value: sha256Hex(options.text) },
            capabilities: SOURCE_CAPABILITIES,
            health: { status: problems > 0 ? "degraded" : "ok", diagnosticCount: problems }
          } as Source
        ].sort(byId)

  return {
    contract: {
      ...draft,
      sources,
      patterns: [...draft.patterns, ...patterns].sort(byId),
      constraints: [...draft.constraints, ...constraints].sort(byId),
      policies: [...draft.policies, ...policies].sort(byId)
    },
    evidence,
    diagnostics: collector.toArray(),
    summary
  }
}
