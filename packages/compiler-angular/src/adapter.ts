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
import { CAPABILITIES, emitComponent, emitModule } from "./emit.js"

type Config = { packageId: string; files: string[] }

export const ADAPTER_ID = "angular"
export const ADAPTER_VERSION = "0.1.0"

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|html|css|scss|sass|less)$|(?:^|\/)tsconfig[^/]*\.json$/
const MAX_FILE_BYTES = 1_000_000

/**
 * Angular adapter. For every workspace package that declares `@angular/core` it reads decorated classes
 * with the TypeScript API (what the Angular compiler reads from decorators, evaluated statically):
 * components and directives, decorator and signal inputs and outputs, `model()`, selectors, standalone
 * metadata and imports, content projection, host bindings, templates and styles, and NgModules.
 * Nothing is executed. `node_modules` is read only for a package opted in as a declaration root, from its `.d.ts` files.
 */
export const angularAdapter: SourceAdapter<Config> = {
  id: ADAPTER_ID,
  version: ADAPTER_VERSION,
  type: "angular",

  async discover({ fs, project }) {
    const sources: DiscoveredSource<Config>[] = []
    const used = new Set<string>()
    for (const pkg of project.packages.filter((p) => p.frameworks.some((f) => f.name === "angular"))) {
      const others = project.packages.filter(
        (p) => p.id !== pkg.id && p.dir !== "." && (pkg.dir === "." || p.dir.startsWith(`${pkg.dir}/`))
      )
      const { files, hashes } = await readPackageFiles(fs, pkg, others)
      const slug =
        (pkg.name ?? pkg.dir)
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, "-")
          .replace(/^[^a-z0-9]+|[-.]+$/g, "") || "root"
      let id = `angular-${slug}`
      for (let n = 2; used.has(id); n++) id = `angular-${slug}-${n}`
      used.add(id)
      sources.push({
        id,
        type: "angular",
        location: pkg.dir,
        config: { packageId: pkg.id, files: [...files.keys()] },
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
      files
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
      extractor: { name: "angular-ts", version: ADAPTER_VERSION },
      capabilities: CAPABILITIES,
      clock
    })
    for (const component of analysis.components) emitComponent(builder, component, pkg)
    for (const module of analysis.modules) emitModule(builder, module)
    for (const d of analysis.diagnostics) builder.diagnostic(d)
    return { ir: builder.build(analysis.components.some((c) => !c.propsComplete) ? "partial" : "complete") }
  },

  async validate({ ir }) {
    return !ir.entities.some((e) => e.kind === "component")
      ? [
          {
            code: "angular.no-components",
            severity: "info" as const,
            message: `No Angular components or directives were found in the entry points of ${ir.source.id}`,
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
