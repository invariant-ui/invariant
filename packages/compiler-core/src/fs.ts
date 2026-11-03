import { promises as nodeFsPromises } from "node:fs"
import path from "node:path"

export type DirEntryKind = "file" | "dir" | "symlink" | "other"

export interface DirEntry {
  name: string
  kind: DirEntryKind
}

/**
 * Read-only view of a project. Paths are POSIX, relative to the project root; `.` is the root.
 * There is deliberately no write, exec, or network method: analysis can only read files.
 */
export interface ReadonlyFs {
  readFile(path: string): Promise<string>
  readDir(path: string): Promise<DirEntry[]>
  exists(path: string): Promise<boolean>
}

/** Reads a real directory. Symlinks are listed but never followed, and no path may escape the root. */
export function nodeFs(rootDirectory: string): ReadonlyFs {
  const root = path.resolve(rootDirectory)
  const resolve = (relative: string): string => {
    const absolute = path.resolve(root, relative)
    if (absolute !== root && !absolute.startsWith(root + path.sep))
      throw new Error(`Path escapes project root: ${relative}`)
    return absolute
  }
  return {
    async readFile(relative) {
      const absolute = resolve(relative)
      const real = await nodeFsPromises.realpath(absolute)
      const realRoot = await nodeFsPromises.realpath(root)
      if (real !== realRoot && !real.startsWith(realRoot + path.sep))
        throw new Error(`Symlink escapes project root: ${relative}`)
      return nodeFsPromises.readFile(real, "utf8")
    },
    async readDir(relative) {
      const entries = await nodeFsPromises.readdir(resolve(relative), { withFileTypes: true })
      return entries
        .map((entry) => ({ name: entry.name, kind: kindOf(entry) }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    },
    async exists(relative) {
      try {
        await nodeFsPromises.access(resolve(relative))
        return true
      } catch {
        return false
      }
    }
  }
}

/** In-memory project for tests and fixtures. Keys are POSIX paths relative to the root. */
export function memoryFs(files: Record<string, string>): ReadonlyFs {
  const normalized = new Map(Object.entries(files).map(([key, value]) => [normalize(key), value]))
  const dirs = new Set<string>(["."])
  for (const file of normalized.keys()) {
    for (let dir = path.posix.dirname(file); dir !== "."; dir = path.posix.dirname(dir)) dirs.add(dir)
  }
  return {
    async readFile(p) {
      const content = normalized.get(normalize(p))
      if (content === undefined) throw new Error(`ENOENT: ${p}`)
      return content
    },
    async readDir(p) {
      const dir = normalize(p)
      if (!dirs.has(dir)) throw new Error(`ENOENT: ${p}`)
      const prefix = dir === "." ? "" : `${dir}/`
      const children = new Map<string, DirEntryKind>()
      for (const file of normalized.keys()) {
        if (!file.startsWith(prefix)) continue
        const [first, ...rest] = file.slice(prefix.length).split("/")
        if (first) children.set(first, rest.length > 0 ? "dir" : "file")
      }
      return [...children]
        .map(([name, kind]) => ({ name, kind }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    },
    async exists(p) {
      const key = normalize(p)
      return normalized.has(key) || dirs.has(key)
    }
  }
}

function kindOf(entry: {
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}): DirEntryKind {
  if (entry.isSymbolicLink()) return "symlink"
  if (entry.isDirectory()) return "dir"
  if (entry.isFile()) return "file"
  return "other"
}

function normalize(p: string): string {
  const result = path.posix.normalize(p.replace(/^\.\//, ""))
  return result === "" ? "." : result.replace(/\/$/, "")
}
