import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { SKILLS } from "@invariant/agent-kit"
import { run } from "@invariant/cli"
import { FIXED_CLOCK } from "@invariant/compiler-core/testing"
import { TOOLS } from "@invariant/mcp"
import { afterAll, describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("..", import.meta.url))
const main = path.join(root, "apps/cli/dist/main.js")
const made: string[] = []
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

async function cli(cwd: string, ...argv: string[]): Promise<number> {
  return run(argv, { cwd, stdout: () => {}, stderr: () => {}, clock: FIXED_CLOCK })
}

async function project(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "invariant-e2e-"))
  made.push(dir)
  cpSync(path.join(root, "fixtures/storybook/acme-ui"), dir, {
    recursive: true,
    filter: (s) => !s.includes("storybook-static")
  })
  expect(await cli(dir, "init")).toBe(0)
  expect(await cli(dir, "compile")).toBe(0)
  return dir
}

type Msg = { id?: number; result?: any; error?: any }

/** Starts the server exactly as a client would, from a generated configuration entry. */
function launch(
  dir: string,
  entry: { command: string; args: string[] }
): {
  send(m: unknown): void
  next(): Promise<Msg>
  close(): Promise<{ code: number | null; stderr: string; stdout: string }>
} {
  const child: ChildProcessWithoutNullStreams = spawn(entry.command, entry.args, {
    cwd: dir,
    stdio: ["pipe", "pipe", "pipe"]
  })
  let buffer = ""
  let stdout = ""
  let stderr = ""
  const waiting: Array<(m: Msg) => void> = []
  const queue: Msg[] = []
  child.stdout.on("data", (c) => {
    buffer += String(c)
    stdout += String(c)
    let i = buffer.indexOf("\n")
    while (i >= 0) {
      const line = buffer.slice(0, i)
      buffer = buffer.slice(i + 1)
      const m = JSON.parse(line) as Msg
      const w = waiting.shift()
      if (w) w(m)
      else queue.push(m)
      i = buffer.indexOf("\n")
    }
  })
  child.stderr.on("data", (c) => {
    stderr += String(c)
  })
  return {
    send: (m) => child.stdin.write(`${JSON.stringify(m)}\n`),
    next: () =>
      new Promise<Msg>((resolve, reject) => {
        const m = queue.shift()
        if (m) return resolve(m)
        const t = setTimeout(() => reject(new Error("timed out waiting for a message")), 20_000)
        waiting.push((x) => {
          clearTimeout(t)
          resolve(x)
        })
      }),
    close: () =>
      new Promise((resolve) => {
        child.on("close", (code) => resolve({ code, stderr, stdout }))
        child.stdin.end()
      })
  }
}

const textOf = (m: Msg): any => JSON.parse(m.result.content[0].text)

describe.skipIf(!existsSync(main))(
  "Phase 9 exit criterion: an AI client can consume and validate the contract",
  () => {
    it("the generated configuration launches a working server, in the modern protocol", async () => {
      const dir = await project()
      expect(await cli(dir, "agent", "init", "claude-code", "--command", "node", "--command-arg", main)).toBe(
        0
      )
      const entry = JSON.parse(readFileSync(path.join(dir, ".mcp.json"), "utf8")).mcpServers.invariant
      const server = launch(dir, entry)
      const meta = {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "e2e", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {}
      }
      server.send({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta } })
      const discover = await server.next()
      expect(discover.result).toMatchObject({ resultType: "complete", supportedVersions: ["2026-07-28"] })
      server.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: meta } })
      expect((await server.next()).result.tools).toHaveLength(11)
      server.send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "get_component", arguments: { name: "Button" }, _meta: meta }
      })
      const component = await server.next()
      expect(textOf(component).id).toBe("component:button")
      const closed = await server.close()
      expect(closed.code).toBe(0)
      expect(closed.stderr).toMatch(/read-only/)
      for (const line of closed.stdout.split("\n").filter(Boolean))
        expect(JSON.parse(line).jsonrpc).toBe("2.0")
    })

    it("serves a legacy (initialize) client the same contract", async () => {
      const dir = await project()
      const server = launch(dir, { command: "node", args: [main, "mcp", "--dir", "invariant"] })
      server.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "legacy", version: "1" }
        }
      })
      expect((await server.next()).result.protocolVersion).toBe("2025-06-18")
      server.send({ jsonrpc: "2.0", method: "notifications/initialized" })
      server.send({
        jsonrpc: "2.0",
        id: 2,
        method: "resources/read",
        params: { uri: "invariant://components" }
      })
      const read = await server.next()
      expect(JSON.parse(read.result.contents[0].text).components.length).toBe(14)
      expect((await server.close()).code).toBe(0)
    })

    it("an agent can find a component, read its contract, and have wrong code rejected and right code accepted", async () => {
      const dir = await project()
      const server = launch(dir, { command: "node", args: [main, "mcp"] })
      let id = 0
      const call = async (name: string, args: Record<string, unknown>) => {
        server.send({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } })
        return server.next()
      }
      const overview = textOf(await call("get_design_system_overview", {}))
      expect(overview.counts.components).toBe(14)
      const hits = textOf(await call("search_design_system", { query: "button" })).hits
      expect(hits[0].id).toBe("component:button")
      const button = textOf(await call("get_component", { name: hits[0].id }))
      const variant = button.props.find((p: { name: string }) => p.name === "variant")
      expect(variant.allowedValues).toEqual(["primary", "secondary", "ghost"])

      const wrong = textOf(
        await call("validate_design_system_compliance", {
          code: `export const A = () => <Button variant="danger" plain>Save</Button>`
        })
      )
      expect(wrong.valid).toBe(false)
      expect(wrong.findings.map((f: { code: string }) => f.code)).toEqual([
        "prop-deprecated",
        "prop-value-not-allowed"
      ])
      expect(wrong.findings[1].source).toMatch(/Button\.tsx:\d+/)

      const right = textOf(
        await call("validate_design_system_compliance", {
          code: `export const A = () => <Button variant="ghost">Save</Button>`
        })
      )
      expect(right).toMatchObject({ valid: true, findings: [] })
      expect((await server.close()).code).toBe(0)
    })

    it("every tool a generated skill pre-approves exists on the server", () => {
      const names = new Set(TOOLS.map((t) => `mcp__invariant__${t.name}`))
      for (const [skill, def] of Object.entries(SKILLS))
        for (const t of def.tools) expect(names.has(`mcp__invariant__${t}`), `${skill} uses ${t}`).toBe(true)
    })
  }
)
