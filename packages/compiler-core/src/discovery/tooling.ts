import { dependencyLine, isRecord, type RawPackage } from "./packages.js"
import type { FrameworkUse, PackageInfo, PackageManager } from "./schema.js"
import { cmp, type DiscoveryEnv, posix } from "./support.js"

const FRAMEWORK_PACKAGES = [
  ["react", "react"],
  ["angular", "@angular/core"],
  ["vue", "vue"]
] as const

const BUILD_TOOL_DEPS: Record<string, string> = {
  vite: "vite",
  webpack: "webpack",
  rollup: "rollup",
  esbuild: "esbuild",
  tsup: "tsup",
  parcel: "parcel",
  "@rspack/core": "rspack",
  "@angular/cli": "angular-cli",
  "@vue/cli-service": "vue-cli",
  "ng-packagr": "ng-packagr",
  nx: "nx",
  turbo: "turbo",
  typescript: "typescript"
}

const BUILD_TOOL_CONFIGS: Array<[RegExp, string]> = [
  [/^vite\.config\.[cm]?[jt]s$/, "vite"],
  [/^webpack\.config\.[cm]?[jt]s$/, "webpack"],
  [/^rollup\.config\.[cm]?[jt]s$/, "rollup"],
  [/^tsup\.config\.[cm]?[jt]s$/, "tsup"],
  [/^angular\.json$/, "angular-cli"],
  [/^nx\.json$/, "nx"],
  [/^turbo\.json$/, "turbo"],
  [/^tsconfig\.json$/, "typescript"],
  [/^vue\.config\.[cm]?js$/, "vue-cli"]
]

const LOCKFILES: Array<[string, PackageManager["name"]]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["package-lock.json", "npm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"]
]

export async function detectPackageManager(
  env: DiscoveryEnv,
  root: RawPackage | undefined
): Promise<PackageManager> {
  const evidence: string[] = []
  let fromField: { name: PackageManager["name"]; version?: string } | undefined
  const field = root?.manifest.packageManager
  if (typeof field === "string") {
    const match = /^(npm|pnpm|yarn|bun)@(.+)$/.exec(field)
    if (match) {
      fromField = {
        name: match[1] as PackageManager["name"],
        version: (match[2] as string).replace(/\+.*$/, "")
      }
      evidence.push("package.json#packageManager")
    }
  }
  const lockfiles = LOCKFILES.filter(([file]) => env.fileSet.has(file))
  for (const [file] of lockfiles) evidence.push(`lockfile:${file}`)
  const lockNames = new Set(lockfiles.map(([, name]) => name))
  if (fromField) {
    if (lockNames.size > 0 && !lockNames.has(fromField.name)) {
      env.diagnostics.warning(
        "discovery.package-manager-mismatch",
        `packageManager field says ${fromField.name} but lockfiles indicate ${[...lockNames].join(", ")}`
      )
    }
    return { name: fromField.name, ...(fromField.version ? { version: fromField.version } : {}), evidence }
  }
  if (lockNames.size > 1) {
    env.diagnostics.warning(
      "discovery.ambiguous-lockfiles",
      `Multiple lockfiles found (${lockfiles.map(([f]) => f).join(", ")}); package manager left unknown`
    )
    return { name: "unknown", evidence }
  }
  const only = [...lockNames][0]
  return only ? { name: only, evidence } : { name: "unknown", evidence }
}

/** Declared range from the manifest plus the installed version when node_modules is present (never guessed). */
export async function detectFrameworks(env: DiscoveryEnv, raw: RawPackage): Promise<FrameworkUse[]> {
  const found: FrameworkUse[] = []
  for (const [framework, pkgName] of FRAMEWORK_PACKAGES) {
    for (const kind of [
      "dependencies",
      "peerDependencies",
      "devDependencies",
      "optionalDependencies"
    ] as const) {
      const group = raw.manifest[kind]
      if (!isRecord(group) || typeof group[pkgName] !== "string") continue
      const installed = await installedVersion(env, raw.info.dir, pkgName)
      const line = dependencyLine(raw, kind, pkgName)
      found.push({
        name: framework,
        package: pkgName,
        dependencyKind: kind,
        declaredRange: group[pkgName] as string,
        ...(installed ? { installedVersion: installed } : {}),
        ...(line ? { line } : {})
      })
      break
    }
  }
  return found
}

export function detectBuildTools(env: DiscoveryEnv, raw: RawPackage): PackageInfo["buildTools"] {
  const tools = new Map<string, Array<{ type: "dependency" | "config-file"; ref: string }>>()
  const add = (name: string, type: "dependency" | "config-file", ref: string): void => {
    const list = tools.get(name) ?? []
    if (!list.some((e) => e.type === type && e.ref === ref)) list.push({ type, ref })
    tools.set(name, list)
  }
  for (const dep of raw.info.dependencies) {
    const tool = BUILD_TOOL_DEPS[dep.name]
    if (tool) add(tool, "dependency", dep.name)
  }
  for (const file of env.files) {
    if (posix.dirname(file) !== raw.info.dir) continue
    const base = posix.basename(file)
    for (const [pattern, tool] of BUILD_TOOL_CONFIGS) if (pattern.test(base)) add(tool, "config-file", file)
  }
  return [...tools]
    .map(([name, evidence]) => ({
      name,
      evidence: evidence.sort((a, b) => cmp(a.type, b.type) || cmp(a.ref, b.ref))
    }))
    .sort((a, b) => cmp(a.name, b.name))
}

/** Looks in `<dir>/node_modules`, then each ancestor directory's, as Node resolution would. */
async function installedVersion(
  env: DiscoveryEnv,
  dir: string,
  pkgName: string
): Promise<string | undefined> {
  for (let current = dir; ; current = posix.dirname(current)) {
    const candidate = posix.join(current, "node_modules", pkgName, "package.json")
    if (await env.fs.exists(candidate)) {
      try {
        const version = (JSON.parse(await env.fs.readFile(candidate)) as { version?: unknown }).version
        if (typeof version === "string") return version
      } catch {
        return undefined
      }
    }
    if (current === ".") return undefined
  }
}
