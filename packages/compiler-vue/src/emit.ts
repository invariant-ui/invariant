import {
  ComponentFacts,
  type Evidence,
  excerpt,
  type IrBuilder,
  type PackageInfo
} from "@invariant/compiler-core"
import type { JsonValue } from "@invariant/shared"
import type ts from "typescript"
import type { VueComponent } from "./analyze.js"

export const CAPABILITIES = [
  "name",
  "implementations.*",
  "props.*",
  "events.*",
  "slots.*",
  "variants.*",
  "accessibility.*",
  "styling.*",
  "composition.*"
]

/** Writes one component with the neutral fact paths shared with the other framework adapters. */
export function emitComponent(builder: IrBuilder, c: VueComponent, pkg: PackageInfo): void {
  const ref = builder.entity(c.ref, "component", c.localName)
  const facts = new ComponentFacts(builder, ref, "vue")
  const at = (node: ts.Node, method: "compiler-api" | "ast" = "compiler-api"): Evidence => {
    const location = c.locate(node)
    return builder.evidence({
      sourceRef: `${location.file}#${c.localName}`,
      location: { type: "file", path: location.file, line: location.line },
      method,
      original: excerpt(node)
    })
  }
  const block = (line: number, method: "ast" | "structured-parse" = "ast", original?: string): Evidence =>
    builder.evidence({
      sourceRef: `${c.file}#${c.localName}`,
      location: { type: "file", path: c.file, line },
      method,
      ...(original ? { original } : {})
    })

  const decl = block(c.line)
  facts.put("name", c.localName, decl)
  facts.link(c.file, c.localName, decl)
  if (pkg.name) facts.put("implementations.vue.packageName", pkg.name, decl)
  const primary = [...c.exports].sort(
    (a, b) =>
      (a.subpath === "." ? 0 : 1) - (b.subpath === "." ? 0 : 1) ||
      (a.name === "default" ? 1 : 0) - (b.name === "default" ? 1 : 0) ||
      (a.name < b.name ? -1 : 1)
  )[0]
  if (primary) {
    facts.put("implementations.vue.exportName", primary.name, decl)
    if (pkg.name)
      facts.put(
        "implementations.vue.importPath",
        primary.subpath === "." ? pkg.name : `${pkg.name}/${primary.subpath.replace(/^\.\//, "")}`,
        decl
      )
  }
  facts.ext("kind", c.kind, decl)
  facts.ext("exports", c.exports as unknown as JsonValue, decl)
  facts.ext("propsComplete", c.propsComplete, decl)
  if (c.sfc) {
    const d = c.sfc.descriptor
    facts.ext("scriptSetup", d.scriptSetup !== null, decl)
    facts.ext("optionsApi", c.script.optionsApi, decl)
    const lang = d.scriptSetup?.lang ?? d.script?.lang
    if (lang) facts.ext("scriptLang", lang, decl)
    if (d.template?.lang) facts.ext("templateLang", d.template.lang, decl)
  }
  if (c.generic) facts.ext("generic", c.generic, decl)
  if (c.script.inheritsFrom.length > 0)
    facts.ext("inheritedPropsFrom", [...new Set(c.script.inheritsFrom)].sort(), decl)
  if (c.script.exposed.length > 0) facts.ext("exposed", c.script.exposed, decl)
  if (c.script.options.name) facts.ext("options.name", c.script.options.name, decl)
  if (c.script.options.inheritAttrs !== undefined)
    facts.ext("options.inheritAttrs", c.script.options.inheritAttrs, decl)
  const dynamicSlots = (c.template?.slots ?? []).filter((s) => s.dynamic).length
  if (dynamicSlots > 0) facts.ext("dynamicSlots", dynamicSlots, decl)

  for (const p of [...c.script.props].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const evidence = at(p.node, p.source === "type" ? "compiler-api" : "ast")
    facts.prop(
      {
        name: p.name,
        typeText: p.typeText,
        kind: p.kind,
        required: p.required,
        ...(p.default !== undefined ? { default: p.default } : {}),
        ...(p.defaultExpression !== undefined ? { defaultExpression: p.defaultExpression } : {}),
        ...(p.allowedValues ? { allowedValues: p.allowedValues } : {}),
        ...(p.description ? { description: p.description } : {}),
        ...(p.deprecated ? { deprecated: p.deprecated } : {}),
        extensions: { kind: p.source === "model" ? "model" : "prop", source: p.source }
      },
      evidence
    )
  }
  for (const e of [...c.script.emits].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    facts.event(
      {
        name: e.name,
        ...(e.payloadText ? { payloadText: e.payloadText } : {}),
        extensions: { kind: e.source === "model" ? "model" : "emit", source: e.source, emit: e.name }
      },
      at(e.node, e.source === "type" ? "compiler-api" : "ast")
    )
  }
  for (const s of c.slots) {
    const evidence = s.node ? at(s.node) : block(s.line ?? c.templateLine ?? c.line)
    facts.slot(
      {
        name: s.name,
        extensions: {
          source: s.sources.length === 2 ? "both" : (s.sources[0] as string),
          ...(s.propsText ? { props: s.propsText } : {}),
          ...(s.templateProps.length > 0 ? { propNames: s.templateProps } : {})
        }
      },
      evidence
    )
  }
  for (const v of c.variants) {
    const prop = c.script.props.find((p) => p.name === v.name)
    facts.variant({ ...v, extensions: { source: "prop-union" } }, prop ? at(prop.node) : decl)
  }

  const a11y = c.template?.accessibility
  if (a11y && (a11y.roles.length > 0 || a11y.attributes.length > 0)) {
    const evidence = block(c.templateLine ?? c.line)
    facts.accessibility(
      { ...(a11y.roles.length === 1 ? { role: a11y.roles[0] as string } : {}), attributes: a11y.attributes },
      evidence
    )
  }

  const s = c.styling
  if (s.blocks > 0) {
    const evidence = block(c.line)
    if (s.variables.length > 0) {
      const refs = s.variables.map((v) => block(v.line, "structured-parse", `var(${v.name})`))
      facts.put(
        "styling.cssVariables",
        s.variables.map((v) => v.name),
        refs
      )
    }
    facts.put("styling.scoped", s.scoped, evidence)
    if (s.module) facts.put("styling.cssModules", [c.file], evidence)
    if (s.preprocessors.length > 0) facts.put("styling.preprocessors", s.preprocessors, evidence)
  }
  if (c.renders.length > 0)
    facts.put("composition.renders", c.renders as unknown as JsonValue, block(c.templateLine ?? c.line))
}
