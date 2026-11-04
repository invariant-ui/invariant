import { type Component, type Contract, isPatternConstraintKind } from "@invariant/contract"
import { type DesignSystem, normalize } from "@invariant/contract-query"
import { z } from "zod"
import type { Severity } from "./rules.js"
import type { ScannedUse } from "./scan.js"
import type { Finding } from "./validate-usage.js"
import { isDynamic } from "./validate-usage.js"

const names = z.array(z.string().min(1).max(200)).min(1).max(200)
const scalar = z.union([z.string(), z.number(), z.boolean()])

/**
 * What an approved policy enforces, in a form the validator can evaluate. Written by people in
 * `invariant.policies.json`, normalized by governance into a constraint's `extensions.invariant.rule`.
 */
export const policyRuleSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("require-attribute"),
    components: names,
    anyOf: names,
    unlessChildren: z.boolean().optional(),
    category: z.enum(["accessibility", "general"]).optional()
  }),
  z.strictObject({
    kind: z.literal("forbid-prop"),
    component: z.string().min(1).max(200),
    prop: z.string().min(1).max(200),
    replacedBy: z.string().min(1).max(200).optional()
  }),
  z.strictObject({
    kind: z.literal("forbid-prop-value"),
    component: z.string().min(1).max(200),
    prop: z.string().min(1).max(200),
    values: z.array(scalar).min(1).max(100)
  }),
  z.strictObject({
    kind: z.literal("forbid-component"),
    component: z.string().min(1).max(200),
    use: z.string().min(1).max(200).optional()
  }),
  z.strictObject({
    kind: z.literal("forbid-token"),
    tokens: names,
    replacedBy: z.string().min(1).max(200).optional()
  }),
  z.strictObject({
    kind: z.literal("allowed-children"),
    container: z.string().min(1).max(200),
    children: names,
    category: z.enum(["layout", "composition"]).optional()
  }),
  z.strictObject({
    kind: z.literal("required-parent"),
    component: z.string().min(1).max(200),
    parents: names
  })
])
export type PolicyRule = z.infer<typeof policyRuleSchema>

export interface ActivePolicy {
  /** Empty for rules that come from the contract's own relationships. */
  policyId: string
  name: string
  severity: Severity
  rule: PolicyRule
  source?: string
}

const capped = (severity: Severity, enforcement: string): Severity =>
  enforcement === "report-only"
    ? "info"
    : enforcement === "warn" && severity === "error"
      ? "warning"
      : severity

/** Approved policies and the rules they carry. A policy whose rule cannot be read is reported, not enforced. */
export function activePolicies(contract: Contract): { active: ActivePolicy[]; problems: string[] } {
  const active: ActivePolicy[] = []
  const problems: string[] = []
  for (const policy of contract.policies) {
    for (const id of policy.basedOn) {
      const constraint = contract.constraints.find((c) => c.id === id)
      // Structural pattern constraints are evaluated by `pattern-rules.ts`, not as component-level rules.
      if (constraint && isPatternConstraintKind(constraint.kind)) continue
      const raw =
        (constraint?.extensions?.invariant as { rule?: unknown; source?: unknown } | undefined) ?? {}
      const parsed = policyRuleSchema.safeParse(raw.rule)
      if (!constraint || !parsed.success) {
        problems.push(`policy ${policy.id}: ${id} has no readable rule`)
        continue
      }
      active.push({
        policyId: policy.id,
        name: policy.name,
        severity: capped(policy.severity, policy.enforcement),
        rule: parsed.data,
        ...(typeof raw.source === "string" ? { source: raw.source } : {})
      })
    }
  }
  return { active, problems }
}

/** `requires-parent` relationships the contract itself records, as rules (inferred ones are not enforced). */
export function relationshipRules(ds: DesignSystem): ActivePolicy[] {
  const out: ActivePolicy[] = []
  for (const c of ds.contract.components)
    c.composition.forEach((r, i) => {
      if (r.type !== "requires-parent") return
      const status = c.facts[`composition.${i}`]?.status
      if (status === "inferred") return
      out.push({
        policyId: "",
        name: `${c.name} requires a parent`,
        severity: "error",
        rule: { kind: "required-parent", component: c.id, parents: [r.target] }
      })
    })
  return out
}

const same = (a: string, b: string): boolean =>
  normalize(a.replace(/^component:/, "")) === normalize(b.replace(/^component:/, ""))
const matches = (c: Component, ref: string): boolean => c.id === ref || same(c.name, ref) || same(c.id, ref)

export interface UseContext {
  uses: readonly ScannedUse[]
  /** The design-system component each use resolved to, if any. */
  resolved: ReadonlyArray<Component | undefined>
}

const ref = (p: ActivePolicy): Pick<Finding, "policy" | "source" | "basis"> => ({
  ...(p.policyId ? { policy: p.policyId } : {}),
  ...(p.source ? { source: p.source } : {}),
  basis: p.policyId ? "approved" : "discovered"
})
const why = (p: ActivePolicy): string => (p.policyId ? ` (policy ${p.policyId})` : "")

function ancestors(ctx: UseContext, index: number): number[] {
  const out: number[] = []
  for (let p = ctx.uses[index]?.parent; p !== undefined; p = ctx.uses[p]?.parent) out.push(p)
  return out
}

/** Evaluates component-level rules against one scanned element. */
export function evaluateUse(policies: readonly ActivePolicy[], ctx: UseContext, index: number): Finding[] {
  const use = ctx.uses[index] as ScannedUse
  const comp = ctx.resolved[index]
  if (!comp) return []
  const findings: Finding[] = []
  const attrNames = new Set(Object.keys(use.attrs).map((n) => normalize(n)))
  for (const p of policies) {
    const r = p.rule
    switch (r.kind) {
      case "require-attribute": {
        if (!r.components.some((x) => matches(comp, x)) || use.hasSpread) break
        if (r.anyOf.some((a) => attrNames.has(normalize(a)))) break
        if (r.unlessChildren) {
          if (use.hasChildren === true) break
          if (use.hasChildren === undefined) break
        }
        const accessibility = r.category === "accessibility"
        findings.push({
          code: accessibility ? "accessibility-requirement-missing" : "policy-attribute-required",
          severity: p.severity,
          subject: comp.id,
          message: `${comp.name} needs one of ${r.anyOf.join(", ")}${r.unlessChildren ? " when it has no children" : ""}${why(p)}`,
          ...ref(p),
          suggestion: `Add ${r.anyOf[0]}="...".`
        })
        break
      }
      case "forbid-prop": {
        if (
          !matches(comp, r.component) ||
          !(normalize(r.prop) in Object.fromEntries([...attrNames].map((n) => [n, 1])))
        )
          break
        findings.push({
          code: "prop-forbidden",
          severity: p.severity,
          subject: comp.id,
          message: `${comp.name} must not use "${r.prop}"${why(p)}`,
          path: `props.${r.prop}`,
          ...ref(p),
          suggestion: r.replacedBy ? `Use ${r.replacedBy} instead.` : `Remove "${r.prop}".`
        })
        break
      }
      case "forbid-prop-value": {
        if (!matches(comp, r.component)) break
        const key = Object.keys(use.attrs).find((n) => normalize(n) === normalize(r.prop))
        const value = key === undefined ? undefined : use.attrs[key]
        if (value === undefined || isDynamic(value)) break
        if (!r.values.some((v) => v === value || String(v) === String(value))) break
        findings.push({
          code: "prop-value-forbidden",
          severity: p.severity,
          subject: comp.id,
          message: `${comp.name}.${r.prop} must not be ${JSON.stringify(value)}${why(p)}`,
          path: `props.${r.prop}`,
          ...ref(p),
          suggestion: "Choose a different value."
        })
        break
      }
      case "forbid-component": {
        if (!matches(comp, r.component)) break
        findings.push({
          code: "component-forbidden",
          severity: p.severity,
          subject: comp.id,
          message: `${comp.name} must not be used${why(p)}`,
          ...ref(p),
          suggestion: r.use ? `Use ${r.use} instead.` : "Use an approved component."
        })
        break
      }
      case "allowed-children": {
        const parent = ctx.uses[index]?.parent
        const container = parent === undefined ? undefined : ctx.resolved[parent]
        if (!container || !matches(container, r.container)) break
        if (r.children.some((x) => matches(comp, x))) break
        findings.push({
          code: r.category === "layout" ? "layout-pattern-invalid" : "composition-not-allowed",
          severity: p.severity,
          subject: comp.id,
          message: `${comp.name} is not allowed directly inside ${container.name}; allowed: ${r.children.join(", ")}${why(p)}`,
          ...ref(p),
          suggestion: `Put ${comp.name} inside an allowed component, or use one of ${r.children.join(", ")} here.`
        })
        break
      }
      case "required-parent": {
        if (!matches(comp, r.component)) break
        const chain = ancestors(ctx, index)
        const dsAncestors = chain.map((a) => ctx.resolved[a]).filter((c): c is Component => c !== undefined)
        // Only a violation when it sits inside other design-system components but none is an allowed parent: at the
        // top of a file the real parent may be in another file.
        if (dsAncestors.length === 0 || dsAncestors.some((a) => r.parents.some((x) => matches(a, x)))) break
        findings.push({
          code: p.policyId ? "composition-not-allowed" : "composition-parent-required",
          severity: p.severity,
          subject: comp.id,
          message: `${comp.name} must be inside ${r.parents.join(" or ")}${why(p)}`,
          ...ref(p),
          suggestion: `Wrap it in ${r.parents[0]}.`
        })
        break
      }
      case "forbid-token":
        break
    }
  }
  return findings
}
