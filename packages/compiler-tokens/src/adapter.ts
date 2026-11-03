import {
  type DiscoveredSource,
  hashText,
  IrBuilder,
  type IrBuilder as IrBuilderType,
  type SourceAdapter,
  scanCssCustomProperties,
  type TokenFile
} from "@invariant/compiler-core"
import { hashJson, type JsonValue } from "@invariant/shared"
import { classifyScope, valueKind } from "./css.js"
import { parseJsonWithLines } from "./json-lines.js"
import { extractJsonTokens } from "./json-tokens.js"

type Config = { files: string[] }

export const ADAPTER_ID = "design-tokens"
export const ADAPTER_VERSION = "0.1.0"

/**
 * Extracts design tokens from CSS custom properties and from W3C-Design-Tokens-shaped or Style
 * Dictionary-shaped JSON. It records names, raw values, references and theme modes exactly as written.
 * It does not decide token categories or semantic names: those are interpretation, not extraction.
 */
export const designTokensAdapter: SourceAdapter<Config> = {
  id: ADAPTER_ID,
  version: ADAPTER_VERSION,
  type: "tokens",
  async discover({ project }) {
    const groups = new Map<string, TokenFile[]>()
    for (const file of project.tokenFiles) {
      if (!isExtractable(file)) continue
      groups.set(file.package ?? "", [...(groups.get(file.package ?? "") ?? []), file])
    }
    const used = new Set<string>()
    const sources: DiscoveredSource<Config>[] = []
    for (const [packageId, files] of [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const pkg = project.packages.find((p) => p.id === packageId)
      const slug =
        (pkg?.name ?? pkg?.dir ?? "root")
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, "-")
          .replace(/^[^a-z0-9]+|[-.]+$/g, "") || "root"
      let id = `design-tokens-${slug}`
      for (let n = 2; used.has(id); n++) id = `design-tokens-${slug}-${n}`
      used.add(id)
      sources.push({
        id,
        type: "tokens",
        location: pkg?.dir ?? ".",
        config: { files: files.map((f) => f.path) },
        inputHash: hashJson(files.map((f) => [f.path, f.contentHash]))
      })
    }
    return { sources, diagnostics: [] }
  },

  async extract({ fs, project, source, clock }, config) {
    const builder = new IrBuilder({
      source: {
        id: source.id,
        type: source.type,
        location: source.location,
        inputHash: source.inputHash,
        adapter: { name: ADAPTER_ID, version: ADAPTER_VERSION }
      },
      extractor: { name: ADAPTER_ID, version: ADAPTER_VERSION },
      capabilities: ["name", "description", "deprecated", "value.*", "modes.*", "extensions.*"],
      clock
    })
    let partial = false
    for (const file of project.tokenFiles.filter((f) => config.files.includes(f.path))) {
      if (file.kind === "css-custom-properties") {
        partial = (await extractCss({ fs, builder, file })) || partial
      } else {
        partial = (await extractJson({ fs, builder, file })) || partial
      }
    }
    return { ir: builder.build(partial ? "partial" : "complete") }
  },

  async validate({ ir }) {
    return ir.entities.length === 0
      ? [
          {
            code: "tokens.none-extracted",
            severity: "warning" as const,
            message: `No tokens were extracted for ${ir.source.id}`,
            sourceId: ir.source.id
          }
        ]
      : []
  }
}

function isExtractable(file: TokenFile): boolean {
  return (
    file.kind === "css-custom-properties" ||
    (file.kind === "json-tokens" && (file.format === "dtcg-like" || file.format === "style-dictionary-like"))
  )
}

async function extractCss(input: {
  fs: import("@invariant/compiler-core").ReadonlyFs
  builder: IrBuilderType
  file: TokenFile
}): Promise<boolean> {
  const { fs, builder, file } = input
  const text = await fs.readFile(file.path)
  if (hashText(text) !== file.contentHash) throw new Error(`${file.path} changed after discovery`)
  for (const variable of scanCssCustomProperties(text)) {
    const scope = classifyScope(variable.chain)
    const name = variable.name.slice(2)
    const ref =
      scope.kind === "other"
        ? `css:${file.path}#${variable.name}@${variable.scope}`
        : `css:${file.path}#${variable.name}`
    builder.entity(ref, "token", name)
    const evidence = builder.evidence({
      sourceRef: `${file.path}#${variable.name}`,
      location: { type: "file", path: file.path, line: variable.line },
      method: "structured-parse",
      original: `${variable.name}: ${variable.value};`
    })
    builder.fact(ref, "name", name, evidence)
    builder.fact(ref, "extensions.css.name", variable.name, evidence)
    // Per-scope facts live under the scope they describe, so a root and a dark definition never
    // contradict each other; only two definitions in the same scope can conflict.
    const base =
      scope.kind === "theme"
        ? `extensions.css.modes.${scope.mode}`
        : scope.kind === "root"
          ? "extensions.css.root"
          : "extensions.css"
    builder.fact(ref, `${base}.rawValue`, variable.value, evidence)
    builder.fact(ref, `${base}.valueKind`, valueKind(variable.value), evidence)
    if (scope.kind === "other") {
      builder.fact(ref, "extensions.css.scopeKind", "other", evidence)
      builder.fact(ref, "extensions.css.scope", variable.scope, evidence)
      continue
    }
    if (scope.kind === "theme") builder.fact(ref, `${base}.via`, scope.via, evidence)
    const prefix = scope.kind === "theme" ? `modes.${scope.mode}` : "value"
    if (variable.aliasOf) builder.fact(ref, `${prefix}.aliasOf`, variable.aliasOf.slice(2), evidence)
    else builder.fact(ref, `${prefix}.value`, variable.value, evidence)
  }
  return file.cssVariablesTruncated === true
}

async function extractJson(input: {
  fs: import("@invariant/compiler-core").ReadonlyFs
  builder: IrBuilderType
  file: TokenFile
}): Promise<boolean> {
  const { fs, builder, file } = input
  const text = await fs.readFile(file.path)
  if (hashText(text) !== file.contentHash) throw new Error(`${file.path} changed after discovery`)
  for (const token of extractJsonTokens(parseJsonWithLines(text))) {
    const ref = `token:${file.path}#${token.name}`
    builder.entity(ref, "token", token.name)
    const evidence = builder.evidence({
      sourceRef: `${file.path}#${token.name}`,
      location: { type: "file", path: file.path, line: token.line },
      method: "structured-parse"
    })
    builder.fact(ref, "name", token.name, evidence)
    if (token.aliasOf) builder.fact(ref, "value.aliasOf", token.aliasOf, evidence)
    else builder.fact(ref, "value.value", token.value as JsonValue, evidence)
    if (token.type) builder.fact(ref, `extensions.${token.format}.type`, token.type, evidence)
    if (token.description)
      builder.fact(ref, "description", token.description, evidence, { origin: "authored" })
    if (token.deprecated)
      builder.fact(ref, "deprecated", token.deprecated as JsonValue, evidence, { origin: "authored" })
  }
  return false
}
