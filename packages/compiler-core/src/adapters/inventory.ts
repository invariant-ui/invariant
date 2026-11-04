import type { Diagnostic } from "@invariant/shared"
import { hashJson, type JsonValue } from "@invariant/shared"
import type { DiscoveredSource, SourceAdapter, SourceVersion } from "../adapter.js"
import type { PackageInfo, ProjectDiscovery } from "../discovery/index.js"
import { cmp } from "../discovery/support.js"
import { IrBuilder } from "../ir-builder.js"

/**
 * Framework-neutral inventory adapters. They project what project discovery found (packages, Storybook
 * configs, token files, documentation) into IR so a repository can be represented without any framework
 * adapter. They do not decide what is a component, and they read nothing beyond the discovery result.
 */

type PackageConfig = { packageId: string }
type FileGroupConfig = { packageId: string; files: string[] }
type StorybookSourceConfig = { storybookId: string }

export const npmPackageAdapter: SourceAdapter<PackageConfig> = {
  id: "inventory-npm",
  version: "0.1.0",
  type: "npm",
  async discover({ project }) {
    const ids = new SourceIds("npm")
    return {
      sources: project.packages.map((pkg) => ({
        id: ids.next(pkg.name ?? pkg.dir),
        type: "npm",
        location: pkg.dir,
        config: { packageId: pkg.id },
        ...(pkg.version
          ? { version: { kind: "package-version", value: pkg.version } satisfies SourceVersion }
          : {}),
        inputHash: hashJson({
          manifest: pkg.manifest.contentHash,
          parsed: pkg.entryPoints.flatMap((e) => e.parsedFiles.map((f) => [f.path, f.contentHash]))
        })
      })),
      diagnostics: []
    }
  },
  async extract({ project, source, clock }, config) {
    const pkg = requirePackage(project, config.packageId)
    const builder = new IrBuilder({
      source: irSource(source, npmPackageAdapter),
      extractor: { name: "inventory-npm", version: npmPackageAdapter.version },
      capabilities: ["package.*", "frameworks", "buildTools", "entryPoints", "export.*"],
      clock
    })
    const manifest = (line?: number) =>
      builder.evidence({
        sourceRef: pkg.manifest.path,
        location: { type: "file", path: pkg.manifest.path, ...(line ? { line } : {}) },
        method: "structured-parse"
      })
    const subject = builder.entity(pkg.id, "package", pkg.name ?? pkg.dir)
    const base = manifest()
    if (pkg.name) builder.fact(subject, "package.name", pkg.name, base)
    if (pkg.version) builder.fact(subject, "package.version", pkg.version, base)
    builder.fact(subject, "package.private", pkg.private, base)
    builder.fact(subject, "package.directory", pkg.dir, base)
    if (pkg.dir === ".")
      builder.fact(subject, "package.manager", project.packageManager as unknown as JsonValue, base)
    builder.fact(
      subject,
      "frameworks",
      pkg.frameworks as unknown as JsonValue,
      manifest(pkg.frameworks[0]?.line)
    )
    builder.fact(subject, "buildTools", pkg.buildTools as unknown as JsonValue, base)
    builder.fact(
      subject,
      "entryPoints",
      pkg.entryPoints.map(({ subpath, condition, target, resolution, file, exportsComplete }) => ({
        subpath,
        condition,
        target,
        resolution,
        ...(file ? { file } : {}),
        exportsComplete
      })) as unknown as JsonValue,
      base
    )
    for (const entry of pkg.entryPoints) {
      for (const exported of entry.exports) {
        const ref = `${pkg.id}#${entry.subpath}:${exported.name}`
        builder.entity(ref, "export", exported.name)
        const evidence = builder.evidence({
          sourceRef: `${exported.file}#${exported.name}`,
          location: { type: "file", path: exported.file, line: exported.line },
          method: "ast"
        })
        const completeness = entry.exportsComplete ? "complete" : "partial"
        builder.fact(ref, "export.name", exported.name, evidence, { completeness })
        builder.fact(ref, "export.kind", exported.kind, evidence, { completeness })
        builder.fact(ref, "export.typeOnly", exported.typeOnly, evidence, { completeness })
        builder.fact(ref, "export.entry", entry.subpath, evidence, { completeness })
        if (exported.reexportOf)
          builder.fact(ref, "export.reexportOf", exported.reexportOf, evidence, { completeness })
      }
    }
    for (const d of diagnosticsAbout(project, [
      pkg.manifest.path,
      ...pkg.entryPoints.flatMap((e) => e.parsedFiles.map((f) => f.path))
    ]))
      builder.diagnostic(d)
    const partial = pkg.entryPoints.some((e) => !e.exportsComplete)
    return { ir: builder.build(partial ? "partial" : "complete") }
  },
  async validate() {
    return []
  }
}

export const storybookConfigAdapter: SourceAdapter<StorybookSourceConfig> = {
  id: "inventory-storybook",
  version: "0.1.0",
  type: "storybook",
  async discover({ project }) {
    const ids = new SourceIds("storybook")
    return {
      sources: project.storybooks.map((sb) => ({
        id: ids.next(sb.directory === "." ? "root" : sb.directory),
        type: "storybook",
        location: sb.directory,
        config: { storybookId: sb.id },
        ...(sb.version?.installedVersion
          ? { version: { kind: "tool-version", value: sb.version.installedVersion } satisfies SourceVersion }
          : {}),
        inputHash: hashJson({ config: sb.configHash, stories: sb.storyFiles })
      })),
      diagnostics: []
    }
  },
  async extract({ project, source, clock }, config) {
    const sb = project.storybooks.find((s) => s.id === config.storybookId)
    if (!sb) throw new Error(`Storybook ${config.storybookId} is not in the project discovery`)
    const builder = new IrBuilder({
      source: irSource(source, storybookConfigAdapter),
      extractor: { name: "inventory-storybook", version: storybookConfigAdapter.version },
      capabilities: ["config.*"],
      clock
    })
    const subject = builder.entity(sb.id, "config", `Storybook (${sb.directory})`)
    const evidence = builder.evidence({
      sourceRef: sb.configPath,
      location: { type: "file", path: sb.configPath },
      method: "ast"
    })
    const complete = sb.dynamicProperties.length === 0 ? "complete" : "partial"
    const put = (
      path: string,
      value: JsonValue | undefined,
      completeness: "complete" | "partial" = complete
    ): void => {
      if (value !== undefined) builder.fact(subject, path, value, evidence, { completeness })
    }
    put("config.path", sb.configPath)
    put("config.framework", sb.framework)
    put("config.addons", sb.addons)
    put("config.stories", sb.stories as unknown as JsonValue)
    put("config.staticDirs", sb.staticDirs)
    put("config.dynamicProperties", sb.dynamicProperties)
    put("config.version", sb.version as unknown as JsonValue | undefined)
    put("config.builtOutput", sb.builtOutput as unknown as JsonValue | undefined)
    put("config.storyFileCount", sb.storyFileCount)
    put("config.storyFiles", sb.storyFiles, sb.storyFilesTruncated ? "partial" : "complete")
    for (const d of diagnosticsAbout(project, [sb.configPath])) builder.diagnostic(d)
    return {
      ir: builder.build(sb.dynamicProperties.length > 0 || sb.storyFilesTruncated ? "partial" : "complete")
    }
  },
  async validate() {
    return []
  }
}

export const tokenFilesAdapter: SourceAdapter<FileGroupConfig> = {
  id: "inventory-tokens",
  version: "0.1.0",
  type: "tokens",
  async discover({ project }) {
    const ids = new SourceIds("tokens")
    return {
      sources: groupByPackage(project, project.tokenFiles).map(({ pkg, files }) => ({
        id: ids.next(pkg?.name ?? pkg?.dir ?? "root"),
        type: "tokens",
        location: pkg?.dir ?? ".",
        config: { packageId: pkg?.id ?? "", files: files.map((f) => f.path) },
        inputHash: hashJson(files.map((f) => [f.path, f.contentHash]))
      })),
      diagnostics: []
    }
  },
  async extract({ project, source, clock }, config) {
    const builder = new IrBuilder({
      source: irSource(source, tokenFilesAdapter),
      extractor: { name: "inventory-tokens", version: tokenFilesAdapter.version },
      capabilities: ["file.*", "name", "extensions.css.*"],
      clock
    })
    let partial = false
    for (const file of project.tokenFiles.filter((f) => config.files.includes(f.path))) {
      const fileRef = builder.entity(`token-file:${file.path}`, "token-file", file.path)
      const fileEvidence = builder.evidence({
        sourceRef: file.path,
        location: { type: "file", path: file.path },
        method: "structured-parse"
      })
      builder.fact(fileRef, "file.kind", file.kind, fileEvidence)
      if (file.format) builder.fact(fileRef, "file.format", file.format, fileEvidence)
      if (file.tokenCount !== undefined)
        builder.fact(fileRef, "file.tokenCount", file.tokenCount, fileEvidence)
      if (file.cssVariablesTruncated) partial = true
      for (const variable of file.cssVariables ?? []) {
        const ref = `css:${file.path}#${variable.name}@${variable.scope}`
        builder.entity(ref, "token", variable.name)
        const evidence = builder.evidence({
          sourceRef: `${file.path}#${variable.name}`,
          location: { type: "file", path: file.path, line: variable.line },
          method: "structured-parse",
          original: `${variable.name}: ${variable.value};`
        })
        builder.fact(ref, "name", variable.name, evidence)
        builder.fact(ref, "extensions.css.scope", variable.scope, evidence)
        builder.fact(ref, "extensions.css.rawValue", variable.value, evidence)
        if (variable.aliasOf) builder.fact(ref, "extensions.css.aliasOf", variable.aliasOf, evidence)
      }
      for (const d of diagnosticsAbout(project, [file.path])) builder.diagnostic(d)
    }
    return { ir: builder.build(partial ? "partial" : "complete") }
  },
  async validate() {
    return []
  }
}

export const markdownDocsAdapter: SourceAdapter<FileGroupConfig> = {
  id: "inventory-markdown",
  version: "0.1.0",
  type: "markdown",
  async discover({ project }) {
    const ids = new SourceIds("docs")
    return {
      sources: groupByPackage(project, project.docFiles).map(({ pkg, files }) => ({
        id: ids.next(pkg?.name ?? pkg?.dir ?? "root"),
        type: "markdown",
        location: pkg?.dir ?? ".",
        config: { packageId: pkg?.id ?? "", files: files.map((f) => f.path) },
        inputHash: hashJson(files.map((f) => [f.path, f.contentHash]))
      })),
      diagnostics: []
    }
  },
  async extract({ project, source, clock }, config) {
    const builder = new IrBuilder({
      source: irSource(source, markdownDocsAdapter),
      extractor: { name: "inventory-markdown", version: markdownDocsAdapter.version },
      capabilities: ["doc.*"],
      clock
    })
    for (const file of project.docFiles.filter((f) => config.files.includes(f.path))) {
      const ref = builder.entity(`doc:${file.path}`, "doc-page", file.title ?? file.path)
      const evidence = builder.evidence({
        sourceRef: file.path,
        location: { type: "file", path: file.path, line: 1 },
        method: "document-parse"
      })
      builder.fact(ref, "doc.kind", file.kind, evidence, { origin: "authored" })
      if (file.title) builder.fact(ref, "doc.title", file.title, evidence, { origin: "authored" })
      builder.fact(ref, "doc.headings", file.headings as unknown as JsonValue, evidence, {
        origin: "authored"
      })
      builder.fact(ref, "doc.lineCount", file.lineCount, evidence, { origin: "authored" })
    }
    return { ir: builder.build("complete") }
  },
  async validate() {
    return []
  }
}

export const INVENTORY_ADAPTERS = [
  npmPackageAdapter,
  storybookConfigAdapter,
  tokenFilesAdapter,
  markdownDocsAdapter
]

function irSource(
  source: DiscoveredSource,
  adapter: SourceAdapter
): import("@invariant/compiler-ir").IrDocument["source"] {
  return {
    id: source.id,
    type: source.type,
    location: source.location,
    ...(source.version ? { version: source.version } : {}),
    inputHash: source.inputHash,
    adapter: { name: adapter.id, version: adapter.version }
  }
}

function requirePackage(project: ProjectDiscovery, id: string): PackageInfo {
  const pkg = project.packages.find((p) => p.id === id)
  if (!pkg) throw new Error(`Package ${id} is not in the project discovery`)
  return pkg
}

function diagnosticsAbout(project: ProjectDiscovery, paths: readonly string[]): Diagnostic[] {
  const set = new Set(paths)
  return project.diagnostics.filter((d) => d.location !== undefined && set.has(d.location.path))
}

function groupByPackage<T extends { path: string; package?: string | undefined }>(
  project: ProjectDiscovery,
  files: readonly T[]
): Array<{ pkg: PackageInfo | undefined; files: T[] }> {
  const groups = new Map<string, T[]>()
  for (const file of files) groups.set(file.package ?? "", [...(groups.get(file.package ?? "") ?? []), file])
  return [...groups]
    .map(([id, group]) => ({ pkg: project.packages.find((p) => p.id === id), files: group }))
    .sort((a, b) => cmp(a.pkg?.dir ?? "", b.pkg?.dir ?? ""))
}

/** Slug generator that stays unique within one adapter run. */
class SourceIds {
  private readonly prefix: string
  private readonly used = new Set<string>()

  constructor(prefix: string) {
    this.prefix = prefix
  }

  next(label: string): string {
    const slug =
      label
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^[^a-z0-9]+|[-.]+$/g, "") || "root"
    let id = `${this.prefix}-${slug}`
    for (let n = 2; this.used.has(id); n++) id = `${this.prefix}-${slug}-${n}`
    this.used.add(id)
    return id
  }
}
