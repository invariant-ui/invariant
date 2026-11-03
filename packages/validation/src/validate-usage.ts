import type { Component } from "@invariant/contract"
import { type DesignSystem, normalize } from "@invariant/contract-query"
import type { JsonValue } from "@invariant/shared"
import { nearest, quoteList } from "./text.js"

/** A value the caller could not evaluate statically (an expression, a binding). It is never checked. */
export interface DynamicValue {
  expression: string
}
export type PropValue = JsonValue | DynamicValue

export const isDynamic = (v: PropValue): v is DynamicValue =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  Object.keys(v).length === 1 &&
  typeof (v as DynamicValue).expression === "string"

export interface UsageInput {
  component: string
  framework?: string | undefined
  props?: Record<string, PropValue> | undefined
  /** Whether children or default slot content are present. Omit when unknown. */
  hasChildren?: boolean | undefined
  /** True when props could also be supplied by a spread, so a missing required prop proves nothing. */
  hasSpread?: boolean | undefined
}

export interface Finding {
  /** The rule violated: a code from the rule catalog. */
  code: string
  severity: "error" | "warning" | "info"
  /** What is wrong and why. */
  message: string
  /** The contract fact path the finding rests on. */
  path?: string
  file?: string
  line?: number
  column?: number
  /** The component or token the finding is about. */
  subject?: string
  /** Where the contract states what this finding relies on, as `path:line`, or the policy file. */
  source?: string
  /** What kind of knowledge the finding rests on. `heuristic` is a name guess, not a fact. */
  basis: "discovered" | "documented" | "inferred" | "approved" | "heuristic"
  confidence?: number
  /** The approved policy that requires this, when the rule is organizational. */
  policy?: string
  /** A concrete way to fix it. */
  suggestion?: string
}

/**
 * Attributes frameworks pass through to the rendered element. A component rarely declares them, and whether it
 * forwards them is not in the contract, so an undeclared one is not evidence of a mistake.
 */
const HTML_ATTRIBUTES = new Set(
  "accept alt autocomplete autofocus checked cols colspan disabled download draggable for form height href hreflang htmlfor inputmode lang list loading max maxlength method min minlength multiple name novalidate pattern placeholder readonly rel required rows rowspan selected size spellcheck src srcset step target type value width wrap dir content crossorigin enterkeyhint open".split(
    " "
  )
)
const PASSTHROUGH = /^(data-|aria-)|^(key|ref|class|className|style|id|slot|role|tabindex|title|hidden)$/i
const isPassthrough = (name: string): boolean =>
  PASSTHROUGH.test(name) || HTML_ATTRIBUTES.has(name.toLowerCase())

export interface UsageResult {
  component?: string
  findings: Finding[]
  /** Number of props whose values were not literals and so were not checked. */
  unverifiedValues: number
}

function sameValue(allowed: string | number | boolean, v: JsonValue): boolean {
  if (allowed === v) return true
  return typeof v === "string" && typeof allowed !== "string" && String(allowed) === v
}

export function validateUsage(ds: DesignSystem, input: UsageInput): UsageResult {
  const findings: Finding[] = []
  const found = ds.findComponent(input.component)
  if (!found.match) {
    const names = found.candidates.map((c) => c.name)
    const close =
      names.length > 0
        ? names
        : nearest(
            input.component,
            ds.contract.components.map((c) => c.name)
          )
    findings.push({
      code:
        found.candidates.length > 1 && names.some((n) => normalize(n) === normalize(input.component))
          ? "component-ambiguous"
          : "component-unknown",
      severity: "error",
      message: `"${input.component}" is not a component in the contract${close.length > 0 ? `. Candidates: ${close.join(", ")}` : ""}`,
      basis: "discovered",
      ...(close.length > 0
        ? { suggestion: `Did you mean ${close.slice(0, 3).join(" or ")}?` }
        : {
            suggestion:
              "Find a component with search_design_system or `invariant components list`, or add the component to the design system."
          })
    })
    return { findings, unverifiedValues: 0 }
  }
  const c: Component = found.match
  const framework = input.framework
  if (framework && !c.implementations.some((i) => i.framework === framework))
    findings.push({
      code: "framework-not-implemented",
      severity: "error",
      subject: c.id,
      message: `${c.name} has no ${framework} implementation (it has: ${c.implementations.map((i) => i.framework).join(", ")})`,
      basis: "discovered",
      suggestion: `Use the ${c.implementations.map((i) => i.framework).join(" or ")} implementation, or a ${framework} component with the same role.`
    })
  if (c.lifecycle === "deprecated") {
    const replacement = c.deprecated?.replacedBy ? ds.component(c.deprecated.replacedBy)?.name : undefined
    findings.push({
      code: "component-deprecated",
      severity: "warning",
      subject: c.id,
      message: `${c.name} is deprecated${c.deprecated?.reason ? `: ${c.deprecated.reason}` : ""}`,
      basis: ds.factView(c.facts, "lifecycle")?.status === "documented" ? "documented" : "discovered",
      ...(ds.factView(c.facts, "lifecycle")?.source
        ? { source: ds.factView(c.facts, "lifecycle")?.source as string }
        : {}),
      suggestion: replacement
        ? `Use ${replacement}.`
        : "Migrate to the component that replaces it; check the component's documentation."
    })
  }

  const complete = ds.propsComplete(c, framework)
  const props = input.props ?? {}
  let unverified = 0
  const basisOf = (path: string): Finding["basis"] => {
    const s = ds.factView(c.facts, path)?.status
    return s === "documented" || s === "inferred" || s === "approved" ? s : "discovered"
  }
  const where = (path: string): { source?: string } => {
    const s = ds.factView(c.facts, path)?.source
    return s ? { source: s } : {}
  }
  const eventNames = new Set(c.events.map((e) => normalize(e.name)))
  const slotNames = new Set(c.slots.map((s) => normalize(s.name)))

  for (const [name, value] of Object.entries(props)) {
    const prop = c.props.find((p) => p.name === name)
    if (!prop) {
      if (
        isPassthrough(name) ||
        eventNames.has(normalize(name.replace(/^on(?=[A-Z])/, ""))) ||
        slotNames.has(normalize(name))
      )
        continue
      const close = nearest(
        name,
        c.props.map((p) => p.name)
      )
      findings.push(
        complete
          ? {
              code: "unknown-prop",
              severity: "warning",
              subject: c.id,
              message: `${c.name} does not declare a prop "${name}"`,
              path: `props.${name}`,
              basis: "discovered",
              suggestion:
                close.length > 0
                  ? `Did you mean ${close.map((x) => `"${x}"`).join(" or ")}?`
                  : `Remove "${name}", or check the props ${c.name} declares (get_component).`
            }
          : {
              code: "unverifiable-prop",
              severity: "info",
              subject: c.id,
              message: `${c.name}'s prop list is incomplete, so "${name}" could not be verified`,
              path: `props.${name}`,
              basis: "discovered"
            }
      )
      continue
    }
    const base = `props.${name}`
    if (prop.deprecated)
      findings.push({
        code: "prop-deprecated",
        severity: "warning",
        subject: c.id,
        message: `${c.name}.${name} is deprecated${prop.deprecated.reason ? `: ${prop.deprecated.reason}` : ""}`,
        path: base,
        basis: basisOf(`${base}.deprecated`),
        ...where(`${base}.deprecated`),
        suggestion: prop.deprecated.reason
          ? `Follow the deprecation note: ${prop.deprecated.reason}`
          : `Stop using "${name}"; see ${c.name}'s documentation for its replacement.`
      })
    if (isDynamic(value)) {
      unverified++
      continue
    }
    if (
      prop.allowedValues &&
      (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    ) {
      if (!prop.allowedValues.some((a) => sameValue(a, value))) {
        const close = typeof value === "string" ? nearest(value, prop.allowedValues.map(String)) : []
        findings.push({
          code: "prop-value-not-allowed",
          severity: "error",
          subject: c.id,
          message: `${c.name}.${name} is ${JSON.stringify(value)}, which is not one of ${quoteList(prop.allowedValues)}`,
          path: `${base}.allowedValues`,
          basis: basisOf(`${base}.allowedValues`),
          ...where(`${base}.allowedValues`),
          suggestion: `Use one of ${quoteList(prop.allowedValues)}${close.length > 0 ? ` (closest: ${JSON.stringify(close[0])})` : ""}.`
        })
      }
    } else {
      const kind = prop.type.kind
      const bad =
        (kind === "boolean" && typeof value !== "boolean") ||
        (kind === "number" && typeof value !== "number") ||
        (kind === "string" && typeof value !== "string")
      if (bad)
        findings.push({
          code: "prop-type-mismatch",
          severity: "warning",
          subject: c.id,
          message: `${c.name}.${name} expects ${kind} (${prop.type.text}) but got ${JSON.stringify(value)}`,
          path: `${base}.type`,
          basis: basisOf(`${base}.type.text`),
          ...where(`${base}.type.text`),
          suggestion: `Pass a ${kind} value${kind === "boolean" ? ` (for example ${name}={true})` : ""}.`
        })
    }
  }

  if (!input.hasSpread)
    for (const p of c.props) {
      if (!p.required || p.name in props) continue
      if (p.name === "children") {
        if (input.hasChildren === false)
          findings.push({
            code: "required-prop-missing",
            severity: "error",
            subject: c.id,
            message: `${c.name} requires children`,
            path: "props.children",
            basis: basisOf("props.children.required"),
            ...where("props.children.required"),
            suggestion: `Put content inside ${c.name}.`
          })
        continue
      }
      findings.push({
        code: "required-prop-missing",
        severity: "error",
        subject: c.id,
        message: `${c.name} requires the prop "${p.name}"`,
        path: `props.${p.name}`,
        basis: basisOf(`props.${p.name}.required`),
        ...where(`props.${p.name}.required`),
        suggestion: `Add ${p.name} (${p.type.text}${p.allowedValues ? `: ${quoteList(p.allowedValues)}` : ""}).`
      })
    }
  return { component: c.id, findings, unverifiedValues: unverified }
}
