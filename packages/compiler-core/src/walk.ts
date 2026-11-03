import type { ReadonlyFs } from "./fs.js"

export const DEFAULT_IGNORED_DIRS: readonly string[] = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".angular",
  ".svelte-kit",
  ".output",
  ".pnpm-store",
  "storybook-static"
]

export interface WalkResult {
  /** Every file path, sorted. */
  files: string[]
  truncated: boolean
}

/**
 * Deterministic walk: sorted traversal, ignored directories skipped, symlinks never followed.
 * Stops at `maxFiles` and reports truncation rather than silently returning a partial list.
 */
export async function walk(
  fs: ReadonlyFs,
  options: { ignoreDirs: ReadonlySet<string>; maxFiles: number; start?: string }
): Promise<WalkResult> {
  const files: string[] = []
  let truncated = false
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await fs.readDir(dir)) {
      if (truncated) return
      const child = dir === "." ? entry.name : `${dir}/${entry.name}`
      if (entry.kind === "dir") {
        if (!options.ignoreDirs.has(entry.name)) await visit(child)
      } else if (entry.kind === "file") {
        if (files.length >= options.maxFiles) {
          truncated = true
          return
        }
        files.push(child)
      }
    }
  }
  await visit(options.start ?? ".")
  return { files: files.sort(), truncated }
}
