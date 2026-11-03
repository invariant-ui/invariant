import {
  createAnalysis,
  DEFAULT_IGNORED_DIRS,
  type DiscoveredSource,
  hashText,
  IrBuilder,
  type PackageInfo,
  type ProjectDiscovery,
  posix,
  type ReadonlyFs,
  type SourceAdapter,
  type StorybookConfig,
  tsconfigPaths,
  walk
} from "@invariant/compiler-core"
import { hashJson } from "@invariant/shared"
import { extractCsf } from "./csf.js"
import { CAPABILITIES, emitCsf, emitMdx } from "./emit.js"
import { type BuiltIndexEntry, parseBuiltIndex } from "./index-json.js"
import { parseMdx } from "./mdx.js"

type Config = {
  storybookId: string
  /** Project-relative files loaded into the type-checking program. */
  files: string[]
  /** Workspace package names resolved to their entry files, so imports of sibling packages resolve. */
  paths: Record<string, string[]>
}

export const ADAPTER_ID = "storybook"
export const ADAPTER_VERSION = "0.1.0"

const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/
// `.vue` files are loaded as well, so stories that import single-file components can be linked to them.
const PROGRAM_FILE = /\.(?:[cm]?[jt]sx?|vue)$|(?:^|\/)tsconfig[^/]*\.json$/
const MAX_FILE_BYTES = 1_000_000

/**
 * Storybook adapter. Reads story files (CSF 2 and 3) and MDX pages statically: titles, the component each
 * meta points at (resolved through the type checker to a file and declaration), args, argTypes and
 * controls, parameters, tags, play-function structure, and components composed in story renders. A built
 * `storybook-static/index.json`, when present, is recorded as optional evidence. Nothing is executed and
 * no story identity is synthesized: a story is identified by its export.
 */
export const storybookAdapter: SourceAdapter<Config> = {
  id: ADAPTER_ID,
  version: ADAPTER_VERSION,
  type: "storybook",

  async discover({ fs, project }) {
    const sources: DiscoveredSource<Config>[] = []
    const used = new Set<string>()
    for (const sb of project.storybooks) {
      if (sb.storyFiles.length === 0) continue
      const { files, hashes, paths } = await loadProgramFiles(fs, project, sb)
      const slug =
        (sb.directory === "." ? "root" : sb.directory)
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, "-")
          .replace(/^[^a-z0-9]+|[-.]+$/g, "") || "root"
      let id = `stories-${slug}`
      for (let n = 2; used.has(id); n++) id = `stories-${slug}-${n}`
      used.add(id)
      const index = sb.builtOutput?.hasIndexJson
        ? await readText(fs, posix.join(sb.builtOutput.path, "index.json"))
        : undefined
      sources.push({
        id,
        type: "storybook",
        location: sb.directory,
        config: { storybookId: sb.id, files: [...files.keys()], paths },
        ...(sb.version?.installedVersion
          ? { version: { kind: "tool-version" as const, value: sb.version.installedVersion } }
          : {}),
        inputHash: hashJson({
          files: hashes,
          index: index === undefined ? null : hashText(index),
          config: sb.configHash
        })
      })
    }
    return { sources, diagnostics: [] }
  },

  async extract({ fs, project, source, clock }, config) {
    const sb = project.storybooks.find((s) => s.id === config.storybookId)
    if (!sb) throw new Error(`Storybook ${config.storybookId} is not in the project discovery`)
    const files = new Map<string, string>()
    for (const path of config.files) files.set(path, await fs.readFile(path))
    const analysis = createAnalysis(files, { paths: config.paths })
    const builder = new IrBuilder({
      source: {
        id: source.id,
        type: source.type,
        location: source.location,
        ...(source.version ? { version: source.version } : {}),
        inputHash: source.inputHash,
        adapter: { name: ADAPTER_ID, version: ADAPTER_VERSION }
      },
      extractor: { name: "storybook-csf", version: ADAPTER_VERSION },
      capabilities: CAPABILITIES,
      clock
    })

    let index: { entries: BuiltIndexEntry[] } | undefined
    if (sb.builtOutput?.hasIndexJson) {
      const text = await readText(fs, posix.join(sb.builtOutput.path, "index.json"))
      index = text === undefined ? undefined : parseBuiltIndex(text)
      if (!index)
        builder.diagnostic({
          code: "storybook.index-unreadable",
          severity: "info",
          message: `${sb.builtOutput.path}/index.json could not be read as a story index and was ignored`
        })
    }

    const storyFiles = sb.storyFiles.filter((f) => CODE_FILE.test(f))
    const mdxFiles = sb.storyFiles.filter((f) => f.endsWith(".mdx"))
    const projectFiles = new Set(files.keys())
    let partial = sb.dynamicProperties.length > 0 || sb.storyFilesTruncated

    const note = (
      code: string,
      severity: "info" | "warning",
      message: string,
      location: { path: string; line?: number }
    ): void => {
      builder.diagnostic({ code, severity, message, location })
    }

    // One unusual story file must not fail the whole source: isolate it, report it, and mark the result partial.
    const readStoryFile = (file: string): void => {
      const sf = analysis.sourceFile(file)
      const csf = sf ? extractCsf(analysis, sf) : undefined
      if (!csf || (!csf.group && csf.stories.length === 0)) {
        note(
          "storybook.no-meta",
          "warning",
          `${file} matches the story globs but has no default-exported meta and no stories`,
          { path: file }
        )
        return
      }
      emitCsf(builder, csf, index?.entries, index ? posix.relative(sb.directory, file) : undefined)
      const group = csf.group
      if (!group) {
        note("storybook.no-meta", "warning", `${file} exports stories but no default-exported meta`, {
          path: file
        })
      } else {
        if (!group.title)
          note(
            "storybook.title-auto",
            "info",
            `${file} has no explicit title; Storybook infers it from the path, which is not reproduced here`,
            { path: file, line: group.line }
          )
        if (!group.component)
          note("storybook.component-missing", "info", `${file} meta has no resolvable component`, {
            path: file,
            line: group.line
          })
        else if (!group.component.file) {
          const origin = group.component.external
            ? ` (from package ${group.component.external})`
            : group.component.unresolvedModule
              ? ` (module ${group.component.unresolvedModule} not found)`
              : ""
          note(
            "storybook.component-unresolved",
            "info",
            `${file} meta component ${group.component.text} could not be resolved to a project file${origin}`,
            { path: file, line: group.line }
          )
        }
      }
      if (csf.selectionUncertain) partial = true
      if ([csf.group, ...csf.stories].some((x) => x && x.args.unresolved.length > 0)) {
        note(
          "storybook.dynamic-args",
          "info",
          `${file} has args that are not statically resolvable; they are listed as unresolved, not guessed`,
          { path: file }
        )
      }
    }
    for (const file of storyFiles) {
      try {
        readStoryFile(file)
      } catch (error) {
        partial = true
        note(
          "storybook.file-failed",
          "warning",
          `${file} could not be analyzed: ${(error as Error).message}`,
          { path: file }
        )
      }
    }
    for (const file of mdxFiles) {
      const text = files.has(file) ? (files.get(file) as string) : await fs.readFile(file)
      emitMdx(builder, parseMdx(file, text, projectFiles))
    }
    if (index) {
      const known = new Set(sb.storyFiles.map((f) => posix.relative(sb.directory, f)))
      for (const entry of index.entries) {
        const path = entry.importPath.replace(/^\.\//, "")
        if (!known.has(path))
          note(
            "storybook.index-stale",
            "warning",
            `The built index lists ${entry.importPath}, which no longer matches the story globs`,
            { path: posix.join(sb.directory, path) }
          )
      }
      const indexed = new Set(index.entries.map((e) => e.importPath.replace(/^\.\//, "")))
      for (const file of sb.storyFiles) {
        if (!indexed.has(posix.relative(sb.directory, file)))
          note(
            "storybook.not-in-built-index",
            "info",
            `${file} is not in the built index (the build may predate it)`,
            { path: file }
          )
      }
    }
    return { ir: builder.build(partial ? "partial" : "complete") }
  },

  async validate({ ir }) {
    return ir.entities.length === 0
      ? [
          {
            code: "storybook.no-stories",
            severity: "warning" as const,
            message: `No stories were extracted for ${ir.source.id}`,
            sourceId: ir.source.id
          }
        ]
      : []
  }
}

/**
 * Files for the type-checking program: every package that owns a story file, plus the workspace packages
 * those packages depend on (so `import { X } from "@scope/ui"` resolves to the real declaration).
 */
async function loadProgramFiles(
  fs: ReadonlyFs,
  project: ProjectDiscovery,
  sb: StorybookConfig
): Promise<{ files: Map<string, string>; hashes: Array<[string, string]>; paths: Record<string, string[]> }> {
  const owners = new Map<string, PackageInfo>()
  const owner = (file: string): PackageInfo | undefined =>
    project.packages
      .filter((p) => p.dir === "." || file === p.dir || file.startsWith(`${p.dir}/`))
      .sort((a, b) => b.dir.length - a.dir.length)[0]
  for (const file of sb.storyFiles) {
    const pkg = owner(file)
    if (pkg) owners.set(pkg.id, pkg)
  }
  const byName = new Map(project.packages.flatMap((p) => (p.name ? [[p.name, p] as const] : [])))
  const included = new Map(owners)
  for (const pkg of owners.values()) {
    for (const dep of pkg.dependencies) {
      const target = byName.get(dep.name)
      if (target) included.set(target.id, target)
    }
  }
  const paths: Record<string, string[]> = {}
  const named: Record<string, string[]> = {}
  for (const pkg of included.values()) {
    if (!pkg.name) continue
    for (const entry of pkg.entryPoints) {
      if (!entry.file) continue
      const specifier = entry.subpath === "." ? pkg.name : `${pkg.name}/${entry.subpath.replace(/^\.\//, "")}`
      named[specifier] = [entry.file]
    }
  }
  const files = new Map<string, string>()
  const hashes: Array<[string, string]> = []
  for (const pkg of [...included.values()].sort((a, b) => (a.dir < b.dir ? -1 : 1))) {
    const nested = project.packages.filter(
      (p) => p.id !== pkg.id && p.dir !== "." && (pkg.dir === "." || p.dir.startsWith(`${pkg.dir}/`))
    )
    const walked = await walk(fs, {
      ignoreDirs: new Set(DEFAULT_IGNORED_DIRS),
      maxFiles: 20_000,
      start: pkg.dir
    })
    for (const path of walked.files) {
      if (
        !PROGRAM_FILE.test(path) ||
        files.has(path) ||
        nested.some((n) => path === n.dir || path.startsWith(`${n.dir}/`))
      )
        continue
      const text = await fs.readFile(path)
      if (text.length > MAX_FILE_BYTES) continue
      files.set(path, text)
      hashes.push([path, hashText(text)])
    }
  }
  // MDX files are read as documents, so their content also determines the input hash.
  for (const file of sb.storyFiles.filter((f) => f.endsWith(".mdx"))) {
    const text = await fs.readFile(file)
    hashes.push([file, hashText(text)])
  }
  // Each package's own tsconfig `paths` apply first; workspace package names then take precedence.
  for (const pkg of [...included.values()].sort((a, b) => (a.dir < b.dir ? -1 : 1)))
    Object.assign(paths, tsconfigPaths(files, pkg.dir))
  Object.assign(paths, named)
  return { files, hashes, paths }
}

async function readText(fs: ReadonlyFs, path: string): Promise<string | undefined> {
  try {
    const text = await fs.readFile(path)
    return text.length > MAX_FILE_BYTES * 5 ? undefined : text
  } catch {
    return undefined
  }
}
