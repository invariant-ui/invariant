import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { PATTERNS_FILE } from "@invariant/governance"
import type { CandidatesFile } from "@invariant/validation"
import { BASELINE_FILE } from "./baseline.js"
import { run } from "./cli.js"
import { type Context, outputDir, print } from "./commands.js"
import { CONFIG_FILE, loadConfig } from "./config.js"
import { CliError } from "./errors.js"
import { loadCompiled } from "./store.js"
import { CLI_NAME } from "./version.js"
import { WORKFLOW_PATH, workflowYaml } from "./workflow.js"

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

/** `invariant setup`: init, compile, confirm, discover, approve, connect, baseline. One command, a few questions. */
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

  // 1. Detect and compile.
  const configPath = path.resolve(c.cwd, c.args.values.config ?? CONFIG_FILE)
  if (!existsSync(configPath)) {
    const r = await sub("init")
    if (r.code !== 0) throw new CliError(r.err.trim() || "init failed", r.code)
    say(`1. detected sources\n${r.out.trim().split("\n").slice(1).join("\n")}`)
  } else say(`1. using ${path.basename(configPath)}`)
  const compiled = await sub("compile")
  const dir = await outputDir(c)
  if (!existsSync(path.join(dir, "invariant.contract.json")))
    throw new CliError(`compile did not produce a contract.\n${(compiled.err || compiled.out).trim()}`, 1)
  const { contract } = loadCompiled(dir)
  const names = contract.components.map((x) => x.name)
  say(
    `2. compiled: ${contract.components.length} components${names.length > 0 ? ` (${names.slice(0, 6).join(", ")}${names.length > 6 ? `, +${names.length - 6} more` : ""})` : ""}, ${contract.tokens.length} tokens, ${contract.conflicts.length} conflicts${compiled.code === 1 ? "\n   compile reported errors; see invariant/invariant.diagnostics.json" : ""}`
  )

  // 2. A person confirms the contract. Nothing is approved before this.
  const by = whoIs(c)
  let confirmed = c.args.values["confirm-contract"] === true
  if (!confirmed) {
    const a = await ask("   Does this look like your design system?", false)
    confirmed = a === true
  }
  if (confirmed && !by)
    throw new CliError(
      "say who is confirming: --as <name> (or set INVARIANT_USER). Names are recorded, not authenticated."
    )
  say(
    confirmed
      ? `   contract confirmed by ${by}. Patterns added below can be approved.`
      : "   contract not confirmed, so nothing will be approved. Patterns are added as proposals only."
  )

  // 3. Propose patterns from the app code.
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
  const holdsDesignSystem = (d: string): boolean => implFiles.some((f) => f.startsWith(`${d}/`))
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
  const promoted: string[] = []
  if (appPaths.length === 0)
    say(
      "3. no application folder found (looked for src, app, pages, apps). Pass --paths a,b to look elsewhere."
    )
  else {
    const found = await sub("discover", ...appPaths, "--json")
    let top: CandidatesFile["candidates"] = []
    if (found.code === 0) {
      const file = JSON.parse(found.out) as CandidatesFile
      top = file.candidates
        .filter((x) => x.status === "proposed" && x.subsumedBy === undefined)
        .sort((a, b) => b.support.files - a.support.files || (a.id < b.id ? -1 : 1))
        .slice(0, TOP)
    } else say(`3. discovery failed: ${found.err.trim()}`)
    if (found.code === 0 && top.length === 0)
      say(`3. looked in ${appPaths.join(", ")}: no structure recurs often enough to propose (needs 3 files).`)
    if (top.length > 0) {
      say(`3. found ${top.length} recurring structure(s) in ${appPaths.join(", ")}:`)
      for (const [i, x] of top.entries()) say(`   ${i + 1}. ${x.suggestedName}  (${x.support.files} files)`)
      let chosen = top
      if (!yes) {
        if (!c.io.prompt) {
          say("   not asking (no terminal). Re-run with --yes to add them.")
          chosen = []
        } else {
          const a = (
            (await c.io.prompt(
              "   Add them as patterns? Enter for all, numbers to skip (like 2,3), n for none: "
            )) ?? ""
          )
            .trim()
            .toLowerCase()
          if (a === "n" || a === "no") chosen = []
          else if (a !== "") {
            const skip = new Set(a.split(/[,\s]+/).map((n) => Number(n) - 1))
            chosen = top.filter((_, i) => !skip.has(i))
          }
        }
      }
      if (chosen.length > 0) {
        if (!by)
          throw new CliError(
            "say who is deciding: --as <name> (or set INVARIANT_USER). Names are recorded, not authenticated."
          )
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
          if (p.code === 0) promoted.push(id)
          else say(`   skipped ${x.suggestedName}: ${(p.err || p.out).trim().split("\n")[0]}`)
        }
      }
    }
  }

  // 4. Approve, only when the contract was confirmed and the person agrees.
  let approved = 0
  if (promoted.length > 0) {
    let go = false
    if (confirmed) {
      const a = c.args.values["confirm-contract"]
        ? true
        : await ask(`4. Approve ${promoted.length} pattern(s) as ${by}?`, true)
      go = a === true
    }
    if (go && by) {
      const file = path.resolve(c.cwd, PATTERNS_FILE)
      const doc = JSON.parse(readFileSync(file, "utf8")) as { patterns: Array<Record<string, unknown>> }
      const at = c.io.clock()
      for (const p of doc.patterns)
        if (typeof p.id === "string" && promoted.includes(p.id) && p.approval === undefined) {
          p.approval = {
            approvedBy: by,
            approvedAt: at,
            reference: `invariant setup, contract confirmed by ${by}`
          }
          approved++
        }
      writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`)
    }
    const r = await sub("compile")
    say(
      approved > 0
        ? `   ${approved} pattern(s) approved by ${by}. They guide agents. Nothing is enforced until you add rules.`
        : `   ${promoted.length} pattern(s) added as proposals (not approved). Approve them with \`${CLI_NAME} review\` after you have read them.${r.code === 1 ? " Compile reported errors." : ""}`
    )
  }

  // 5. Connect the AI tools found here.
  if (c.args.values["no-agent"]) say("5. skipped agent setup (--no-agent)")
  else {
    const clients = CLIENT_DIRS.filter(([d]) => existsSync(path.join(c.cwd, d))).map(([, n]) => n)
    if (clients.length === 0)
      say(
        `5. no AI tool detected here. Run \`${CLI_NAME} agent init <claude-code|cursor|codex|windsurf>\` when you use one.`
      )
    else {
      for (const client of clients) {
        const r = await sub("agent", "init", client)
        say(
          r.code === 0
            ? `5. connected ${client}`
            : `5. could not connect ${client}: ${(r.err || r.out).trim().split("\n")[0]}`
        )
      }
    }
  }

  // 6. Baseline, so day one reports only new violations.
  if (appPaths.length > 0 && !existsSync(path.join(c.cwd, BASELINE_FILE))) {
    const r = await sub("validate", ...appPaths, "--format", "json", "--no-baseline")
    let count = 0
    try {
      count = (JSON.parse(r.out) as { violations: unknown[] }).violations.length
    } catch {
      count = 0
    }
    if (count > 0) {
      const a = yes
        ? true
        : await ask(`6. ${count} existing violation(s) found. Hide them so only new ones fail?`, true)
      if (a === true) {
        const w = await sub("validate", ...appPaths, "--update-baseline")
        say(`   ${w.out.trim().split("\n")[0]}`)
      } else
        say(
          `6. ${count} existing violation(s) found, not hidden. Run \`${CLI_NAME} validate ${appPaths.join(" ")} --update-baseline\` to hide them.`
        )
    } else say("6. validate found no violations.")
  }

  // 7. Offer a GitHub Action that checks every commit on a pull request.
  const workflowFile = path.join(c.cwd, WORKFLOW_PATH)
  const wantsCi = c.args.values.ci === true
  const offerCi =
    c.args.values["no-ci"] !== true &&
    (wantsCi || existsSync(path.join(c.cwd, ".git")) || existsSync(path.join(c.cwd, ".github")))
  let ciAdded = false
  if (offerCi) {
    if (existsSync(workflowFile)) say(`7. ${WORKFLOW_PATH} already exists, so it was left alone.`)
    else {
      const a =
        wantsCi || yes
          ? true
          : await ask("7. Add a GitHub Action that checks every commit on pull requests?", true)
      if (a === true) {
        mkdirSync(path.dirname(workflowFile), { recursive: true })
        writeFileSync(workflowFile, workflowYaml(appPaths))
        ciAdded = true
        say(
          `7. wrote ${WORKFLOW_PATH}. Commit it with the ${path.relative(c.cwd, dir) || "invariant"}/ folder, so CI has a contract to check against.`
        )
      } else if (a === false) say("7. no workflow added. Re-run with --ci, or copy the job from the docs.")
    }
  }
  const hasCi = ciAdded || existsSync(workflowFile)

  say()
  say(`done in ${Math.max(1, Math.round((Date.now() - started) / 1000))}s.${hasCi ? "" : " Add this to CI:"}`)
  if (hasCi) say(`CI: ${WORKFLOW_PATH} checks every pull request commit.`)
  else
    say(
      `  ${CLI_NAME} verify --fresh && ${CLI_NAME} validate ${appPaths.length > 0 ? appPaths.join(" ") : "src/"}`
    )
  say(`Review what was set up: ${CLI_NAME} patterns list`)
  return 0
}
