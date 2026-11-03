import type { Component, Token } from "@invariant/contract"
import { type DesignSystem, normalize } from "@invariant/contract-query"
import {
  colorFunctionLiterals,
  colorKey,
  expandHex,
  type Found,
  namedColorLiterals,
  spacingLiterals,
  tokenValueKeys,
  typographyLiterals
} from "./literals.js"
import { type ActivePolicy, activePolicies, evaluateUse, relationshipRules } from "./policy.js"
import type { RuleOverrides } from "./rules.js"
import { type ImportBinding, type ScannedUse, scanJsx, scanMarkup } from "./scan.js"
import { nearest } from "./text.js"
import { type Finding, validateUsage } from "./validate-usage.js"

export const MAX_CODE_CHARS = 200_000
export const MAX_FINDINGS = 200

export type CodeFramework = "react" | "vue" | "angular" | "html"

export interface CodeInput {
  code: string
  framework?: CodeFramework | undefined
  filename?: string | undefined
}

export interface ValidateOptions {
  /** Per-rule severity, or `off`. */
  rules?: RuleOverrides
}

export interface CodeResult {
  valid: boolean
  framework: CodeFramework
  summary: {
    errors: number
    warnings: number
    info: number
    componentsChecked: string[]
    elementsNotInContract: string[]
    unverifiedValues: number
  }
  findings: Finding[]
  truncated: boolean
  limitations: string[]
}

const NATIVE_EQUIVALENTS: Record<string, string[]> = {
  button: ["button"],
  input: ["input", "textfield", "textinput"],
  select: ["select", "dropdown"],
  textarea: ["textarea", "textfield"],
  dialog: ["dialog", "modal"],
  table: ["table", "datatable"],
  a: ["link"],
  img: ["image", "img"],
  label: ["label"],
  progress: ["progress", "progressbar"]
}

const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9A-Za-z_-])/g
const CSS_VAR = /var\(\s*(--[A-Za-z0-9_-]+)/g

function tagIndex(ds: DesignSystem): Map<string, Component[]> {
  const map = new Map<string, Component[]>()
  const add = (key: string, c: Component): void => {
    if (key === "") return
    const list = map.get(key) ?? []
    if (!list.includes(c)) list.push(c)
    map.set(key, list)
  }
  for (const c of ds.contract.components) {
    add(normalize(c.name), c)
    for (const i of c.implementations) {
      if (i.exportName) add(normalize(i.exportName), c)
      const sel = (i.extensions?.[i.framework] as { selector?: unknown } | undefined)?.selector
      if (typeof sel === "string") add(normalize(/^[a-z][a-z0-9-]*/.exec(sel)?.[0] ?? ""), c)
    }
  }
  return map
}

function designSystemModules(ds: DesignSystem): string[] {
  const modules = new Set<string>()
  for (const c of ds.contract.components)
    for (const i of c.implementations) {
      if (i.packageName) modules.add(i.packageName)
      if (i.importPath) modules.add(i.importPath)
    }
  return [...modules]
}

interface Token_ {
  token: Token
  cssName: string
}

function cssVariables(ds: DesignSystem): Map<string, Token_> {
  const map = new Map<string, Token_>()
  for (const t of ds.contract.tokens) {
    const css = t.extensions?.css as Record<string, unknown> | undefined
    const names = new Set<string>()
    if (typeof css?.name === "string") names.add(css.name)
    names.add(t.name.startsWith("--") ? t.name : `--${t.name.replace(/\./g, "-")}`)
    for (const n of names) map.set(n, { token: t, cssName: n })
  }
  return map
}

/** Every literal value a token can take in the default and in each theme. */
function tokenLiterals(ds: DesignSystem, t: Token): unknown[] {
  return [ds.resolveToken(t).value, ...Object.keys(t.modes ?? {}).map((m) => ds.resolveToken(t, m).value)]
}

function tokenColors(ds: DesignSystem): Map<string, string> {
  const colors = new Map<string, string>()
  for (const t of ds.contract.tokens)
    for (const v of tokenLiterals(ds, t)) {
      const key = typeof v === "string" ? colorKey(v) : undefined
      if (key && !colors.has(key)) colors.set(key, t.id)
    }
  return colors
}

/** Comparable keys of the tokens of one category, to the first token that has the value. */
function tokenKeysByCategory(ds: DesignSystem, category: Token["category"]): Map<string, string> {
  const keys = new Map<string, string>()
  for (const t of ds.contract.tokens) {
    if (t.category !== category) continue
    for (const v of tokenLiterals(ds, t))
      for (const k of tokenValueKeys(v)) if (!keys.has(k)) keys.set(k, t.id)
  }
  return keys
}

function tokenSource(ds: DesignSystem, id: string): { source?: string } {
  const t = ds.contract.tokens.find((x) => x.id === id)
  const source = t ? (ds.factView(t.facts, "value.value") ?? ds.factView(t.facts, "name"))?.source : undefined
  return source ? { source } : {}
}

/** From the file name, else the contract's only framework, else React. */
export function defaultFramework(ds: DesignSystem, filename?: string): CodeFramework {
  if (filename) {
    if (/\.vue$/i.test(filename)) return "vue"
    if (/\.component\.html$/i.test(filename)) return "angular"
    if (/\.html?$/i.test(filename)) return "html"
    if (/\.[cm]?[jt]sx?$/i.test(filename)) return "react"
  }
  const known = ds.contract.metadata.frameworks.filter(
    (f): f is "react" | "vue" | "angular" => f === "react" || f === "vue" || f === "angular"
  )
  return known.length === 1 ? (known[0] as CodeFramework) : "react"
}

type Resolution =
  | { kind: "component"; component: Component }
  | { kind: "foreign" }
  | { kind: "unknown-ds"; name: string }
  | { kind: "ambiguous"; matches: Component[] }
  | { kind: "none" }

function resolveUse(
  use: ScannedUse,
  index: Map<string, Component[]>,
  imports: Map<string, ImportBinding>,
  isDs: (m: string) => boolean
): Resolution {
  const parts = use.tag.split(".")
  const base = parts[0] as string
  const member = parts.slice(1)
  const imp = imports.get(base)
  const pick = (key: string): Resolution => {
    const found = index.get(key) ?? []
    return found.length === 1
      ? { kind: "component", component: found[0] as Component }
      : found.length > 1
        ? { kind: "ambiguous", matches: found }
        : { kind: "none" }
  }
  if (imp) {
    if (!isDs(imp.module)) return { kind: "foreign" }
    const importedName = imp.imported === "*" ? (member[0] ?? "") : imp.imported
    const rest = imp.imported === "*" ? member.slice(1) : member
    if (importedName === "" || importedName === "default") return pick(normalize(use.tag))
    let r = pick(normalize(importedName + rest.join("")))
    if (r.kind === "ambiguous") {
      // Several packages may export the same name: the import tells which one this file means.
      const fromModule = r.matches.filter((c) =>
        c.implementations.some((i) =>
          [i.packageName, i.importPath].some(
            (m) => m !== undefined && (imp.module === m || imp.module.startsWith(`${m}/`))
          )
        )
      )
      if (fromModule.length === 1) r = { kind: "component", component: fromModule[0] as Component }
    }
    if (r.kind === "none" && rest.length === 0 && /^[A-Z]/.test(importedName))
      return { kind: "unknown-ds", name: importedName }
    return r
  }
  // A lowercase tag without a hyphen is a native element in every framework (custom elements need a hyphen).
  if (/^[a-z][a-z0-9]*$/.test(use.tag)) return { kind: "none" }
  return pick(normalize(use.tag.replace(/^.*:/, "")))
}

/**
 * Checks a code snippet against the contract without running it: uses of known components are validated
 * with their literal props, approved policies are applied, and literal colors and CSS variables are compared
 * with the tokens. Dynamic values are counted, not guessed.
 */
export function validateCode(ds: DesignSystem, input: CodeInput, options: ValidateOptions = {}): CodeResult {
  const framework: CodeFramework = input.framework ?? defaultFramework(ds, input.filename)
  const findings: Finding[] = []
  const limitations = [
    "Static check of the given snippet only: nothing is executed or imported.",
    "Only literal prop values are verified; expressions and bindings are counted as unverified.",
    "A component is recognized by its import from a design-system package (React) or by name or selector. Components from other libraries are not checked."
  ]
  const checked = new Set<string>()
  const unknown = new Set<string>()
  let unverified = 0
  if (input.code.length > MAX_CODE_CHARS) {
    return {
      valid: false,
      framework,
      summary: {
        errors: 1,
        warnings: 0,
        info: 0,
        componentsChecked: [],
        elementsNotInContract: [],
        unverifiedValues: 0
      },
      findings: [
        {
          code: "input-too-large",
          severity: "error",
          message: `The snippet is ${input.code.length} characters; the limit is ${MAX_CODE_CHARS}`,
          basis: "discovered",
          suggestion: "Validate smaller files."
        }
      ],
      truncated: false,
      limitations
    }
  }

  const index = tagIndex(ds)
  const modules = designSystemModules(ds)
  const isDs = (m: string): boolean => modules.some((p) => m === p || m.startsWith(`${p}/`))
  const jsx = framework === "react" ? scanJsx(input.code, input.filename) : undefined
  const uses = jsx ? jsx.uses : scanMarkup(input.code)
  const imports = jsx?.imports ?? new Map<string, ImportBinding>()
  const resolved: Array<Component | undefined> = []
  const at = (u: ScannedUse): Pick<Finding, "line" | "column"> => ({ line: u.line, column: u.column })

  uses.forEach((use) => {
    const r = resolveUse(use, index, imports, isDs)
    if (r.kind === "component") {
      resolved.push(r.component)
      const result = validateUsage(ds, {
        component: r.component.id,
        framework: framework === "html" ? undefined : framework,
        props: use.attrs,
        hasChildren: use.hasChildren,
        hasSpread: use.hasSpread
      })
      checked.add(r.component.id)
      unverified += result.unverifiedValues
      for (const f of result.findings) findings.push({ ...f, ...at(use) })
      return
    }
    resolved.push(undefined)
    if (r.kind === "ambiguous") {
      findings.push({
        code: "component-ambiguous",
        severity: "info",
        message: `<${use.tag}> matches ${r.matches.map((m) => m.id).join(", ")}; it was not checked`,
        ...at(use),
        basis: "discovered"
      })
      return
    }
    if (r.kind === "unknown-ds") {
      const close = nearest(
        r.name,
        ds.contract.components.map((c) => c.name)
      )
      findings.push({
        code: "component-unknown",
        severity: "error",
        message: `<${use.tag}> is imported from the design system, but the contract has no component "${r.name}"${close.length > 0 ? `. Candidates: ${close.join(", ")}` : ""}`,
        ...at(use),
        basis: "discovered",
        suggestion:
          close.length > 0
            ? `Did you mean ${close.join(" or ")}?`
            : "Check the export name, or find a component with search_design_system."
      })
      return
    }
    if (r.kind === "foreign") return
    const equivalents = NATIVE_EQUIVALENTS[use.tag.toLowerCase()]
    const equivalent = equivalents
      ? ds.contract.components.find((c) => equivalents.includes(normalize(c.name)))
      : undefined
    if (equivalent)
      findings.push({
        code: "native-element-has-equivalent",
        severity: "info",
        subject: equivalent.id,
        message: `<${use.tag}> is a native element and the design system has ${equivalent.name}. This is a name match, not a rule`,
        ...at(use),
        basis: "heuristic",
        confidence: 0.5,
        suggestion: `Consider ${equivalent.name} if it covers this use.`
      })
    else if (/^[A-Z]/.test(use.tag) || use.tag.includes("-")) unknown.add(use.tag)
  })

  const { active, problems } = activePolicies(ds.contract)
  if (problems.length > 0) limitations.push(...problems.map((p) => `Not enforced: ${p}.`))
  const rules: ActivePolicy[] = [...active, ...relationshipRules(ds)]
  const ctx = { uses, resolved }
  uses.forEach((use, i) => {
    for (const f of evaluateUse(rules, ctx, i)) findings.push({ ...f, ...at(use) })
  })

  const colors = tokenColors(ds)
  const lines = input.code.split("\n")
  if (colors.size > 0) {
    lines.forEach((text, idx) => {
      const found: Found[] = []
      for (const m of text.matchAll(HEX)) {
        const before = text.slice(Math.max(0, (m.index ?? 0) - 14), m.index ?? 0)
        if (/(href|to|id|name)\s*=\s*["']?$/i.test(before) || /&$/.test(before)) continue
        found.push({ text: m[0], keys: [expandHex(m[0])], column: (m.index ?? 0) + 1 })
      }
      found.push(...colorFunctionLiterals(text), ...namedColorLiterals(text))
      for (const f of found) {
        const token = colors.get(f.keys[0] as string)
        const where = { line: idx + 1, column: f.column }
        findings.push(
          token
            ? {
                code: "color-matches-token",
                severity: "info",
                subject: token,
                message: `${f.text} equals the value of ${token}`,
                ...where,
                basis: "discovered",
                ...tokenSource(ds, token),
                suggestion: `Reference ${token} instead of the literal.`
              }
            : {
                code: "color-not-in-tokens",
                severity: "warning",
                message: `${f.text} is a literal color that is not the value of any token`,
                ...where,
                basis: "discovered",
                suggestion:
                  "Use a color token from get_design_tokens, or add this color to the design system."
              }
        )
      }
    })
  } else limitations.push("No token has a literal color value, so literal colors were not checked.")

  const measured = [
    { name: "spacing", category: "spacing" as const, scan: spacingLiterals },
    { name: "typography", category: "typography" as const, scan: typographyLiterals }
  ]
  for (const m of measured) {
    const keys = tokenKeysByCategory(ds, m.category)
    if (keys.size === 0) {
      limitations.push(`No ${m.name} token has a literal value, so literal ${m.name} was not checked.`)
      continue
    }
    lines.forEach((text, idx) => {
      for (const f of m.scan(text)) {
        const token = f.keys.map((k) => keys.get(k)).find((t) => t !== undefined)
        const where = { line: idx + 1, column: f.column }
        findings.push(
          token
            ? {
                code: `${m.name}-matches-token`,
                severity: "info",
                subject: token,
                message: `${f.property}: ${f.text} equals the value of ${token}`,
                ...where,
                basis: "discovered",
                ...tokenSource(ds, token),
                suggestion: `Reference ${token} instead of the literal.`
              }
            : {
                code: `${m.name}-not-in-tokens`,
                severity: "warning",
                message: `${f.property}: ${f.text} is a literal ${m.name} value that is not the value of any ${m.name} token`,
                ...where,
                basis: "discovered",
                suggestion: `Use a ${m.name} token from get_design_tokens, or add this value to the design system.`
              }
        )
      }
    })
  }

  if (ds.contract.tokens.length > 0) {
    const vars = cssVariables(ds)
    // A custom property declared in this very file is local to it, not a missing token.
    const declared = new Set([...input.code.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)].map((m) => m[1] as string))
    const forbidden = rules.filter((r) => r.rule.kind === "forbid-token")
    lines.forEach((text, idx) => {
      for (const m of text.matchAll(CSS_VAR)) {
        const name = m[1] as string
        const where = { line: idx + 1, column: (m.index ?? 0) + 1 }
        const known = vars.get(name)
        const banned = forbidden.find(
          (p) =>
            p.rule.kind === "forbid-token" &&
            p.rule.tokens.some(
              (t) =>
                normalize(t.replace(/^token:/, "").replace(/^--/, "")) === normalize(name.replace(/^--/, ""))
            )
        )
        if (banned && banned.rule.kind === "forbid-token")
          findings.push({
            code: "token-forbidden",
            severity: banned.severity,
            subject: known?.token.id ?? name,
            message: `${name} must not be used (policy ${banned.policyId})`,
            ...where,
            basis: "approved",
            policy: banned.policyId,
            ...(banned.source ? { source: banned.source } : {}),
            suggestion: banned.rule.replacedBy
              ? `Use ${banned.rule.replacedBy} instead.`
              : "Use an approved token."
          })
        if (!known && declared.has(name)) continue
        if (!known) {
          const close = nearest(name, [...vars.keys()])
          findings.push({
            code: "unknown-css-variable",
            severity: "warning",
            message: `${name} is not a token in the contract`,
            ...where,
            basis: "discovered",
            suggestion:
              close.length > 0 ? `Did you mean ${close.join(" or ")}?` : "Use a token from get_design_tokens."
          })
        } else if (known.token.deprecated) {
          const replacement = known.token.deprecated.replacedBy
            ? vars.get(`--${known.token.deprecated.replacedBy.slice(6).replace(/\./g, "-")}`)?.cssName
            : undefined
          findings.push({
            code: "token-deprecated",
            severity: "warning",
            subject: known.token.id,
            message: `${name} is deprecated${known.token.deprecated.reason ? `: ${known.token.deprecated.reason}` : ""}`,
            ...where,
            basis:
              ds.factView(known.token.facts, "deprecated")?.status === "documented"
                ? "documented"
                : "discovered",
            suggestion: replacement ? `Use ${replacement}.` : "Migrate to the token that replaces it."
          })
        }
      }
    })
  } else limitations.push("The contract has no tokens, so CSS variables were not checked.")

  const overrides = options.rules ?? {}
  const final: Finding[] = []
  for (const f of findings) {
    const o = overrides[f.code]
    if (o === "off") continue
    final.push({
      ...f,
      ...(o ? { severity: o } : {}),
      ...(input.filename ? { file: input.filename } : {})
    })
  }
  // Helper findings repeat for every use of the same element; say each once per file.
  const HELPERS = new Set(["component-ambiguous", "native-element-has-equivalent", "unverifiable-prop"])
  const seen = new Set<string>()
  const deduped = final.filter((f) => {
    if (!HELPERS.has(f.code)) return true
    const key = `${f.code}\u0000${f.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const sorted = deduped.sort(
    (a, b) =>
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.column ?? 0) - (b.column ?? 0) ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)
  )
  const count = (s: Finding["severity"]): number => sorted.filter((f) => f.severity === s).length
  return {
    valid: count("error") === 0,
    framework,
    summary: {
      errors: count("error"),
      warnings: count("warning"),
      info: count("info"),
      componentsChecked: [...checked].sort(),
      elementsNotInContract: [...unknown].sort().slice(0, 50),
      unverifiedValues: unverified
    },
    findings: sorted.slice(0, MAX_FINDINGS),
    truncated: sorted.length > MAX_FINDINGS,
    limitations
  }
}
