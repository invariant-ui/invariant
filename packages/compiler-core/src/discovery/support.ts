import path from "node:path"
import type { DiagnosticCollector } from "@invariant/shared"
import { sha256Hex } from "@invariant/shared"
import type { ReadonlyFs } from "../fs.js"

export interface DiscoveryEnv {
  fs: ReadonlyFs
  /** Every walked file path, sorted. */
  files: readonly string[]
  fileSet: ReadonlySet<string>
  ignoreDirs: ReadonlySet<string>
  diagnostics: DiagnosticCollector
  limits: DiscoveryLimits
}

export interface DiscoveryLimits {
  maxFiles: number
  maxFileBytes: number
  maxParsedFilesPerEntry: number
  maxCssVariablesPerFile: number
  maxStoryFiles: number
  maxHeadings: number
}

export const DEFAULT_LIMITS: DiscoveryLimits = {
  maxFiles: 50_000,
  maxFileBytes: 1_000_000,
  maxParsedFilesPerEntry: 200,
  maxCssVariablesPerFile: 5000,
  maxStoryFiles: 1000,
  maxHeadings: 100
}

export const posix = path.posix

export function hashText(text: string): string {
  return sha256Hex(text)
}

export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Reads a file; returns undefined (with a diagnostic) when unreadable or over the size limit. */
export async function readBounded(env: DiscoveryEnv, file: string): Promise<string | undefined> {
  try {
    const text = await env.fs.readFile(file)
    if (text.length > env.limits.maxFileBytes) {
      env.diagnostics.warning(
        "discovery.file-too-large",
        `Skipped ${file}: larger than ${env.limits.maxFileBytes} bytes`,
        {
          location: { path: file }
        }
      )
      return undefined
    }
    return text
  } catch (error) {
    env.diagnostics.warning(
      "discovery.file-unreadable",
      `Could not read ${file}: ${(error as Error).message}`,
      { location: { path: file } }
    )
    return undefined
  }
}

/** 1-based line of the first line at or after `fromLine` containing the quoted JSON key. */
export function lineOfJsonKey(text: string, key: string, fromLine = 1): number | undefined {
  const lines = text.split("\n")
  const needle = `"${key}"`
  for (let i = fromLine - 1; i < lines.length; i++) {
    if ((lines[i] as string).includes(needle)) return i + 1
  }
  return undefined
}

/** Line of `key` inside the top-level `group` object, e.g. a dependency inside "dependencies". */
export function lineOfJsonMember(text: string, group: string, key: string): number | undefined {
  const start = lineOfJsonKey(text, group)
  return start === undefined ? undefined : lineOfJsonKey(text, key, start)
}

/** Directory of `file` is inside (or equal to) `dir`. */
export function isInside(dir: string, file: string): boolean {
  return dir === "." || file === dir || file.startsWith(`${dir}/`)
}

/** Owning package: the package whose directory is the longest prefix of `file`. */
export function owningPackage<T extends { dir: string }>(
  packages: readonly T[],
  file: string
): T | undefined {
  let best: T | undefined
  for (const pkg of packages) {
    if (isInside(pkg.dir, file) && (!best || pkg.dir.length > best.dir.length)) best = pkg
  }
  return best
}

/**
 * Case-exact existence. Walked files are authoritative (the real filesystem may be case-insensitive,
 * so `exists("Button.ts")` can be true when only `button.ts` is present). Only paths inside ignored
 * directories such as `dist/`, which the walk skips on purpose, fall back to the filesystem.
 */
export async function fileExists(env: DiscoveryEnv, file: string): Promise<boolean> {
  if (env.fileSet.has(file)) return true
  if (!file.split("/").some((segment) => env.ignoreDirs.has(segment))) return false
  return env.fs.exists(file)
}
