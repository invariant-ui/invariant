import {
  type Component,
  type ConstraintDetails,
  constraintDetailsSchemas,
  type EvidenceLevel,
  effectiveParts,
  isPatternConstraintKind,
  type Pattern,
  type PatternConstraintKind
} from "@invariant/contract"
import type { DesignSystem } from "@invariant/contract-query"
import { globToRegExp } from "@invariant/shared"
import { analyzeInteractions, type InteractionSite } from "./interaction-workflows.js"
import type { Severity } from "./rules.js"
import type { ScannedUse } from "./scan.js"
import type { Finding } from "./validate-usage.js"

/*
 * Structural checks from approved pattern constraints, over the element tree of one React file.
 *
 * What a check may say:
 *   pass            it was evaluated and holds
 *   fail            it was evaluated and is violated
 *   warning         it holds only if conditionally rendered elements render, or might be exceeded
 *   not-verifiable  this analysis cannot establish it (content from another file, dynamic children)
 *   skipped         it applies here but cannot be evaluated (see the reason)
 * Absence is never proven in a scope that is not closed, and a requirement that cannot be established is
 * never reported as a pass.
 */

export type EvaluationStatus = "pass" | "fail" | "warning" | "not-verifiable" | "skipped"

export interface Evaluation {
  /** The rule code, also the code of the finding a fail or warning produces. */
  rule: string
  status: EvaluationStatus
  reason: string
  pattern: string
  constraint: string
  policy: string
  file?: string
  line?: number
  column?: number
  /**
   * For interaction checks that found what they looked for: how much that establishes. `structural` means the code
   * has the piece and shows it; `static-inferred` means a handler's code shows it happening. Static analysis never
   * produces `runtime-verified`, which is reserved for results of running the code.
   */
  level?: EvidenceLevel
  /** What was seen, with lines. */
  evidence?: string[]
  /** Set when the rule applies to this file through a page pattern's opt-in inheritance, not through its own policy. */
  inheritedFrom?: string
}

export interface PatternRule {
  policy: string
  pattern: string
  constraint: string
  kind: PatternConstraintKind
  details: ConstraintDetails[PatternConstraintKind]
  severity: Severity
  paths: readonly string[]
  frameworks: readonly string[]
  /** Where the constraint is written, for findings. */
  source?: string
  /** The page pattern whose opt-in inheritance put this rule on these paths. Absent for a rule the policy itself scopes. */
  inheritedFrom?: string
}

const CODE: Record<PatternConstraintKind, string> = {
  "required-child": "pattern-required-child-missing",
  "forbidden-child": "pattern-child-forbidden",
  "requires-parent": "pattern-parent-required",
  "required-region": "pattern-region-missing",
  ordering: "pattern-order-violated",
  cardinality: "pattern-cardinality-violated",
  "required-state": "pattern-state-missing"
}
export const PATTERN_RULE_CODES: readonly string[] = Object.values(CODE)
export const patternRuleCode = (kind: PatternConstraintKind): string => CODE[kind]

/** What one element of the file is, for deciding whether a scope can be trusted to be complete. */
export type UseKind = "component" | "native" | "foreign" | "unknown" | "ambiguous"

export interface Tree {
  uses: readonly ScannedUse[]
  components: ReadonlyArray<Component | undefined>
  kinds: readonly UseKind[]
}

const capped = (severity: Severity, enforcement: string): Severity =>
  enforcement === "report-only"
    ? "info"
    : enforcement === "warn" && severity === "error"
      ? "warning"
      : severity

/**
 * The structural rules approved policies carry. A policy carries one when it is based on a constraint of a
 * pattern kind; its `details` are parsed here and a constraint that does not parse is reported, not enforced.
 */
export function patternRules(ds: DesignSystem): { rules: PatternRule[]; problems: string[] } {
  const rules: PatternRule[] = []
  const problems: string[] = []
  for (const policy of ds.contract.policies)
    for (const id of policy.basedOn) {
      const constraint = ds.contract.constraints.find((c) => c.id === id)
      if (!constraint || !isPatternConstraintKind(constraint.kind)) continue
      const owner = ds.contract.patterns.find((p) => p.constraints?.includes(constraint.id))
      const parsed = constraintDetailsSchemas[constraint.kind].safeParse(constraint.details)
      if (!owner || !parsed.success) {
        problems.push(
          `policy ${policy.id}: ${constraint.id} ${owner ? "has details that do not fit its kind" : "belongs to no pattern"}`
        )
        continue
      }
      const source = ds.location(constraint.facts.description?.evidenceIds ?? [])
      rules.push({
        policy: policy.id,
        pattern: owner.id,
        constraint: constraint.id,
        kind: constraint.kind,
        details: parsed.data,
        severity: capped(policy.severity, policy.enforcement),
        paths: policy.scope.paths ?? [],
        frameworks: policy.scope.frameworks ?? [],
        ...(source ? { source } : {})
      })
    }
  return { rules: [...rules, ...inheritedRules(ds, rules)], problems }
}

/** Every pattern a pattern composes, in the base blueprint and every variation, followed through patterns it uses. */
function composedPatterns(ds: DesignSystem, root: Pattern): Set<string> {
  const byId = new Map<string, Pattern>(ds.contract.patterns.map((p) => [p.id, p]))
  const seen = new Set<string>()
  const queue: Pattern[] = [root]
  for (let next = queue.shift(); next; next = queue.shift()) {
    const ids = [undefined, ...(next.variations ?? []).map((v) => v.name)]
    for (const v of ids)
      for (const part of effectiveParts(next, v)) {
        const target = byId.get(part.ref)
        if (!target || seen.has(target.id) || target.id === root.id) continue
        seen.add(target.id)
        queue.push(target)
      }
  }
  return seen
}

/**
 * Constraint inheritance is opt in and needs approval. A page pattern that sets `inheritsConstraints` and names
 * `appliesTo.paths` puts the rules of everything it composes onto those paths. Both settings must be approved facts,
 * so a definition nobody approved enforces nothing, and no rule is created that an approved policy did not already carry.
 */
function inheritedRules(ds: DesignSystem, base: readonly PatternRule[]): PatternRule[] {
  const out: PatternRule[] = []
  for (const page of ds.contract.patterns) {
    const paths = page.appliesTo?.paths
    if (page.inheritsConstraints !== true || !paths) continue
    if (page.facts.appliesTo?.status !== "approved" || page.facts.inheritsConstraints?.status !== "approved")
      continue
    const composed = composedPatterns(ds, page)
    for (const rule of base) {
      if (!composed.has(rule.pattern)) continue
      out.push({
        ...rule,
        paths,
        frameworks: page.appliesTo?.frameworks ?? rule.frameworks,
        inheritedFrom: page.id
      })
    }
  }
  return out
}

type Matcher = { ok: true; test: (i: number) => boolean; describe: string } | { ok: false; reason: string }

export interface PatternEvaluation {
  evaluations: Evaluation[]
  findings: Finding[]
}

interface Ctx {
  ds: DesignSystem
  tree: Tree
  rule: PatternRule
  owner: Pattern | undefined
  filename: string | undefined
  children: number[][]
  out: PatternEvaluation
  interactions: () => InteractionSite[]
}

const PRECEDENCE: EvaluationStatus[] = ["fail", "warning", "not-verifiable", "pass", "skipped"]

const depthOf = (t: Tree, i: number): number => t.uses[i]?.exprDepth ?? 0
const loopOf = (t: Tree, i: number): number => t.uses[i]?.loopDepth ?? 0
const nameOf = (ctx: Ctx, ref: string): string =>
  ref.startsWith("region:") ? ref : (ctx.ds.component(ref)?.name ?? ref.replace(/^[a-z]+:/, ""))

function matcher(ctx: Ctx, ref: string): Matcher {
  if (ref.startsWith("pattern:"))
    return {
      ok: false,
      reason: `${ref} is a pattern, and occurrences of a pattern are not detected statically yet`
    }
  if (ref.startsWith("region:")) {
    const name = ref.slice("region:".length)
    const parts = (ctx.owner?.composition?.parts ?? []).filter(
      (p) => p.region === name && p.role !== "prohibited"
    )
    const ids = new Set(parts.filter((p) => p.ref.startsWith("component:")).map((p) => p.ref as string))
    if (ids.size === 0)
      return {
        ok: false,
        reason: `region ${name} has no component parts to recognize it by; give a composition part that region`
      }
    return {
      ok: true,
      describe: `region ${name}`,
      test: (i) => {
        const c = ctx.tree.components[i]
        return c !== undefined && ids.has(c.id)
      }
    }
  }
  return {
    ok: true,
    describe: nameOf(ctx, ref),
    test: (i) => ctx.tree.components[i]?.id === ref
  }
}

function descendants(ctx: Ctx, root: number): number[] {
  const out: number[] = []
  const walk = (i: number): void => {
    for (const c of ctx.children[i] ?? []) {
      out.push(c)
      walk(c)
    }
  }
  walk(root)
  return out.sort((a, b) => a - b)
}

/** True when nothing in the scope can hide elements: no other-file component and no opaque children. */
function closed(ctx: Ctx, scope: readonly number[]): { ok: true } | { ok: false; why: string } {
  for (const i of scope) {
    const use = ctx.tree.uses[i] as ScannedUse
    const kind = ctx.tree.kinds[i] as UseKind
    if (kind === "foreign" || kind === "unknown" || kind === "ambiguous")
      return {
        ok: false,
        why: `<${use.tag}> at line ${use.line} comes from outside the design system and may render more`
      }
    if (use.opaque)
      return {
        ok: false,
        why: `<${use.tag}> at line ${use.line} gets content from outside what this file shows (children, a spread or an expression)`
      }
  }
  return { ok: true }
}

function record(
  ctx: Ctx,
  status: EvaluationStatus,
  reason: string,
  at: { line?: number; column?: number } | undefined,
  suggestion?: string,
  extra?: { level?: EvidenceLevel; evidence?: string[] }
): undefined {
  const { rule } = ctx
  const code = CODE[rule.kind]
  ctx.out.evaluations.push({
    rule: code,
    status,
    reason,
    pattern: rule.pattern,
    constraint: rule.constraint,
    policy: rule.policy,
    ...(ctx.filename ? { file: ctx.filename } : {}),
    ...(at?.line === undefined ? {} : { line: at.line }),
    ...(at?.column === undefined ? {} : { column: at.column }),
    ...(extra?.level ? { level: extra.level } : {}),
    ...(extra?.evidence && extra.evidence.length > 0 ? { evidence: extra.evidence } : {}),
    ...(rule.inheritedFrom ? { inheritedFrom: rule.inheritedFrom } : {})
  })
  if (status !== "fail" && status !== "warning") return
  ctx.out.findings.push({
    code,
    severity: status === "warning" && rule.severity === "error" ? "warning" : rule.severity,
    message: `${reason} (pattern ${rule.pattern}${rule.inheritedFrom ? `, inherited through ${rule.inheritedFrom}` : ""})`,
    subject: rule.pattern,
    ...(at?.line === undefined ? {} : { line: at.line }),
    ...(at?.column === undefined ? {} : { column: at.column }),
    basis: "approved",
    policy: rule.policy,
    ...(rule.source ? { source: rule.source } : {}),
    ...(suggestion ? { suggestion } : {})
  })
}

const at = (ctx: Ctx, i: number): { line: number; column: number } => ({
  line: (ctx.tree.uses[i] as ScannedUse).line,
  column: (ctx.tree.uses[i] as ScannedUse).column
})

/** A scope is the whole file, or the subtree of one element. Returns the indices inside it. */
function scopeOf(ctx: Ctx, within: number | undefined): number[] {
  return within === undefined ? ctx.tree.uses.map((_, i) => i) : descendants(ctx, within)
}

/**
 * Matches in a scope. `certain` ones render exactly once relative to the scope's root; `repeated` ones sit in a
 * callback (a list, a render prop) and may render any number of times, so they can never prove an upper bound.
 */
function counts(
  ctx: Ctx,
  scope: readonly number[],
  test: (i: number) => boolean,
  baseDepth: number,
  baseLoop = 0
) {
  const matched = scope.filter(test)
  return {
    all: matched,
    certain: matched.filter((i) => depthOf(ctx.tree, i) <= baseDepth),
    repeated: matched.filter((i) => loopOf(ctx.tree, i) > baseLoop)
  }
}

function evaluateRequiredChild(ctx: Ctx, d: ConstraintDetails["required-child"]): undefined {
  const parent = matcher(ctx, d.parent)
  const child = matcher(ctx, d.child)
  if (!parent.ok || !child.ok) {
    record(ctx, "not-verifiable", (!parent.ok ? parent : (child as { reason: string })).reason, undefined)
    return
  }
  const min = d.min ?? 1
  const each = (p: number): undefined => {
    if (!parent.test(p)) return
    const scope = descendants(ctx, p)
    const { all, certain } = counts(ctx, scope, child.test, depthOf(ctx.tree, p))
    const label = `${parent.describe} at line ${at(ctx, p).line}`
    if (certain.length >= min) return record(ctx, "pass", `${label} contains ${child.describe}`, at(ctx, p))
    if (all.length >= min)
      return record(
        ctx,
        "warning",
        `${label} contains ${child.describe} only conditionally, so it may be missing when rendered`,
        at(ctx, p),
        `Render ${child.describe} unconditionally inside ${parent.describe}.`
      )
    const c = closed(ctx, [p, ...scope])
    if (!c.ok)
      return record(
        ctx,
        "not-verifiable",
        `${label}: cannot tell whether it contains ${child.describe}; ${c.why}`,
        at(ctx, p)
      )
    record(
      ctx,
      "fail",
      `${label} has no ${child.describe}${min > 1 ? ` (needs ${min})` : ""}`,
      at(ctx, p),
      `Add ${child.describe} inside ${parent.describe}.`
    )
  }
  for (const p of ctx.tree.uses.keys()) each(p)
}

function evaluateForbiddenChild(ctx: Ctx, d: ConstraintDetails["forbidden-child"]): undefined {
  const parent = matcher(ctx, d.parent)
  const child = matcher(ctx, d.child)
  if (!parent.ok || !child.ok) {
    record(ctx, "not-verifiable", (!parent.ok ? parent : (child as { reason: string })).reason, undefined)
    return
  }
  const each = (p: number): undefined => {
    if (!parent.test(p)) return
    const scope = descendants(ctx, p)
    const label = `${parent.describe} at line ${at(ctx, p).line}`
    const found = scope.find(child.test)
    if (found !== undefined)
      return record(
        ctx,
        "fail",
        `${label} contains ${child.describe} at line ${at(ctx, found).line}, which is not allowed there`,
        at(ctx, found),
        `Remove ${child.describe} from inside ${parent.describe}.`
      )
    const c = closed(ctx, [p, ...scope])
    if (!c.ok)
      return record(
        ctx,
        "not-verifiable",
        `${label}: cannot tell whether it avoids ${child.describe}; ${c.why}`,
        at(ctx, p)
      )
    record(ctx, "pass", `${label} does not contain ${child.describe}`, at(ctx, p))
  }
  for (const p of ctx.tree.uses.keys()) each(p)
}

function evaluateRequiresParent(ctx: Ctx, d: ConstraintDetails["requires-parent"]): undefined {
  const child = matcher(ctx, d.child)
  const parents = d.parents.map((p) => matcher(ctx, p))
  const bad = [child, ...parents].find((m) => !m.ok)
  if (bad && !bad.ok) {
    record(ctx, "not-verifiable", bad.reason, undefined)
    return
  }
  const okParents = parents as Array<Extract<Matcher, { ok: true }>>
  const okChild = child as Extract<Matcher, { ok: true }>
  const names = okParents.map((m) => m.describe).join(" or ")
  const each = (i: number): undefined => {
    const use = ctx.tree.uses[i] as ScannedUse
    if (!okChild.test(i)) return
    const chain: number[] = []
    for (let p = use.parent; p !== undefined; p = ctx.tree.uses[p]?.parent) chain.push(p)
    const label = `${okChild.describe} at line ${use.line}`
    if (chain.some((a) => okParents.some((m) => m.test(a))))
      return record(ctx, "pass", `${label} is inside ${names}`, at(ctx, i))
    const designSystemAncestors = chain.filter((a) => ctx.tree.components[a] !== undefined)
    if (designSystemAncestors.length === 0)
      return record(
        ctx,
        "not-verifiable",
        `${label}: no design-system element encloses it in this file, so its parent may be in another file`,
        at(ctx, i)
      )
    record(
      ctx,
      "fail",
      `${label} must be inside ${names}, but sits inside ${nameOf(ctx, ctx.tree.components[designSystemAncestors[0] as number]?.id ?? "")} instead`,
      at(ctx, i),
      `Wrap it in ${names}.`
    )
  }
  for (const i of ctx.tree.uses.keys()) each(i)
}

/** A file-level scope needs the policy to say which files are instances of the pattern. */
function fileLevel(ctx: Ctx): boolean {
  if (ctx.rule.paths.length > 0) return true
  record(
    ctx,
    "skipped",
    "this rule is about a whole file, and the policy names no paths (appliesTo.paths), so there is no way to know this file is an instance of the pattern",
    undefined
  )
  return false
}

function evaluateRequiredRegion(ctx: Ctx, d: ConstraintDetails["required-region"]): undefined {
  const region = matcher(ctx, d.region)
  if (!region.ok) return record(ctx, "not-verifiable", region.reason, undefined)
  if (!fileLevel(ctx)) return
  const all = ctx.tree.uses.map((_, i) => i)
  const { all: found, certain } = counts(ctx, all, region.test, 0)
  if (certain.length > 0)
    return record(ctx, "pass", `${region.describe} is present`, at(ctx, certain[0] as number))
  if (found.length > 0)
    return record(
      ctx,
      "warning",
      `${region.describe} appears only conditionally, so it may be missing when rendered`,
      at(ctx, found[0] as number),
      `Render ${region.describe} unconditionally.`
    )
  const c = closed(ctx, all)
  if (!c.ok)
    return record(ctx, "not-verifiable", `cannot tell whether ${region.describe} is present; ${c.why}`, {
      line: 1,
      column: 1
    })
  record(
    ctx,
    "fail",
    `${region.describe} is missing`,
    { line: 1, column: 1 },
    `Add the components that make up ${region.describe}.`
  )
}

function evaluateOrdering(ctx: Ctx, d: ConstraintDetails["ordering"]): undefined {
  const before = matcher(ctx, d.before)
  const after = matcher(ctx, d.after)
  const within = d.within === undefined ? undefined : matcher(ctx, d.within)
  const bad = [before, after, within].find((m) => m !== undefined && !m.ok)
  if (bad && !bad.ok) return record(ctx, "not-verifiable", bad.reason, undefined)
  if (d.within?.startsWith("region:"))
    return record(ctx, "not-verifiable", "ordering within a region is not evaluated yet", undefined)
  const b = before as Extract<Matcher, { ok: true }>
  const a = after as Extract<Matcher, { ok: true }>
  const scopes: Array<{ root: number | undefined; label: string }> =
    within === undefined
      ? [{ root: undefined, label: "this file" }]
      : ctx.tree.uses.flatMap((_, i) =>
          (within as Extract<Matcher, { ok: true }>).test(i)
            ? [
                {
                  root: i,
                  label: `${(within as Extract<Matcher, { ok: true }>).describe} at line ${at(ctx, i).line}`
                }
              ]
            : []
        )
  if (within === undefined && !fileLevel(ctx)) return
  for (const { root, label } of scopes) {
    const scope = scopeOf(ctx, root)
    const bs = scope.filter(b.test)
    const as = scope.filter(a.test)
    const where = root === undefined ? undefined : at(ctx, root)
    if (bs.length === 0 || as.length === 0) {
      record(ctx, "skipped", `${label}: no ${bs.length === 0 ? b.describe : a.describe} to order`, where)
      continue
    }
    const early = as.find((x) => bs.some((y) => y > x && !isAncestor(ctx, x, y) && !isAncestor(ctx, y, x)))
    if (early !== undefined) {
      const late = bs.find((y) => y > early) as number
      record(
        ctx,
        "fail",
        `${label}: ${a.describe} (line ${at(ctx, early).line}) comes before ${b.describe} (line ${at(ctx, late).line}); ${b.describe} must come first`,
        at(ctx, early),
        `Move ${b.describe} before ${a.describe}.`
      )
      continue
    }
    const c = closed(ctx, root === undefined ? scope : [root, ...scope])
    if (!c.ok) record(ctx, "not-verifiable", `${label}: order looks right, but ${c.why}`, where)
    else record(ctx, "pass", `${label}: ${b.describe} comes before ${a.describe}`, where)
  }
}

function isAncestor(ctx: Ctx, ancestor: number, of: number): boolean {
  for (let p = ctx.tree.uses[of]?.parent; p !== undefined; p = ctx.tree.uses[p]?.parent)
    if (p === ancestor) return true
  return false
}

function evaluateCardinality(ctx: Ctx, d: ConstraintDetails["cardinality"]): undefined {
  const target = matcher(ctx, d.target)
  const within = d.within === undefined ? undefined : matcher(ctx, d.within)
  const bad = [target, within].find((m) => m !== undefined && !m.ok)
  if (bad && !bad.ok) return record(ctx, "not-verifiable", bad.reason, undefined)
  if (d.within?.startsWith("region:"))
    return record(ctx, "not-verifiable", "counting within a region is not evaluated yet", undefined)
  const t = target as Extract<Matcher, { ok: true }>
  const w = within as Extract<Matcher, { ok: true }> | undefined
  if (w === undefined && !fileLevel(ctx)) return
  const scopes =
    w === undefined
      ? [{ root: undefined as number | undefined, label: "this file" }]
      : ctx.tree.uses.flatMap((_, i) =>
          w.test(i)
            ? [{ root: i as number | undefined, label: `${w.describe} at line ${at(ctx, i).line}` }]
            : []
        )
  for (const { root, label } of scopes) {
    const scope = scopeOf(ctx, root)
    const base = root === undefined ? 0 : depthOf(ctx.tree, root)
    const { all, certain, repeated } = counts(
      ctx,
      scope,
      t.test,
      base,
      root === undefined ? 0 : loopOf(ctx.tree, root)
    )
    const where = root === undefined ? undefined : at(ctx, root)
    const range = `${d.min !== undefined ? `at least ${d.min}` : ""}${d.min !== undefined && d.max !== undefined ? " and " : ""}${d.max !== undefined ? `at most ${d.max}` : ""}`
    const seal = closed(ctx, root === undefined ? scope : [root, ...scope])
    const outcomes: Array<{
      status: EvaluationStatus
      reason: string
      at?: { line: number; column: number }
      fix?: string
    }> = []
    if (d.max !== undefined) {
      if (certain.length > d.max)
        outcomes.push({
          status: "fail",
          reason: `${label} has ${certain.length} ${t.describe}, but ${range} are allowed`,
          at: at(ctx, certain[d.max] as number),
          fix: `Keep at most ${d.max} ${t.describe}.`
        })
      else if (repeated.length > 0)
        outcomes.push({
          status: "warning",
          reason: `${label} renders ${t.describe} in a list or callback, so there may be more than ${d.max}`,
          at: at(ctx, repeated[0] as number)
        })
      else if (all.length > d.max)
        outcomes.push({
          status: "warning",
          reason: `${label} may have more than ${d.max} ${t.describe} when conditional ones render`,
          ...(all[0] === undefined ? {} : { at: at(ctx, all[0]) })
        })
      else if (!seal.ok)
        outcomes.push({
          status: "not-verifiable",
          reason: `${label}: ${all.length} ${t.describe} seen (at most ${d.max} allowed), but ${seal.why}`
        })
      else
        outcomes.push({
          status: "pass",
          reason: `${label} has ${all.length} ${t.describe}, within the limit of ${d.max}`
        })
    }
    if (d.min !== undefined) {
      if (certain.length >= d.min)
        outcomes.push({
          status: "pass",
          reason: `${label} has ${certain.length} ${t.describe}, at least ${d.min}`
        })
      else if (all.length >= d.min)
        outcomes.push({
          status: "warning",
          reason: `${label} reaches ${d.min} ${t.describe} only with conditionally rendered ones`,
          ...(all[0] === undefined ? {} : { at: at(ctx, all[0]) }),
          fix: `Render ${t.describe} unconditionally.`
        })
      else if (!seal.ok)
        outcomes.push({
          status: "not-verifiable",
          reason: `${label}: ${all.length} ${t.describe} seen (needs ${d.min}), but ${seal.why}`
        })
      else
        outcomes.push({
          status: "fail",
          reason: `${label} has ${all.length} ${t.describe}, but needs at least ${d.min}`,
          at: where ?? { line: 1, column: 1 },
          fix: `Add ${t.describe}.`
        })
    }
    const worst = PRECEDENCE.find((s) => outcomes.some((o) => o.status === s)) as EvaluationStatus
    const picked = outcomes.filter((o) => o.status === worst)
    record(
      ctx,
      worst,
      picked.map((o) => o.reason).join("; "),
      picked[0]?.at ?? where,
      picked.find((o) => o.fix)?.fix
    )
  }
}

const STATE_FIX: Record<string, string> = {
  "form-submission:submitting":
    "Show that the form is submitting, for example disable the submit button and show progress.",
  "form-submission:error": "Show an error message, and a way to try again, when the submission fails.",
  "form-submission:success": "Confirm the result, for example with a message or by navigating on success.",
  "form-submission:guarded":
    "Disable the submit button, or return early in the handler, while the form is pending.",
  "destructive-confirmation:confirming": "Ask for confirmation, for example in a dialog, before deleting.",
  "destructive-confirmation:cancellable":
    "Give the confirmation a Cancel button that closes it without deleting.",
  "search-results:connected": "Use the search text to filter or fetch the results.",
  "search-results:loading": "Show a loading state while the results load.",
  "search-results:empty": "Show an empty state when the search finds nothing.",
  "search-results:error": "Show an error state when the search fails.",
  "search-results:clearable": "Give the user a way to clear the search."
}
const LEVEL_RANK = { structural: 1, "static-inferred": 2 } as const

/**
 * A workflow state the code must represent. The result says how it was established. A state found only
 * structurally when the rule asks for more is a warning, and one the file hides is not verifiable.
 */
function evaluateRequiredState(ctx: Ctx, d: ConstraintDetails["required-state"]): undefined {
  const minimum = d.minimum ?? "structural"
  for (const site of ctx.interactions().filter((s) => s.workflow === d.workflow)) {
    const check = site.states[d.state]
    const where = { line: site.line, column: site.column }
    if (!check) {
      record(ctx, "not-verifiable", `${site.label}: ${d.state} is not a state this analysis looks for`, where)
    } else if (check.level) {
      const extra = { level: check.level, evidence: check.evidence }
      if (LEVEL_RANK[check.level] >= LEVEL_RANK[minimum])
        record(
          ctx,
          "pass",
          `${site.label}: ${d.state} is represented (${check.level})`,
          where,
          undefined,
          extra
        )
      else
        record(
          ctx,
          "warning",
          `${site.label}: ${d.state} is represented only structurally; the rule asks for evidence that the code makes it happen (${minimum})`,
          where,
          STATE_FIX[`${d.workflow}:${d.state}`],
          extra
        )
    } else if (check.open)
      record(
        ctx,
        "not-verifiable",
        `${site.label}: cannot tell whether ${d.state} is represented; ${check.open}`,
        where
      )
    else
      record(
        ctx,
        "fail",
        `${site.label}: ${d.state} is not represented; ${check.absent ?? "nothing shows it"}`,
        where,
        STATE_FIX[`${d.workflow}:${d.state}`]
      )
  }
  return undefined
}

const framework = (rule: PatternRule, name: string): boolean =>
  rule.frameworks.length === 0 || rule.frameworks.includes(name)

/**
 * Evaluates the structural rules that apply to one file. A rule applies when the policy's frameworks include
 * the file's framework and, if the policy names paths, the file matches one. Rules for other files are not
 * recorded: they are not part of this file's result.
 */
/**
 * One policy and constraint is evaluated once per file. When inheritance gives a rule a second route to the file,
 * the route that says most wins: the policy's own paths, then inherited paths, then no paths at all.
 */
function shadowedRules(
  rules: readonly PatternRule[],
  frameworkName: string,
  filename: string | undefined
): Set<PatternRule> {
  const shadowed = new Set<PatternRule>()
  if (!rules.some((r) => r.inheritedFrom)) return shadowed
  const name = filename?.replace(/^\.\//, "")
  const applies = (r: PatternRule): boolean =>
    framework(r, frameworkName) &&
    (r.paths.length === 0 || (name !== undefined && r.paths.some((g) => globToRegExp(g).test(name))))
  const rank = (r: PatternRule): number => (r.inheritedFrom ? 1 : r.paths.length > 0 ? 0 : 2)
  const best = new Map<string, PatternRule>()
  for (const r of rules) {
    if (!applies(r)) continue
    const key = `${r.policy}|${r.constraint}`
    const held = best.get(key)
    if (!held || rank(r) < rank(held)) best.set(key, r)
  }
  for (const r of rules) if (applies(r) && best.get(`${r.policy}|${r.constraint}`) !== r) shadowed.add(r)
  return shadowed
}

export function evaluatePatternRules(input: {
  ds: DesignSystem
  rules: readonly PatternRule[]
  tree: Tree
  framework: string
  filename: string | undefined
  /** The file's text, for the checks that read handlers and state rather than the element tree. */
  code?: string | undefined
}): PatternEvaluation {
  const out: PatternEvaluation = { evaluations: [], findings: [] }
  const children: number[][] = input.tree.uses.map(() => [])
  input.tree.uses.forEach((u, i) => {
    if (u.parent !== undefined) children[u.parent]?.push(i)
  })
  let model: InteractionSite[] | undefined
  const interactions = (): InteractionSite[] => {
    if (model) return model
    const components = new Set(
      input.tree.uses.filter((_, i) => input.tree.kinds[i] === "component").map((u) => u.tag)
    )
    model =
      input.code === undefined
        ? []
        : analyzeInteractions(input.code, input.filename ?? "snippet.tsx", components)
    return model
  }
  const shadowed = shadowedRules(input.rules, input.framework, input.filename)
  for (const rule of input.rules) {
    if (shadowed.has(rule)) continue
    if (!framework(rule, input.framework)) continue
    if (rule.paths.length > 0) {
      if (input.filename === undefined) {
        out.evaluations.push({
          rule: CODE[rule.kind],
          status: "skipped",
          reason: "the policy applies to certain paths and no file name was given, so it was not checked",
          pattern: rule.pattern,
          constraint: rule.constraint,
          policy: rule.policy
        })
        continue
      }
      const name = input.filename.replace(/^\.\//, "")
      if (!rule.paths.some((g) => globToRegExp(g).test(name))) continue
    }
    const ctx: Ctx = {
      ds: input.ds,
      tree: input.tree,
      rule,
      owner: input.ds.contract.patterns.find((p) => p.id === rule.pattern),
      filename: input.filename,
      children,
      out,
      interactions
    }
    if (input.framework !== "react") {
      record(
        ctx,
        "skipped",
        `pattern rules are evaluated for React JSX only; ${input.framework} templates are not analyzed for patterns yet`,
        undefined
      )
      continue
    }
    switch (rule.kind) {
      case "required-child":
        evaluateRequiredChild(ctx, rule.details as ConstraintDetails["required-child"])
        break
      case "forbidden-child":
        evaluateForbiddenChild(ctx, rule.details as ConstraintDetails["forbidden-child"])
        break
      case "requires-parent":
        evaluateRequiresParent(ctx, rule.details as ConstraintDetails["requires-parent"])
        break
      case "required-region":
        evaluateRequiredRegion(ctx, rule.details as ConstraintDetails["required-region"])
        break
      case "ordering":
        evaluateOrdering(ctx, rule.details as ConstraintDetails["ordering"])
        break
      case "cardinality":
        evaluateCardinality(ctx, rule.details as ConstraintDetails["cardinality"])
        break
      case "required-state":
        evaluateRequiredState(ctx, rule.details as ConstraintDetails["required-state"])
        break
    }
  }
  return out
}
