import type { Evidence, IrBuilder, PackageInfo } from "@invariant/compiler-core"
import { excerpt, lineOf } from "@invariant/compiler-core"
import type { JsonValue } from "@invariant/shared"
import type ts from "typescript"
import type { ComponentAnalysis } from "./analyze.js"

export const CAPABILITIES = [
  "name",
  "description",
  "lifecycle",
  "deprecated",
  "implementations.*",
  "props.*",
  "slots.*",
  "variants.*",
  "accessibility.*",
  "examples.*",
  "styling.*",
  "usage.*",
  "composition.*"
]

type Method = "compiler-api" | "ast" | "structured-parse"

/** Writes one component's facts. Prose from JSDoc is `authored`; everything derived from syntax or types is `extracted`. */
export function emitComponent(builder: IrBuilder, c: ComponentAnalysis, pkg: PackageInfo): void {
  const ref = builder.entity(c.ref, "component", c.displayName)
  const at = (node: ts.Node, method: Method = "compiler-api"): Evidence => {
    // Project files are loaded under a virtual root, so a node's path is its project-relative path.
    const file = node.getSourceFile().fileName.replace(/^\//, "")
    return builder.evidence({
      sourceRef: `${file}#${c.candidate.name}`,
      location: { type: "file", path: file, line: lineOf(node) },
      method,
      original: excerpt(node)
    })
  }
  const declEv = at(c.candidate.decl)
  const implEv = at(c.candidate.impl ?? c.candidate.decl)
  const put = (
    path: string,
    value: JsonValue,
    evidence: Evidence | Evidence[],
    origin: "extracted" | "authored" = "extracted"
  ): void => builder.fact(ref, path, value, evidence, { origin })

  put("name", c.displayName, declEv)
  if (c.docs.description) put("description", c.docs.description, declEv, "authored")
  if (c.docs.deprecated) {
    put("lifecycle", "deprecated", declEv, "authored")
    put("deprecated", c.docs.deprecated as JsonValue, declEv, "authored")
  }
  c.docs.examples.forEach((code, index) => {
    const id = `example-${index + 1}`
    put(`examples.${id}.language`, c.file.split(".").pop() ?? "tsx", declEv, "authored")
    put(`examples.${id}.code`, code, declEv, "authored")
  })

  // Implementation
  const primary = [...c.exports].sort(
    (a, b) =>
      (a.subpath === "." ? 0 : 1) - (b.subpath === "." ? 0 : 1) ||
      (a.name === "default" ? 1 : 0) - (b.name === "default" ? 1 : 0) ||
      (a.name < b.name ? -1 : 1)
  )[0]
  const impl = "implementations.react"
  put(`${impl}.framework`, "react", declEv)
  if (pkg.name) put(`${impl}.packageName`, pkg.name, declEv)
  if (primary) {
    put(`${impl}.exportName`, primary.name, declEv)
    if (pkg.name)
      put(
        `${impl}.importPath`,
        primary.subpath === "." ? pkg.name : `${pkg.name}/${primary.subpath.replace(/^\.\//, "")}`,
        declEv
      )
  }
  const ext = `${impl}.extensions.react`
  put(`${ext}.kind`, c.candidate.kind, declEv)
  put(`${ext}.file`, c.file, declEv)
  // Neutral link key: other sources identify a component by (file, local declaration name).
  put(`${ext}.localName`, c.candidate.name, declEv)
  put(`${ext}.exports`, c.exports as unknown as JsonValue, declEv)
  put(`${ext}.forwardRef`, c.candidate.wrappers.includes("forwardRef"), declEv)
  put(`${ext}.memo`, c.candidate.wrappers.includes("memo"), declEv)
  if (c.candidate.wrappers.length > 0) put(`${ext}.wrappers`, c.candidate.wrappers, declEv)
  if (c.candidate.refTypeText) put(`${ext}.refType`, c.candidate.refTypeText, declEv)
  if (c.candidate.reactDisplayName) put(`${ext}.displayName`, c.candidate.reactDisplayName, declEv)
  if (c.candidate.styled) put(`${ext}.styledLibrary`, c.candidate.styled.library, declEv)
  if (c.props.generics.length > 0) put(`${ext}.generics`, c.props.generics, declEv)
  if (c.props.inheritsFrom.length > 0) put(`${ext}.inheritedPropsFrom`, c.props.inheritsFrom, declEv)
  put(`${ext}.propsComplete`, c.props.complete, declEv)
  if (c.compoundParent) put(`${ext}.compoundParent`, c.compoundParent, declEv)

  // Props
  for (const p of c.props.props) {
    const base = `props.${p.name}`
    const ev = at(p.declaration.node)
    put(`${base}.type.text`, p.typeText, ev)
    put(`${base}.type.kind`, p.kind, ev)
    put(`${base}.required`, p.required, ev)
    if (p.default !== undefined) put(`${base}.default`, p.default, [ev, implEv])
    if (p.defaultExpression !== undefined)
      put(`${base}.extensions.react.defaultExpression`, p.defaultExpression, implEv)
    if (p.allowedValues) put(`${base}.allowedValues`, p.allowedValues, ev)
    if (p.description) put(`${base}.description`, p.description, ev, "authored")
    if (p.deprecated) put(`${base}.deprecated`, p.deprecated as JsonValue, ev, "authored")
    put(`${base}.extensions.react.role`, p.role, ev)
    if (p.inheritedFrom) put(`${base}.extensions.react.inheritedFrom`, p.inheritedFrom, ev)
  }

  // Variants
  for (const v of c.variants) {
    const ev = v.node ? at(v.node, v.source === "cva" ? "ast" : "compiler-api") : declEv
    put(`variants.${v.name}.values`, v.values, ev)
    if (v.default !== undefined) put(`variants.${v.name}.default`, v.default, ev)
    put(`variants.${v.name}.extensions.react.source`, v.source, ev)
    if (v.via) put(`variants.${v.name}.extensions.react.via`, v.via, ev)
  }

  // Slots
  for (const s of c.slots) {
    put(`slots.${s.name}.declared`, true, declEv)
    put(`slots.${s.name}.required`, s.required, declEv)
    put(`slots.${s.name}.extensions.react.prop`, s.prop, declEv)
    put(`slots.${s.name}.extensions.react.typeText`, s.typeText, declEv)
    if (s.renderProp) put(`slots.${s.name}.extensions.react.renderProp`, true, declEv)
  }

  // Accessibility
  if (c.accessibility) {
    if (c.accessibility.role) put("accessibility.role", c.accessibility.role, implEv)
    if (c.accessibility.attributes.length > 0)
      put("accessibility.attributes", c.accessibility.attributes, implEv)
  }

  // Styling
  if (c.styling) {
    const s = c.styling
    if (s.cssModules.length > 0)
      put(
        "styling.cssModules",
        s.cssModules.map((m) => m.path),
        implEv
      )
    const moduleEvidence = s.cssModules.flatMap((m) =>
      m.variables.map((v) =>
        builder.evidence({
          sourceRef: `${m.path}#${v.name}`,
          location: { type: "file", path: m.path, line: v.line },
          method: "structured-parse",
          original: `var(${v.name})`
        })
      )
    )
    const variables = [
      ...new Set([...s.inlineVariables, ...s.cssModules.flatMap((m) => m.variables.map((v) => v.name))])
    ].sort()
    if (variables.length > 0) put("styling.cssVariables", variables, [implEv, ...moduleEvidence])
    if (s.classNames.length > 0) put("styling.classNames", s.classNames, implEv)
    if (s.tailwind && s.classNames.length > 0) put("styling.tailwind", true, implEv)
    if (s.libraries.length > 0) put("styling.libraries", s.libraries, implEv)
  }

  // Composition and usage
  if (c.renders.length > 0) put("composition.renders", c.renders as unknown as JsonValue, implEv)
  if (c.subcomponents.length > 0)
    put("composition.subcomponents", c.subcomponents as unknown as JsonValue, declEv)
  if (c.usage) {
    const u = c.usage
    const samples = u.samples.map((s) =>
      builder.evidence({
        sourceRef: `${s.file}#usage`,
        location: { type: "file", path: s.file, line: s.line },
        method: "compiler-api",
        original: s.text
      })
    )
    put("usage.sites", u.sites, samples)
    // Variant names count as declared (cva variants reach the component through VariantProps).
    const declared = new Set([...c.props.props.map((p) => p.name), ...c.variants.map((v) => v.name)])
    for (const [name, stat] of [...u.props].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!/^[A-Za-z0-9_:-]+$/.test(name)) continue
      put(`usage.props.${name}.count`, stat.count, samples)
      if (stat.values.length > 0) put(`usage.props.${name}.observedValues`, stat.values, samples)
      if (stat.dynamic > 0) put(`usage.props.${name}.dynamicCount`, stat.dynamic, samples)
      // When the props set is incomplete, absence from it proves nothing, so `declared: false` is not claimed.
      if (declared.has(name) || c.props.complete)
        put(`usage.props.${name}.declared`, declared.has(name), samples)
    }
    if (u.undeclared.size > 0) put("usage.undeclaredProps", [...u.undeclared].sort(), samples)
    const combos = [...u.combinations]
      .map(([key, count]) => ({ props: key === "" ? [] : key.split(","), count }))
      .sort((a, b) => b.count - a.count || (a.props.join() < b.props.join() ? -1 : 1))
      .slice(0, 10)
    put("usage.combinations", combos, samples)
  }
}
