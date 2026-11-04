import { DiagnosticCollector } from "@invariant/shared"
import type { ReadonlyFs } from "../fs.js"
import { DEFAULT_IGNORED_DIRS, walk } from "../walk.js"
import { discoverDocFiles } from "./docs.js"
import { discoverEntryPoints } from "./entries.js"
import { buildGraph } from "./graph.js"
import { discoverPackages } from "./packages.js"
import { DISCOVERY_VERSION, type ProjectDiscovery, projectDiscoverySchema } from "./schema.js"
import { discoverStorybooks } from "./storybook.js"
import { DEFAULT_LIMITS, type DiscoveryLimits, owningPackage } from "./support.js"
import { discoverTokenFiles } from "./tokens.js"
import { detectBuildTools, detectFrameworks, detectPackageManager } from "./tooling.js"

export interface DiscoverOptions {
  fs: ReadonlyFs
  /** Extra directory names to skip, added to the defaults (node_modules, dist, .git, ...). */
  ignoreDirs?: readonly string[]
  limits?: Partial<DiscoveryLimits>
}

/**
 * Framework-neutral project discovery: packages, workspaces, package manager, frameworks and
 * versions, build tools, entry points and exports, Storybook configs, token files and CSS
 * variables, documentation files, and the relationship graph. Read-only and deterministic.
 */
export async function discoverProject(options: DiscoverOptions): Promise<ProjectDiscovery> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits }
  const diagnostics = new DiagnosticCollector()
  const ignore = new Set([...DEFAULT_IGNORED_DIRS, ...(options.ignoreDirs ?? [])])
  const walked = await walk(options.fs, { ignoreDirs: ignore, maxFiles: limits.maxFiles })
  if (walked.truncated) {
    diagnostics.warning(
      "discovery.walk-truncated",
      `Stopped after ${limits.maxFiles} files; discovery is incomplete`
    )
  }
  const env = {
    fs: options.fs,
    files: walked.files,
    fileSet: new Set(walked.files),
    ignoreDirs: ignore,
    diagnostics,
    limits
  }

  const { packages: raws, workspaces } = await discoverPackages(env)
  const root = raws.find((p) => p.info.dir === ".")
  const packageManager = await detectPackageManager(env, root)
  for (const raw of raws) {
    raw.info.frameworks = await detectFrameworks(env, raw)
    raw.info.buildTools = detectBuildTools(env, raw)
    raw.info.entryPoints = await discoverEntryPoints(env, raw)
  }
  const packages = raws.map((r) => r.info)
  const storybooks = await discoverStorybooks(env, raws)
  const tokenFiles = (await discoverTokenFiles(env)).map((file) => withOwner(file, packages))
  const docFiles = (await discoverDocFiles(env)).map((file) => withOwner(file, packages))

  const result: ProjectDiscovery = {
    discoveryVersion: DISCOVERY_VERSION,
    packageManager,
    workspaces,
    packages,
    storybooks,
    tokenFiles,
    docFiles,
    graph: buildGraph({ packages, storybooks, tokenFiles, docFiles }),
    stats: { filesScanned: walked.files.length, truncated: walked.truncated },
    diagnostics: diagnostics.toArray()
  }
  return projectDiscoverySchema.parse(result)
}

function withOwner<T extends { path: string }>(
  file: T,
  packages: ProjectDiscovery["packages"]
): T & { package?: string } {
  const owner = owningPackage(packages, file.path)
  return owner ? { ...file, package: owner.id } : file
}

export { parsePnpmWorkspacePackages } from "./packages.js"
export {
  type CssVariable,
  DISCOVERY_VERSION,
  type DocFile,
  type EntryPoint,
  type ExportInfo,
  type FrameworkUse,
  type PackageInfo,
  type ProjectDiscovery,
  projectDiscoverySchema,
  type StorybookConfig,
  type TokenFile
} from "./schema.js"
export type { DiscoveryLimits } from "./support.js"
export { parseCssCustomProperties, scanCssCustomProperties } from "./tokens.js"
