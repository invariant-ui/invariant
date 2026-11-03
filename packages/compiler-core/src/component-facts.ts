import type { Evidence } from "@invariant/contract"
import type { JsonValue } from "@invariant/shared"
import type { IrBuilder } from "./ir-builder.js"
import type { MemberKind } from "./ts/members.js"

export interface PropSpec {
  name: string
  typeText: string
  kind: MemberKind
  required: boolean
  default?: JsonValue
  /** Source text of a default that is not a plain literal; never presented as a value. */
  defaultExpression?: string
  allowedValues?: Array<string | number | boolean>
  description?: string
  deprecated?: { reason?: string }
  /** Framework-specific detail, written under `extensions.<framework>`. */
  extensions?: Record<string, JsonValue>
}

export interface EventSpec {
  name: string
  payloadText?: string
  description?: string
  deprecated?: { reason?: string }
  extensions?: Record<string, JsonValue>
}

export interface SlotSpec {
  name: string
  required?: boolean
  description?: string
  extensions?: Record<string, JsonValue>
}

export interface VariantSpec {
  name: string
  values: string[]
  default?: string
  extensions?: Record<string, JsonValue>
}

const FACT_SEGMENT = /^[A-Za-z0-9_:-]+$/

/**
 * Writes a component's facts with the neutral paths every framework adapter shares, so React, Angular
 * and Vue describe equivalent concepts identically and keep framework detail under
 * `extensions.<framework>`. Names that cannot be addressed by a fact path are reported through `skipped`.
 */
export class ComponentFacts {
  readonly skipped: string[] = []
  private readonly builder: IrBuilder
  private readonly ref: string
  private readonly framework: string

  constructor(builder: IrBuilder, ref: string, framework: string) {
    this.builder = builder
    this.ref = ref
    this.framework = framework
  }

  put(
    path: string,
    value: JsonValue,
    evidence: Evidence | readonly Evidence[],
    origin: "extracted" | "authored" = "extracted"
  ): void {
    this.builder.fact(this.ref, path, value, evidence, { origin })
  }

  /** `implementations.<fw>.extensions.<fw>.<path>` */
  ext(path: string, value: JsonValue, evidence: Evidence | readonly Evidence[]): void {
    this.put(`implementations.${this.framework}.extensions.${this.framework}.${path}`, value, evidence)
  }

  /** The neutral link key: sources are matched on (file, localName), never on display names. */
  link(file: string, localName: string, evidence: Evidence): void {
    this.put(`implementations.${this.framework}.framework`, this.framework, evidence)
    this.ext("file", file, evidence)
    this.ext("localName", localName, evidence)
  }

  prop(spec: PropSpec, evidence: Evidence, extra: { default?: Evidence[] } = {}): void {
    if (!this.addressable(spec.name, "prop")) return
    const base = `props.${spec.name}`
    this.put(`${base}.type.text`, spec.typeText, evidence)
    this.put(`${base}.type.kind`, spec.kind, evidence)
    this.put(`${base}.required`, spec.required, evidence)
    if (spec.default !== undefined)
      this.put(`${base}.default`, spec.default, [evidence, ...(extra.default ?? [])])
    if (spec.defaultExpression !== undefined)
      this.put(
        `${base}.extensions.${this.framework}.defaultExpression`,
        spec.defaultExpression,
        extra.default?.[0] ?? evidence
      )
    if (spec.allowedValues) this.put(`${base}.allowedValues`, spec.allowedValues, evidence)
    if (spec.description) this.put(`${base}.description`, spec.description, evidence, "authored")
    if (spec.deprecated) this.put(`${base}.deprecated`, spec.deprecated as JsonValue, evidence, "authored")
    for (const [key, value] of Object.entries(spec.extensions ?? {}))
      this.put(`${base}.extensions.${this.framework}.${key}`, value, evidence)
  }

  event(spec: EventSpec, evidence: Evidence): void {
    if (!this.addressable(spec.name, "event")) return
    const base = `events.${spec.name}`
    this.put(`${base}.declared`, true, evidence)
    if (spec.payloadText) this.put(`${base}.payload.text`, spec.payloadText, evidence)
    if (spec.description) this.put(`${base}.description`, spec.description, evidence, "authored")
    if (spec.deprecated) this.put(`${base}.deprecated`, spec.deprecated as JsonValue, evidence, "authored")
    for (const [key, value] of Object.entries(spec.extensions ?? {}))
      this.put(`${base}.extensions.${this.framework}.${key}`, value, evidence)
  }

  slot(spec: SlotSpec, evidence: Evidence): void {
    if (!this.addressable(spec.name, "slot")) return
    const base = `slots.${spec.name}`
    this.put(`${base}.declared`, true, evidence)
    if (spec.required !== undefined) this.put(`${base}.required`, spec.required, evidence)
    if (spec.description) this.put(`${base}.description`, spec.description, evidence, "authored")
    for (const [key, value] of Object.entries(spec.extensions ?? {}))
      this.put(`${base}.extensions.${this.framework}.${key}`, value, evidence)
  }

  variant(spec: VariantSpec, evidence: Evidence): void {
    if (!this.addressable(spec.name, "variant")) return
    const base = `variants.${spec.name}`
    this.put(`${base}.values`, spec.values, evidence)
    if (spec.default !== undefined) this.put(`${base}.default`, spec.default, evidence)
    for (const [key, value] of Object.entries(spec.extensions ?? {}))
      this.put(`${base}.extensions.${this.framework}.${key}`, value, evidence)
  }

  accessibility(info: { role?: string; attributes: string[] }, evidence: Evidence): void {
    if (info.role) this.put("accessibility.role", info.role, evidence)
    if (info.attributes.length > 0) this.put("accessibility.attributes", info.attributes, evidence)
  }

  private addressable(name: string, what: string): boolean {
    if (FACT_SEGMENT.test(name)) return true
    this.skipped.push(`${what} "${name}"`)
    return false
  }
}

/** Variants from props typed as a union of two or more string literals (the same rule in every framework). */
export function variantsFromProps(props: readonly PropSpec[]): VariantSpec[] {
  const out: VariantSpec[] = []
  for (const p of props) {
    const values = p.allowedValues
    if (p.kind !== "enum" || !values || values.length < 2 || !values.every((v) => typeof v === "string"))
      continue
    const fallback =
      typeof p.default === "string" && (values as string[]).includes(p.default) ? p.default : undefined
    out.push({ name: p.name, values: values as string[], ...(fallback ? { default: fallback } : {}) })
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** `var(--x)` references in CSS or source text, with the first line each appears on. */
export function cssVariableReferences(text: string): Array<{ name: string; line: number }> {
  const seen = new Map<string, number>()
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/var\(\s*(--[\w-]+)/g))
      if (!seen.has(match[1] as string)) seen.set(match[1] as string, index + 1)
  })
  return [...seen]
    .map(([name, line]) => ({ name, line }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}
