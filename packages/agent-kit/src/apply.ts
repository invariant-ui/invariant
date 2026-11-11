import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import path from "node:path"
import { MARKER } from "./guidance.js"
import type { PlannedFile } from "./integrations.js"

export type Action = "created" | "updated" | "unchanged" | "skipped"
export interface Applied {
  path: string
  action: Action
  reason?: string
}

const BEGIN = "<!-- invariant:begin -->"
const END = "<!-- invariant:end -->"

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Resolves a project-relative path, refusing anything that would land outside the root, symlinks included. */
export function resolveInside(root: string, rel: string): string {
  if (rel === "" || path.isAbsolute(rel) || rel.split(/[\\/]/).includes(".."))
    throw new Error(`unsafe path: ${rel}`)
  const target = path.resolve(root, rel)
  const realRoot = realpathSync(root)
  let probe = target
  while (!existsSync(probe)) probe = path.dirname(probe)
  const real = realpathSync(probe)
  if (real !== realRoot && !real.startsWith(realRoot + path.sep))
    throw new Error(`path escapes the project: ${rel}`)
  if (existsSync(target) && lstatSync(target).isSymbolicLink())
    throw new Error(`refusing to write through a symbolic link: ${rel}`)
  return target
}

function write(file: string, text: string, dryRun: boolean): void {
  if (dryRun) return
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text, "utf8")
}

function jsonMerge(
  file: string,
  f: Extract<PlannedFile, { kind: "json-merge" }>,
  force: boolean,
  dryRun: boolean
): Applied {
  const rel = f.path
  let doc: Record<string, unknown> = {}
  const existed = existsSync(file)
  if (existed) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        throw new Error("not an object")
      doc = parsed as Record<string, unknown>
    } catch {
      return {
        path: rel,
        action: "skipped",
        reason:
          "the file is not plain JSON (comments or trailing commas?), so it was left alone. Add the entry by hand."
      }
    }
  }
  let node = doc
  for (const key of f.key.slice(0, -1)) {
    const next = node[key]
    if (next === undefined) {
      const created: Record<string, unknown> = {}
      node[key] = created
      node = created
    } else if (typeof next === "object" && next !== null && !Array.isArray(next))
      node = next as Record<string, unknown>
    else
      return { path: rel, action: "skipped", reason: `"${key}" is not an object, so the file was left alone` }
  }
  const last = f.key[f.key.length - 1] as string
  if (same(node[last], f.value)) return { path: rel, action: "unchanged" }
  if (node[last] !== undefined && !force)
    return {
      path: rel,
      action: "skipped",
      reason: `an entry "${last}" already exists with different settings; use --force to replace it`
    }
  node[last] = f.value
  write(file, `${JSON.stringify(doc, null, 2)}\n`, dryRun)
  return { path: rel, action: existed ? "updated" : "created" }
}

/**
 * Makes sure an array at `key` holds our elements, leaving any the user configured alone. An element that
 * carries our `identity` is ours: identical means unchanged, different means replace with `--force`, and no
 * identity anywhere means append. A non-array at the key is never touched.
 */
function jsonArrayAppend(
  file: string,
  f: Extract<PlannedFile, { kind: "json-array-append" }>,
  force: boolean,
  dryRun: boolean
): Applied {
  const rel = f.path
  let doc: Record<string, unknown> = {}
  const existed = existsSync(file)
  if (existed) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        throw new Error("not an object")
      doc = parsed as Record<string, unknown>
    } catch {
      return {
        path: rel,
        action: "skipped",
        reason:
          "the file is not plain JSON (comments or trailing commas?), so it was left alone. Add the entry by hand."
      }
    }
  }
  let node = doc
  for (const key of f.key.slice(0, -1)) {
    const next = node[key]
    if (next === undefined) {
      const created: Record<string, unknown> = {}
      node[key] = created
      node = created
    } else if (typeof next === "object" && next !== null && !Array.isArray(next))
      node = next as Record<string, unknown>
    else
      return { path: rel, action: "skipped", reason: `"${key}" is not an object, so the file was left alone` }
  }
  const last = f.key[f.key.length - 1] as string
  const arr = node[last]
  if (arr === undefined) {
    node[last] = f.value
    write(file, `${JSON.stringify(doc, null, 2)}\n`, dryRun)
    return { path: rel, action: existed ? "updated" : "created" }
  }
  if (!Array.isArray(arr))
    return { path: rel, action: "skipped", reason: `"${last}" is not an array, so the file was left alone` }
  if (f.value.every((el) => arr.some((x) => same(x, el)))) return { path: rel, action: "unchanged" }
  const isOurs = (el: unknown): boolean => JSON.stringify(el).includes(f.identity)
  if (arr.some(isOurs)) {
    if (!force)
      return {
        path: rel,
        action: "skipped",
        reason: "an invariant hook already exists with different settings; use --force to replace it"
      }
    node[last] = [...arr.filter((el) => !isOurs(el)), ...f.value]
  } else node[last] = [...arr, ...f.value]
  write(file, `${JSON.stringify(doc, null, 2)}\n`, dryRun)
  return { path: rel, action: existed ? "updated" : "created" }
}

function tomlTable(
  file: string,
  f: Extract<PlannedFile, { kind: "toml-table" }>,
  force: boolean,
  dryRun: boolean
): Applied {
  if (!existsSync(file)) {
    write(file, f.text, dryRun)
    return { path: f.path, action: "created" }
  }
  const text = readFileSync(file, "utf8")
  const header = `[${f.table}]`
  const lines = text.split("\n")
  const start = lines.findIndex((l) => l.trim() === header)
  if (start < 0) {
    write(file, `${text}${text.endsWith("\n") || text === "" ? "" : "\n"}\n${f.text}`, dryRun)
    return { path: f.path, action: "updated" }
  }
  let end = start + 1
  while (end < lines.length && !/^\s*\[/.test(lines[end] as string)) end++
  const current = lines.slice(start, end).join("\n").trimEnd()
  if (current === f.text.trimEnd()) return { path: f.path, action: "unchanged" }
  if (!force)
    return {
      path: f.path,
      action: "skipped",
      reason: `a [${f.table}] table already exists with different settings; use --force to replace it`
    }
  const next = [...lines.slice(0, start), ...f.text.trimEnd().split("\n"), "", ...lines.slice(end)].join("\n")
  write(file, next, dryRun)
  return { path: f.path, action: "updated" }
}

function generated(
  file: string,
  f: Extract<PlannedFile, { kind: "generated" }>,
  force: boolean,
  dryRun: boolean
): Applied {
  if (!existsSync(file)) {
    write(file, f.content, dryRun)
    return { path: f.path, action: "created" }
  }
  const current = readFileSync(file, "utf8")
  if (current === f.content) return { path: f.path, action: "unchanged" }
  if (!current.includes(MARKER) && !force)
    return {
      path: f.path,
      action: "skipped",
      reason: "the file exists and was not generated by invariant; use --force to replace it"
    }
  write(file, f.content, dryRun)
  return { path: f.path, action: "updated" }
}

function markdownSection(
  file: string,
  f: Extract<PlannedFile, { kind: "markdown-section" }>,
  dryRun: boolean
): Applied {
  const block = `${BEGIN}\n<!-- ${MARKER}; edits between the markers are replaced when it is regenerated -->\n${f.content.trimEnd()}\n${END}\n`
  if (!existsSync(file)) {
    write(file, block, dryRun)
    return { path: f.path, action: "created" }
  }
  const text = readFileSync(file, "utf8")
  const b = text.indexOf(BEGIN)
  const e = text.indexOf(END)
  if (b >= 0 && e > b) {
    const next = `${text.slice(0, b)}${block.trimEnd()}${text.slice(e + END.length)}`
    if (next === text) return { path: f.path, action: "unchanged" }
    write(file, next, dryRun)
    return { path: f.path, action: "updated" }
  }
  if (b >= 0 || e >= 0)
    return {
      path: f.path,
      action: "skipped",
      reason: "the invariant markers are unbalanced, so the file was left alone"
    }
  write(file, `${text}${text.endsWith("\n") || text === "" ? "" : "\n"}\n${block}`, dryRun)
  return { path: f.path, action: "updated" }
}

/** Writes planned files under `root`. Nothing outside the root is touched, and user files are merged or left alone. */
export function applyPlan(
  root: string,
  files: readonly PlannedFile[],
  options: { force?: boolean; dryRun?: boolean } = {}
): Applied[] {
  const force = options.force === true
  const dryRun = options.dryRun === true
  const one = (f: PlannedFile): Applied => {
    let file: string
    try {
      file = resolveInside(root, f.path)
    } catch (error) {
      return { path: f.path, action: "skipped", reason: (error as Error).message }
    }
    if (f.kind === "json-merge") return jsonMerge(file, f, force, dryRun)
    if (f.kind === "json-array-append") return jsonArrayAppend(file, f, force, dryRun)
    if (f.kind === "toml-table") return tomlTable(file, f, force, dryRun)
    if (f.kind === "generated") return generated(file, f, force, dryRun)
    return markdownSection(file, f, dryRun)
  }
  return files.map(one)
}
