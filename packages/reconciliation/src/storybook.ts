import type { IrDocument } from "@invariant/compiler-ir"
import { type Diagnostic, sortDiagnostics } from "@invariant/diagnostics"
import type { JsonValue } from "@invariant/shared"
import { type CodeComponent, codeComponents } from "./code.js"
import { FactIndex } from "./facts.js"

export interface Discrepancy {
  code: string
  severity: "error" | "warning" | "info"
  message: string
  /** Source that produced the finding's subject (a story, or a component for coverage findings). */
  sourceId: string
  entityId: string
  component?: string
  prop?: string
  /** Evidence on the Storybook side and on the code side, so a later conflict record can cite both. */
  storybookEvidence: string[]
  codeEvidence: string[]
  /** Source location of the Storybook-side evidence, when known. */
  location?: { path: string; line?: number }
  /** What each side says, for findings that turn into contract conflicts. Absent means that side has no such field. */
  claim?: { storybook?: JsonValue; code?: JsonValue }
}

export interface StoryLink {
  group: string
  storySourceId: string
  stories: string[]
  component: string
  componentSourceId: string
  via: "component" | "type-argument"
  matchedBy: "file+localName"
}

export interface StorybookReconciliation {
  links: StoryLink[]
  discrepancies: Discrepancy[]
  diagnostics: Diagnostic[]
}

type Scalar = string | number | boolean

interface StoryView {
  ref: string
  name: string
  /**
   * True when args reach `meta.component` directly (the story has no custom render). With a custom
   * render, args go to that function and may belong to a different component entirely.
   */
  defaultRender: boolean
  args: Map<string, { value: unknown; evidence: string[] }>
  unresolvedArgs: Set<string>
  argTypes: Map<string, ArgTypeView>
}

interface ArgTypeView {
  options?: Scalar[]
  optionsUncertain: boolean
  mappingKeys?: string[]
  defaultSummary?: string
  hidden: boolean
  evidence: string[]
  defaultEvidence: string[]
}

const PREFIX = { group: "group", story: "story" } as const

/**
 * Compares Storybook sources with code sources. A Storybook control or arg is never taken as proof that
 * an API exists: it is checked against the implementation's own facts, and claims are only made when the
 * implementation's props are fully known (`propsComplete`). Findings carry evidence from both sides.
 */
export function reconcileStorybook(docs: readonly IrDocument[]): StorybookReconciliation {
  const components = codeComponents(docs)
  const byKey = new Map(components.map((c) => [`${c.file}#${c.localName}`, c]))
  const links: StoryLink[] = []
  const found: Discrepancy[] = []
  const demonstrated = new Map<
    CodeComponent,
    { names: Set<string>; values: Map<string, Set<string>>; uncertain: Set<string>; storyCount: number }
  >()

  for (const doc of docs.filter((d) => d.source.type === "storybook")) {
    const index = new FactIndex(doc)
    const storiesByGroup = new Map<string, string[]>()
    for (const e of doc.entities.filter((x) => x.kind === "story")) {
      const group = index.value<string>(e.ref, "story.group")
      if (group) storiesByGroup.set(group, [...(storiesByGroup.get(group) ?? []), e.ref])
    }

    for (const groupEntity of doc.entities.filter((e) => e.kind === "story-group")) {
      const target = index.value<{ file?: string; name?: string; via?: "component" | "type-argument" }>(
        groupEntity.ref,
        "group.component"
      )
      if (!target?.file || !target.name) continue
      const component = byKey.get(`${target.file}#${target.name}`)
      const storyRefs = (storiesByGroup.get(groupEntity.ref) ?? []).sort()
      if (!component) {
        found.push({
          code: "reconcile.storybook.component-unlinked",
          severity: "info",
          message: `${groupEntity.name} points at ${target.name} in ${target.file}, but no compiled source has a public component there`,
          sourceId: doc.source.id,
          entityId: groupEntity.ref,
          storybookEvidence: index.evidenceIds(groupEntity.ref, "group.component"),
          codeEvidence: [],
          ...locationOf(index, index.evidenceIds(groupEntity.ref, "group.component"))
        })
        continue
      }
      links.push({
        group: groupEntity.ref,
        storySourceId: doc.source.id,
        stories: storyRefs,
        component: component.ref,
        componentSourceId: component.sourceId,
        via: target.via ?? "component",
        matchedBy: "file+localName"
      })

      const storyViews = storyRefs.map((ref) =>
        view(
          index,
          ref,
          PREFIX.story,
          doc.entities.find((e) => e.ref === ref)?.name ?? ref,
          index.value<boolean>(ref, "story.hasRender") === false
        )
      )
      // Meta-level args reach the component only through stories that use the default render.
      const groupView = view(
        index,
        groupEntity.ref,
        PREFIX.group,
        groupEntity.name,
        storyViews.some((v) => v.defaultRender)
      )
      const seen = demonstrated.get(component) ?? {
        names: new Set<string>(),
        values: new Map<string, Set<string>>(),
        uncertain: new Set<string>(),
        storyCount: 0
      }
      demonstrated.set(component, seen)
      seen.storyCount += storyViews.length
      const unverifiable = { inherited: new Set<string>(), render: new Set<string>() }
      // Meta-level annotations are checked once; each story's own annotations are checked at the story.
      for (const v of [groupView, ...storyViews]) {
        checkView({ doc, index, view: v, inherited: groupView, component, found, seen, unverifiable })
      }
      for (const [names, reason] of [
        [unverifiable.inherited, `whose props are inherited from types that were not enumerated`],
        [
          unverifiable.render,
          `because the stories that pass them use a custom render, so the args may not be ${component.name}'s props`
        ]
      ] as const) {
        if (names.size === 0) continue
        found.push({
          code: "reconcile.storybook.unverifiable-names",
          severity: "info",
          message: `${groupEntity.name}: ${[...names].sort().slice(0, 10).join(", ")}${names.size > 10 ? ", …" : ""} could not be verified against ${component.name}, ${reason}`,
          sourceId: doc.source.id,
          entityId: groupEntity.ref,
          component: component.ref,
          storybookEvidence: [],
          codeEvidence: []
        })
      }
      if (component.deprecated) {
        found.push({
          code: "reconcile.storybook.deprecated-demonstrated",
          severity: "warning",
          message: `${groupEntity.name} demonstrates ${component.name}, which is marked deprecated`,
          sourceId: doc.source.id,
          entityId: groupEntity.ref,
          component: component.ref,
          storybookEvidence: index.evidenceIds(groupEntity.ref, "group.component"),
          codeEvidence: component.index.evidenceIds(component.ref, "lifecycle"),
          ...locationOf(index, index.evidenceIds(groupEntity.ref, "group.component"))
        })
      }
    }
  }

  for (const [component, seen] of demonstrated) coverage(component, seen, found)

  const discrepancies = found.sort(compare)
  return {
    links: links.sort((a, b) => (a.group < b.group ? -1 : 1)),
    discrepancies,
    diagnostics: sortDiagnostics(discrepancies.map(toDiagnostic))
  }
}

function view(
  index: FactIndex,
  ref: string,
  prefix: "group" | "story",
  name: string,
  defaultRender: boolean
): StoryView {
  const args = new Map<string, { value: unknown; evidence: string[] }>()
  for (const arg of index.children(ref, `${prefix}.args`))
    args.set(arg, {
      value: index.value(ref, `${prefix}.args.${arg}`),
      evidence: index.evidenceIds(ref, `${prefix}.args.${arg}`)
    })
  const unresolved = new Set<string>()
  for (const path of [...(index.value<string[]>(ref, `${prefix}.argsUnresolved`) ?? [])]) {
    const first = path.split(".")[0] as string
    if (first && first !== "..." && first !== "<computed>") unresolved.add(first)
  }
  const argTypes = new Map<string, ArgTypeView>()
  for (const prop of index.children(ref, `${prefix}.argTypes`)) {
    if (prop === "") continue
    const base = `${prefix}.argTypes.${prop}`
    const options = index.value<Scalar[]>(ref, `${base}.options`)
    const optionsFact = index.get(ref, `${base}.options`)
    const mapping = index.value<string[]>(ref, `${base}.mappingKeys`)
    const summary = index.value<string>(ref, `${base}.defaultSummary`)
    argTypes.set(prop, {
      ...(options ? { options } : {}),
      optionsUncertain:
        index.get(ref, `${base}.optionsUnresolved`) !== undefined || optionsFact?.completeness === "partial",
      ...(mapping ? { mappingKeys: mapping } : {}),
      ...(summary === undefined ? {} : { defaultSummary: summary }),
      hidden: index.value<boolean>(ref, `${base}.hidden`) === true,
      evidence: index.evidenceIds(ref, `${base}.declared`),
      defaultEvidence: index.evidenceIds(ref, `${base}.defaultSummary`)
    })
  }
  return { ref, name, defaultRender, args, unresolvedArgs: unresolved, argTypes }
}

function checkView(input: {
  doc: IrDocument
  index: FactIndex
  view: StoryView
  /** The meta-level view: its argTypes (such as `mapping`) also apply to every story. */
  inherited: StoryView
  component: CodeComponent
  found: Discrepancy[]
  seen: { names: Set<string>; values: Map<string, Set<string>>; uncertain: Set<string>; storyCount: number }
  unverifiable: { inherited: Set<string>; render: Set<string> }
}): void {
  const { doc, index, view: v, inherited, component, found, seen, unverifiable } = input
  const declared = (name: string): boolean =>
    component.props.has(name) ||
    component.variantNames.has(name) ||
    (name === "children" && (component.slotNames.has("default") || component.props.has("children")))
  const add = (d: Omit<Discrepancy, "sourceId" | "entityId" | "component">): void => {
    found.push({
      ...d,
      sourceId: doc.source.id,
      entityId: v.ref,
      component: component.ref,
      ...locationOf(index, d.storybookEvidence)
    })
  }

  const argNames = new Set([...v.args.keys(), ...v.unresolvedArgs])
  for (const name of argNames) {
    seen.names.add(name)
    const prop = component.props.get(name)
    const arg = v.args.get(name)
    // With a mapping at either level, an arg value is a mapping key rather than the real prop value.
    const mapped =
      v.argTypes.get(name)?.mappingKeys !== undefined ||
      inherited.argTypes.get(name)?.mappingKeys !== undefined
    if (v.unresolvedArgs.has(name)) seen.uncertain.add(name)
    if (!v.defaultRender) {
      // Args of a custom-render story are not attributed to the component: no claim either way.
      if (!declared(name)) unverifiable.render.add(name)
      continue
    }
    if (!declared(name)) {
      if (component.propsComplete) {
        add({
          code: "reconcile.storybook.arg-undeclared",
          severity: "warning",
          message: `${v.name} passes arg "${name}", which ${component.name} does not declare as a prop`,
          prop: name,
          storybookEvidence: arg?.evidence ?? [],
          codeEvidence: [],
          claim: { storybook: true }
        })
      } else unverifiable.inherited.add(name)
      continue
    }
    if (prop?.deprecated) {
      add({
        code: "reconcile.storybook.deprecated-demonstrated",
        severity: "warning",
        message: `${v.name} uses arg "${name}", a deprecated prop of ${component.name}`,
        prop: name,
        storybookEvidence: arg?.evidence ?? [],
        codeEvidence: prop.evidence.deprecated,
        claim: { storybook: true, code: "deprecated" }
      })
    }
    if (arg && prop?.allowedValues && isScalar(arg.value) && !mapped) {
      const key = String(arg.value)
      const values = valuesFor(seen, name)
      values.add(key)
      if (!prop.allowedValues.some((a) => a === arg.value)) {
        add({
          code: "reconcile.storybook.arg-value-not-allowed",
          severity: "warning",
          message: `${v.name} sets ${component.name}.${name} to ${JSON.stringify(arg.value)}, which is not one of its declared values (${prop.allowedValues.map((a) => JSON.stringify(a)).join(", ")})`,
          prop: name,
          storybookEvidence: arg.evidence,
          codeEvidence: prop.evidence.allowedValues,
          claim: { storybook: arg.value as JsonValue, code: prop.allowedValues as JsonValue }
        })
      }
    }
  }

  for (const [name, at] of v.argTypes) {
    seen.names.add(name)
    const prop = component.props.get(name)
    if (!declared(name)) {
      if (at.hidden) continue
      if (component.propsComplete) {
        add({
          code: "reconcile.storybook.control-undeclared",
          severity: "warning",
          message: `${v.name} documents a control for "${name}", which ${component.name} does not declare as a prop`,
          prop: name,
          storybookEvidence: at.evidence,
          codeEvidence: [],
          claim: { storybook: true }
        })
      } else unverifiable.inherited.add(name)
      continue
    }
    if (prop?.deprecated && !at.hidden) {
      add({
        code: "reconcile.storybook.deprecated-demonstrated",
        severity: "warning",
        message: `${v.name} documents a control for "${name}", a deprecated prop of ${component.name}`,
        prop: name,
        storybookEvidence: at.evidence,
        codeEvidence: prop.evidence.deprecated,
        claim: { storybook: true, code: "deprecated" }
      })
    }
    if (at.options && !at.mappingKeys && !at.optionsUncertain) {
      const values = valuesFor(seen, name)
      for (const o of at.options) values.add(String(o))
      if (prop?.allowedValues) {
        const extra = at.options.filter((o) => !prop.allowedValues?.some((a) => a === o))
        if (extra.length > 0) {
          add({
            code: "reconcile.storybook.control-option-not-allowed",
            severity: "warning",
            message: `${v.name}: the control for ${component.name}.${name} offers ${extra.map((o) => JSON.stringify(o)).join(", ")}, which the component does not declare`,
            prop: name,
            storybookEvidence: at.evidence,
            codeEvidence: prop.evidence.allowedValues,
            claim: { storybook: extra as JsonValue, code: prop.allowedValues as JsonValue }
          })
        }
      }
    } else if (at.options || at.optionsUncertain || at.mappingKeys) seen.uncertain.add(name)
    if (
      at.defaultSummary !== undefined &&
      prop &&
      prop.default !== undefined &&
      normalize(at.defaultSummary) !== normalize(prop.default)
    ) {
      add({
        code: "reconcile.storybook.default-mismatch",
        severity: "warning",
        message: `${v.name} documents the default of ${component.name}.${name} as ${at.defaultSummary}, but the code default is ${JSON.stringify(prop.default)}`,
        prop: name,
        storybookEvidence: at.defaultEvidence,
        codeEvidence: prop.evidence.default,
        claim: { storybook: normalize(at.defaultSummary), code: prop.default as JsonValue }
      })
    }
  }
}

/** Props and declared values no linked story demonstrates. Only claimed where the story side is fully known. */
function coverage(
  component: CodeComponent,
  seen: { names: Set<string>; values: Map<string, Set<string>>; uncertain: Set<string>; storyCount: number },
  found: Discrepancy[]
): void {
  if (seen.storyCount === 0) return
  const skipRoles = new Set(["children", "ref", "event-handler"])
  const missing = [...component.props.values()]
    .filter(
      (p) => !skipRoles.has(p.role ?? "") && !seen.names.has(p.name) && !component.variantNames.has(p.name)
    )
    .map((p) => p.name)
  if (missing.length > 0) {
    found.push({
      code: "reconcile.storybook.prop-not-demonstrated",
      severity: "info",
      message: `${component.name} declares ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", …" : ""}, which no story passes as an arg or documents as a control`,
      sourceId: component.sourceId,
      entityId: component.ref,
      component: component.ref,
      storybookEvidence: [],
      codeEvidence: missing.flatMap((m) => component.props.get(m)?.evidence.declared ?? [])
    })
  }
  for (const prop of component.props.values()) {
    if (
      !prop.allowedValues ||
      prop.allowedValues.length < 2 ||
      seen.uncertain.has(prop.name) ||
      !seen.names.has(prop.name)
    )
      continue
    const shown = seen.values.get(prop.name) ?? new Set<string>()
    const absent = prop.allowedValues.filter((v) => !shown.has(String(v)))
    if (absent.length > 0) {
      found.push({
        code: "reconcile.storybook.value-not-demonstrated",
        severity: "info",
        message: `${component.name}.${prop.name} declares ${absent
          .slice(0, 8)
          .map((v) => JSON.stringify(v))
          .join(
            ", "
          )}${absent.length > 8 ? `, … (${absent.length} in all)` : ""}, which no story or control demonstrates`,
        sourceId: component.sourceId,
        entityId: component.ref,
        component: component.ref,
        prop: prop.name,
        storybookEvidence: [],
        codeEvidence: prop.evidence.allowedValues
      })
    }
  }
}

function valuesFor(seen: { values: Map<string, Set<string>> }, name: string): Set<string> {
  const existing = seen.values.get(name)
  if (existing) return existing
  const created = new Set<string>()
  seen.values.set(name, created)
  return created
}

function isScalar(value: unknown): value is Scalar {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
}

/** Compares a documented default (`'md'`, `"md"`, `md`, `false`) with a code default. */
function normalize(value: unknown): string {
  const text = String(value).trim()
  return text.replace(/^(["'`])(.*)\1$/s, "$2")
}

function locationOf(
  index: FactIndex,
  evidenceIds: readonly string[]
): { location?: { path: string; line?: number } } {
  const location = index.location(evidenceIds[0])
  return location ? { location } : {}
}

function compare(a: Discrepancy, b: Discrepancy): number {
  const key = (d: Discrepancy): string =>
    `${d.code}\u0000${d.sourceId}\u0000${d.entityId}\u0000${d.prop ?? ""}\u0000${d.message}`
  const order = { error: 0, warning: 1, info: 2 }
  return order[a.severity] - order[b.severity] || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)
}

function toDiagnostic(d: Discrepancy): Diagnostic {
  return {
    code: d.code,
    severity: d.severity,
    message: d.message,
    sourceId: d.sourceId,
    entityId: d.entityId,
    ...(d.location ? { location: d.location } : {})
  }
}
