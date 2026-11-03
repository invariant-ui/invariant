import {
  ComponentFacts,
  type Evidence,
  excerpt,
  type IrBuilder,
  type PackageInfo,
  variantsFromProps
} from "@invariant/compiler-core"
import type { JsonValue } from "@invariant/shared"
import type ts from "typescript"
import type { AngularComponent, AngularModule } from "./analyze.js"

export const CAPABILITIES = [
  "name",
  "implementations.*",
  "props.*",
  "events.*",
  "slots.*",
  "variants.*",
  "accessibility.*",
  "styling.*",
  "composition.*",
  "module.*"
]

/** Writes one component or directive with the neutral fact paths shared with the other framework adapters. */
export function emitComponent(builder: IrBuilder, c: AngularComponent, pkg: PackageInfo): void {
  const { meta } = c
  const ref = builder.entity(c.ref, "component", meta.name)
  const facts = new ComponentFacts(builder, ref, "angular")
  const atNode = (node: ts.Node, method: "compiler-api" | "ast" = "ast"): Evidence =>
    builder.evidence({
      sourceRef: `${meta.file}#${meta.name}`,
      location: {
        type: "file",
        path: node.getSourceFile().fileName.replace(/^\//, ""),
        line: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1
      },
      method,
      original: excerpt(node)
    })
  const atLine = (file: string, line: number, original?: string): Evidence =>
    builder.evidence({
      sourceRef: `${file}#${meta.name}`,
      location: { type: "file", path: file, line },
      method: "ast",
      ...(original ? { original } : {})
    })

  const decl = atNode(meta.node)
  facts.put("name", meta.name, decl)
  facts.link(meta.file, meta.name, decl)
  if (pkg.name) facts.put("implementations.angular.packageName", pkg.name, decl)
  const primary = [...c.exports].sort(
    (a, b) => (a.subpath === "." ? 0 : 1) - (b.subpath === "." ? 0 : 1) || (a.name < b.name ? -1 : 1)
  )[0]
  if (primary) {
    facts.put("implementations.angular.exportName", primary.name, decl)
    if (pkg.name)
      facts.put(
        "implementations.angular.importPath",
        primary.subpath === "." ? pkg.name : `${pkg.name}/${primary.subpath.replace(/^\.\//, "")}`,
        decl
      )
  }
  facts.ext("kind", meta.kind, decl)
  facts.ext("exports", c.exports as unknown as JsonValue, decl)
  facts.ext("propsComplete", c.propsComplete, decl)
  if (meta.selector) facts.ext("selector", meta.selector, decl)
  // `standalone` is recorded only when it is written: its default depends on the Angular version.
  if (meta.standalone !== undefined) facts.ext("standalone", meta.standalone, decl)
  if (meta.imports.length > 0) facts.ext("imports", meta.imports as unknown as JsonValue, decl)
  if (meta.exportAs) facts.ext("exportAs", meta.exportAs, decl)
  if (meta.changeDetection) facts.ext("changeDetection", meta.changeDetection, decl)
  if (meta.encapsulation) facts.ext("encapsulation", meta.encapsulation, decl)
  if (meta.hostDirectives.length > 0) facts.ext("hostDirectives", meta.hostDirectives, decl)
  if (meta.inheritsFrom.length > 0)
    facts.ext("inheritedPropsFrom", [...new Set(meta.inheritsFrom)].sort(), decl)
  if (c.template)
    facts.ext("templateSource", c.template.source === "inline" ? "inline" : c.template.file, decl)
  if (c.modules.declaredIn.length > 0) facts.ext("declaredIn", c.modules.declaredIn, decl)
  if (c.modules.exportedBy.length > 0) facts.ext("exportedBy", c.modules.exportedBy, decl)
  if (meta.queries.length > 0) facts.ext("queries", meta.queries as unknown as JsonValue, decl)
  const hostListeners = [
    ...meta.hostListeners,
    ...Object.keys(meta.host)
      .filter((k) => /^\(.+\)$/.test(k))
      .map((k) => k.slice(1, -1))
  ].sort()
  const hostBindings = [
    ...meta.hostBindings,
    ...Object.keys(meta.host)
      .filter((k) => /^\[.+\]$/.test(k))
      .map((k) => k.slice(1, -1))
  ].sort()
  if (hostListeners.length > 0) facts.ext("host.listeners", hostListeners, decl)
  if (hostBindings.length > 0) facts.ext("host.bindings", hostBindings, decl)

  const specs = c.inputs.map((p) => ({
    name: p.name,
    typeText: p.typeText,
    kind: p.typeKind,
    required: p.required,
    ...(p.default !== undefined ? { default: p.default } : {}),
    ...(p.defaultExpression !== undefined ? { defaultExpression: p.defaultExpression } : {}),
    ...(p.allowedValues ? { allowedValues: p.allowedValues } : {}),
    ...(p.description ? { description: p.description } : {}),
    ...(p.deprecated ? { deprecated: p.deprecated } : {}),
    extensions: {
      kind: p.kind,
      property: p.property,
      ...(p.alias ? { alias: p.alias } : {}),
      ...(p.transform ? { transform: p.transform } : {}),
      ...(p.writeType ? { writeType: p.writeType } : {}),
      ...(p.typeInferred ? { typeInferred: true } : {}),
      ...(p.inheritedFrom ? { inheritedFrom: p.inheritedFrom } : {})
    }
  }))
  for (const [i, p] of c.inputs.entries()) {
    facts.prop(
      specs[i] as (typeof specs)[number],
      atNode(p.node, p.kind === "input" ? "compiler-api" : "ast")
    )
  }
  for (const o of c.outputs) {
    facts.event(
      {
        name: o.name,
        ...(o.payloadText ? { payloadText: o.payloadText } : {}),
        ...(o.description ? { description: o.description } : {}),
        extensions: {
          kind: o.kind,
          property: o.property,
          ...(o.alias ? { alias: o.alias } : {}),
          ...(o.inheritedFrom ? { inheritedFrom: o.inheritedFrom } : {})
        }
      },
      atNode(o.node)
    )
  }
  if (c.template) {
    for (const s of c.template.info.slots) {
      facts.slot(
        {
          name: s.name,
          extensions: { source: "ng-content", ...(s.select !== undefined ? { select: s.select } : {}) }
        },
        atLine(c.template.file, s.line)
      )
    }
  }
  for (const v of variantsFromProps(specs)) {
    const input = c.inputs.find((p) => p.name === v.name)
    facts.variant({ ...v, extensions: { source: "prop-union" } }, input ? atNode(input.node) : decl)
  }
  if (c.template && (c.accessibility.roles.length > 0 || c.accessibility.attributes.length > 0)) {
    facts.accessibility(
      {
        ...(c.accessibility.roles.length === 1 ? { role: c.accessibility.roles[0] as string } : {}),
        attributes: c.accessibility.attributes
      },
      atLine(c.template.file, c.template.line)
    )
  }
  const s = c.styling
  if (s.files.length > 0) facts.put("styling.cssFiles", s.files, decl)
  if (s.variables.length > 0) {
    facts.put(
      "styling.cssVariables",
      s.variables.map((v) => v.name),
      s.variables.map((v) =>
        builder.evidence({
          sourceRef: `${v.file}#${v.name}`,
          location: { type: "file", path: v.file, line: v.line },
          method: "structured-parse",
          original: `var(${v.name})`
        })
      )
    )
  }
  if (s.preprocessors.length > 0) facts.put("styling.preprocessors", s.preprocessors, decl)
  if (c.renders.length > 0)
    facts.put(
      "composition.renders",
      c.renders as unknown as JsonValue,
      c.template ? atLine(c.template.file, c.template.line) : decl
    )
}

/** An NgModule: what it declares, imports and exports. Names are kept as written. */
export function emitModule(builder: IrBuilder, m: AngularModule): void {
  const ref = builder.entity(m.ref, "module", m.meta.name)
  const evidence = builder.evidence({
    sourceRef: `${m.meta.file}#${m.meta.name}`,
    location: { type: "file", path: m.meta.file, line: m.meta.line },
    method: "ast",
    original: excerpt(m.meta.node)
  })
  const put = (path: string, value: JsonValue): void =>
    builder.fact(ref, path, value, evidence, { origin: "extracted" })
  put("module.name", m.meta.name)
  put("module.file", m.meta.file)
  put("module.public", m.public)
  put("module.declarations", m.meta.declarations as unknown as JsonValue)
  put("module.imports", m.meta.imports as unknown as JsonValue)
  put("module.exports", m.meta.exports as unknown as JsonValue)
}
