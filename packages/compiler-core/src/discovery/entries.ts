import ts from "typescript"
import { listExports } from "./exports.js"
import { isRecord, type RawPackage } from "./packages.js"
import type { EntryPoint } from "./schema.js"
import { cmp, type DiscoveryEnv, fileExists, posix, readBounded } from "./support.js"

const CONDITION_ORDER = ["types", "import", "module", "default", "require", "node", "browser"]
const CONVENTIONAL_ROOT_ENTRIES = [
  "src/index.ts",
  "src/index.tsx",
  "src/public-api.ts",
  "src/public_api.ts",
  "public-api.ts",
  "index.ts",
  "index.tsx"
]

interface Declared {
  subpath: string
  condition: string
  target: string
}

/** Package entry points from `exports` (or main/module/types), resolved to a readable file and enumerated. */
export async function discoverEntryPoints(env: DiscoveryEnv, raw: RawPackage): Promise<EntryPoint[]> {
  const dir = raw.info.dir
  const tsconfig = await readOutRoot(env, dir)
  const declared = declaredEntries(env, raw, tsconfig)
  // ng-packagr libraries declare their entry in `ng-package.json` (or default to a `public-api` file),
  // not in package.json: the source manifest has no entry fields at all.
  if (declared.length === 0) declared.push(...(await angularLibraryEntry(env, dir)))
  declared.push(...(await angularSecondaryEntries(env, dir)))
  // Resolve every entry first: an entry may re-export another one through the package's own name.
  const resolvedEntries: Array<{ declared: Declared; resolved: Awaited<ReturnType<typeof resolveTarget>> }> =
    []
  for (const d of declared)
    resolvedEntries.push({
      declared: d,
      resolved: await resolveTarget(env, { dir, subpath: d.subpath, target: d.target, tsconfig })
    })
  const self = new Map<string, string>()
  const name = raw.info.name
  if (name)
    for (const { declared: d, resolved } of resolvedEntries)
      if (resolved && !self.has(selfSpecifier(name, d.subpath)))
        self.set(selfSpecifier(name, d.subpath), resolved.file)
  const entries: EntryPoint[] = []
  for (const { declared: d, resolved } of resolvedEntries) {
    const { subpath, condition, target } = d
    if (!resolved) {
      env.diagnostics.warning(
        "discovery.entry-unresolved",
        `Entry ${subpath} (${target}) in ${raw.info.id} could not be resolved to a file`,
        {
          location: { path: raw.info.manifest.path }
        }
      )
      entries.push({
        subpath,
        condition,
        target,
        resolution: "unresolved",
        exports: [],
        exportsComplete: false,
        parsedFiles: []
      })
      continue
    }
    const listing = await listExports(env, resolved.file, self)
    entries.push({
      subpath,
      condition,
      target,
      resolution: resolved.resolution,
      file: resolved.file,
      exports: listing.exports,
      exportsComplete: listing.complete,
      parsedFiles: listing.parsedFiles
    })
  }
  return entries.sort((a, b) => cmp(a.subpath, b.subpath))
}

/** `primevue` for the root entry, `primevue/accordion` for `./accordion`: how the package imports itself. */
function selfSpecifier(name: string, subpath: string): string {
  return subpath === "." ? name : `${name}/${subpath.replace(/^\.\//, "")}`
}

function declaredEntries(
  env: DiscoveryEnv,
  raw: RawPackage,
  tsconfig: { outDir?: string; rootDir?: string }
): Declared[] {
  const out: Declared[] = []
  const manifest = raw.manifest
  const add = (subpath: string, condition: string, target: string): void => {
    if (subpath.includes("*") || target.includes("*")) {
      const stars = (t: string): number => t.split("*").length - 1
      if (stars(subpath) !== 1 || stars(target) !== 1) {
        env.diagnostics.info(
          "discovery.entry-pattern-unsupported",
          `Entry pattern ${subpath} in ${raw.info.id} is not expanded`,
          { location: { path: raw.info.manifest.path } }
        )
        return
      }
      const matches = expandPattern(env, { dir: raw.info.dir, target, tsconfig })
      if (matches.length === 0)
        env.diagnostics.info(
          "discovery.entry-pattern-unmatched",
          `Entry pattern ${subpath} (${target}) in ${raw.info.id} matches no file`,
          { location: { path: raw.info.manifest.path } }
        )
      for (const match of matches)
        out.push({ subpath: subpath.replace("*", match), condition, target: target.replace("*", match) })
      return
    }
    out.push({ subpath, condition, target })
  }
  const walkConditions = (subpath: string, node: unknown, trail: string): void => {
    if (typeof node === "string") add(subpath, trail || "default", node)
    else if (Array.isArray(node)) for (const item of node) walkConditions(subpath, item, trail)
    else if (isRecord(node)) {
      const keys = Object.keys(node).sort((a, b) => rank(a) - rank(b))
      for (const key of keys) walkConditions(subpath, node[key], trail ? `${trail}.${key}` : key)
    }
  }
  const exportsField = manifest.exports
  if (typeof exportsField === "string" || Array.isArray(exportsField)) walkConditions(".", exportsField, "")
  else if (isRecord(exportsField)) {
    const subpathKeys = Object.keys(exportsField).filter((k) => k.startsWith("."))
    if (subpathKeys.length > 0) for (const key of subpathKeys) walkConditions(key, exportsField[key], "")
    else walkConditions(".", exportsField, "")
  } else {
    for (const field of ["types", "typings", "module", "main"] as const) {
      const target = manifest[field]
      if (typeof target === "string") {
        add(".", field, target)
        break
      }
    }
  }
  // One entry per subpath: the highest-priority condition that resolves is chosen later; keep the
  // first (best-ranked) declaration per subpath to stay deterministic and bounded.
  const seen = new Set<string>()
  return out.filter((e) => {
    if (seen.has(e.subpath)) return false
    seen.add(e.subpath)
    return true
  })
}

/**
 * What `*` stands for in a target pattern such as `./dist/*\/index.d.ts`, for every file that fits it. A target in
 * build output is also matched against the sources it was built from (`src/*.ts`), as `resolveTarget` does.
 */
function expandPattern(
  env: DiscoveryEnv,
  input: { dir: string; target: string; tsconfig: { outDir?: string; rootDir?: string } }
): string[] {
  const { dir, target, tsconfig } = input
  const declaredPath = posix.normalize(posix.join(dir, target))
  const regexes = [globRegExp(declaredPath, "")]
  if (tsconfig.outDir !== undefined) {
    const out = posix.normalize(posix.join(dir, tsconfig.outDir))
    if (declaredPath.startsWith(`${out}/`)) {
      const rootDir = posix.normalize(posix.join(dir, tsconfig.rootDir ?? "src"))
      const rel = declaredPath.slice(out.length + 1).replace(/\.d\.ts$|\.(?:[cm]?js|jsx)$/, "")
      regexes.push(globRegExp(posix.join(rootDir, rel), String.raw`\.(?:[cm]?tsx?)`))
    }
  }
  const found = new Set<string>()
  for (const file of env.files)
    for (const [i, re] of regexes.entries()) {
      // Declaration files are not the sources a build output was made from.
      if (i > 0 && file.endsWith(".d.ts")) continue
      const captured = re.exec(file)?.[1]
      // `*` never stands for an empty string or for a dependency's files.
      if (captured && !captured.split("/").includes("node_modules")) found.add(captured)
    }
  return [...found].sort(cmp)
}

function globRegExp(pattern: string, suffix: string): RegExp {
  const [head = "", tail = ""] = pattern.split("*")
  const quote = (t: string): string => t.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`^${quote(head)}(.+)${quote(tail)}${suffix}$`)
}

function rank(condition: string): number {
  const i = CONDITION_ORDER.indexOf(condition)
  return i < 0 ? CONDITION_ORDER.length : i
}

async function resolveTarget(
  env: DiscoveryEnv,
  input: { dir: string; subpath: string; target: string; tsconfig: { outDir?: string; rootDir?: string } }
): Promise<{ file: string; resolution: "declared" | "mapped" | "conventional" } | undefined> {
  const { dir, subpath, target, tsconfig } = input
  const declaredPath = posix.normalize(posix.join(dir, target))
  const isSource = /\.(?:tsx?|mts|cts)$/.test(declaredPath) && !declaredPath.endsWith(".d.ts")
  if (isSource && (await fileExists(env, declaredPath))) return { file: declaredPath, resolution: "declared" }

  if (tsconfig.outDir !== undefined) {
    const out = posix.normalize(posix.join(dir, tsconfig.outDir))
    if (declaredPath.startsWith(`${out}/`)) {
      const rootDir = posix.normalize(posix.join(dir, tsconfig.rootDir ?? "src"))
      const rel = declaredPath.slice(out.length + 1).replace(/\.d\.ts$|\.(?:[cm]?js|jsx)$/, "")
      for (const ext of [".ts", ".tsx", ".mts", ".cts"]) {
        const candidate = posix.join(rootDir, rel + ext)
        if (await fileExists(env, candidate)) return { file: candidate, resolution: "mapped" }
      }
    }
  }
  if (await fileExists(env, declaredPath)) return { file: declaredPath, resolution: "declared" }
  if (subpath === ".") {
    for (const conventional of CONVENTIONAL_ROOT_ENTRIES) {
      const candidate = posix.join(dir, conventional)
      if (await fileExists(env, candidate)) return { file: candidate, resolution: "conventional" }
    }
  }
  return undefined
}

/** `outDir` / `rootDir` from the package's own tsconfig.json (no `extends` resolution). */
async function readOutRoot(env: DiscoveryEnv, dir: string): Promise<{ outDir?: string; rootDir?: string }> {
  const file = posix.join(dir, "tsconfig.json")
  if (!env.fileSet.has(file)) return {}
  const text = await readBounded(env, file)
  if (text === undefined) return {}
  const parsed = ts.parseConfigFileTextToJson(file, text)
  const options =
    isRecord(parsed.config) && isRecord(parsed.config.compilerOptions) ? parsed.config.compilerOptions : {}
  return {
    ...(typeof options.outDir === "string" ? { outDir: options.outDir } : {}),
    ...(typeof options.rootDir === "string" ? { rootDir: options.rootDir } : {})
  }
}

const PUBLIC_API_FILES = ["src/public-api.ts", "src/public_api.ts", "public-api.ts", "public_api.ts"]

async function angularLibraryEntry(env: DiscoveryEnv, dir: string): Promise<Declared[]> {
  const ngPackage = posix.join(dir, "ng-package.json")
  if (env.fileSet.has(ngPackage)) {
    const text = await readBounded(env, ngPackage)
    if (text !== undefined) {
      const parsed = ts.parseConfigFileTextToJson(ngPackage, text)
      const lib = isRecord(parsed.config) && isRecord(parsed.config.lib) ? parsed.config.lib : undefined
      if (typeof lib?.entryFile === "string")
        return [{ subpath: ".", condition: "ng-package", target: lib.entryFile }]
    }
  }
  for (const candidate of PUBLIC_API_FILES) {
    if (env.fileSet.has(posix.join(dir, candidate)))
      return [{ subpath: ".", condition: "conventional", target: candidate }]
  }
  return []
}

/**
 * ng-packagr secondary entry points: subfolders with their own `ng-package.json`. Consumers import them
 * as `<package>/<folder>`; the entry file defaults to a `public-api` file in the folder.
 */
async function angularSecondaryEntries(env: DiscoveryEnv, dir: string): Promise<Declared[]> {
  if (!env.fileSet.has(posix.join(dir, "ng-package.json"))) return []
  const out: Declared[] = []
  for (const file of env.files) {
    if (posix.basename(file) !== "ng-package.json" || !file.startsWith(dir === "." ? "" : `${dir}/`)) continue
    const folder = posix.dirname(file)
    if (folder === dir) continue
    const relative = posix.relative(dir, folder)
    // A folder with its own package.json is a separate package, not a secondary entry point.
    if (env.fileSet.has(posix.join(folder, "package.json"))) continue
    const text = await readBounded(env, file)
    const parsed = text === undefined ? undefined : ts.parseConfigFileTextToJson(file, text)
    const lib =
      parsed && isRecord(parsed.config) && isRecord(parsed.config.lib) ? parsed.config.lib : undefined
    const entry =
      typeof lib?.entryFile === "string"
        ? lib.entryFile
        : PUBLIC_API_FILES.map((f) => posix.basename(f)).find((f) => env.fileSet.has(posix.join(folder, f)))
    if (entry)
      out.push({ subpath: `./${relative}`, condition: "ng-package", target: posix.join(relative, entry) })
  }
  return out
}
