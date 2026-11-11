import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import type { Readable } from "node:stream"
import { globToRegExp, matchesAny } from "@invariant/compiler-core"
import { DesignSystem } from "@invariant/contract-query"
import {
  enforcementCard,
  passCard,
  type RuleOverrides,
  type Violation,
  validateCode
} from "@invariant/validation"
import { z } from "zod"
import { applyBaseline, BASELINE_FILE, readBaseline } from "./baseline.js"
import type { Context } from "./commands.js"
import { EXTENSIONS, frameworkFor } from "./commands-validate.js"
import { loadConfig, outputDirectory } from "./config.js"
import { appendEvent } from "./enforcement-log.js"
import { CliError } from "./errors.js"
import { loadCompiled } from "./store.js"

/**
 * `invariant hook`: the agent-enforcement entry point. A coding agent (Claude Code today) runs this as a
 * `PreToolUse`/`PostToolUse` hook on Write and Edit, passing the hook payload on stdin. The command validates
 * the file the agent is writing against the compiled contract and answers in the agent's hook format:
 *
 * - `PreToolUse`, posture `gate-errors`: error-severity findings (after the baseline and rule overrides) deny
 *   the write, with the findings as the reason the agent must fix.
 * - `PostToolUse`: findings are reported next to the tool result so the agent can fix them in a follow-up edit,
 *   and a clean pass is confirmed to the person watching.
 *
 * The hook fails open: any problem (no config, no contract, malformed payload, oversized input) is noted on
 * stderr and the write proceeds. Warnings never block a write.
 */

/** Claude Code hook payloads carry the whole file; the MCP line limit is a reasonable ceiling here too. */
const MAX_PAYLOAD_CHARS = 2_000_000
export const POSTURES = ["gate-errors", "warn", "off"] as const
export type Posture = (typeof POSTURES)[number]
export const DEFAULT_POSTURE: Posture = "gate-errors"

const payloadSchema = z.object({
  hook_event_name: z.string(),
  tool_name: z.string(),
  cwd: z.string().optional(),
  session_id: z.string().optional(),
  tool_input: z.object({
    /** Claude Code always expands it to an absolute path before hooks run. */
    file_path: z.string().min(1),
    content: z.string().optional(),
    old_string: z.string().optional(),
    new_string: z.string().optional(),
    replace_all: z.boolean().optional()
  })
})

type Payload = z.infer<typeof payloadSchema>

/**
 * Cursor's `afterFileEdit` payload (cursor.com/docs/hooks): the edit has already landed, so it is treated as a
 * `PostToolUse` on the file. The fields are from the docs; the answer shape in {@link cursorAnswer} is not yet
 * verified against a live Cursor.
 */
const cursorPayloadSchema = z.object({
  hook_event_name: z.string(),
  file_path: z.string().min(1),
  workspace_roots: z.array(z.string()).optional(),
  conversation_id: z.string().optional()
})

const CLIENTS = ["claude-code", "cursor"] as const

function cursorPayload(raw: unknown): Payload | undefined {
  const parsed = cursorPayloadSchema.safeParse(raw)
  if (!parsed.success || parsed.data.hook_event_name !== "afterFileEdit") return undefined
  const root = parsed.data.workspace_roots?.find((r) => parsed.data.file_path.startsWith(r))
  return {
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    ...((root ?? parsed.data.workspace_roots?.[0]) ? { cwd: root ?? parsed.data.workspace_roots?.[0] } : {}),
    ...(parsed.data.conversation_id ? { session_id: parsed.data.conversation_id } : {}),
    tool_input: { file_path: parsed.data.file_path }
  }
}

/** Cursor reads `agent_message` as feedback to the model and `user_message` as text for the person. */
function cursorAnswer(decision: Record<string, unknown>): Record<string, unknown> {
  if (typeof decision.reason === "string") return { agent_message: decision.reason }
  if (typeof decision.systemMessage === "string") return { user_message: decision.systemMessage }
  return {}
}

async function readAll(stream: Readable, max: number): Promise<string> {
  let text = ""
  for await (const chunk of stream) {
    text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    if (text.length > max)
      throw new CliError(`the hook payload is larger than ${max.toLocaleString()} characters`)
  }
  return text
}

/**
 * The content the write would produce. `Write` carries it; `Edit` carries only the change, so the current file
 * is read and the edit applied to reconstruct it. When the edit cannot apply (old text missing or ambiguous),
 * the agent's own Edit call fails anyway and the hook stays silent; `PostToolUse` reads what landed.
 */
function contentFor(
  event: string,
  tool: string,
  input: Payload["tool_input"],
  file: string
): string | undefined {
  if (event === "PostToolUse") {
    try {
      return readFileSync(file, "utf8")
    } catch {
      return undefined
    }
  }
  if (tool === "Write") return input.content
  if (input.old_string === undefined || input.new_string === undefined) return undefined
  let current: string
  try {
    current = readFileSync(file, "utf8")
  } catch {
    return undefined
  }
  const parts = current.split(input.old_string)
  if (parts.length === 1) return undefined
  if (parts.length > 2 && input.replace_all !== true) return undefined
  return parts.join(input.new_string)
}

/** Runs the check and returns the hook's JSON answer, or undefined to stay silent. */
async function decide(c: Context, payload: Payload): Promise<Record<string, unknown> | undefined> {
  const event = payload.hook_event_name
  if (event !== "PreToolUse" && event !== "PostToolUse") return undefined
  if (payload.tool_name !== "Write" && payload.tool_name !== "Edit") return undefined
  const file = payload.tool_input.file_path
  if (!EXTENSIONS.test(file)) return undefined

  // The project is where the session runs: the agent exports CLAUDE_PROJECT_DIR to hooks, the payload carries
  // the working directory, and an explicit --cwd wins for manual runs.
  const root = c.args.values.cwd ? c.cwd : (c.io.env?.CLAUDE_PROJECT_DIR ?? payload.cwd ?? c.cwd)
  const rel = path.relative(root, file)
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined

  const loaded = await loadConfig({ cwd: root, trustConfig: false })
  if (!loaded) {
    if (c.args.values.quiet !== true)
      c.io.stderr(`invariant hook: no invariant.config.json in ${root}; the write proceeds unchecked\n`)
    return undefined
  }
  const ignore = (loaded.config.validation?.ignore ?? []).map((g) => globToRegExp(g))
  if (matchesAny(rel, ignore)) return undefined

  const postureArg = c.args.values.posture
  if (postureArg && !(POSTURES as readonly string[]).includes(postureArg))
    throw new CliError(`--posture must be one of ${POSTURES.join(", ")}`)
  const posture = (postureArg ?? loaded.config.enforcement?.hooks ?? DEFAULT_POSTURE) as Posture
  if (posture === "off") return undefined

  const dir = path.resolve(root, outputDirectory(loaded.config))
  if (!existsSync(path.join(dir, "invariant.contract.json"))) {
    if (c.args.values.quiet !== true)
      c.io.stderr(
        `invariant hook: no compiled contract in ${path.relative(root, dir) || "."}; run \`invariant compile\`. The write proceeds unchecked.\n`
      )
    return undefined
  }
  const { contract, evidence } = loadCompiled(dir)
  const ds = new DesignSystem(contract, evidence)

  const content = contentFor(event, payload.tool_name, payload.tool_input, file)
  if (content === undefined) return undefined

  const rules = (loaded.config.validation?.rules ?? {}) as RuleOverrides
  const result = validateCode(ds, { code: content, filename: rel, framework: frameworkFor(rel) }, { rules })
  let violations: Violation[] = result.findings.map((f) => ({ ...f, file: rel }))

  const baselineFile = path.resolve(root, BASELINE_FILE)
  if (existsSync(baselineFile)) {
    try {
      const baseline = readBaseline(baselineFile)
      if (baseline) violations = applyBaseline(violations, baseline).fresh
    } catch (error) {
      // A broken baseline must not block writes: note it and check without one.
      c.io.stderr(`invariant hook: ${(error as Error).message}\n`)
    }
  }

  const name = contract.metadata.name
  const log = (outcome: "blocked" | "warned" | "passed"): void => {
    try {
      appendEvent(root, {
        time: c.io.clock(),
        session: payload.session_id ?? "unknown",
        file: rel,
        outcome,
        findings: violations,
        checked: result.summary.componentsChecked.length
      })
    } catch (error) {
      c.io.stderr(`invariant hook: could not write the enforcement log: ${(error as Error).message}\n`)
    }
  }
  const more = (n: number): string => `…and ${n} more (run \`invariant validate ${rel}\`)`
  if (event === "PreToolUse") {
    if (posture === "gate-errors" && violations.some((v) => v.severity === "error")) {
      log("blocked")
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: enforcementCard({
            findings: violations,
            contractName: name,
            file: rel,
            blocked: true,
            next: "Fix these, then write the file again.",
            more
          })
        }
      }
    }
    return undefined
  }
  log(violations.length > 0 ? "warned" : "passed")
  if (violations.length > 0)
    return {
      decision: "block",
      reason: enforcementCard({
        findings: violations,
        contractName: name,
        file: rel,
        next: "Fix these in a follow-up edit.",
        more
      })
    }
  return {
    systemMessage: passCard({
      contractName: name,
      file: rel,
      componentsChecked: result.summary.componentsChecked
    })
  }
}

/** `invariant hook`: check an agent's Write/Edit against the contract and answer in its hook format. */
export async function hook(c: Context): Promise<number> {
  const { input } = c.io
  if (!input) throw new CliError("`hook` reads the agent's hook payload from standard input")
  const client = c.args.values.client ?? "claude-code"
  if (!(CLIENTS as readonly string[]).includes(client))
    throw new CliError(`--client must be one of ${CLIENTS.join(", ")}`)
  let payload: Payload | undefined
  try {
    const raw = JSON.parse(await readAll(input, MAX_PAYLOAD_CHARS))
    if (client === "cursor") payload = cursorPayload(raw)
    else {
      const parsed = payloadSchema.safeParse(raw)
      if (parsed.success) payload = parsed.data
    }
    if (!payload) c.io.stderr(`invariant hook: unrecognized payload; staying silent\n`)
  } catch (error) {
    // Fail open in every way: the write proceeds and the reason is visible on stderr.
    c.io.stderr(`invariant hook: ${(error as Error).message}\n`)
  }
  if (!payload) return 0
  try {
    const decision = await decide(c, payload)
    if (decision) c.io.stdout(`${JSON.stringify(client === "cursor" ? cursorAnswer(decision) : decision)}\n`)
  } catch (error) {
    c.io.stderr(`invariant hook: ${(error as Error).message}\n`)
  }
  return 0
}
