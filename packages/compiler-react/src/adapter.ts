import {
  DEFAULT_IGNORED_DIRS,
  type DiscoveredSource,
  hashText,
  IrBuilder,
  type PackageInfo,
  type ReadonlyFs,
  type SourceAdapter,
  walk
} from "@invariant/compiler-core"
import { hashJson } from "@invariant/shared"
import { analyzePackage } from "./analyze.js"
import { CAPABILITIES, emitComponent } from "./emit.js"

type Config = { packageId: string; files: string[]; tailwind: boolean }

export const ADAPTER_ID = "react"
export const ADAPTER_VERSION = "0.1.0"

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|css)$|(?:^|\/)tsconfig[^/]*\.json$/
const MAX_FILE_BYTES = 1_000_000

/**
 * React/TypeScript adapter. For every workspace package that declares React, it type-checks the
 * package's own files (never third-party code, never executing anything) and emits one IR document
 * with the components its entry points export: props, defaults, variants, slots, accessibility,
 * styling references, composition, and static usage.
 */
export const reactAdapter: SourceAdapter<Config> = {
  id: ADAPTER_ID,
  version: ADAPTER_VERSION,
  type: "react",

  async discover({ fs, project }) {
    const sources: DiscoveredSource<Config>[] = []
    const used = new Set<string>()
    for (const pkg of project.packages.filter((p) => p.frameworks.some((f) => f.name === "react"))) {
      const others = project.packages.filter(
        (p) => p.id !== pkg.id && p.dir !== "." && (pkg.dir === "." || p.dir.startsWith(`${pkg.dir}/`))
      )
      const { files, hashes } = await readPackageFiles(fs, pkg, others)
      const slug =
        (pkg.name ?? pkg.dir)
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, "-")
          .replace(/^[^a-z0-9]+|[-.]+$/g, "") || "root"
      let id = `react-${slug}`
      for (let n = 2; used.has(id); n++) id = `react-${slug}-${n}`
      used.add(id)
      sources.push({
        id,
        type: "react",
        location: pkg.dir,
        config: {
          packageId: pkg.id,
          files: [...files.keys()],
          tailwind:
            pkg.dependencies.some((d) => d.name === "tailwindcss") ||
            project.tokenFiles.some((f) => f.kind === "tailwind-config" && f.package === pkg.id)
        },
        ...(pkg.version ? { version: { kind: "package-version" as const, value: pkg.version } } : {}),
        inputHash: hashJson(hashes)
      })
    }
    return { sources, diagnostics: [] }
  },

  async extract({ fs, project, source, clock }, config) {
    const pkg = project.packages.find((p) => p.id === config.packageId)
    if (!pkg) throw new Error(`Package ${config.packageId} is not in the project discovery`)
    const files = new Map<string, string>()
    for (const path of config.files) files.set(path, await fs.readFile(path))

    const analysis = analyzePackage({
      ...(pkg.name ? { packageName: pkg.name } : {}),
      packageDir: pkg.dir,
      entryPoints: pkg.entryPoints,
      files,
      tailwind: config.tailwind
    })
    const builder = new IrBuilder({
      source: {
        id: source.id,
        type: source.type,
        location: source.location,
        ...(source.version ? { version: source.version } : {}),
        inputHash: source.inputHash,
        adapter: { name: ADAPTER_ID, version: ADAPTER_VERSION }
      },
      extractor: { name: "react-ts", version: ADAPTER_VERSION },
      capabilities: CAPABILITIES,
      clock
    })
    for (const component of analysis.components) emitComponent(builder, component, pkg)
    for (const d of analysis.diagnostics) builder.diagnostic(d)
    const partial =
      analysis.components.some((c) => !c.props.complete) ||
      analysis.diagnostics.some((d) => d.code === "react.entry-not-analyzed")
    return { ir: builder.build(partial ? "partial" : "complete") }
  },

  async validate({ ir }) {
    return ir.entities.length === 0
      ? [
          {
            code: "react.no-components",
            severity: "info" as const,
            message: `No React components were found in the entry points of ${ir.source.id}`,
            sourceId: ir.source.id
          }
        ]
      : []
  }
}

async function readPackageFiles(
  fs: ReadonlyFs,
  pkg: PackageInfo,
  nested: readonly PackageInfo[]
): Promise<{ files: Map<string, string>; hashes: Array<[string, string]> }> {
  // An installed package (opted in through a declaration root) keeps its declaration files in build output.
  const installed = pkg.dir.split("/").includes("node_modules")
  const walked = await walk(fs, {
    ignoreDirs: new Set(
      installed
        ? DEFAULT_IGNORED_DIRS.filter((d) => !["dist", "build", "out"].includes(d))
        : DEFAULT_IGNORED_DIRS
    ),
    maxFiles: 20_000,
    start: pkg.dir
  })
  const files = new Map<string, string>()
  const hashes: Array<[string, string]> = []
  for (const path of walked.files) {
    if (!SOURCE_FILE.test(path) || nested.some((n) => path === n.dir || path.startsWith(`${n.dir}/`)))
      continue
    const text = await fs.readFile(path)
    if (text.length > MAX_FILE_BYTES) continue
    files.set(path, text)
    hashes.push([path, hashText(text)])
  }
  return { files, hashes }
}
