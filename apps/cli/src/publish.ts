import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { InvariantConfig } from "./config.js"
import { CLI_VERSION, NPM_PACKAGE } from "./version.js"

export interface PublishPlan {
  /** Absolute path of the package.json of the design system package. */
  file: string
  name: string
  /** The package's folder, relative to the project root. `.` for a single-package repository. */
  dir: string
  /** What to put in `scripts.prepack`. */
  prepack: string
  /** What is already in place. */
  hasFiles: boolean
  hasPrepack: boolean
}

export type PublishFinding = { ok: true; plan: PublishPlan } | { ok: false; reason: string }

const posix = (p: string): string => p.split(path.sep).join("/")

/**
 * Finds the package that ships the design system and says what it needs so that its published tarball carries the
 * compiled contract. A private package is skipped: it is not published, so apps in the same repository use it directly.
 */
export function planPublish(cwd: string, config: InvariantConfig, outputDirectory: string): PublishFinding {
  const framework = config.sources.filter(
    (s) => s.type === "react" || s.type === "vue" || s.type === "angular"
  )
  const dirs = [...framework.map((s) => s.path ?? "."), "."]
  for (const dir of dirs) {
    const file = path.join(cwd, dir, "package.json")
    if (!existsSync(file)) continue
    let pkg: { name?: unknown; private?: unknown; files?: unknown; scripts?: Record<string, unknown> }
    try {
      pkg = JSON.parse(readFileSync(file, "utf8"))
    } catch {
      return { ok: false, reason: `${posix(path.join(dir, "package.json"))} is not valid JSON` }
    }
    if (typeof pkg.name !== "string" || pkg.name === "")
      return {
        ok: false,
        reason: `${posix(path.join(dir, "package.json"))} has no name, so it is not a published package`
      }
    if (pkg.private === true)
      return {
        ok: false,
        reason: `${pkg.name} is private, so it is not published (apps in this repository use it directly)`
      }
    const rel = dir === "." ? "." : posix(path.normalize(dir))
    const pkgDirFromRoot = rel
    const out = posix(path.normalize(outputDirectory))
    const run = `npx ${NPM_PACKAGE}@${CLI_VERSION}`
    // In the package's own folder the output directory is the folder to ship. Anywhere else it is copied there.
    const toRoot = rel === "." ? "" : ` --cwd ${posix(path.relative(path.join(cwd, rel), cwd)) || "."}`
    const prepack =
      rel === "." && out === "invariant"
        ? `${run} compile`
        : `${run} compile${toRoot} && ${run} export --to ${posix(path.join(pkgDirFromRoot, "invariant"))} --force${toRoot}`
    const files = Array.isArray(pkg.files) ? (pkg.files as unknown[]) : undefined
    return {
      ok: true,
      plan: {
        file,
        name: pkg.name,
        dir: rel,
        prepack,
        hasFiles:
          files === undefined
            ? true
            : files.some((f) => f === "invariant" || f === "invariant/" || f === "invariant/**"),
        hasPrepack: typeof pkg.scripts?.prepack === "string"
      }
    }
  }
  return { ok: false, reason: "no package.json with a name was found for the design system" }
}

/** Adds `invariant` to `files` (only if the package lists its files) and a `prepack` script (only if it has none). */
export function applyPublish(plan: PublishPlan): string[] {
  const raw = readFileSync(plan.file, "utf8")
  const indent = /^\{\n(\t| +)"/.exec(raw)?.[1] ?? 2
  const pkg = JSON.parse(raw) as { files?: string[]; scripts?: Record<string, string> } & Record<
    string,
    unknown
  >
  const done: string[] = []
  if (Array.isArray(pkg.files) && !plan.hasFiles) {
    pkg.files = [...pkg.files, "invariant"]
    done.push('added "invariant" to files')
  }
  if (!plan.hasPrepack) {
    pkg.scripts = { ...(pkg.scripts ?? {}), prepack: plan.prepack }
    done.push("added a prepack script that compiles the contract")
  }
  if (done.length > 0)
    writeFileSync(plan.file, `${JSON.stringify(pkg, null, indent)}${raw.endsWith("\n") ? "\n" : ""}`)
  return done
}
