import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { applyPlan, CLIENTS, type Client, planIntegration, validateLaunch } from "@invariant/agent-kit"
import { renderArtifacts, writeArtifacts } from "@invariant/artifact-generator"
import { compile, nodeFs, toArtifactEntries } from "@invariant/compiler-core"
import { type Component, type Conflict, contractJsonSchemas, type Evidence } from "@invariant/contract"
import { patternsFileJsonSchema } from "@invariant/governance"
import { ContractSource, McpServer, serveStdio } from "@invariant/mcp"
import type { JsonValue } from "@invariant/shared"
import { hasErrors } from "@invariant/shared"
import type { Parsed } from "./args.js"
import {
  CONFIG_FILE,
  detectConfig,
  type InvariantConfig,
  isDirectory,
  isSafeRelativePath,
  type LoadedConfig,
  loadConfig,
  outputDirectory,
  SOURCE_TYPES,
  slug,
  writeConfig
} from "./config.js"
import { type CollectionDiff, diffContracts, formatDiff } from "./diff.js"
import { CliError } from "./errors.js"
import { countBySeverity, formatDiagnostic, shortValue, table } from "./format.js"
import type { Io } from "./io.js"
import { adaptersFor, runPipeline } from "./pipeline.js"
import { checkOutput, loadCompiled } from "./store.js"
import { CLI_NAME, CLI_VERSION, NPM_PACKAGE } from "./version.js"
import { watchProject } from "./watch.js"

export interface Context {
  io: Io
  args: Parsed
  cwd: string
}

export const print = (c: Context, text: string): void => c.io.stdout(`${text}\n`)
export const json = (c: Context, value: unknown): void => print(c, JSON.stringify(value, null, 2))

export async function requireConfig(c: Context): Promise<LoadedConfig> {
  const loaded = await loadConfig({
    cwd: c.cwd,
    file: c.args.values.config,
    trustConfig: c.args.values["trust-config"] === true
  })
  if (!loaded) throw new CliError(`no ${CONFIG_FILE} found. Run \`${CLI_NAME} init\` first.`)
  return loaded
}

export async function outputDir(c: Context): Promise<string> {
  if (c.args.values.dir) {
    if (!isSafeRelativePath(c.args.values.dir))
      throw new CliError("--dir must be a relative path inside the project")
    return path.resolve(c.cwd, c.args.values.dir)
  }
  const loaded = await loadConfig({
    cwd: c.cwd,
    file: c.args.values.config,
    trustConfig: c.args.values["trust-config"] === true
  })
  return path.resolve(c.cwd, outputDirectory(loaded?.config))
}

export async function init(c: Context): Promise<number> {
  const file = path.join(c.cwd, CONFIG_FILE)
  if (existsSync(file) && !c.args.values.force)
    throw new CliError(`${CONFIG_FILE} already exists. Use --force to replace it.`)
  const config = await detectConfig(c.cwd)
  writeConfig(file, config)
  print(c, `wrote ${CONFIG_FILE} with ${config.sources.length} source(s):`)
  for (const s of config.sources) print(c, `  ${s.id}  ${s.type}${s.path ? `  ${s.path}` : ""}`)
  if (config.sources.length === 0)
    print(c, "nothing detected; add sources with `invariant source add <type> <path>`")
  return 0
}

/** Code configuration is never edited: loading it executes it. Point at the safe alternative instead. */
const CODE_CONFIG_HINT = (command: string): string =>
  `${command} edits JSON configuration; this configuration is code, and the CLI never rewrites code. ` +
  `Edit it by hand, or run \`${CLI_NAME} init\` to write ${CONFIG_FILE}, which wins over code files.`

export async function source(c: Context): Promise<number> {
  const [, sub, type, rawPath] = c.args.positionals
  if (sub === "list") {
    const { config } = await requireConfig(c)
    if (c.args.values.json) json(c, config.sources)
    else
      print(
        c,
        config.sources.length === 0
          ? "no sources configured"
          : table(
              ["id", "type", "path"],
              config.sources.map((s) => [s.id, s.type, s.path ?? "."])
            )
      )
    return 0
  }
  if (sub === "remove") {
    const id = type
    if (!id) throw new CliError("usage: invariant source remove <id>")
    const loaded = await requireConfig(c)
    if (!loaded.editable) throw new CliError(CODE_CONFIG_HINT("source remove"))
    if (!loaded.config.sources.some((s) => s.id === id)) {
      const known = loaded.config.sources.map((s) => s.id).join(", ") || "none"
      throw new CliError(`no source with id "${id}" (configured: ${known})`)
    }
    writeConfig(loaded.file, { ...loaded.config, sources: loaded.config.sources.filter((s) => s.id !== id) })
    print(c, `removed ${id}`)
    return 0
  }
  if (sub !== "add") throw new CliError("usage: invariant source <add|remove|list> ...")
  if (!type || !(SOURCE_TYPES as readonly string[]).includes(type))
    throw new CliError(`usage: invariant source add <${SOURCE_TYPES.join("|")}> [path] [--id <id>]`)
  const loaded = await requireConfig(c)
  if (!loaded.editable) throw new CliError(CODE_CONFIG_HINT("source add"))
  const dir = rawPath === undefined ? undefined : rawPath.replace(/^\.\//, "").replace(/\/+$/, "") || "."
  if (dir !== undefined) {
    if (!isSafeRelativePath(dir))
      throw new CliError(`path must be relative and inside the project: ${rawPath}`)
    if (!isDirectory(path.resolve(c.cwd, dir))) throw new CliError(`not a directory: ${rawPath}`)
  }
  const id = c.args.values.id ?? slug(dir && dir !== "." ? `${type}-${dir}` : type)
  if (loaded.config.sources.some((s) => s.id === id))
    throw new CliError(`a source with id "${id}" already exists`)
  const next: InvariantConfig = {
    ...loaded.config,
    sources: [
      ...loaded.config.sources,
      { id, type: type as (typeof SOURCE_TYPES)[number], ...(dir && dir !== "." ? { path: dir } : {}) }
    ]
  }
  writeConfig(loaded.file, next)
  print(c, `added ${id} (${type}${dir && dir !== "." ? ` at ${dir}` : ""})`)
  return 0
}

export async function analyze(c: Context): Promise<number> {
  const { config } = await requireConfig(c)
  const result = await compile({ fs: nodeFs(c.cwd), adapters: adaptersFor(config), clock: c.io.clock })
  const out = path.join(await outputDir(c), "analysis")
  const artifacts = renderArtifacts(toArtifactEntries(result), {
    tool: { name: CLI_NAME, version: CLI_VERSION },
    generatedAt: c.io.clock(),
    sources: result.sources
  })
  await writeArtifacts(out, artifacts)
  const entities: Record<string, number> = {}
  for (const ir of result.irDocuments)
    for (const e of ir.entities) entities[e.kind] = (entities[e.kind] ?? 0) + 1
  print(
    c,
    `project: ${result.project.packages.length} packages, ${result.project.storybooks.length} storybooks, ${result.project.tokenFiles.length} token files, ${result.project.docFiles.length} docs`
  )
  print(c, `sources: ${result.sources.length}`)
  for (const s of result.sources) print(c, `  ${s.id}  ${s.type}  ${s.completeness}`)
  print(
    c,
    `entities: ${
      Object.entries(entities)
        .sort()
        .map(([k, n]) => `${k} ${n}`)
        .join(", ") || "none"
    }`
  )
  print(c, `diagnostics: ${countBySeverity(result.diagnostics)}`)
  for (const d of result.diagnostics.filter((x) => x.severity === "error").slice(0, 10))
    print(c, `  ${formatDiagnostic(d)}`)
  print(c, `wrote ${path.relative(c.cwd, out) || "."}/ (${artifacts.length} files)`)
  return hasErrors(result.diagnostics) ? 1 : 0
}

async function compileOnce(c: Context): Promise<number> {
  const { config } = await requireConfig(c)
  const result = await runPipeline({
    cwd: c.cwd,
    config,
    clock: c.io.clock,
    keepIr: c.args.values["keep-ir"] === true
  })
  const out = await outputDir(c)
  await writeArtifacts(out, result.artifacts)
  const contract = result.final.contract
  print(c, `compiled ${contract.metadata.name}`)
  for (const m of result.mapping.slice(0, 12)) {
    const shown = m.sources.slice(0, 4).join(", ") || "nothing"
    const more = m.sources.length > 4 ? `, +${m.sources.length - 4} more` : ""
    print(c, `  ${m.configId} (${m.type}${m.path ? ` ${m.path}` : ""}) -> ${shown}${more}`)
  }
  if (result.mapping.length > 12) print(c, `  … ${result.mapping.length - 12} more`)
  print(
    c,
    `components ${contract.components.length}, tokens ${contract.tokens.length}, themes ${contract.themes.length}, guidelines ${contract.guidelines.length}`
  )
  print(c, `conflicts ${contract.conflicts.length}, needs review ${result.review.length}`)
  print(
    c,
    `patterns ${result.governance.patterns}${result.governance.patternsSkipped > 0 ? ` (${result.governance.patternsSkipped} skipped)` : ""}${result.governance.patternsAwaitingApproval > 0 ? `, ${result.governance.patternsAwaitingApproval} awaiting approval` : ""}, policies ${result.governance.policies}, decisions applied ${result.governance.decisionsApplied}${result.governance.decisionsStale > 0 ? ` (${result.governance.decisionsStale} stale)` : ""}`
  )
  print(c, `diagnostics: ${countBySeverity(result.diagnostics)}`)
  for (const d of result.diagnostics.filter((x) => x.severity === "error").slice(0, 10))
    print(c, `  ${formatDiagnostic(d)}`)
  print(c, `wrote ${path.relative(c.cwd, out) || "."}/ (${result.artifacts.length} files)`)
  return result.ok ? 0 : 1
}

const WATCH_LIST = 3

/** `compile`, or with `--watch` compile now and again after every settled change until stopped. */
export async function compileCommand(c: Context): Promise<number> {
  if (!c.args.values.watch) return compileOnce(c)
  const dir = await outputDir(c)
  const stamp = (): string => c.io.clock().slice(11, 19)
  const cycle = async (): Promise<void> => {
    const started = Date.now()
    try {
      const code = await compileOnce(c)
      print(c, `[${stamp()}] ${code === 0 ? "ok" : "finished with errors"} in ${Date.now() - started} ms`)
    } catch (error) {
      // A broken config or a failed read must not end the watcher: say what is wrong and keep listening.
      print(c, `[${stamp()}] ${error instanceof CliError ? error.message : String(error)}`)
    }
  }
  await cycle()
  print(c, `watching ${c.cwd} for changes (Ctrl+C to stop). Every change recompiles all sources.`)
  await watchProject({
    root: c.cwd,
    outputDir: path.relative(c.cwd, dir) || ".",
    ...(c.io.signal ? { signal: c.io.signal } : {}),
    onChange: async (files) => {
      const shown = files.slice(0, WATCH_LIST).join(", ")
      const more = files.length > WATCH_LIST ? ` and ${files.length - WATCH_LIST} more` : ""
      print(c, `[${stamp()}] changed: ${shown}${more}`)
      await cycle()
    }
  })
  print(c, "stopped watching")
  return 0
}

const frameworks = (x: Component): string => [...new Set(x.implementations.map((i) => i.framework))].join(",")

export async function components(c: Context): Promise<number> {
  const [, sub, query] = c.args.positionals
  const { contract, evidence } = loadCompiled(await outputDir(c))
  if (sub === "list") {
    const conflicts = (id: string): number => contract.conflicts.filter((x) => x.subject === id).length
    const inferred = (x: Component): number =>
      Object.values(x.facts).filter((f) => f.status === "inferred").length
    if (c.args.values.json)
      json(
        c,
        contract.components.map((x) => ({
          id: x.id,
          name: x.name,
          frameworks: frameworks(x).split(","),
          props: x.props.length,
          conflicts: conflicts(x.id)
        }))
      )
    else
      print(
        c,
        contract.components.length === 0
          ? "no components"
          : table(
              ["id", "name", "frameworks", "props", "events", "slots", "conflicts", "inferred"],
              contract.components.map((x) => [
                x.id,
                x.name,
                frameworks(x),
                x.props.length,
                x.events.length,
                x.slots.length,
                conflicts(x.id),
                inferred(x)
              ])
            )
      )
    return 0
  }
  if (sub !== "inspect" || !query) throw new CliError("usage: invariant components <list|inspect <name>>")
  const q = query.toLowerCase()
  const matches = contract.components.filter(
    (x) => x.id === q || x.id === `component:${q}` || x.name.toLowerCase() === q
  )
  if (matches.length === 0)
    throw new CliError(`no component named "${query}". Try \`${CLI_NAME} components list\`.`, 1)
  if (matches.length > 1)
    throw new CliError(`"${query}" is ambiguous: ${matches.map((m) => m.id).join(", ")}. Use the id.`, 1)
  const comp = matches[0] as Component
  const related = contract.conflicts.filter((x) => x.subject === comp.id)
  if (c.args.values.json) {
    json(c, { component: comp, conflicts: related })
    return 0
  }
  const evidenceById = new Map(evidence.evidence.map((e) => [e.id, e]))
  const where = (ids: readonly string[]): string => {
    const e = ids.map((id) => evidenceById.get(id)).find((x): x is Evidence => x !== undefined)
    return e?.location.type === "file"
      ? `${e.location.path}${e.location.line ? `:${e.location.line}` : ""}`
      : (e?.sourceRef ?? "")
  }
  const status = (p: string): string => {
    const f = comp.facts[p]
    return f ? (f.status === "inferred" ? `inferred ${f.confidence}` : f.status) : ""
  }
  print(c, `${comp.name}  (${comp.id})`)
  if (comp.description) print(c, comp.description)
  print(c, `lifecycle: ${comp.lifecycle ?? "unspecified"}`)
  print(c, "\nimplementations")
  print(
    c,
    table(
      ["id", "framework", "package", "export", "status"],
      comp.implementations.map((i) => [
        i.id,
        i.framework,
        i.packageName ?? "",
        i.exportName ?? "",
        status(`implementations.${i.id}`)
      ])
    )
  )
  if (comp.props.length > 0) {
    print(c, "\nprops")
    print(
      c,
      table(
        ["name", "type", "required", "default", "values", "status"],
        comp.props.map((p) => [
          p.name,
          shortValue(p.type.text, 36),
          p.required ? "yes" : "",
          shortValue(p.default, 16),
          shortValue(p.allowedValues, 40),
          status(`props.${p.name}.type.text`)
        ])
      )
    )
  }
  if (comp.events.length > 0) print(c, `\nevents: ${comp.events.map((e) => e.name).join(", ")}`)
  if (comp.slots.length > 0) print(c, `slots: ${comp.slots.map((s) => s.name).join(", ")}`)
  if (comp.variants.length > 0)
    print(
      c,
      `variants: ${comp.variants.map((v) => `${v.name}=[${v.values.join("|")}]${v.default ? ` (default ${v.default})` : ""}`).join("; ")}`
    )
  if (comp.accessibility?.role) print(c, `accessibility role: ${comp.accessibility.role}`)
  if (comp.composition.length > 0)
    print(
      c,
      `composition: ${comp.composition.map((r, i) => `${r.type} ${r.target}${comp.facts[`composition.${i}`]?.status === "inferred" ? " (inferred)" : ""}`).join("; ")}`
    )
  if (related.length > 0) {
    print(c, "\nconflicts")
    print(
      c,
      table(
        ["severity", "type", "path", "claims"],
        related.map((x: Conflict) => [
          x.severity,
          x.type,
          x.path ?? "",
          x.claims.map((cl) => `${cl.sourceId}=${shortValue(cl.value ?? "(absent)", 24)}`).join(" vs ")
        ])
      )
    )
  }
  if (c.args.values.evidence) {
    print(c, "\nevidence")
    print(
      c,
      table(
        ["fact", "status", "where"],
        Object.entries(comp.facts)
          .filter(([p]) => !p.startsWith("extensions.") && !p.includes(".extensions."))
          .map(([p, f]) => [p, f.status, where(f.evidenceIds)])
      )
    )
  }
  return 0
}

export async function tokens(c: Context): Promise<number> {
  if (c.args.positionals[1] !== "list") throw new CliError("usage: invariant tokens list")
  const { contract } = loadCompiled(await outputDir(c))
  if (c.args.values.json) {
    json(c, contract.tokens)
    return 0
  }
  print(
    c,
    contract.tokens.length === 0
      ? "no tokens"
      : table(
          ["id", "category", "value", "modes"],
          contract.tokens.map((t) => [
            t.id,
            `${t.category}${t.facts.category?.status === "inferred" ? "*" : ""}`,
            "aliasOf" in t.value && t.value.aliasOf ? `-> ${t.value.aliasOf}` : shortValue(t.value.value, 48),
            Object.keys(t.modes ?? {}).join(",")
          ])
        )
  )
  if (contract.tokens.some((t) => t.facts.category?.status === "inferred"))
    print(c, "\n* category is inferred, not declared")
  return 0
}

export async function conflicts(c: Context): Promise<number> {
  if (c.args.positionals[1] !== "list")
    throw new CliError("usage: invariant conflicts list [--severity s] [--type t] [--subject id]")
  const { contract } = loadCompiled(await outputDir(c))
  const { severity, type, subject } = c.args.values
  const rows = contract.conflicts.filter(
    (x) =>
      (!severity || x.severity === severity) &&
      (!type || x.type === type) &&
      (!subject || x.subject === subject || x.subject === `component:${subject.toLowerCase()}`)
  )
  if (c.args.values.json) {
    json(c, rows)
    return 0
  }
  print(
    c,
    rows.length === 0
      ? "no conflicts"
      : table(
          ["severity", "type", "subject", "path", "claims"],
          rows.map((x) => [
            x.severity,
            x.type,
            x.subject,
            x.path ?? "",
            x.claims.map((cl) => `${cl.sourceId}=${shortValue(cl.value ?? "(absent)", 24)}`).join(" vs ")
          ])
        )
  )
  return 0
}

export async function verify(c: Context): Promise<number> {
  const dir = await outputDir(c)
  const { compiled, diagnostics } = checkOutput(dir)
  const all = [...diagnostics]
  let changes: CollectionDiff[] | undefined
  if (c.args.values.fresh) {
    const { config } = await requireConfig(c)
    const fresh = await runPipeline({ cwd: c.cwd, config, clock: c.io.clock })
    if (fresh.final.contract.integrity.contentHash !== compiled.contract.integrity.contentHash) {
      changes = diffContracts(compiled.contract, fresh.final.contract)
      all.push({
        code: "verify.stale",
        severity: "error",
        message: "the sources have changed since the contract was compiled. Run `invariant compile`."
      })
    }
  }
  if (c.args.values.json) json(c, { ok: !hasErrors(all), diagnostics: all, ...(changes ? { changes } : {}) })
  else {
    for (const d of all) print(c, formatDiagnostic(d))
    if (changes) for (const line of formatDiff(changes)) print(c, line)
    print(
      c,
      hasErrors(all)
        ? `invalid: ${countBySeverity(all)}`
        : `valid: contract ${compiled.contract.integrity.contentHash.slice(0, 12)}, ${countBySeverity(all)}`
    )
  }
  return hasErrors(all) ? 1 : 0
}

export async function exportCommand(c: Context): Promise<number> {
  const to = c.args.values.to
  if (!to) throw new CliError("usage: invariant export --to <directory>")
  if (!isSafeRelativePath(to)) throw new CliError("--to must be a relative path inside the project")
  const dir = await outputDir(c)
  const { diagnostics } = checkOutput(dir)
  if (hasErrors(diagnostics) && !c.args.values.force) {
    for (const d of diagnostics.filter((x) => x.severity === "error")) print(c, formatDiagnostic(d))
    throw new CliError("the compiled output is invalid; fix it or pass --force", 1)
  }
  const target = path.resolve(c.cwd, to)
  if (path.resolve(target) === path.resolve(dir))
    throw new CliError("--to must differ from the output directory")
  if (existsSync(target) && readdirSync(target).length > 0 && !c.args.values.force)
    throw new CliError(`${to} is not empty. Use --force to write into it.`)
  mkdirSync(target, { recursive: true })
  const files = [
    "invariant.contract.json",
    "invariant.evidence.json",
    "invariant.diagnostics.json",
    "invariant.review.json",
    "invariant.report.html",
    "invariant.manifest.json"
  ]
  for (const f of files) if (existsSync(path.join(dir, f))) cpSync(path.join(dir, f), path.join(target, f))
  mkdirSync(path.join(target, "schema"), { recursive: true })
  for (const [name, schema] of Object.entries({
    ...contractJsonSchemas(),
    "patterns-file-v1.schema.json": patternsFileJsonSchema()
  }))
    writeFileSync(path.join(target, "schema", name), `${JSON.stringify(schema as JsonValue, null, 2)}\n`)
  print(
    c,
    `exported to ${to}/ (contract, evidence, diagnostics, review, report, manifest, schema/ with the contract and pattern-definition schemas)`
  )
  return 0
}

export async function mcp(c: Context): Promise<number> {
  const { input, output } = c.io
  if (!input || !output) throw new CliError("`mcp` needs standard input and output streams")
  const dir = await outputDir(c)
  const server = new McpServer({ source: new ContractSource(dir), version: CLI_VERSION })
  // stdout carries only protocol messages; everything human-readable goes to stderr.
  c.io.stderr(
    `invariant mcp: serving the contract in ${path.relative(c.cwd, dir) || "."} (read-only, stdio)\n`
  )
  await serveStdio(input, output, server, c.io.stderr)
  return 0
}

export async function agent(c: Context): Promise<number> {
  const [, sub, target] = c.args.positionals
  if (sub === "list") {
    print(c, CLIENTS.join("\n"))
    return 0
  }
  if (sub !== "init" || !target)
    throw new CliError(
      `usage: invariant agent init <${CLIENTS.join("|")}|all> [--command exe] [--command-arg arg] [--dry-run] [--force]`
    )
  const clients =
    target === "all"
      ? [...CLIENTS]
      : (CLIENTS as readonly string[]).includes(target)
        ? [target as Client]
        : undefined
  if (!clients) throw new CliError(`unknown client "${target}". Choose one of: ${CLIENTS.join(", ")}, all`)
  const dir = await outputDir(c)
  const { contract } = loadCompiled(dir)
  const rel = path.relative(c.cwd, dir).split(path.sep).join("/") || "."
  if (rel.startsWith(".."))
    throw new CliError(
      "the output directory must be inside the project so a committed config can refer to it"
    )
  // With no --command, use `invariant` if it is installed. Someone running through npx has no such command, so the
  // agent's config starts it through npx instead (it installs on first use). A missing PATH means we cannot tell.
  const searchPath = c.io.env?.PATH
  const installed =
    searchPath === undefined ||
    searchPath.split(path.delimiter).some((d) => d !== "" && existsSync(path.join(d, "invariant")))
  const viaNpx = c.args.values.command === undefined && !installed
  const launch = {
    command: c.args.values.command ?? (viaNpx ? "npx" : "invariant"),
    args: [
      ...(viaNpx ? ["-y", NPM_PACKAGE] : []),
      ...(c.args.values["command-arg"] ?? []),
      "mcp",
      "--dir",
      rel
    ]
  }
  if (viaNpx)
    print(
      c,
      `${CLI_NAME} is not on your PATH, so the agent will start it with npx ${NPM_PACKAGE} (it installs on first use).`
    )
  const problem = validateLaunch(launch)
  if (problem) throw new CliError(problem)
  let skipped = 0
  for (const client of clients) {
    const plan = planIntegration(client, contract, launch)
    print(c, `${client}${c.args.values["dry-run"] ? " (dry run)" : ""}`)
    for (const r of applyPlan(c.cwd, plan.files, {
      force: c.args.values.force === true,
      dryRun: c.args.values["dry-run"] === true
    })) {
      if (r.action === "skipped") skipped++
      print(c, `  ${r.action.padEnd(9)} ${r.path}${r.reason ? `  (${r.reason})` : ""}`)
    }
    for (const note of plan.notes) print(c, `  note: ${note}`)
    for (const s of plan.snippets) print(c, `  ${s.title}:\n${s.text.replace(/^/gm, "    ")}`)
  }
  if (skipped > 0) print(c, `${skipped} file(s) were left alone; see the reasons above.`)
  return 0
}
