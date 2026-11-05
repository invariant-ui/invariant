import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { globToRegExp } from "@invariant/compiler-core"
import { DesignSystem } from "@invariant/contract-query"
import { PATTERNS_FILE, parsePatterns } from "@invariant/governance"
import {
  applyReviews,
  CANDIDATE_KINDS,
  CANDIDATE_STATUSES,
  CANDIDATES_FILE,
  type Candidate,
  type CandidatesFile,
  candidatesFileSchema,
  DEFAULT_OPTIONS,
  type Decision,
  discover,
  emptyReviews,
  latestReview,
  parseReviews,
  REVIEWS_FILE,
  type ReviewsFile,
  recordReview,
  serializeReviews,
  toDefinition
} from "@invariant/validation"
import { type Context, json, outputDir, print, writableDir } from "./commands.js"
import { collect } from "./commands-validate.js"
import { loadConfig } from "./config.js"
import { CliError } from "./errors.js"
import { table } from "./format.js"
import { loadCompiled } from "./store.js"
import { CLI_NAME } from "./version.js"

const DISCOVER_USAGE = `usage: ${CLI_NAME} discover <path...> [--min-files n] [--min-uses n] [--similarity 0-1] [--depth n] [--json]
Finds structures that recur in your application code and writes them to ${CANDIDATES_FILE} as candidates to review.
Nothing it finds is approved or enforced.`

const CANDIDATES_USAGE = `usage: ${CLI_NAME} candidates <list|show|accept|reject|defer|promote> ...
  candidates list [--status s] [--kind k] [--all]
  candidates show <id>
  candidates accept|reject|defer <id> --as <name> [--note why] [--reference ref]
  candidates promote <id> --id <pattern id> --as <name> [--name n] [--category c] [--dry-run]`

function integer(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max)
    throw new CliError(`--${name} must be a whole number from ${min} to ${max}`)
  return n
}

function similarityOption(value: string | undefined): number {
  if (value === undefined) return DEFAULT_OPTIONS.similarity
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0 || n > 1)
    throw new CliError("--similarity must be a number above 0 and up to 1")
  return n
}

const read = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, "utf8") : undefined)

async function reviewsPath(c: Context): Promise<string> {
  const loaded = await loadConfig({
    cwd: c.cwd,
    file: c.args.values.config,
    trustConfig: c.args.values["trust-config"] === true
  })
  return path.resolve(c.cwd, loaded?.config.governance?.candidateReviewsFile ?? REVIEWS_FILE)
}

function loadReviews(file: string): ReviewsFile | undefined {
  const text = read(file)
  if (text === undefined) return undefined
  const parsed = parseReviews(text, path.basename(file))
  if (!parsed.ok) throw new CliError(parsed.message, 2)
  return parsed.value
}

/** `invariant discover <paths...>`: finds recurring structures and writes them as candidates. */
export async function discoverCommand(c: Context): Promise<number> {
  const targets = c.args.positionals.slice(1)
  if (targets.length === 0) throw new CliError(DISCOVER_USAGE)
  const options = {
    minFiles: integer("min-files", c.args.values["min-files"], DEFAULT_OPTIONS.minFiles, 2, 1000),
    minUses: integer("min-uses", c.args.values["min-uses"], DEFAULT_OPTIONS.minUses, 2, 10000),
    similarity: similarityOption(c.args.values.similarity),
    maxDepth: integer("depth", c.args.values.depth, DEFAULT_OPTIONS.maxDepth, 1, 6)
  }
  const loaded = await loadConfig({
    cwd: c.cwd,
    file: c.args.values.config,
    trustConfig: c.args.values["trust-config"] === true
  })
  const contractFolder = await outputDir(c)
  const dir = await writableDir(c)
  const { contract, evidence } = loadCompiled(contractFolder)
  const ds = new DesignSystem(contract, evidence)
  const ignore = (loaded?.config.validation?.ignore ?? []).map((g) => globToRegExp(g))
  const found: string[] = []
  for (const t of targets) collect(c.cwd, t, ignore, found)
  const files = [...new Set(found)]
    .sort()
    .map((file) => ({ file, code: readFileSync(path.resolve(c.cwd, file), "utf8") }))
  const result = discover({ ds, files, options, reviews: loadReviews(await reviewsPath(c)) })

  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, CANDIDATES_FILE), `${JSON.stringify(result, null, 2)}\n`)
  if (c.args.values.json) json(c, result)
  else print(c, summaryText(result, c.args.values.all === true))
  return 0
}

function summaryText(result: CandidatesFile, all: boolean): string {
  const shown = result.candidates.filter((x) => all || x.subsumedBy === undefined)
  const lines = [
    `${result.summary.filesAnalyzed} of ${result.summary.files} files analyzed, ${result.candidates.length} candidates written to ${CANDIDATES_FILE}`
  ]
  for (const d of result.diagnostics) lines.push(`${d.severity}: ${d.message}`)
  if (shown.length > 0) lines.push("", listTable(shown))
  lines.push(
    "",
    `Candidates are observations, not approved patterns. Review one with \`${CLI_NAME} candidates show <id>\`.`
  )
  return lines.join("\n")
}

const listTable = (candidates: readonly Candidate[]): string =>
  table(
    ["id", "kind", "status", "files", "uses", "name"],
    candidates.map((x) => [
      x.id.replace("candidate:", ""),
      x.kind,
      x.status,
      x.support.files,
      x.support.occurrences,
      x.suggestedName
    ])
  )

/** Candidates as last discovered, with the decisions recorded since applied. */
async function loadCandidates(
  c: Context
): Promise<{ file: CandidatesFile; candidates: Candidate[]; stale: boolean; dir: string }> {
  const dir = await writableDir(c)
  const text = read(path.join(dir, CANDIDATES_FILE))
  if (text === undefined)
    throw new CliError(`no ${CANDIDATES_FILE} in ${dir}. Run \`${CLI_NAME} discover <path...>\` first.`)
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new CliError(`${CANDIDATES_FILE} is not valid JSON; run discover again`, 1)
  }
  const parsed = candidatesFileSchema.safeParse(raw)
  if (!parsed.success)
    throw new CliError(`${CANDIDATES_FILE} does not match its schema; run discover again`, 1)
  const reviews = loadReviews(await reviewsPath(c))
  const applied = applyReviews(
    parsed.data.candidates.map((x) => {
      const { review: _, ...rest } = x
      return { ...rest, status: "proposed" as const }
    }),
    reviews
  )
  let stale = false
  try {
    stale =
      loadCompiled(await outputDir(c)).contract.integrity.contentHash !== parsed.data.contract.contentHash
  } catch {
    stale = false
  }
  return { file: parsed.data, candidates: applied.candidates, stale, dir }
}

function find(candidates: readonly Candidate[], query: string | undefined): Candidate {
  if (!query) throw new CliError(CANDIDATES_USAGE)
  const q = query.replace(/^candidate:/, "")
  const exact = candidates.filter((x) => x.id === `candidate:${q}`)
  const hits =
    exact.length > 0
      ? exact
      : candidates.filter(
          (x) =>
            x.id.replace("candidate:", "").endsWith(q) ||
            x.id.replace("candidate:", "").split(".")[1]?.startsWith(q)
        )
  if (hits.length === 1) return hits[0] as Candidate
  if (hits.length === 0)
    throw new CliError(
      `no candidate matches "${query}". List them with \`${CLI_NAME} candidates list --all\`.`
    )
  throw new CliError(
    `"${query}" matches several candidates: ${hits.map((x) => x.id).join(", ")}. Use the full id.`
  )
}

function show(c: Context, x: Candidate): void {
  if (c.args.values.json) {
    json(c, x)
    return
  }
  print(c, `${x.suggestedName}  (${x.id})`)
  print(c, `kind: ${x.kind}   status: ${x.status}   basis: ${x.basis}   equivalence: ${x.equivalence}`)
  print(c, `found in ${x.support.files} files, ${x.support.occurrences} places`)
  if (x.consistency)
    print(
      c,
      `overlap between files: lowest ${x.consistency.minimumPairwise}, mean ${x.consistency.meanPairwise}`
    )
  if (x.subsumedBy) print(c, `inside a larger candidate: ${x.subsumedBy}`)
  print(c, `\n${x.summary}`)
  print(c, "\nwhy it was found")
  for (const line of x.explanation) print(c, `  ${line}`)
  if (x.structure.common.length > 0) print(c, `\nin every file\n  ${x.structure.common.join("\n  ")}`)
  if (x.structure.frequent.length > 0)
    print(
      c,
      `\nin most files\n  ${x.structure.frequent.map((f) => `${f.feature} (${f.files})`).join("\n  ")}`
    )
  if (x.structure.variable.length > 0)
    print(
      c,
      `\nvaries\n  ${x.structure.variable.map((f) => `${f.feature} (${f.files})`).join("\n  ")}${x.structure.variableTruncated ? "\n  ..." : ""}`
    )
  if (x.kind === "arrangement") print(c, `\nform: ${x.structure.key}`)
  print(
    c,
    `\nevidence${x.evidenceTruncated ? ` (first ${x.evidence.length} of ${x.support.occurrences})` : ""}`
  )
  for (const e of x.evidence) print(c, `  ${e.file}:${e.line}:${e.column}  ${e.detail}`)
  if (x.review)
    print(
      c,
      `\n${x.review.decision} by ${x.review.decidedBy} on ${x.review.decidedAt}${x.review.reason ? `: ${x.review.reason}` : ""}${x.review.promotedTo ? `\npromoted to ${x.review.promotedTo}` : ""}`
    )
  else
    print(
      c,
      `\nNo decision recorded. \`${CLI_NAME} candidates accept ${x.id.replace("candidate:", "")} --as <name>\``
    )
}

async function who(c: Context): Promise<string> {
  const loaded = await loadConfig({
    cwd: c.cwd,
    file: c.args.values.config,
    trustConfig: c.args.values["trust-config"] === true
  })
  const by = c.args.values.as ?? c.io.env?.INVARIANT_USER
  if (!by || by.trim() === "")
    throw new CliError(
      "say who is deciding: --as <name> (or set INVARIANT_USER). Names are recorded, not authenticated."
    )
  const approvers = loaded?.config.governance?.approvers
  if (approvers && approvers.length > 0 && !approvers.includes(by))
    throw new CliError(`"${by}" is not listed in governance.approvers`)
  return by
}

const DECISION_OF: Record<string, Decision> = { accept: "accepted", reject: "rejected", defer: "deferred" }

async function decide(c: Context, sub: string, id: string | undefined): Promise<number> {
  const { candidates } = await loadCandidates(c)
  const x = find(candidates, id)
  const by = await who(c)
  const file = await reviewsPath(c)
  const next = recordReview(loadReviews(file) ?? emptyReviews(), {
    candidate: x.id,
    decision: DECISION_OF[sub] as Decision,
    decidedBy: by,
    decidedAt: c.io.clock(),
    ...(c.args.values.note ? { reason: c.args.values.note } : {}),
    ...(c.args.values.reference ? { reference: c.args.values.reference } : {})
  })
  writeFileSync(file, serializeReviews(next))
  print(
    c,
    `${DECISION_OF[sub]} ${x.id}, recorded in ${path.basename(file)}${sub === "accept" ? `. To add it to your definitions: ${CLI_NAME} candidates promote ${x.id.replace("candidate:", "")} --id <pattern id> --as ${by}` : ""}`
  )
  return 0
}

async function promote(c: Context, id: string | undefined): Promise<number> {
  const { candidates } = await loadCandidates(c)
  const x = find(candidates, id)
  if (x.status !== "accepted")
    throw new CliError(
      `${x.id} is ${x.status}. Accept it first: ${CLI_NAME} candidates accept ${x.id.replace("candidate:", "")} --as <name>`
    )
  const patternId = c.args.values.id
  if (!patternId)
    throw new CliError(
      `give the pattern an id: --id <id>, such as composition.card-with-header\n${CANDIDATES_USAGE}`
    )
  const by = await who(c)
  const loaded = await loadConfig({
    cwd: c.cwd,
    file: c.args.values.config,
    trustConfig: c.args.values["trust-config"] === true
  })
  const patternsFile = path.resolve(c.cwd, loaded?.config.governance?.patternsFile ?? PATTERNS_FILE)
  const text = read(patternsFile)
  let doc: { version?: unknown; patterns?: unknown[]; [k: string]: unknown } = { version: 1, patterns: [] }
  if (text !== undefined) {
    try {
      doc = JSON.parse(text)
    } catch {
      throw new CliError(`${path.basename(patternsFile)} is not valid JSON`, 2)
    }
    if (!Array.isArray(doc.patterns))
      throw new CliError(`${path.basename(patternsFile)} has no "patterns" list`, 2)
  }
  const definition = toDefinition(x, {
    id: patternId,
    name: c.args.values.name,
    category: c.args.values.category
  })
  const bare = (s: string): string => s.replace(/^pattern:/, "")
  if (
    (doc.patterns ?? []).some(
      (p) =>
        typeof (p as { id?: unknown }).id === "string" && bare((p as { id: string }).id) === bare(patternId)
    )
  )
    throw new CliError(`${path.basename(patternsFile)} already has a pattern "${patternId}"`)
  const next = { ...doc, patterns: [...(doc.patterns ?? []), definition] }
  const check = parsePatterns(JSON.stringify(next), path.basename(patternsFile))
  if (!check.ok) throw new CliError(`the definition is not valid: ${check.message}`, 2)
  if (c.args.values["dry-run"]) {
    json(c, definition)
    return 0
  }
  writeFileSync(patternsFile, `${JSON.stringify(next, null, 2)}\n`)
  const reviewFile = await reviewsPath(c)
  const prior = latestReview(loadReviews(reviewFile) ?? emptyReviews(), x.id)
  writeFileSync(
    reviewFile,
    serializeReviews(
      recordReview(loadReviews(reviewFile) ?? emptyReviews(), {
        candidate: x.id,
        decision: "accepted",
        decidedBy: by,
        decidedAt: c.io.clock(),
        ...(prior?.reason ? { reason: prior.reason } : {}),
        ...(prior?.reference ? { reference: prior.reference } : {}),
        promotedTo: patternId
      })
    )
  )
  print(
    c,
    `added ${patternId} to ${path.basename(patternsFile)}. It has no approval, intent or constraints. Run \`${CLI_NAME} compile\`, then approve it with \`${CLI_NAME} review\` or add an approval block, once you have read it.`
  )
  return 0
}

/** `invariant candidates ...`: review what discovery found. */
export async function candidatesCommand(c: Context): Promise<number> {
  const [, sub, id] = c.args.positionals
  if (!sub || !["list", "show", "accept", "reject", "defer", "promote"].includes(sub))
    throw new CliError(CANDIDATES_USAGE)
  if (sub === "accept" || sub === "reject" || sub === "defer") return decide(c, sub, id)
  if (sub === "promote") return promote(c, id)
  const loaded = await loadCandidates(c)
  if (sub === "show") {
    show(c, find(loaded.candidates, id))
    return 0
  }
  const status = c.args.values.status
  if (status && !(CANDIDATE_STATUSES as readonly string[]).includes(status))
    throw new CliError(`--status must be one of: ${CANDIDATE_STATUSES.join(", ")}`)
  const kind = c.args.values.kind
  if (kind && !(CANDIDATE_KINDS as readonly string[]).includes(kind))
    throw new CliError(`--kind must be one of: ${CANDIDATE_KINDS.join(", ")}`)
  const shown = loaded.candidates.filter(
    (x) =>
      (!status || x.status === status) &&
      (!kind || x.kind === kind) &&
      (c.args.values.all || x.subsumedBy === undefined)
  )
  if (c.args.values.json) json(c, shown)
  else {
    if (loaded.stale)
      print(c, `note: the contract has changed since discovery ran. Run \`${CLI_NAME} discover\` again.`)
    print(c, shown.length === 0 ? "no candidates match" : listTable(shown))
  }
  return 0
}
