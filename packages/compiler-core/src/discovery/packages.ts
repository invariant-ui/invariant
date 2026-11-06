import { globToRegExp, matchesAny } from "../glob.js"
import type { PackageInfo } from "./schema.js"
import { cmp, type DiscoveryEnv, hashText, lineOfJsonMember, posix, readBounded } from "./support.js"

export interface RawPackage {
  info: PackageInfo
  manifest: Record<string, unknown>
  manifestText: string
}

type Workspaces = { kind: "pnpm-workspace" | "package-json" | "none"; patterns: string[]; source?: string }

const DEP_KINDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const

export async function discoverPackages(
  env: DiscoveryEnv
): Promise<{ packages: RawPackage[]; workspaces: Workspaces }> {
  const workspaces = await discoverWorkspaces(env)
  const manifestPaths = env.files.filter((f) => posix.basename(f) === "package.json")
  const positive = workspaces.patterns
    .filter((p) => !p.startsWith("!"))
    .map((p) => globToRegExp(trimSlashes(p)))
  const negative = workspaces.patterns
    .filter((p) => p.startsWith("!"))
    .map((p) => globToRegExp(trimSlashes(p.slice(1))))

  const selected = manifestPaths.filter((manifest) => {
    const dir = posix.dirname(manifest)
    if (dir === ".") return true
    if (env.declarationRoots?.has(dir)) return true
    // An ng-packagr library root (a package.json next to an ng-package.json) is a package even when the
    // repository declares no workspaces: its source lives in a subfolder such as `src/`.
    if (env.fileSet.has(posix.join(dir, "ng-package.json"))) return true
    if (workspaces.kind === "none") return false
    return matchesAny(dir, positive) && !matchesAny(dir, negative)
  })
  // Without workspace config and without a root manifest, fall back to every manifest found.
  const chosen = selected.length === 0 && workspaces.kind === "none" ? manifestPaths : selected

  const packages: RawPackage[] = []
  for (const manifestPath of chosen) {
    const text = await readBounded(env, manifestPath)
    if (text === undefined) continue
    let manifest: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        throw new Error("not an object")
      manifest = parsed as Record<string, unknown>
    } catch (error) {
      env.diagnostics.error(
        "discovery.invalid-manifest",
        `Invalid ${manifestPath}: ${(error as Error).message}`,
        {
          location: { path: manifestPath }
        }
      )
      continue
    }
    packages.push({ info: toPackageInfo(manifestPath, manifest, text), manifest, manifestText: text })
  }
  if (packages.length === 0) {
    env.diagnostics.warning(
      "discovery.no-package",
      "No package.json was found; package, framework and entry-point discovery are empty"
    )
  }
  packages.sort((a, b) => cmp(a.info.dir, b.info.dir))
  // Two packages can share a name (a repository root and the library it contains): ids stay unique.
  const seenIds = new Set<string>()
  for (const raw of packages) {
    if (seenIds.has(raw.info.id)) raw.info.id = `package:${raw.info.name ?? ""}@${raw.info.dir}`
    seenIds.add(raw.info.id)
  }
  return { packages, workspaces }
}

async function discoverWorkspaces(env: DiscoveryEnv): Promise<Workspaces> {
  if (env.fileSet.has("pnpm-workspace.yaml")) {
    const text = await readBounded(env, "pnpm-workspace.yaml")
    if (text !== undefined)
      return {
        kind: "pnpm-workspace",
        patterns: parsePnpmWorkspacePackages(text),
        source: "pnpm-workspace.yaml"
      }
  }
  if (env.fileSet.has("package.json")) {
    const text = await readBounded(env, "package.json")
    try {
      const manifest = JSON.parse(text ?? "{}") as { workspaces?: unknown }
      const raw = manifest.workspaces
      const list = Array.isArray(raw)
        ? raw
        : isRecord(raw) && Array.isArray(raw.packages)
          ? raw.packages
          : undefined
      if (list)
        return {
          kind: "package-json",
          patterns: list.filter((p): p is string => typeof p === "string"),
          source: "package.json"
        }
    } catch {
      // Reported when the manifest itself is parsed.
    }
  }
  return { kind: "none", patterns: [] }
}

/** Reads the `packages:` list from pnpm-workspace.yaml without a YAML dependency (block lists only). */
export function parsePnpmWorkspacePackages(text: string): string[] {
  const patterns: string[] = []
  let inPackages = false
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").replace(/\r$/, "")
    if (/^packages\s*:/.test(line)) {
      inPackages = true
      continue
    }
    if (inPackages) {
      const item = /^\s*-\s*(.+?)\s*$/.exec(line)
      if (item) patterns.push((item[1] as string).replace(/^["']|["']$/g, ""))
      else if (/^\S/.test(line)) inPackages = false
    }
  }
  return patterns
}

function toPackageInfo(manifestPath: string, manifest: Record<string, unknown>, text: string): PackageInfo {
  const dir = posix.dirname(manifestPath)
  const name = typeof manifest.name === "string" && manifest.name ? manifest.name : undefined
  const version = typeof manifest.version === "string" && manifest.version ? manifest.version : undefined
  const dependencies = DEP_KINDS.flatMap((kind) => {
    const group = manifest[kind]
    if (!isRecord(group)) return []
    return Object.entries(group).map(([depName, range]) => ({ name: depName, range: String(range), kind }))
  }).sort((a, b) => cmp(a.name, b.name) || cmp(a.kind, b.kind))
  return {
    id: `package:${name ?? dir}`,
    ...(name ? { name } : {}),
    ...(version ? { version } : {}),
    dir,
    private: manifest.private === true,
    manifest: { path: manifestPath, contentHash: hashText(text) },
    dependencies,
    scripts: isRecord(manifest.scripts) ? Object.keys(manifest.scripts).sort() : [],
    frameworks: [],
    buildTools: [],
    entryPoints: []
  }
}

export function dependencyLine(raw: RawPackage, group: string, name: string): number | undefined {
  return lineOfJsonMember(raw.manifestText, group, name)
}

function trimSlashes(p: string): string {
  return p.replace(/^\.\//, "").replace(/\/+$/, "")
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
