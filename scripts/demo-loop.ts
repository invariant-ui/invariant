import { spawn } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The enforcement loop, scripted: an agent builds a settings page with a delete button and gets blocked three
 * times (a prop value outside the contract, a hardcoded color, a pattern violation) before a clean write passes.
 * Every check is the real `invariant hook` process fed a Claude Code payload on stdin; nothing is mocked.
 * Shared by `pnpm demo` and the e2e test so the two cannot drift.
 */
export const root = fileURLToPath(new URL("..", import.meta.url))
const main = path.join(root, "apps/cli/dist/main.js")
export const PAGE = "app/pages/Settings.tsx"
const SESSION = "demo-session"

const IMPORTS = `import { Button, Card, Modal, Stack } from "@acme/ui"\n`
const page = (button: string, modal: string): string => `${IMPORTS}
export const Settings = () => (
  <Stack>
    <Card>
      <Card.Header title="Settings" />
      <Card.Body>
        ${button}
      </Card.Body>
    </Card>
    ${modal}
  </Stack>
)
`
const CONFIRM = `<Modal open title="Delete account?">\n      <Button variant="primary">Confirm</Button>\n    </Modal>`

export interface Attempt {
  /** What the agent is trying to do, for the transcript. */
  intent: string
  code: string
}

/** The agent's four tries, in order. The first three break the contract in three different ways. */
export const ATTEMPTS: readonly Attempt[] = [
  {
    intent: "first try: a danger-styled delete button",
    code: page(`<Button variant="danger">Delete account</Button>`, CONFIRM)
  },
  {
    intent: "second try: a primary button, painted red by hand",
    code: page(`<Button variant="primary" style={{ background: "#ff0000" }}>Delete account</Button>`, CONFIRM)
  },
  {
    intent: "third try: tokens only, but the confirmation dialog has no button",
    code: page(
      `<Button variant="primary">Delete account</Button>`,
      `<Modal open title="Delete account?">Are you sure?</Modal>`
    )
  },
  {
    intent: "fourth try: a confirm button inside the dialog",
    code: page(`<Button variant="primary">Delete account</Button>`, CONFIRM)
  }
]

export interface Step {
  intent: string
  /** The write was denied before it landed. */
  blocked: boolean
  /** The card the agent read: the deny reason, or the post-write report or confirmation. */
  card: string
}

export interface Outcome {
  dir: string
  steps: Step[]
  /** `invariant enforcement report`, as text. */
  report: string
}

interface Ran {
  code: number | null
  out: string
  err: string
}

function exec(cwd: string, argv: string[], stdin?: string): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [main, ...argv], { cwd, env: { ...process.env, CLAUDE_PROJECT_DIR: cwd } })
    let out = ""
    let err = ""
    child.stdout.on("data", (c) => {
      out += String(c)
    })
    child.stderr.on("data", (c) => {
      err += String(c)
    })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, out, err }))
    child.stdin.end(stdin ?? "")
  })
}

const payload = (dir: string, event: "PreToolUse" | "PostToolUse", content: string): string =>
  JSON.stringify({
    session_id: SESSION,
    hook_event_name: event,
    tool_name: "Write",
    cwd: dir,
    tool_input: { file_path: path.join(dir, PAGE), content }
  })

/** A project with the design system compiled, the settings-page pattern approved, and colors enforced as errors. */
export async function prepare(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "invariant-demo-"))
  cpSync(path.join(root, "fixtures/storybook/acme-ui"), dir, {
    recursive: true,
    filter: (s) => !s.includes("storybook-static")
  })
  // The component library has no color tokens of its own; the Acme token package supplies the palette.
  cpSync(path.join(root, "fixtures/monorepo/acme/packages/tokens"), path.join(dir, "packages/tokens"), {
    recursive: true
  })
  cpSync(
    path.join(root, "fixtures/pattern-validation/invariant.patterns.json"),
    path.join(dir, "invariant.patterns.json")
  )
  for (const step of [["init"], ["compile"]]) {
    const r = await exec(dir, step)
    if (r.code !== 0) throw new Error(`invariant ${step.join(" ")} failed: ${r.err || r.out}`)
  }
  const file = path.join(dir, "invariant.config.json")
  const config = JSON.parse(readFileSync(file, "utf8"))
  // The starter rules ship as warnings; this team has decided a hardcoded color is an error.
  config.validation = { ...config.validation, rules: { "color-not-in-tokens": "error" } }
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
  return dir
}

const reasonOf = (out: string): string | undefined => {
  if (!out.trim()) return undefined
  const json = JSON.parse(out)
  return json.hookSpecificOutput?.permissionDecisionReason ?? json.reason ?? json.systemMessage
}

/** Plays the agent's tries against the hook, the way Claude Code would: Pre, then the write, then Post. */
export async function playLoop(dir: string): Promise<Outcome> {
  const steps: Step[] = []
  for (const attempt of ATTEMPTS) {
    const pre = await exec(dir, ["hook"], payload(dir, "PreToolUse", attempt.code))
    const denied = reasonOf(pre.out)
    if (denied) {
      steps.push({ intent: attempt.intent, blocked: true, card: denied })
      continue
    }
    mkdirSync(path.dirname(path.join(dir, PAGE)), { recursive: true })
    writeFileSync(path.join(dir, PAGE), attempt.code)
    const post = await exec(dir, ["hook"], payload(dir, "PostToolUse", attempt.code))
    steps.push({ intent: attempt.intent, blocked: false, card: reasonOf(post.out) ?? "" })
  }
  const report = await exec(dir, ["enforcement", "report"])
  return { dir, steps, report: report.out }
}
