import { watch } from "node:fs/promises"
import path from "node:path"

/** Directories whose contents are never sources. The output directory is added by the caller. */
const NEVER = new Set(["node_modules", ".git", ".hg", ".svn", ".turbo", ".next", "coverage"])

export interface WatchOptions {
  /** Directory to watch recursively. */
  root: string
  /** Output directory, relative to `root` or absolute. Writing artifacts must never trigger a recompile. */
  outputDir: string
  /** Stops the watcher. */
  signal?: AbortSignal
  /** Quiet period after the last change before `onChange` runs. */
  debounceMs?: number
  /** Called once the watcher is listening. */
  onReady?: () => void
  /** Called with the changed files (project-relative, sorted) once changes stop. Runs one at a time. */
  onChange: (files: string[]) => Promise<void>
}

/** True when a project-relative path is inside the output directory or a directory that is never a source. */
export function isIgnored(rel: string, outputRel: string): boolean {
  const parts = rel.split(path.sep).filter(Boolean)
  if (parts.some((p) => NEVER.has(p))) return true
  if (outputRel && outputRel !== ".") {
    const out = outputRel.split(path.sep).filter(Boolean)
    if (out.every((seg, i) => parts[i] === seg)) return true
  }
  return false
}

/**
 * Watches a project and calls `onChange` after changes settle. Changes that arrive while `onChange` is running
 * are collected and trigger exactly one more run, so a burst of saves never queues many compiles.
 * Resolves when `signal` aborts.
 */
export async function watchProject(options: WatchOptions): Promise<void> {
  const { root, signal, debounceMs = 250 } = options
  const outputRel = path.isAbsolute(options.outputDir)
    ? path.relative(root, options.outputDir)
    : path.normalize(options.outputDir)
  const pending = new Set<string>()
  let timer: NodeJS.Timeout | undefined
  let running = false

  const flush = async (): Promise<void> => {
    timer = undefined
    if (running || pending.size === 0) return
    running = true
    try {
      while (pending.size > 0) {
        const files = [...pending].sort()
        pending.clear()
        await options.onChange(files)
      }
    } finally {
      running = false
    }
  }

  try {
    const events = watch(root, { recursive: true, ...(signal ? { signal } : {}) })
    options.onReady?.()
    for await (const event of events) {
      const rel = event.filename ? path.normalize(event.filename.toString()) : ""
      if (!rel || isIgnored(rel, outputRel)) continue
      pending.add(rel)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void flush(), debounceMs)
    }
  } catch (error) {
    if ((error as { name?: string }).name !== "AbortError") throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}
