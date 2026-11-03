import { posix } from "node:path"
import ts from "typescript"

/** True for files that tsconfigPaths reads (`tsconfig.json`, `tsconfig.app.json`, ...). */
export const TSCONFIG_FILE = /(?:^|\/)tsconfig[^/]*\.json$/

/**
 * `compilerOptions.paths` for a package, as project-relative targets, so import aliases such as
 * `@/Primitive` resolve in the analysis program. Follows relative `extends` and `references` (a common
 * layout is a solution-style `tsconfig.json` whose real options live in `tsconfig.app.json`). Later
 * configs override earlier ones; targets are resolved against `baseUrl` when set, else the config's
 * directory. Nothing is executed and `node_modules` configs (`extends` from packages) are not read.
 */
export function tsconfigPaths(
  files: ReadonlyMap<string, string>,
  packageDir: string
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  const seen = new Set<string>()

  const visit = (file: string, depth: number): void => {
    if (depth > 6 || seen.has(file)) return
    seen.add(file)
    const text = files.get(file)
    if (text === undefined) return
    const config: unknown = ts.parseConfigFileTextToJson(file, text).config
    if (!isRecord(config)) return
    const here = posix.dirname(file)

    for (const parent of toArray(config.extends)) {
      if (typeof parent === "string" && parent.startsWith("."))
        visit(withJson(files, posix.normalize(posix.join(here, parent))), depth + 1)
    }
    const options = config.compilerOptions
    if (isRecord(options) && isRecord(options.paths)) {
      const base =
        typeof options.baseUrl === "string" ? posix.normalize(posix.join(here, options.baseUrl)) : here
      for (const [pattern, targets] of Object.entries(options.paths)) {
        const resolved = toArray(targets).flatMap((t) =>
          typeof t === "string" ? [posix.normalize(posix.join(base, t))] : []
        )
        if (resolved.length > 0) out[pattern] = resolved
      }
    }
    for (const reference of toArray(config.references)) {
      if (isRecord(reference) && typeof reference.path === "string") {
        visit(configFile(files, posix.normalize(posix.join(here, reference.path))), depth + 1)
      }
    }
  }

  visit(posix.join(packageDir, "tsconfig.json"), 0)
  return out
}

function withJson(files: ReadonlyMap<string, string>, path: string): string {
  return files.has(path) ? path : `${path}.json`
}

function configFile(files: ReadonlyMap<string, string>, path: string): string {
  return files.has(path) ? path : posix.join(path, "tsconfig.json")
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
