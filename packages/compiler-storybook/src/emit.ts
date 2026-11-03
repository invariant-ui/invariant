import type { Evidence, IrBuilder } from "@invariant/compiler-core"
import { excerpt, lineOf } from "@invariant/compiler-core"
import type { JsonValue } from "@invariant/shared"
import type ts from "typescript"
import type { Annotations, ArgTypeInfo, CsfFile, CsfGroup, CsfStory } from "./csf.js"
import type { BuiltIndexEntry } from "./index-json.js"
import type { MdxDoc } from "./mdx.js"

export const CAPABILITIES = ["group.*", "story.*", "doc.*"]

type Origin = "extracted" | "authored"

/** Writes one story file: its meta (a `story-group`) and each story. */
export function emitCsf(
  builder: IrBuilder,
  csf: CsfFile,
  index: ReadonlyArray<BuiltIndexEntry> | undefined,
  indexPath: string | undefined
): void {
  const at = (node: ts.Node, method: "ast" | "compiler-api" = "ast"): Evidence =>
    builder.evidence({
      sourceRef: `${csf.file}#${lineOf(node)}`,
      location: { type: "file", path: csf.file, line: lineOf(node) },
      method,
      original: excerpt(node)
    })

  let groupRef: string | undefined
  if (csf.group) {
    groupRef = builder.entity(`storybook:${csf.file}`, "story-group", csf.group.title ?? csf.file)
    emitGroup(builder, groupRef, csf, csf.group, at)
    if (index && indexPath) {
      const entries = index.filter((e) => e.importPath.replace(/^\.\//, "") === indexPath)
      const evidence = builder.evidence({
        sourceRef: "storybook-static/index.json",
        location: { type: "file", path: "storybook-static/index.json" },
        method: "structured-parse"
      })
      builder.fact(
        groupRef,
        "group.index.entries",
        entries.map((e) => ({
          id: e.id,
          type: e.type,
          ...(e.title ? { title: e.title } : {}),
          ...(e.name ? { name: e.name } : {})
        })) as unknown as JsonValue,
        evidence
      )
    }
  }
  for (const story of csf.stories) emitStory(builder, csf, story, groupRef, at)
}

function emitGroup(
  builder: IrBuilder,
  ref: string,
  csf: CsfFile,
  group: CsfGroup,
  at: (n: ts.Node, m?: "ast" | "compiler-api") => Evidence
): void {
  const node = at(group.node)
  const put = (
    path: string,
    value: JsonValue,
    evidence: Evidence | Evidence[] = node,
    origin: Origin = "extracted",
    completeness?: "complete" | "partial"
  ): void => builder.fact(ref, path, value, evidence, { origin, ...(completeness ? { completeness } : {}) })
  put("group.file", csf.file)
  if (group.title) put("group.title", group.title)
  else put("group.titleAuto", true)
  if (csf.selectionUncertain) put("group.selectionUncertain", true)
  if (csf.excluded.length > 0) put("group.excludedExports", csf.excluded)
  if (group.component) {
    const ev = at(group.componentNode ?? group.node, "compiler-api")
    const c = group.component
    put(
      "group.component",
      {
        text: c.text,
        via: c.via,
        ...(c.file ? { file: c.file } : {}),
        ...(c.name ? { name: c.name } : {}),
        ...(c.external ? { external: c.external } : {}),
        ...(c.unresolvedModule ? { unresolvedModule: c.unresolvedModule } : {})
      },
      ev
    )
  }
  emitAnnotations(builder, ref, "group", group, at)
}

function emitStory(
  builder: IrBuilder,
  csf: CsfFile,
  story: CsfStory,
  groupRef: string | undefined,
  at: (n: ts.Node, m?: "ast" | "compiler-api") => Evidence
): void {
  const ref = builder.entity(
    `storybook:${csf.file}#${story.exportName}`,
    "story",
    story.name ?? story.exportName
  )
  const node = at(story.node)
  const put = (
    path: string,
    value: JsonValue,
    evidence: Evidence | Evidence[] = node,
    origin: Origin = "extracted"
  ): void => builder.fact(ref, path, value, evidence, { origin })
  put("story.exportName", story.exportName)
  put("story.file", csf.file)
  put("story.shape", story.shape)
  if (story.name) put("story.name", story.name)
  if (groupRef) put("story.group", groupRef)
  if (story.description) put("story.description", story.description, node, "authored")
  put("story.hasRender", story.hasRender)
  if (story.play) {
    put("story.play.present", true)
    if (story.play.calls.length > 0) put("story.play.calls", story.play.calls)
    if (story.play.steps.length > 0) put("story.play.steps", story.play.steps)
  }
  if (story.composes.length > 0)
    put("story.composes", story.composes as unknown as JsonValue, at(story.node, "compiler-api"))
  emitAnnotations(builder, ref, "story", story, at)
}

type Put = (
  path: string,
  value: JsonValue,
  evidence: Evidence,
  options?: { origin?: Origin; completeness?: "complete" | "partial" }
) => void

function emitAnnotations(
  builder: IrBuilder,
  ref: string,
  prefix: "group" | "story",
  a: Annotations,
  at: (n: ts.Node, m?: "ast" | "compiler-api") => Evidence
): void {
  const put: Put = (path, value, evidence, options = {}) =>
    builder.fact(ref, `${prefix}.${path}`, value, evidence, {
      origin: options.origin ?? "extracted",
      ...(options.completeness ? { completeness: options.completeness } : {})
    })

  if (a.args.value && typeof a.args.value === "object" && !Array.isArray(a.args.value)) {
    for (const [name, value] of Object.entries(a.args.value)) {
      const node = a.argNodes.get(name) ?? a.argsNode
      if (node) put(`args.${name}`, value, at(node))
    }
  }
  if (a.args.unresolved.length > 0 && a.argsNode)
    put("argsUnresolved", [...new Set(a.args.unresolved)].sort(), at(a.argsNode), { completeness: "partial" })
  if (a.args.spies.length > 0 && a.argsNode)
    put("argsSpies", [...new Set(a.args.spies)].sort(), at(a.argsNode))

  for (const [prop, info] of Object.entries(a.argTypes)) {
    const node = a.argTypeNodes.get(prop)
    if (node) emitArgType(put, `argTypes.${prop}`, info, at(node))
  }
  const firstArgType = [...a.argTypeNodes.values()][0]
  if (a.argTypesUnresolved.length > 0 && firstArgType)
    put("argTypesUnresolved", [...new Set(a.argTypesUnresolved)].sort(), at(firstArgType), {
      completeness: "partial"
    })

  const p = a.parameters
  if (a.nodes.parameters && p.keys.length > 0) {
    const ev = at(a.nodes.parameters)
    put("parameters.keys", p.keys, ev)
    if (p.a11y !== undefined) put("parameters.a11y", p.a11y, ev)
    if (p.layout) put("parameters.layout", p.layout, ev)
    if (p.controls !== undefined) put("parameters.controls", p.controls, ev)
    if (p.docsDescription?.component)
      put("docs.description", p.docsDescription.component, ev, { origin: "authored" })
  }
  if (a.nodes.tags && a.tags && a.tags.length > 0) put("tags", a.tags, at(a.nodes.tags))
  if (a.nodes.decorators) put("hasDecorators", true, at(a.nodes.decorators))
  if (a.nodes.loaders) put("hasLoaders", true, at(a.nodes.loaders))
}

function emitArgType(put: Put, base: string, info: ArgTypeInfo, ev: Evidence): void {
  put(`${base}.declared`, true, ev)
  if (info.control !== undefined) put(`${base}.control`, info.control, ev)
  if (info.options)
    put(`${base}.options`, info.options, ev, {
      completeness: info.optionsUnresolved ? "partial" : "complete"
    })
  else if (info.optionsUnresolved) put(`${base}.optionsUnresolved`, true, ev, { completeness: "partial" })
  // A description is prose a person wrote in the story file.
  if (info.description) put(`${base}.description`, info.description, ev, { origin: "authored" })
  if (info.defaultSummary !== undefined) put(`${base}.defaultSummary`, info.defaultSummary, ev)
  if (info.mappingKeys) put(`${base}.mappingKeys`, info.mappingKeys, ev)
  if (info.action) put(`${base}.action`, info.action, ev)
  if (info.hidden) put(`${base}.hidden`, true, ev)
  if (info.category) put(`${base}.category`, info.category, ev)
}

/** Writes an MDX documentation page. Prose is authored; imports and blocks are extracted. */
export function emitMdx(builder: IrBuilder, doc: MdxDoc): void {
  const ref = builder.entity(`storybook:${doc.path}`, "doc-page", doc.title ?? doc.path)
  const structure = builder.evidence({
    sourceRef: doc.path,
    location: { type: "file", path: doc.path, line: 1 },
    method: "document-parse"
  })
  const putStructure = (path: string, value: JsonValue, evidence: Evidence = structure): void =>
    builder.fact(ref, path, value, evidence, { origin: "extracted" })
  putStructure("doc.kind", "storybook-mdx")
  putStructure("doc.file", doc.path)
  if (doc.title) builder.fact(ref, "doc.title", doc.title, structure, { origin: "authored" })
  if (doc.metaTitle) builder.fact(ref, "doc.meta.title", doc.metaTitle, structure, { origin: "authored" })
  if (doc.metaOf) {
    const ev = builder.evidence({
      sourceRef: `${doc.path}#meta`,
      location: { type: "file", path: doc.path, line: doc.metaOf.line },
      method: "document-parse"
    })
    putStructure(
      "doc.meta.of",
      { identifier: doc.metaOf.identifier, ...(doc.metaOf.file ? { file: doc.metaOf.file } : {}) },
      ev
    )
  }
  if (doc.blocks.length > 0) putStructure("doc.blocks", doc.blocks)
  if (doc.storyRefs.length > 0) {
    const first = doc.storyRefs[0]
    const ev = builder.evidence({
      sourceRef: `${doc.path}#stories`,
      location: { type: "file", path: doc.path, line: first?.line ?? 1 },
      method: "document-parse"
    })
    putStructure(
      "doc.stories",
      doc.storyRefs.map(({ block, exportName, file }) => ({
        block,
        exportName,
        ...(file ? { file } : {})
      })) as unknown as JsonValue,
      ev
    )
  }
  for (const [i, section] of doc.sections.entries()) {
    const ev = builder.evidence({
      sourceRef: `${doc.path}#${section.line}`,
      location: { type: "file", path: doc.path, line: section.line },
      method: "document-parse",
      original: section.heading
    })
    builder.fact(
      ref,
      `doc.sections.s${i + 1}`,
      { heading: section.heading, level: section.level, text: section.text },
      ev,
      { origin: "authored" }
    )
  }
}
