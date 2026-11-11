import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"
import { FIXED_CLOCK } from "@invariant/compiler-core/testing"
import { afterAll, describe, expect, it } from "vitest"
import { run } from "./index.js"

const root = fileURLToPath(new URL("../../..", import.meta.url))
const made: string[] = []
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

/** A compiled project: the storybook fixture with a contract ready to enforce. */
async function project(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "invariant-hook-"))
  made.push(dir)
  cpSync(path.join(root, "fixtures/storybook/acme-ui"), dir, {
    recursive: true,
    filter: (s) => !s.includes("storybook-static")
  })
  await cli(dir, "init")
  await cli(dir, "compile")
  return dir
}

interface Run {
  code: number
  out: string
  err: string
}

async function cli(cwd: string, ...argv: string[]): Promise<Run> {
  return await raw(cwd, argv, undefined, undefined)
}

/** Runs `invariant hook` with a payload on stdin, the way Claude Code does. */
async function hook(
  cwd: string,
  payload: unknown,
  options: { env?: Record<string, string | undefined>; extraArgs?: string[] } = {}
): Promise<Run> {
  return await raw(cwd, ["hook", ...(options.extraArgs ?? [])], JSON.stringify(payload), options.env)
}

async function raw(
  cwd: string,
  argv: string[],
  stdin?: string,
  env?: Record<string, string | undefined>
): Promise<Run> {
  let out = ""
  let err = ""
  let input: PassThrough | undefined
  if (stdin !== undefined) {
    input = new PassThrough()
    input.write(stdin)
    input.end()
  }
  const code = await run(argv, {
    cwd,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    clock: FIXED_CLOCK,
    env: env ?? {},
    ...(input ? { input } : {})
  })
  return { code, out, err }
}

const ERROR_FILE = `import { Button } from "@acme/ui"

export const Danger = () => <Button variant="danger">Go</Button>
`
const WARNING_FILE = `import { Button } from "@acme/ui"

export const Plain = () => <Button plain>Go</Button>
`
const CLEAN_FILE = `import { Button } from "@acme/ui"

export const Save = () => <Button variant="primary">Save</Button>
`

/** A Claude Code Write payload. `file_path` is absolute, as Claude Code guarantees. */
const writePayload = (dir: string, rel: string, content: string): unknown => ({
  session_id: "s1",
  hook_event_name: "PreToolUse",
  tool_name: "Write",
  cwd: dir,
  tool_input: { file_path: path.join(dir, rel), content }
})

const postWritePayload = (dir: string, rel: string): unknown => ({
  session_id: "s1",
  hook_event_name: "PostToolUse",
  tool_name: "Write",
  cwd: dir,
  tool_input: { file_path: path.join(dir, rel), content: "unused" },
  tool_response: { filePath: path.join(dir, rel), type: "create" }
})

const editPayload = (dir: string, rel: string, oldString: string, newString: string): unknown => ({
  session_id: "s1",
  hook_event_name: "PreToolUse",
  tool_name: "Edit",
  cwd: dir,
  tool_input: { file_path: path.join(dir, rel), old_string: oldString, new_string: newString }
})

describe("hook: PreToolUse gates error-severity violations", () => {
  it("denies the write, with the findings as the reason the agent must fix", async () => {
    const dir = await project()
    const r = await hook(dir, writePayload(dir, "src/Danger.tsx", ERROR_FILE))
    expect(r.code).toBe(0)
    const decision = JSON.parse(r.out)
    expect(decision).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.any(String)
      }
    })
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain("prop-value-not-allowed")
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain("src/Danger.tsx")
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain("fix:")
  })

  it("stays silent when the code follows the contract", async () => {
    const dir = await project()
    const r = await hook(dir, writePayload(dir, "src/Save.tsx", CLEAN_FILE))
    expect(r.code).toBe(0)
    expect(r.out).toBe("")
  })

  it("never blocks for warnings: they arrive after the write instead", async () => {
    const dir = await project()
    const pre = await hook(dir, writePayload(dir, "src/Plain.tsx", WARNING_FILE))
    expect(pre.code).toBe(0)
    expect(pre.out).toBe("")
  })

  it("reconstructs an Edit's result and gates it; an ambiguous edit stays silent", async () => {
    const dir = await project()
    writeFileSync(path.join(dir, "src/Page.tsx"), CLEAN_FILE, "utf8")
    const unique = await hook(
      dir,
      editPayload(
        dir,
        "src/Page.tsx",
        '<Button variant="primary">Save</Button>',
        '<Button variant="danger">Save</Button>'
      )
    )
    expect(unique.code).toBe(0)
    expect(JSON.parse(unique.out).hookSpecificOutput.permissionDecision).toBe("deny")

    writeFileSync(
      path.join(dir, "src/Twice.tsx"),
      `<Button variant="primary">One</Button>\n<Button variant="primary">Two</Button>\n`,
      "utf8"
    )
    const ambiguous = await hook(
      dir,
      editPayload(dir, "src/Twice.tsx", '<Button variant="primary">', '<Button variant="danger">')
    )
    expect(ambiguous.code).toBe(0)
    expect(ambiguous.out).toBe("")
  })

  it("applies the baseline, so pre-existing violations do not block the agent forever", async () => {
    const dir = await project()
    writeFileSync(path.join(dir, "src/Danger.tsx"), ERROR_FILE, "utf8")
    await cli(dir, "validate", "src/Danger.tsx", "--update-baseline")
    const r = await hook(dir, writePayload(dir, "src/Danger.tsx", ERROR_FILE))
    expect(r.code).toBe(0)
    expect(r.out).toBe("")
  })

  it("never denies in warn posture, and reports everything after the write", async () => {
    const dir = await project()
    const pre = await hook(dir, writePayload(dir, "src/Danger.tsx", ERROR_FILE), {
      extraArgs: ["--posture", "warn"]
    })
    expect(pre.code).toBe(0)
    expect(pre.out).toBe("")
    writeFileSync(path.join(dir, "src/Danger.tsx"), ERROR_FILE, "utf8")
    const post = await hook(dir, postWritePayload(dir, "src/Danger.tsx"), {
      extraArgs: ["--posture", "warn"]
    })
    expect(JSON.parse(post.out)).toEqual({
      decision: "block",
      reason: expect.stringContaining("prop-value-not-allowed")
    })
  })

  it("checks nothing in off posture", async () => {
    const dir = await project()
    const r = await hook(dir, writePayload(dir, "src/Danger.tsx", ERROR_FILE), {
      extraArgs: ["--posture", "off"]
    })
    expect(r.code).toBe(0)
    expect(r.out).toBe("")
  })
})

describe("hook: PostToolUse reports what landed", () => {
  it("puts warnings next to the tool result so the agent can fix them next", async () => {
    const dir = await project()
    writeFileSync(path.join(dir, "src/Plain.tsx"), WARNING_FILE, "utf8")
    const r = await hook(dir, postWritePayload(dir, "src/Plain.tsx"))
    expect(r.code).toBe(0)
    const decision = JSON.parse(r.out)
    expect(decision).toEqual({ decision: "block", reason: expect.any(String) })
    expect(decision.reason).toContain("prop-deprecated")
    expect(decision.reason).toContain("fix:")
  })

  it("confirms a clean pass to the person watching the chat", async () => {
    const dir = await project()
    writeFileSync(path.join(dir, "src/Save.tsx"), CLEAN_FILE, "utf8")
    const r = await hook(dir, postWritePayload(dir, "src/Save.tsx"))
    expect(r.code).toBe(0)
    const decision = JSON.parse(r.out)
    expect(decision).toEqual({ systemMessage: expect.any(String) })
    expect(decision.systemMessage).toContain("✓ src/Save.tsx")
  })
})

describe("hook: scope and failure behavior", () => {
  it("ignores files validate does not read, before loading anything", async () => {
    const dir = await project()
    const r = await hook(dir, writePayload(dir, "README.md", "# no ui here\n"))
    expect(r.code).toBe(0)
    expect(r.out).toBe("")
  })

  it("resolves the project from CLAUDE_PROJECT_DIR when the agent works in a subdirectory", async () => {
    const dir = await project()
    const sub = path.join(dir, "src")
    const r = await hook(sub, writePayload(dir, "src/Danger.tsx", ERROR_FILE), {
      env: { CLAUDE_PROJECT_DIR: dir }
    })
    expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision).toBe("deny")
  })

  it("skips files the validation ignore globs exclude", async () => {
    const dir = await project()
    const config = JSON.parse(readFileSync(path.join(dir, "invariant.config.json"), "utf8"))
    writeFileSync(
      path.join(dir, "invariant.config.json"),
      JSON.stringify({ ...config, validation: { ignore: ["src/generated/**"] } }, null, 2),
      "utf8"
    )
    mkdirSync(path.join(dir, "src/generated"), { recursive: true })
    const r = await hook(dir, writePayload(dir, "src/generated/Danger.tsx", ERROR_FILE))
    expect(r.code).toBe(0)
    expect(r.out).toBe("")
  })

  it("fails open when there is no compiled contract, and says so on stderr", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "invariant-hook-"))
    made.push(dir)
    cpSync(path.join(root, "fixtures/storybook/acme-ui"), dir, {
      recursive: true,
      filter: (s) => !s.includes("storybook-static")
    })
    await cli(dir, "init")
    expect(existsSync(path.join(dir, "invariant/invariant.contract.json"))).toBe(false)
    const r = await hook(dir, writePayload(dir, "src/Danger.tsx", ERROR_FILE))
    expect(r.code).toBe(0)
    expect(r.out).toBe("")
    expect(r.err).toContain("no compiled contract")
  })

  it("fails open on a malformed or unknown payload", async () => {
    const dir = await project()
    for (const bad of [
      "not json",
      "{}",
      JSON.stringify({ hook_event_name: "Stop", tool_name: "Write", tool_input: { file_path: "/x.tsx" } })
    ]) {
      const r = await hook(dir, bad)
      expect(r.code).toBe(0)
      expect(r.out).toBe("")
    }
  })
})

describe("hook: enforcement log and report", () => {
  it("records block → rewrite → pass, and the report computes fixed", async () => {
    const dir = await project()
    const file = "src/Save.tsx"
    expect((await hook(dir, writePayload(dir, file, ERROR_FILE))).out).toContain("deny")
    // The agent rewrites it: the clean write is silent before and confirmed after.
    expect((await hook(dir, writePayload(dir, file, CLEAN_FILE))).out).toBe("")
    mkdirSync(path.join(dir, "src"), { recursive: true })
    writeFileSync(path.join(dir, file), CLEAN_FILE)
    await hook(dir, postWritePayload(dir, file))

    const lines = readFileSync(path.join(dir, ".invariant/enforcement.jsonl"), "utf8").trim().split("\n")
    expect(lines.map((l) => JSON.parse(l).outcome)).toEqual(["blocked", "passed"])
    expect(readFileSync(path.join(dir, ".invariant/.gitignore"), "utf8")).toBe("*\n")

    const text = (await cli(dir, "enforcement", "report")).out
    expect(text).toContain("2 writes checked · 1 violation caught · 1 fixed · 0 outstanding")
    expect(text).toContain("prop-value-not-allowed")
    expect(text).toMatch(/fixed \(caught prop-value-not-allowed/)

    const to = path.join(dir, "out/report.html")
    await cli(dir, "enforcement", "report", "--format", "html", "--to", to)
    const html = readFileSync(to, "utf8")
    expect(html).toContain("1 fixed")
    expect(html).not.toMatch(/<script|https?:\/\//)
  })

  it("leaves an unfixed catch outstanding, and a failed log write never breaks the hook", async () => {
    const dir = await project()
    await hook(dir, writePayload(dir, "src/Danger.tsx", ERROR_FILE))
    expect((await cli(dir, "enforcement", "report")).out).toContain(
      "1 violation caught · 0 fixed · 1 outstanding"
    )

    const blocked = await project()
    writeFileSync(path.join(blocked, ".invariant"), "a file where the directory belongs")
    const r = await hook(blocked, writePayload(blocked, "src/Danger.tsx", ERROR_FILE))
    expect(r.out).toContain("deny")
    expect(r.err).toContain("could not write the enforcement log")
  })

  it("reports an empty log without failing", async () => {
    const dir = await project()
    expect((await cli(dir, "enforcement", "report")).out).toContain("0 writes checked")
  })
})
