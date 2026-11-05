import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { discoverProject, nodeFs } from "@invariant/compiler-core"
import { nearest, RULES } from "@invariant/validation"
import { z } from "zod"
import { CliError } from "./errors.js"

export const CONFIG_FILE = "invariant.config.json"
export const DEFAULT_OUTPUT = "invariant"
const CODE_CONFIGS = [
  "invariant.config.ts",
  "invariant.config.mts",
  "invariant.config.mjs",
  "invariant.config.js"
]

/** Source types the compiler can read today. zeroheight and Figma are planned but not implemented. */
export const SOURCE_TYPES = ["react", "vue", "angular", "storybook", "tokens"] as const
const PLANNED_TYPES = ["zeroheight", "figma"]

const slugRe = /^[a-z0-9][a-z0-9._-]*$/

/** A project-relative path: no absolute paths, no drive letters, no backslashes, no `..`. */
export function isSafeRelativePath(p: string): boolean {
  return (
    p !== "" &&
    !p.startsWith("/") &&
    !/^[A-Za-z]:/.test(p) &&
    !p.includes("\\") &&
    !p.split("/").includes("..")
  )
}

const relPath = z.string().refine(isSafeRelativePath, "must be a relative path inside the project (no '..')")

export const configSchema = z.strictObject({
  name: z.string().min(1),
  contractId: z.string().regex(slugRe).max(64).optional(),
  description: z.string().min(1).optional(),
  sources: z.array(
    z.strictObject({
      /** A label for this entry. Compiled source ids come from the adapters; `analyze` shows the mapping. */
      id: z.string().regex(slugRe).max(64),
      type: z.enum(SOURCE_TYPES),
      /** Limits the entry to sources found at or below this directory. Omitted means the whole project. */
      path: relPath.optional()
    })
  ),
  output: z.strictObject({ directory: relPath }).optional(),
  /**
   * For an application that uses a design system it does not contain: the folder holding the contract the library
   * ships (for example `node_modules/@acme/ui/invariant`). `compile` then starts from that contract instead of reading
   * sources, and adds this project's own patterns, policies and decisions on top.
   */
  extends: z.strictObject({ contract: relPath }).optional(),
  validation: z
    .strictObject({
      /** Severity per rule code, or `off`. See `invariant rules`. */
      rules: z.record(z.string(), z.enum(["off", "info", "warning", "error"])).optional(),
      /** Globs of files `validate` skips when walking directories. */
      ignore: z.array(z.string().min(1).max(300)).max(100).optional(),
      failOn: z.enum(["error", "warning", "never"]).optional()
    })
    .optional(),
  governance: z
    .strictObject({
      /** If present, only these names may record decisions. Names are asserted, not authenticated. */
      approvers: z.array(z.string().min(1).max(200)).max(200).optional(),
      policiesFile: relPath.optional(),
      patternsFile: relPath.optional(),
      decisionsFile: relPath.optional(),
      candidateReviewsFile: relPath.optional()
    })
    .optional()
})
export type InvariantConfig = z.infer<typeof configSchema>

export function outputDirectory(config: InvariantConfig | undefined): string {
  return config?.output?.directory ?? DEFAULT_OUTPUT
}

export function validateConfig(raw: unknown): InvariantConfig {
  const sources = (raw as { sources?: unknown })?.sources
  if (Array.isArray(sources)) {
    for (const s of sources) {
      const type = (s as { type?: unknown })?.type
      if (typeof type === "string" && PLANNED_TYPES.includes(type))
        throw new CliError(
          `source type "${type}" is not supported yet. Supported: ${SOURCE_TYPES.join(", ")}. Remove the entry, or wait for the ${type} compiler.`
        )
    }
  }
  const parsed = configSchema.safeParse(raw)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
    throw new CliError(`invalid configuration:\n${lines.join("\n")}`)
  }
  for (const code of Object.keys(parsed.data.validation?.rules ?? {})) {
    if (RULES.some((r) => r.code === code)) continue
    const close = nearest(
      code,
      RULES.map((r) => r.code)
    )
    throw new CliError(
      `invalid configuration: validation.rules has unknown rule "${code}"${close.length > 0 ? `. Did you mean ${close.join(" or ")}?` : ""} (see \`invariant rules\`)`
    )
  }
  const ids = new Set<string>()
  for (const s of parsed.data.sources) {
    if (ids.has(s.id)) throw new CliError(`invalid configuration: duplicate source id "${s.id}"`)
    ids.add(s.id)
  }
  return parsed.data
}

export interface LoadedConfig {
  config: InvariantConfig
  file: string
  /** JSON files can be edited by `source add`; code configs cannot. */
  editable: boolean
}

/**
 * Finds and loads the configuration. JSON is read as data. A TypeScript or JavaScript config is code, and
 * loading it runs it, so it is only loaded when the user passes `--trust-config`.
 */
export async function loadConfig(input: {
  cwd: string
  file?: string | undefined
  trustConfig: boolean
}): Promise<LoadedConfig | undefined> {
  const candidates = input.file
    ? [path.resolve(input.cwd, input.file)]
    : [CONFIG_FILE, ...CODE_CONFIGS].map((f) => path.join(input.cwd, f))
  const file = candidates.find((f) => existsSync(f))
  if (!file) {
    if (input.file) throw new CliError(`configuration file not found: ${input.file}`)
    return undefined
  }
  if (file.endsWith(".json")) {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file, "utf8"))
    } catch (error) {
      throw new CliError(`${path.relative(input.cwd, file)} is not valid JSON: ${(error as Error).message}`)
    }
    return { config: validateConfig(raw), file, editable: true }
  }
  if (!input.trustConfig)
    throw new CliError(
      `${path.relative(input.cwd, file)} is code, and loading it runs it. Re-run with --trust-config if you trust it, or use ${CONFIG_FILE}.`
    )
  const module = (await import(pathToFileURL(file).href)) as { default?: unknown }
  if (module.default === undefined)
    throw new CliError(`${path.relative(input.cwd, file)} has no default export`)
  return { config: validateConfig(module.default), file, editable: false }
}

export function writeConfig(file: string, config: InvariantConfig): void {
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8")
}

export const slug = (text: string): string => {
  const s = text
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-{2,}/g, "-")
    .replace(/[-.]+$/, "")
  return s === "" ? "source" : s
}

export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Proposes a configuration from what discovery finds: one entry per framework package, Storybook, tokens. */
export async function detectConfig(cwd: string): Promise<InvariantConfig> {
  const project = await discoverProject({ fs: nodeFs(cwd) })
  const sources: InvariantConfig["sources"] = []
  const taken = new Set<string>()
  const add = (base: string, type: (typeof SOURCE_TYPES)[number], dir: string): void => {
    let id = slug(base)
    for (let n = 2; taken.has(id); n++) id = `${slug(base)}-${n}`
    taken.add(id)
    sources.push({ id, type, ...(dir === "." ? {} : { path: dir }) })
  }
  const MANY = 5
  const packages = [...project.packages].sort((a, b) => (a.dir < b.dir ? -1 : 1))
  for (const type of ["react", "vue", "angular"] as const) {
    const using = packages.filter((p) => p.frameworks.some((f) => f.name === type))
    // A repository with many packages of one framework gets one whole-project entry rather than a long list.
    if (using.length > MANY) add(type, type, ".")
    else for (const pkg of using) add(`${pkg.name}-${type}`, type, pkg.dir)
  }
  for (const sb of project.storybooks) add(`storybook-${sb.directory}`, "storybook", sb.directory)
  if (project.tokenFiles.length > 0) add("tokens", "tokens", ".")
  const rootName = project.packages.find((p) => p.dir === ".")?.name
  return { name: rootName ?? (path.basename(cwd) || "design-system"), sources }
}
