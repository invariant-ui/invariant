import { IR_VERSION, type IrDocument, type IrFact } from "@invariant/compiler-ir"
import { computeEvidenceId, type Evidence } from "@invariant/contract"
import type { JsonValue } from "@invariant/shared"

const HASH = "0".repeat(64)

class Doc {
  readonly entities: IrDocument["entities"] = []
  readonly facts: IrFact[] = []
  readonly evidence = new Map<string, Evidence>()
  readonly sourceId: string
  readonly type: "react" | "vue" | "storybook"
  readonly adapter: string

  constructor(sourceId: string, type: "react" | "vue" | "storybook", adapter: string) {
    this.sourceId = sourceId
    this.type = type
    this.adapter = adapter
  }

  ev(path: string, line: number): Evidence {
    const base = {
      sourceId: this.sourceId,
      sourceRef: `${path}#${line}`,
      location: { type: "file" as const, path, line },
      method: "ast" as const,
      extractor: { name: this.adapter, version: "1" }
    }
    const evidence: Evidence = {
      ...base,
      id: computeEvidenceId(base),
      verificationStatus: "unverified",
      capturedAt: "2026-01-01T00:00:00.000Z"
    }
    this.evidence.set(evidence.id, evidence)
    return evidence
  }

  add(ref: string, kind: IrDocument["entities"][number]["kind"], name: string): void {
    this.entities.push({ ref, kind, name })
  }

  fact(subject: string, path: string, value: JsonValue, evidence: Evidence, completeness?: "partial"): void {
    this.facts.push({
      subject,
      path,
      value,
      origin: "extracted",
      evidenceIds: [evidence.id],
      ...(completeness ? { completeness } : {})
    })
  }

  build(): IrDocument {
    return {
      irVersion: IR_VERSION,
      source: {
        id: this.sourceId,
        type: this.type,
        location: ".",
        inputHash: HASH,
        adapter: { name: this.adapter, version: "1" }
      },
      capabilities: ["*"],
      completeness: "complete",
      entities: this.entities,
      facts: this.facts,
      evidence: [...this.evidence.values()],
      diagnostics: []
    }
  }
}

export interface PropSpec {
  required?: boolean
  default?: JsonValue
  allowedValues?: Array<string | number | boolean>
  deprecated?: boolean
  role?: string
}

export interface CodeSpec {
  ref: string
  name: string
  file: string
  localName: string
  framework?: "react" | "vue"
  propsComplete?: boolean
  props?: Record<string, PropSpec>
  variants?: string[]
  slots?: string[]
  deprecated?: boolean
}

export function codeDoc(sourceId: string, components: CodeSpec[]): IrDocument {
  const framework = components[0]?.framework ?? "react"
  const doc = new Doc(sourceId, framework, framework)
  for (const c of components) {
    const fw = c.framework ?? "react"
    doc.add(c.ref, "component", c.name)
    const decl = doc.ev(c.file, 1)
    doc.fact(c.ref, "name", c.name, decl)
    doc.fact(c.ref, `implementations.${fw}.extensions.${fw}.file`, c.file, decl)
    doc.fact(c.ref, `implementations.${fw}.extensions.${fw}.localName`, c.localName, decl)
    doc.fact(c.ref, `implementations.${fw}.extensions.${fw}.propsComplete`, c.propsComplete ?? true, decl)
    if (c.deprecated) doc.fact(c.ref, "lifecycle", "deprecated", decl)
    let line = 10
    for (const [name, p] of Object.entries(c.props ?? {})) {
      const ev = doc.ev(c.file, line++)
      doc.fact(c.ref, `props.${name}.type.text`, "x", ev)
      if (p.required !== undefined) doc.fact(c.ref, `props.${name}.required`, p.required, ev)
      if (p.default !== undefined) doc.fact(c.ref, `props.${name}.default`, p.default, ev)
      if (p.allowedValues) doc.fact(c.ref, `props.${name}.allowedValues`, p.allowedValues, ev)
      if (p.deprecated) doc.fact(c.ref, `props.${name}.deprecated`, {}, ev)
      if (p.role) doc.fact(c.ref, `props.${name}.extensions.${fw}.role`, p.role, ev)
    }
    for (const v of c.variants ?? []) doc.fact(c.ref, `variants.${v}.values`, ["a", "b"], decl)
    for (const s of c.slots ?? []) doc.fact(c.ref, `slots.${s}.required`, false, decl)
  }
  return doc.build()
}

export interface ArgTypeSpec {
  options?: Array<string | number | boolean>
  optionsPartial?: boolean
  mappingKeys?: string[]
  defaultSummary?: string
  hidden?: boolean
}

export interface StorySpec {
  name: string
  /** True for a story with a custom render (or a function/template story). Default: the default render. */
  render?: boolean
  args?: Record<string, JsonValue>
  unresolvedArgs?: string[]
  argTypes?: Record<string, ArgTypeSpec>
}

export interface GroupSpec {
  file: string
  title: string
  component?: { file: string; name: string; via?: "component" | "type-argument" } | undefined
  args?: Record<string, JsonValue>
  unresolvedArgs?: string[]
  argTypes?: Record<string, ArgTypeSpec>
  stories?: StorySpec[]
}

export function storyDoc(sourceId: string, groups: GroupSpec[]): IrDocument {
  const doc = new Doc(sourceId, "storybook", "storybook")
  for (const g of groups) {
    const gref = `storybook:${g.file}`
    doc.add(gref, "story-group", g.title)
    let line = 5
    const annotate = (
      ref: string,
      prefix: "group" | "story",
      s: {
        args?: Record<string, JsonValue>
        unresolvedArgs?: string[]
        argTypes?: Record<string, ArgTypeSpec>
      }
    ): void => {
      for (const [k, v] of Object.entries(s.args ?? {}))
        doc.fact(ref, `${prefix}.args.${k}`, v, doc.ev(g.file, line++))
      if (s.unresolvedArgs?.length)
        doc.fact(ref, `${prefix}.argsUnresolved`, s.unresolvedArgs, doc.ev(g.file, line++), "partial")
      for (const [k, a] of Object.entries(s.argTypes ?? {})) {
        const ev = doc.ev(g.file, line++)
        doc.fact(ref, `${prefix}.argTypes.${k}.declared`, true, ev)
        if (a.options)
          doc.fact(
            ref,
            `${prefix}.argTypes.${k}.options`,
            a.options,
            ev,
            a.optionsPartial ? "partial" : undefined
          )
        if (a.mappingKeys) doc.fact(ref, `${prefix}.argTypes.${k}.mappingKeys`, a.mappingKeys, ev)
        if (a.defaultSummary !== undefined)
          doc.fact(ref, `${prefix}.argTypes.${k}.defaultSummary`, a.defaultSummary, ev)
        if (a.hidden) doc.fact(ref, `${prefix}.argTypes.${k}.hidden`, true, ev)
      }
    }
    if (g.component)
      doc.fact(
        gref,
        "group.component",
        {
          text: g.component.name,
          via: g.component.via ?? "component",
          file: g.component.file,
          name: g.component.name
        },
        doc.ev(g.file, 3)
      )
    annotate(gref, "group", g)
    for (const s of g.stories ?? []) {
      const sref = `${gref}#${s.name}`
      doc.add(sref, "story", s.name)
      doc.fact(sref, "story.group", gref, doc.ev(g.file, line++))
      doc.fact(sref, "story.hasRender", s.render === true, doc.ev(g.file, line++))
      annotate(sref, "story", s)
    }
  }
  return doc.build()
}
