import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { DEFAULT_IGNORED_DIRS, globToRegExp, matchesAny } from "@invariant/compiler-core"
import { DesignSystem } from "@invariant/contract-query"
import {
  type CodeFramework,
  type FailOn,
  formatGithub,
  formatText,
  RULES,
  type RuleOverrides,
  shouldFail,
  summarize,
  toJson,
  toSarif,
  type Violation,
  validateCode
} from "@invariant/validation"
import { type Context, json, outputDir, print } from "./commands.js"
import { loadConfig } from "./config.js"
import { CliError } from "./errors.js"
import { table } from "./format.js"
import { loadCompiled } from "./store.js"
import { CLI_NAME, CLI_VERSION } from "./version.js"

const EXTENSIONS = /\.(tsx|jsx|ts|js|mjs|cjs|vue|html)$/i
const MAX_FILES = 5000
const FRAMEWORKS: readonly string[] = ["react", "vue", "angular", "html"]
const FORMATS = ["text", "json", "github", "sarif"] as const
const FAIL_ON: readonly string[] = ["error", "warning", "never"]

function frameworkFor(file: string): CodeFramework | undefined {
  if (/\.vue$/i.test(file)) return "vue"
  if (/\.component\.html$/i.test(file)) return "angular"
  if (/\.html$/i.test(file)) return "html"
  return undefined
}

function collect(cwd: string, target: string, ignore: readonly RegExp[], out: string[]): void {
  const abs = path.resolve(cwd, target)
  const rel = path.relative(cwd, abs).split(path.sep).join("/")
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new CliError(`${target} is outside the project`)
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(abs)
  } catch {
    throw new CliError(`not found: ${target}`)
  }
  if (stat.isFile()) {
    if (!EXTENSIONS.test(abs))
      throw new CliError(`${target} is not a file type validate reads (${EXTENSIONS.source})`)
    out.push(rel)
    return
  }
  for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (DEFAULT_IGNORED_DIRS.includes(entry.name) || matchesAny(`${childRel}/`, ignore)) continue
      collect(cwd, childRel, ignore, out)
    } else if (
      entry.isFile() &&
      EXTENSIONS.test(entry.name) &&
      !/\.d\.ts$/i.test(entry.name) &&
      !matchesAny(childRel, ignore)
    )
      out.push(childRel)
    if (out.length > MAX_FILES)
      throw new CliError(`more than ${MAX_FILES} files; narrow the paths or add validation.ignore`)
  }
}

/** `invariant validate <paths...>`: checks application code against the compiled contract. */
export async function validate(c: Context): Promise<number> {
  const targets = c.args.positionals.slice(1)
  if (targets.length === 0)
    throw new CliError(
      `usage: ${CLI_NAME} validate <path...> [--format text|json|github|sarif] [--fail-on error|warning|never]. To check the compiled output itself, use \`${CLI_NAME} verify\`.`
    )
  const format = c.args.values.format ?? "text"
  if (!(FORMATS as readonly string[]).includes(format))
    throw new CliError(`--format must be one of ${FORMATS.join(", ")}`)
  const framework = c.args.values.framework
  if (framework && !FRAMEWORKS.includes(framework))
    throw new CliError(`--framework must be one of ${FRAMEWORKS.join(", ")}`)
  const loaded = await loadConfig({
    cwd: c.cwd,
    file: c.args.values.config,
    trustConfig: c.args.values["trust-config"] === true
  })
  const failOn = c.args.values["fail-on"] ?? loaded?.config.validation?.failOn ?? "error"
  if (!FAIL_ON.includes(failOn)) throw new CliError(`--fail-on must be one of ${FAIL_ON.join(", ")}`)

  const { contract, evidence } = loadCompiled(await outputDir(c))
  const ds = new DesignSystem(contract, evidence)
  const files: string[] = []
  const ignore = (loaded?.config.validation?.ignore ?? []).map((g) => globToRegExp(g))
  for (const t of targets) collect(c.cwd, t, ignore, files)
  const unique = [...new Set(files)].sort()
  const rules = (loaded?.config.validation?.rules ?? {}) as RuleOverrides

  const violations: Violation[] = []
  const checked = new Set<string>()
  for (const file of unique) {
    const code = readFileSync(path.resolve(c.cwd, file), "utf8")
    const result = validateCode(
      ds,
      { code, filename: file, framework: (framework as CodeFramework | undefined) ?? frameworkFor(file) },
      { rules }
    )
    for (const id of result.summary.componentsChecked) checked.add(id)
    for (const f of result.findings) violations.push({ ...f, file })
  }
  const summary = summarize(violations, unique.length, checked.size)

  if (format === "json") json(c, toJson(violations, summary, contract.integrity.contentHash))
  else if (format === "sarif") json(c, toSarif(violations, { name: CLI_NAME, version: CLI_VERSION }))
  else if (format === "github") {
    const lines = formatGithub(violations)
    if (lines !== "") print(c, lines)
    print(
      c,
      `${summary.errors} errors, ${summary.warnings} warnings, ${summary.info} info in ${summary.files} files`
    )
  } else print(c, formatText(violations, summary))
  return shouldFail(summary, failOn as FailOn) ? 1 : 0
}

/** `invariant rules`: the rules `validate` applies. */
export async function rules(c: Context): Promise<number> {
  if (c.args.values.json) {
    json(c, RULES)
    return 0
  }
  print(
    c,
    table(
      ["rule", "default", "origin", "plan rule", "title"],
      RULES.map((r) => [r.code, r.severity, r.origin, r.plan, r.title])
    )
  )
  print(
    c,
    "\nOverride severity (or turn a rule off) with validation.rules in invariant.config.json. Policy rules take their severity from the approved policy."
  )
  return 0
}
