import type { Contract } from "@invariant/contract"
import { type Facts, MARKER, rulesBody, SERVER_NAME, SKILL_NAMES, safeFacts, skillFile } from "./guidance.js"

export const CLIENTS = ["claude-code", "cursor", "codex", "windsurf"] as const
export type Client = (typeof CLIENTS)[number]

export type PlannedFile =
  | { path: string; kind: "json-merge"; key: string[]; value: Record<string, unknown> }
  | {
      path: string
      kind: "json-array-append"
      key: string[]
      /** Elements to make sure the array holds. Others the user configured are kept. */
      value: unknown[]
      /** Substring that marks an existing element as ours, so a changed one is replaced, not duplicated. */
      identity: string
    }
  | { path: string; kind: "toml-table"; table: string; text: string }
  | { path: string; kind: "generated"; content: string }
  | { path: string; kind: "markdown-section"; content: string }

export interface Plan {
  client: Client
  files: PlannedFile[]
  /** Things to tell the user instead of doing them: anything outside the project, or not verified. */
  notes: string[]
  /** Text to show for configuration that is printed rather than written. */
  snippets: Array<{ title: string; text: string }>
}

export interface LaunchOptions {
  command: string
  args: string[]
}

const hasControl = (s: string): boolean => [...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)

export function validateLaunch(launch: LaunchOptions): string | undefined {
  if (launch.command.trim() === "" || hasControl(launch.command))
    return "the command must be a non-empty single line"
  if (launch.args.some((a) => hasControl(a))) return "command arguments must be single lines"
  return undefined
}

const tomlString = (s: string): string => JSON.stringify(s)

const server = (launch: LaunchOptions): { command: string; args: string[] } => ({
  command: launch.command,
  args: launch.args
})

/** Marks a settings entry as ours. The status message is the marker because it survives launch-command changes: an entry written with a different `--command` is still ours, and is replaced with `--force`. */
const HOOK_STATUS_MESSAGE = "invariant: checking the design system contract"
const hookIdentity = (): string => JSON.stringify(HOOK_STATUS_MESSAGE)

/** A Claude Code matcher group that runs `invariant hook` on every Write and Edit. */
const hookGroup = (launch: LaunchOptions): Record<string, unknown> => ({
  matcher: "Write|Edit",
  hooks: [
    {
      type: "command",
      command: launch.command,
      args: launch.args,
      timeout: 30,
      statusMessage: HOOK_STATUS_MESSAGE
    }
  ]
})

const HOOK_NOTES = [
  "The hooks in .claude/settings.json run `invariant hook` before and after every Write and Edit, so UI the agent writes is checked against the contract in real time. They fail open: if invariant cannot run, the write proceeds.",
  "Errors block a write; warnings and info arrive after it. Soften or disable that with enforcement.hooks (warn, off) in invariant.config.json.",
  "Re-run `invariant agent init` after changing the launch command or the enforcement posture."
]

const rulesFile = (f: Facts, frontmatter: string): string =>
  `${frontmatter}<!-- ${MARKER} (contract ${f.hash.slice(0, 12)}); regenerate with \`invariant agent init\` -->\n\n${rulesBody(f)}`

export function planIntegration(
  client: Client,
  contract: Contract,
  launch: LaunchOptions,
  hookLaunch?: LaunchOptions
): Plan {
  const f = safeFacts(contract)
  const entry = server(launch)
  switch (client) {
    case "claude-code":
      return {
        client,
        files: [
          { path: ".mcp.json", kind: "json-merge", key: ["mcpServers", SERVER_NAME], value: entry },
          ...SKILL_NAMES.map((name) => ({
            path: `.claude/skills/${name}/SKILL.md`,
            kind: "generated" as const,
            content: skillFile(name, f)
          })),
          ...(hookLaunch
            ? (["PreToolUse", "PostToolUse"] as const).map((event) => ({
                path: ".claude/settings.json",
                kind: "json-array-append" as const,
                key: ["hooks", event],
                value: [hookGroup(hookLaunch)],
                identity: hookIdentity()
              }))
            : [])
        ],
        notes: [
          "Claude Code asks you to approve project MCP servers the first time it loads .mcp.json.",
          ...(hookLaunch ? HOOK_NOTES : [])
        ],
        snippets: []
      }
    case "cursor":
      return {
        client,
        files: [
          {
            path: ".cursor/mcp.json",
            kind: "json-merge",
            key: ["mcpServers", SERVER_NAME],
            value: { type: "stdio", ...entry }
          },
          {
            path: ".cursor/rules/invariant.mdc",
            kind: "generated",
            content: rulesFile(
              f,
              `---\ndescription: Use when writing or changing UI for ${f.name}: find components, props and tokens in the Invariant MCP server and validate the result.\nglobs:\nalwaysApply: false\n---\n`
            )
          }
        ],
        notes: [],
        snippets: []
      }
    case "codex":
      return {
        client,
        files: [
          {
            path: ".codex/config.toml",
            kind: "toml-table",
            table: `mcp_servers.${SERVER_NAME}`,
            text: `[mcp_servers.${SERVER_NAME}]\ncommand = ${tomlString(launch.command)}\nargs = [${launch.args.map(tomlString).join(", ")}]\n`
          },
          { path: "AGENTS.md", kind: "markdown-section", content: rulesBody(f) }
        ],
        notes: [
          "Codex reads a project .codex/config.toml only for trusted projects. Trust this project, or add the server to ~/.codex/config.toml yourself."
        ],
        snippets: []
      }
    case "windsurf":
      return {
        client,
        files: [{ path: ".windsurf/rules/invariant.md", kind: "generated", content: rulesFile(f, "") }],
        notes: [
          "The location of Windsurf's MCP configuration could not be verified against current documentation, so nothing was written for it. Add the server below through Windsurf's MCP settings.",
          "Set how the rule is activated (always on, model decision, or manual) in Windsurf's rules settings."
        ],
        snippets: [
          {
            title: "MCP server entry",
            text: JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2)
          }
        ]
      }
  }
}
