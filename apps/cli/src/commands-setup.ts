import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { PATTERNS_FILE } from "@invariant/governance"
import type { CandidatesFile } from "@invariant/validation"
import { BASELINE_FILE } from "./baseline.js"
import { run } from "./cli.js"
import { type Context, outputDir, print } from "./commands.js"
import { CONFIG_FILE, detectConfig, type InvariantConfig, loadConfig, writeConfig } from "./config.js"
import { CliError } from "./errors.js"
import { applyPublish, planPublish } from "./publish.js"
import { type StarterRule, starterRules } from "./starter-rules.js"
import { loadCompiled } from "./store.js"
import { CLI_NAME } from "./version.js"
import { installStepsFor, WORKFLOW_PATH, workflowYaml } from "./workflow.js"

const TOP = 5
const APP_DIRS = ["src", "app", "pages", "apps"]
const CLIENT_DIRS: Array<[string, string]> = [
  [".claude", "claude-code"],
  [".cursor", "cursor"],
  [".codex", "codex"],
  [".windsurf", "windsurf"]
]

interface Ran {
  code: number
  out: string
  err: string
}

/** The person setting this up: --as, INVARIANT_USER, else git's user.name. Recorded, not authenticated. */
function whoIs(c: Context): string | undefined {
  const given = c.args.values.as ?? c.io.env?.INVARIANT_USER
  if (given && given.trim() !== "") return given.trim()
  try {
    const name = execFileSync("git", ["config", "user.name"], {
      cwd: c.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim()
    return name === "" ? undefined : name
  } catch {
    return undefined
  }
}

const slugId = (name: string): string =>
  `composition.${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)}`.replace(/\.$/, ".pattern")

/** Folders under node_modules that ship a compiled contract (`<package>/invariant/invariant.contract.json`). */
function shippedContracts(cwd: string): string[] {
  const modules = path.join(cwd, "node_modules")
  if (!existsSync(modules)) return []
  const found: string[] = []
  const check = (rel: string): void => {
    if (existsSync(path.join(cwd, rel, "invariant", "invariant.contract.json")))
      found.push(`${rel}/invariant`)
  }
  for (const name of readdirSync(modules).sort()) {
    if (name.startsWith(".")) continue
    if (name.startsWith("@")) {
      for (const inner of readdirSync(path.join(modules, name)).sort()) check(`node_modules/${name}/${inner}`)
    } else check(`node_modules/${name}`)
  }
  return found
}

/**
 * `invariant setup`: compile, look at the app code, then show one plan and ask once. Yes confirms the contract and does
 * everything in the plan; n stops; c asks about each step. Approval only ever follows a confirmed contract.
 */
export async function setup(c: Context): Promise<number> {
  const started = Date.now()
  const say = (m = ""): void => print(c, m)
  const yes = c.args.values.yes === true
  const carry = [
    ...(c.args.values.config ? ["--config", c.args.values.config] : []),
    ...(c.args.values.dir ? ["--dir", c.args.values.dir] : []),
    ...(c.args.values["trust-config"] ? ["--trust-config"] : [])
  ]
  const sub = async (...argv: string[]): Promise<Ran> => {
    let out = ""
    let err = ""
    const code = await run([...argv, ...carry], {
      ...c.io,
      cwd: c.cwd,
      stdout: (t) => {
        out += t
      },
      stderr: (t) => {
        err += t
      }
    })
    return { code, out, err }
  }
  /** true or false when someone answered or --yes decided; undefined when there is no one to ask. */
  const ask = async (question: string, byDefault: boolean): Promise<boolean | undefined> => {
    if (!c.io.prompt) return undefined
    const a = (await c.io.prompt(`${question} ${byDefault ? "[Y/n]" : "[y/N]"} `))?.trim().toLowerCase()
    if (a === undefined || a === "") return byDefault
    return a.startsWith("y")
  }

  say(`${CLI_NAME} setup`)

  // 1. Detect and compile. A project with no design-system sources of its own uses the contract its library ships.
  const configPath = path.resolve(c.cwd, c.args.values.config ?? CONFIG_FILE)
  let consumer = false
  if (!existsSync(configPath)) {
    const detected = c.args.values.contract ? undefined : await detectConfig(c.cwd)
    if (detected && detected.sources.length > 0) {
      const r = await sub("init")
      if (r.code !== 0) throw new CliError(r.err.trim() || "init failed", r.code)
      say(`1. detected sources\n${r.out.trim().split("\n").slice(1).join("\n")}`)
    } else {
      consumer = true
      let from = c.args.values.contract?.replace(/\\/g, "/").replace(/\/+$/, "")
      if (!from) {
        const found = shippedContracts(c.cwd)
        if (found.length === 0)
          throw new CliError(
            "no design system source found here, and no installed package ships a contract (no node_modules/<package>/invariant/). Install your design system package, pass --contract <folder>, or run setup in the design system's own repository."
          )
        if (found.length === 1) from = found[0]
        else {
          const list = found.map((f, i) => `   ${i + 1}. ${f}`).join("\n")
          const pick = c.io.prompt
            ? Number(
                (await c.io.prompt(
                  `1. Several contracts are installed:\n${list}\n   Which one? [1-${found.length}] `
                )) ?? ""
              )
            : Number.NaN
          if (!Number.isInteger(pick) || pick < 1 || pick > found.length)
            throw new CliError(
              `several installed packages ship a contract, so say which: --contract <folder>\n${list}`
            )
          from = found[pick - 1]
        }
      }
      if (!from) throw new CliError("--contract needs a folder")
      const base = loadCompiled(path.resolve(c.cwd, from))
      const config: InvariantConfig = {
        name: base.contract.metadata.name,
        sources: [],
        extends: { contract: from }
      }
      writeConfig(configPath, config)
      say(
        `1. no design system source here. Using the contract shipped in ${from} (${base.contract.metadata.name}, ${base.contract.components.length} components) and wrote ${path.basename(configPath)}.`
      )
    }
  } else {
    const existing = (
      await loadConfig({
        cwd: c.cwd,
        file: c.args.values.config,
        trustConfig: c.args.values["trust-config"] === true
      })
    )?.config
    consumer = existing?.extends !== undefined
    say(`1. using ${path.basename(configPath)}${consumer ? ` (extends ${existing?.extends?.contract})` : ""}`)
  }
  const compiled = await sub("compile")
  const dir = await outputDir(c)
  if (!existsSync(path.join(dir, "invariant.contract.json")))
    throw new CliError(`compile did not produce a contract.\n${(compiled.err || compiled.out).trim()}`, 1)
  const { contract } = loadCompiled(dir)
  const names = contract.components.map((x) => x.name)
  say(
    `2. ${consumer ? "compiled with your own patterns on top" : "compiled"}: ${contract.components.length} components${names.length > 0 ? ` (${names.slice(0, 6).join(", ")}${names.length > 6 ? `, +${names.length - 6} more` : ""})` : ""}, ${contract.tokens.length} tokens, ${contract.conflicts.length} conflicts${compiled.code === 1 ? "\n   compile reported errors; see invariant/invariant.diagnostics.json" : ""}`
  )

  // 2. Gather everything the plan needs. Nothing here changes the project except the compile output and the candidates file.
  const by = whoIs(c)
  const config = (
    await loadConfig({
      cwd: c.cwd,
      file: c.args.values.config,
      trustConfig: c.args.values["trust-config"] === true
    })
  )?.config
  const sourcePaths = (config?.sources ?? [])
    .map((s) => ("path" in s && typeof s.path === "string" ? s.path.replace(/^\.\//, "") : ""))
    .filter((p) => p !== "" && p !== ".")
  const isDir = (p: string): boolean =>
    existsSync(path.join(c.cwd, p)) && statSync(path.join(c.cwd, p)).isDirectory()
  // A folder that holds the design system's own component files is the design system, not an application.
  const implFiles = contract.components.flatMap((x) =>
    x.implementations.flatMap((i) => {
      const file = (i.extensions as { react?: { file?: unknown } } | undefined)?.react?.file
      return typeof file === "string" ? sourcePaths.map((p) => `${p}/${file}`).concat(file) : []
    })
  )
  const holdsDesignSystem = (d: string): boolean => !consumer && implFiles.some((f) => f.startsWith(`${d}/`))
  const skipped: string[] = []
  const appPaths = c.args.values.paths
    ? c.args.values.paths
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
    : APP_DIRS.filter((d) => {
        if (!isDir(d) || sourcePaths.some((s) => s === d)) return false
        if (!holdsDesignSystem(d)) return true
        skipped.push(d)
        return false
      })
  if (skipped.length > 0) say(`   skipped ${skipped.join(", ")}: it holds the design system's own components`)

  type Cand = CandidatesFile["candidates"][number]
  let top: Cand[] = []
  if (appPaths.length === 0)
    say(
      "3. no application folder found (looked for src, app, pages, apps). Pass --paths a,b to look elsewhere."
    )
  else {
    const found = await sub("discover", ...appPaths, "--json")
    if (found.code === 0) {
      const file = JSON.parse(found.out) as CandidatesFile
      top = file.candidates
        .filter((x) => x.status === "proposed" && x.subsumedBy === undefined)
        .sort((a, b) => b.support.files - a.support.files || (a.id < b.id ? -1 : 1))
        .slice(0, TOP)
      if (top.length === 0)
        say(
          `3. looked in ${appPaths.join(", ")}: no structure recurs often enough to propose (needs 3 files).`
        )
      else {
        say(`3. found ${top.length} recurring structure(s) in ${appPaths.join(", ")}:`)
        for (const [i, x] of top.entries()) say(`   ${i + 1}. ${x.suggestedName}  (${x.support.files} files)`)
      }
    } else say(`3. discovery failed: ${found.err.trim()}`)
  }
  const rulesFor = (x: Cand): StarterRule[] => starterRules(x.structure.tree)
  const countViolations = async (): Promise<number> => {
    if (appPaths.length === 0) return 0
    const r = await sub("validate", ...appPaths, "--format", "json", "--no-baseline")
    try {
      return (JSON.parse(r.out) as { violations: unknown[] }).violations.length
    } catch {
      return 0
    }
  }
  const baselineWanted = appPaths.length > 0 && !existsSync(path.join(c.cwd, BASELINE_FILE))
  const existingViolations =
    baselineWanted && c.args.values["no-baseline"] !== true ? await countViolations() : 0
  const clients =
    c.args.values["no-agent"] === true
      ? []
      : CLIENT_DIRS.filter(([d]) => existsSync(path.join(c.cwd, d))).map(([, n]) => n)
  const workflowFile = path.join(c.cwd, WORKFLOW_PATH)
  const wantsCi = c.args.values.ci === true
  const ciPossible =
    c.args.values["no-ci"] !== true &&
    !existsSync(workflowFile) &&
    (wantsCi || existsSync(path.join(c.cwd, ".git")) || existsSync(path.join(c.cwd, ".github")))
  if (existsSync(workflowFile) && c.args.values["no-ci"] !== true)
    say(`   ${WORKFLOW_PATH} already exists, so it will be left alone.`)
  const publishFinding =
    consumer || c.args.values["no-publish"] === true || !config
      ? undefined
      : planPublish(c.cwd, config, path.relative(c.cwd, dir) || "invariant")
  const publish = publishFinding?.ok ? publishFinding.plan : undefined
  const publishNeeded = publish !== undefined && !(publish.hasFiles && publish.hasPrepack)
  if (publishFinding && !publishFinding.ok) say(`   not wiring publishing: ${publishFinding.reason}.`)

  // 3. One plan, one question.
  const noRules = c.args.values["no-rules"] === true
  const ruleCount = noRules ? 0 : top.reduce((n, x) => n + rulesFor(x).length, 0)
  const planLines = (approving: boolean): string[] => [
    ...(top.length > 0
      ? [
          approving
            ? `add ${top.length} recurring pattern(s) from ${appPaths.join(", ")}, approved by ${by ?? "you"}`
            : `add ${top.length} recurring pattern(s) from ${appPaths.join(", ")} as proposals (not approved)`
        ]
      : []),
    ...(approving && ruleCount > 0
      ? [
          `turn on ${ruleCount} starter rule(s) as warnings: they flag new code, and existing code is hidden by the baseline`
        ]
      : []),
    ...(existingViolations > 0
      ? [`hide ${existingViolations} existing violation(s) so only new ones are flagged`]
      : []),
    ...(clients.length > 0 ? [`connect ${clients.join(", ")}`] : []),
    ...(ciPossible ? [`add ${WORKFLOW_PATH}, which checks every pull request commit`] : []),
    ...(publishNeeded && publish
      ? [`publish the contract with ${publish.name} (adds "invariant" to files and a prepack script)`]
      : [])
  ]

  type Mode = "quick" | "custom" | "none" | "stop"
  let mode: Mode
  let confirmed = false
  if (c.args.values["confirm-contract"] === true) {
    mode = "quick"
    confirmed = true
  } else if (yes) mode = "quick"
  else if (c.io.prompt) {
    const lines = planLines(true)
    say()
    say("Plan. Yes confirms the contract above is right, and does all of this:")
    if (lines.length === 0) say("  (nothing else to do)")
    for (const l of lines) say(`  - ${l}`)
    const a = ((await c.io.prompt("Looks right? [Y/n, or c to choose each step] ")) ?? "")
      .trim()
      .toLowerCase()
    if (a === "c") mode = "custom"
    else if (a === "" || a.startsWith("y")) {
      mode = "quick"
      confirmed = true
    } else mode = "stop"
  } else mode = "none"

  if (mode === "stop") {
    say()
    say(
      `Stopped. Nothing was approved or added. The contract is compiled in ${path.relative(c.cwd, dir) || "."}/. If it looks wrong, check ${path.basename(configPath)} (or pass --paths, --contract) and run ${CLI_NAME} setup again.`
    )
    return 0
  }
  if (mode === "none") {
    say()
    say(
      `not asking (no terminal). Nothing was added. Re-run with --yes to add proposals, or --confirm-contract --as <name> once you have checked the contract above.`
    )
    return 0
  }

  // Decisions. Quick takes the plan. Custom asks about each step, as setup used to.
  let chosen: Cand[] = top
  let approve = false
  let withRules = false
  let wantAgents = clients.length > 0
  let wantBaseline = existingViolations > 0
  let wantCi = ciPossible
  let wantPublish = publishNeeded
  if (mode === "quick") {
    approve = confirmed
    withRules = confirmed && !noRules
  } else {
    confirmed = (await ask("   Does this look like your design system?", false)) === true
    if (top.length > 0 && c.io.prompt) {
      const a = (
        (await c.io.prompt("   Add the patterns? Enter for all, numbers to skip (like 2,3), n for none: ")) ??
        ""
      )
        .trim()
        .toLowerCase()
      if (a === "n" || a === "no") chosen = []
      else if (a !== "") {
        const skip = new Set(a.split(/[,\s]+/).map((n) => Number(n) - 1))
        chosen = top.filter((_, i) => !skip.has(i))
      }
    }
    if (chosen.length > 0 && confirmed)
      approve = (await ask(`   Approve ${chosen.length} pattern(s) as ${by}?`, true)) === true
    const n = chosen.reduce((m, x) => m + rulesFor(x).length, 0)
    if (approve && n > 0 && !noRules)
      withRules = (await ask(`   Turn on ${n} starter rule(s) as warnings?`, true)) === true
    if (clients.length > 0) wantAgents = (await ask(`   Connect ${clients.join(", ")}?`, true)) === true
    if (existingViolations > 0)
      wantBaseline =
        (await ask(
          `   Hide ${existingViolations} existing violation(s) so only new ones are flagged?`,
          true
        )) === true
    if (ciPossible)
      wantCi =
        wantsCi ||
        (await ask("   Add a GitHub Action that checks every commit on pull requests?", true)) === true
    if (publishNeeded && publish)
      wantPublish = (await ask(`   Add the contract to what ${publish.name} publishes?`, true)) === true
  }
  if ((confirmed || chosen.length > 0) && !by)
    throw new CliError(
      "say who is deciding: --as <name> (or set INVARIANT_USER). Names are recorded, not authenticated."
    )
  say(
    confirmed
      ? `   contract confirmed by ${by}.`
      : "   contract not confirmed, so nothing is approved and no rule is turned on."
  )

  // 4. Do it.
  const did: string[] = []
  const promoted: Array<{ id: string; cand: Cand }> = []
  if (chosen.length > 0 && by) {
    const taken = new Set<string>()
    const existing = existsSync(path.join(c.cwd, PATTERNS_FILE))
      ? ((
          JSON.parse(readFileSync(path.join(c.cwd, PATTERNS_FILE), "utf8")) as {
            patterns?: Array<{ id?: string }>
          }
        ).patterns ?? [])
      : []
    for (const p of existing) if (p.id) taken.add(p.id.replace(/^pattern:/, ""))
    for (const x of chosen) {
      let id = slugId(x.suggestedName)
      for (let n = 2; taken.has(id); n++) id = `${slugId(x.suggestedName)}-${n}`
      taken.add(id)
      const a = await sub("candidates", "accept", x.id, "--as", by, "--note", "added by invariant setup")
      const p = a.code === 0 ? await sub("candidates", "promote", x.id, "--id", id, "--as", by) : a
      if (p.code === 0) promoted.push({ id, cand: x })
      else say(`   skipped ${x.suggestedName}: ${(p.err || p.out).trim().split("\n")[0]}`)
    }
  }
  let approved = 0
  let rulesOn = 0
  if (promoted.length > 0) {
    const file = path.resolve(c.cwd, PATTERNS_FILE)
    const doc = JSON.parse(readFileSync(file, "utf8")) as { patterns: Array<Record<string, unknown>> }
    const at = c.io.clock()
    const globs = appPaths.map((p) => `${p.replace(/\/+$/, "")}/**`)
    for (const def of doc.patterns) {
      const hit = promoted.find((x) => x.id === def.id)
      if (!hit || def.approval !== undefined || !approve || !by) continue
      def.approval = {
        approvedBy: by,
        approvedAt: at,
        reference: `invariant setup, contract confirmed by ${by}`
      }
      approved++
      const rules = withRules ? rulesFor(hit.cand) : []
      if (rules.length > 0) {
        def.constraints = rules
        def.appliesTo = { paths: globs, frameworks: ["react"] }
        rulesOn += rules.length
      }
    }
    writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`)
    const r = await sub("compile")
    if (r.code === 1)
      say("   compile reported errors after adding patterns; see invariant/invariant.diagnostics.json")
    did.push(
      approved > 0
        ? `patterns   ${approved} approved by ${by}. They guide agents.`
        : `patterns   ${promoted.length} added as proposals (not approved). Approve with \`${CLI_NAME} review\` once you have read them.`
    )
    if (rulesOn > 0) did.push(`rules      ${rulesOn} starter rule(s), as warnings`)
  }

  if (wantAgents)
    for (const client of clients) {
      const r = await sub("agent", "init", client)
      did.push(
        r.code === 0
          ? `agents     connected ${client}`
          : `agents     could not connect ${client}: ${(r.err || r.out).trim().split("\n")[0]}`
      )
    }
  else if (c.args.values["no-agent"] !== true && clients.length === 0)
    did.push(
      `agents     none detected. Run \`${CLI_NAME} agent init <claude-code|cursor|codex|windsurf>\` when you use one.`
    )

  if (baselineWanted && wantBaseline) {
    const count = await countViolations()
    if (count > 0) {
      const w = await sub("validate", ...appPaths, "--update-baseline")
      did.push(
        `baseline   ${
          w.out
            .trim()
            .split("\n")[0]
            ?.replace(/^wrote [^:]+: /, "") ?? ""
        }`
      )
    }
  }

  let ciAdded = false
  if (wantCi) {
    mkdirSync(path.dirname(workflowFile), { recursive: true })
    writeFileSync(
      workflowFile,
      workflowYaml(appPaths, consumer ? installStepsFor((f) => existsSync(path.join(c.cwd, f))) : [])
    )
    ciAdded = true
    did.push(
      `CI         wrote ${WORKFLOW_PATH}. Commit it with the ${path.relative(c.cwd, dir) || "invariant"}/ folder, so CI has a contract to check against.`
    )
  }
  const hasCi = ciAdded || existsSync(workflowFile)

  if (wantPublish && publish) {
    const edits = applyPublish(publish)
    const ignored = [".gitignore", ".npmignore"].filter(
      (f) =>
        existsSync(path.join(c.cwd, f)) &&
        /^\/?invariant\/?$/m.test(readFileSync(path.join(c.cwd, f), "utf8"))
    )
    did.push(
      `publish    ${publish.name}: ${edits.join(" and ") || "already set up"}. Apps that install it can run ${CLI_NAME} setup.${ignored.length > 0 ? ` Warning: ${ignored.join(" and ")} ignores invariant/, so it would not be published.` : ""}`
    )
  }

  say()
  say("Set up:")
  say(
    `  contract   ${contract.components.length} components, ${contract.tokens.length} tokens (${path.relative(c.cwd, dir) || "."}/)`
  )
  for (const l of did) say(`  ${l}`)
  const first =
    promoted.length > 0 && withRules ? rulesFor((promoted[0] as { cand: Cand }).cand)[0] : undefined
  if (first && appPaths.length > 0)
    say(
      `\nSee it work: break this, then run ${CLI_NAME} validate ${appPaths.join(" ")}\n  "${first.description}"`
    )
  say(`\ndone in ${Math.max(1, Math.round((Date.now() - started) / 1000))}s.`)
  if (!hasCi)
    say(
      `Add this to CI: ${CLI_NAME} verify --fresh && ${CLI_NAME} validate ${appPaths.length > 0 ? appPaths.join(" ") : "src/"}`
    )
  say(`Review: ${CLI_NAME} patterns list`)
  return 0
}
