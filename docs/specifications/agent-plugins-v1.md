# Agent plugins (v1, plan)

Status: **plan only. Nothing here is built.** Decisions are in `docs/decisions/0005-agent-plugins.md` (Proposed). This document holds the verified client formats, the design, and the phases.

## Goal

A product, design or engineering leader of a company's internal design system installs one plugin into Claude Code or Cursor, answers a few questions, and ends up with a contract that AI agents must follow when they generate UI. The loop already built in Phases A to E (hook, card, log, report) is what enforces it; the plugin is how it gets installed and configured with the least effort.

## Verified client formats (2026-11-11)

Sources are the clients' own docs, read by a research agent. Items marked *unverified* were not confirmed and need a live test before the build relies on them.

### Claude Code (code.claude.com/docs/en/plugins)

- Manifest `.claude-plugin/plugin.json`; only `name` is required. Components live at the plugin root: `skills/<name>/SKILL.md`, `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json`, `bin/`.
- `hooks/hooks.json` has a required top-level `"hooks"` wrapper, then the same matcher-group shape as `settings.json` (`matcher`, `hooks[]` with `type`, `command`, `args`, `timeout`, `statusMessage`). Exec form (`command` plus `args`, no shell) is used; on Windows exec form cannot run `.cmd` shims, so the launcher is run as `node <script>`.
- Variables substituted in hook and MCP `command`, `args` and `env`: `${CLAUDE_PLUGIN_ROOT}` (changes on update), `${CLAUDE_PLUGIN_DATA}` (persists across updates), `${CLAUDE_PROJECT_DIR}`. The same names are exported to hook processes.
- Plugin hooks merge with the user's and project's hooks; they register when the plugin loads, not when a skill is used. Plugin MCP tools are named `mcp__plugin_<plugin>_<server>__<tool>`.
- Install: `/plugin marketplace add <owner>/<repo>` then `/plugin install <name>@<marketplace>`; or one step `claude plugin install <name> --marketplace <owner>/<repo>`. Without a marketplace: `claude --plugin-dir <folder or zip>` for one session, `--plugin-url` for a hosted zip, or a folder under `~/.claude/skills/` for every session. `claude plugin validate <dir> --strict` checks a plugin.
- Marketplace file `.claude-plugin/marketplace.json`: `name`, `owner`, `plugins[]` with `name` and `source` (a relative path works).
- Directory submission: claude.ai/directory/manage (paid plan; the portal applies extra rules the CLI does not check). The official `claude-plugins-official` marketplace is through an Anthropic contact, not the portal.
- *Unverified*: `npx -y` behavior inside hooks or MCP servers (the docs' documented pattern for npm dependencies is a `SessionStart` hook that installs into `${CLAUDE_PLUGIN_DATA}`); whether `CLAUDE_PROJECT_DIR` equals the hook's working directory in every case.

### Cursor (cursor.com/docs)

- Manifest `.cursor-plugin/plugin.json`; only `name` is required. Components: `rules/*.mdc`, `skills/<name>/SKILL.md`, `agents/`, `commands/`, `hooks/hooks.json`, `mcp.json`. `${CURSOR_PLUGIN_ROOT}` expands to the install path. A multi-plugin repo uses `.cursor-plugin/marketplace.json`.
- Manual install: a folder at `~/.cursor/plugins/local/<name>`, then reload the window. Enterprise admins must enable "Allow Local Plugin Imports". Zip, git URL and `.vsix` installs are not documented. Marketplace submission is at cursor.com/marketplace/publish and every plugin is reviewed by hand; teams can also import a repo (Dashboard, Plugins and MCPs, Import from Repo).
- Hooks: `hooks.json` (`{"version":1,"hooks":{<event>:[{"command":...,"matcher":...}]}}`). `afterFileEdit` receives `file_path` (absolute) and `edits` (`old_string`, `new_string`) plus `workspace_roots`, `conversation_id`, `hook_event_name`. Exit 2 or `permission: "deny"` blocks on permission-style hooks; `agent_message` and `user_message` carry text. `afterFileEdit` runs after the edit and has no documented deny field.
- *Unverified*: whether `preToolUse` can deny a `Write` and what its `tool_input` looks like; what output an `afterFileEdit` hook can return to the agent (the documented `agent_message` is shown on shell and MCP hooks); whether `type: "stdio"` is required in `mcp.json`.
- Skills use the same `SKILL.md` format and are also read from `.claude/skills/`. Rules are `.mdc` only, with `description`, `globs` and `alwaysApply` frontmatter.

## Design

### What each plugin contains

| Component | Claude Code | Cursor |
| --- | --- | --- |
| MCP server | `.mcp.json`: `node ${CLAUDE_PLUGIN_ROOT}/bin/invariant-launch.mjs mcp` | `mcp.json`, same launcher |
| Hook | `PreToolUse` and `PostToolUse` on `Write\|Edit` running the launcher with `hook --quiet` | `afterFileEdit` running the launcher with `hook --quiet --client cursor` (feedback only) |
| Skills | `invariant-setup` (the discovery and approval flow), plus the generic build, discovery, layout and review skills | the same skills |
| Rules | none (Claude Code uses skills) | `rules/invariant.mdc`, `alwaysApply: true`, short and generic |
| Launcher | `bin/invariant-launch.mjs` | `scripts/invariant-launch.mjs` (same file) |

The plugin name is `invariant`, so the setup skill appears as `/invariant:setup` in Claude Code.

### The launcher

One dependency-free file, run as `node <launcher> <subcommand...>`:

1. **Fast exit for unrelated projects.** Look for `invariant.config.json` from `CLAUDE_PROJECT_DIR` (or the payload's directory) upward to the filesystem root. If there is none, and the subcommand is `hook`, exit 0 with no output. For `mcp`, still start (the server reports there is no contract and tells the agent to run setup).
2. **Resolve the CLI:** an `invariant` on PATH wins; otherwise `~/.invariant/cli/<pinned version>/node_modules/.bin/invariant` (the version is written into the plugin at build time).
3. **First-use install** when neither exists: `npm install --ignore-scripts --prefix ~/.invariant/cli/<version> invariant-ui@<version>`, under an exclusive lock file so concurrent hooks wait instead of racing. A hook that cannot install fails open with one stderr line; the first write is simply unchecked.
4. **Exec** the CLI with the same arguments, passing stdin and stdout through.

Safety: exact version pin, `--ignore-scripts`, writes only under `~/.invariant/`, no use of project content in any command, and no network access except that one install. Cost: one Node start for the launcher plus the CLI's own start, which has to be re-measured against the 500 ms budget.

### The setup skill (`/invariant:setup`)

Interactive by design; the CLI's own `setup` asks questions on a terminal, which an agent cannot answer. The skill instead asks the person in the chat and calls the CLI non-interactively:

1. **Where does the design system live?** Offer what it finds: an installed package that ships a contract (`node_modules/<pkg>/invariant/`), design system source in this repository (React, Vue, Angular, Storybook, token files), or both. The person confirms, or names a folder.
2. **What was discovered.** Run `invariant init` and `invariant compile`, then summarize components, tokens and diagnostics in plain words, and list what could not be extracted.
3. **Patterns.** Run `invariant discover`, show the candidate patterns, and ask which to approve. Approval is recorded with the approver's name through the CLI's governance commands; the skill never approves anything on its own.
4. **Enforcement.** Ask for the posture (`gate-errors` by default), offer the baseline for existing violations, and offer the CI workflow.
5. **Verify.** Write a deliberately wrong snippet to a scratch file, show the block, then delete it.

The skill never writes contract text into committed files by hand, and reports what was approved, what was inferred and what was skipped.

### The hook changes

- `--quiet`: do not print the missing-config or missing-contract notes.
- `--client cursor`: parse `afterFileEdit` (`file_path`, `edits`, `workspace_roots`), read the file as it landed, validate, and answer with `agent_message` and `user_message`. The exact output shape is *unverified* and is the first thing the Cursor build tests.
- The enforcement log, card and baseline behave identically for both clients.

### Generation

`scripts/build-plugins.ts` writes:

```
plugins/claude/invariant/        # the Claude Code plugin
plugins/cursor/invariant/        # the Cursor plugin
.claude-plugin/marketplace.json  # repo-root marketplace pointing at plugins/claude/invariant
dist-plugins/*.zip               # one zip per client (not committed)
```

Inputs are `packages/agent-kit` (skills, rules, the hook definition), the pinned CLI version from `apps/cli/src/version.ts`, and the single launcher source. The generated directories are committed so a GitHub marketplace serves them; a test regenerates them and fails on any difference.

### Support matrix after this work

| Client | Install | Write-time blocking |
| --- | --- | --- |
| Claude Code | marketplace, zip, or folder | Yes |
| Cursor | local folder (or marketplace once listed) | No: feedback after the edit; blocking is a tested follow-up |
| Codex, Windsurf | `agent init` only | No |

## Phases

**P0. Publish (owner action).** Publish `invariant-ui` to npm and confirm the name, owner and first version. The registry returns 404 today. Blocks P2's end-to-end test and everything user-facing.

**P1. Hook for plugin use (done 2026-11-11).** `--quiet`, `--client cursor` adapter, tests with recorded Cursor-shaped payloads. Acceptance: Claude behavior unchanged; Cursor payloads produce findings; quiet mode prints nothing on stderr when unconfigured. Built: `--quiet` and `--client claude-code|cursor` on `invariant hook`, with three new tests in `apps/cli/src/hook.test.ts`. The Cursor answer (`agent_message` for findings, `user_message` for the clean pass) follows the documented field names but is still unverified against a live Cursor.

**P2. Launcher.** The install source is swappable: npm by default, or a tarball URL (for example a GitHub release asset of the `dist-npm` package), so the plugins are not blocked on the npm account. Tests use a local `npm pack` tarball. `invariant-launch.mjs` with fast exit, resolution order, locked install, fail-open. Tests with a fake registry (a local tarball) and concurrent invocations. Acceptance: first call installs once under concurrency; later calls add under 100 ms of overhead before the CLI starts; unrelated projects exit in under 100 ms; the full hook stays under 500 ms.

**P3. Generic skills and the setup skill.** Generic versions of the existing skills; `invariant-setup` as designed above. Acceptance: the setup flow succeeds end to end on a fixture (compile, approve a pattern, verify a block) driven by scripted answers; no skill text derives from contract content.

**P4. Generator and Claude Code plugin.** `build-plugins.ts`, `plugins/claude/`, the repo marketplace, the zip. Acceptance: `claude plugin validate plugins/claude/invariant --strict` passes; the generated tree matches the committed one; install from the local marketplace works in a real Claude Code session and the demo loop runs through the plugin's hook.

**P5. Cursor plugin.** `plugins/cursor/`, manual-install docs, a live test of the `afterFileEdit` output shape and of `preToolUse` blocking. Acceptance: feedback reaches the agent in a real Cursor install; the blocking result (works or does not) is recorded in the spec and the matrix.

**P6. Website and listings.** Download page with both zips and the three install paths, the leader-facing quick start, and the submission steps for Anthropic's directory and Cursor's marketplace (owner actions).

## Risks

- **Auto-install is code execution on the user's machine.** Mitigations are in the launcher section. A compromised `invariant-ui` release would reach every user of the plugin, so the release process (provenance, 2FA on the npm account) matters more once plugins exist.
- **Plugin hooks fire in every project.** The fast exit keeps the cost small, but a bug in the launcher would affect every repo a user opens. Fail open, always.
- **Cursor's hook semantics are unverified.** The Cursor plugin may ship with weaker enforcement than the docs imply; the matrix says so.
- **Version skew.** The plugin pins a CLI version; the contract format is versioned (`SUPPORTED_CONTRACT_VERSIONS`). A plugin that pins an older CLI than the one that compiled a project's contract must say so clearly rather than mis-validate.
- **Context cost.** Every enabled plugin adds skill descriptions to each Claude turn; keep the skill set small and the descriptions short.
- **Windows.** Exec form cannot run npm shims; the launcher is invoked as `node <script>` for that reason, and the install step must be tested on Windows before the plugin claims support.

## Out of scope

Rendered preview (ADR 0004), a VS Code extension, Codex and Windsurf plugins, and any change to the contract or IR.
