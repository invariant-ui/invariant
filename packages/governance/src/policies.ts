import type { Constraint, ContractDraft, Policy } from "@invariant/contract"
import type { JsonValue } from "@invariant/shared"
import { type Diagnostic, DiagnosticCollector } from "@invariant/shared"
import { type PolicyRule, policyRuleSchema } from "@invariant/validation"
import { z } from "zod"

export const POLICIES_FILE = "invariant.policies.json"

const slugRe = /^[a-z0-9][a-z0-9._-]*$/

/**
 * Organizational rules, written and approved by people and kept in version control. Nothing infers a policy:
 * every entry must carry who approved it and when.
 */
export const policiesFileSchema = z.strictObject({
  version: z.literal(1),
  policies: z.array(
    z.strictObject({
      id: z.string().regex(slugRe).max(64),
      name: z.string().min(1).max(200),
      statement: z.string().min(1).max(2000),
      severity: z.enum(["error", "warning", "info"]),
      enforcement: z.enum(["block", "warn", "report-only"]).default("block"),
      approval: z.strictObject({
        approvedBy: z.string().min(1).max(200),
        approvedAt: z.iso.datetime(),
        role: z.string().min(1).max(200).optional(),
        reference: z.string().min(1).max(500).optional()
      }),
      rule: policyRuleSchema
    })
  )
})
export type PoliciesFile = z.infer<typeof policiesFileSchema>

export type ParsePolicies = { ok: true; value: PoliciesFile } | { ok: false; message: string }

export function parsePolicies(text: string): ParsePolicies {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ok: false, message: `${POLICIES_FILE} is not valid JSON: ${(error as Error).message}` }
  }
  const parsed = policiesFileSchema.safeParse(raw)
  if (!parsed.success) {
    const i = parsed.error.issues[0]
    return {
      ok: false,
      message: `${POLICIES_FILE} is invalid at ${i?.path.join(".") || "(root)"}: ${i?.message ?? "schema error"}`
    }
  }
  const seen = new Set<string>()
  for (const p of parsed.data.policies) {
    if (seen.has(p.id)) return { ok: false, message: `${POLICIES_FILE}: duplicate policy id "${p.id}"` }
    seen.add(p.id)
  }
  return { ok: true, value: parsed.data }
}

const referencedComponents = (rule: PolicyRule): string[] => {
  switch (rule.kind) {
    case "require-attribute":
      return rule.components
    case "forbid-prop":
    case "forbid-prop-value":
    case "forbid-component":
      return [rule.component]
    case "allowed-children":
      return [rule.container, ...rule.children]
    case "required-parent":
      return [rule.component, ...rule.parents]
    case "forbid-token":
      return []
  }
}

const KIND: Record<PolicyRule["kind"], Constraint["kind"]> = {
  "require-attribute": "required-prop",
  "forbid-prop": "deprecated-api",
  "forbid-prop-value": "invalid-combination",
  "forbid-component": "deprecated-api",
  "forbid-token": "deprecated-api",
  "allowed-children": "valid-combination",
  "required-parent": "valid-combination"
}

const norm = (s: string): string =>
  s
    .replace(/^component:/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")

/**
 * Adds each approved policy to the contract as a policy plus the constraint that carries its rule. Existing
 * entries are never changed. A policy that names a component the contract does not have is still added (it
 * simply never fires) and is reported.
 */
export function compilePolicies(
  draft: ContractDraft,
  file: PoliciesFile,
  source: string = POLICIES_FILE
): { contract: ContractDraft; diagnostics: Diagnostic[] } {
  const collector = new DiagnosticCollector()
  const policies: Policy[] = []
  const constraints: Constraint[] = []
  const existing = new Set([...draft.policies.map((p) => p.id), ...draft.constraints.map((c) => c.id)])
  for (const p of file.policies) {
    const policyId = `policy:${p.id}` as Policy["id"]
    const constraintId = `constraint:${p.id}` as Constraint["id"]
    if (existing.has(policyId) || existing.has(constraintId)) {
      collector.error(
        "governance.policy-id-taken",
        `${source}: ${policyId} already exists in the contract and was not added`
      )
      continue
    }
    const subjects = new Set<string>()
    for (const ref of referencedComponents(p.rule)) {
      const found = draft.components.find(
        (c) => c.id === ref || norm(c.name) === norm(ref) || norm(c.id) === norm(ref)
      )
      if (found) subjects.add(found.id)
      else
        collector.warning(
          "governance.policy-unknown-component",
          `${source}: policy ${p.id} names "${ref}", which is not a component in the contract; that part of the policy cannot fire`
        )
    }
    if (p.rule.kind === "forbid-token")
      for (const t of p.rule.tokens) {
        const n = norm(t.replace(/^token:/, "").replace(/^--/, ""))
        const found = draft.tokens.find((x) => norm(x.name.replace(/^--/, "")) === n)
        if (found) subjects.add(found.id)
        else
          collector.warning(
            "governance.policy-unknown-token",
            `${source}: policy ${p.id} names token "${t}", which is not in the contract`
          )
      }
    const ruleJson = p.rule as unknown as Record<string, JsonValue>
    constraints.push({
      id: constraintId,
      name: p.name,
      kind: KIND[p.rule.kind],
      description: p.statement,
      subjects: subjects.size > 0 ? ([...subjects].sort() as Constraint["subjects"]) : [policyId],
      details: ruleJson,
      facts: {},
      extensions: { invariant: { rule: ruleJson, source, policy: p.id } }
    })
    policies.push({
      id: policyId,
      name: p.name,
      statement: p.statement,
      severity: p.severity,
      enforcement: p.enforcement,
      scope:
        subjects.size > 0
          ? { entities: [...subjects].filter((s) => s.startsWith("component:")).sort() as never }
          : {},
      basedOn: [constraintId],
      approval: p.approval
    })
  }
  const cmp = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  return {
    contract: {
      ...draft,
      policies: [...draft.policies, ...policies].sort(cmp),
      constraints: [...draft.constraints, ...constraints].sort(cmp)
    },
    diagnostics: collector.toArray()
  }
}
