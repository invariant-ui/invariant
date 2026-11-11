# ADR 0005: Installable agent plugins for Claude Code and Cursor

Status: Proposed, 2026-11-11. Decisions D1 to D3 were chosen by the owner on 2026-11-11. No code is written.
Related: `docs/specifications/agent-plugins-v1.md`, `docs/decisions/0003-agent-enforcement-hooks.md`, `docs/decisions/0004-rendered-preview.md`, `docs/releasing.md`

## Context

Today a team adopts Invariant by running the CLI (`npx @invariant-ui/cli setup`, then `invariant agent init <client>`). That is fine for an engineer. The people who decide that an internal design system must govern AI-generated UI are often product, design or engineering leaders, and for them "install a plugin from a marketplace, or upload a downloaded file, then follow a guided setup" is a much lower bar. The goal is the least human effort between "I want my AI tools to follow our design system" and a contract the agents are bound to.

Claude Code and Cursor both have installable plugin systems that can bundle skills, hooks and MCP servers (verified against their docs on 2026-11-11; see the spec). Neither plugin can contain the CLI's logic by itself: the hook runs `invariant hook` and the MCP server runs `invariant mcp`. And `@invariant-ui/cli` has not been published to npm (the registry returns 404), so nothing can fetch it yet.

## Decisions

**D1. The plugins auto-install a pinned `@invariant-ui/cli` into a user cache, through one launcher.** A small dependency-free Node launcher script, shipped in each plugin, resolves the CLI in this order: an `invariant` on PATH, then a pinned version in `~/.invariant/cli/<version>/`, installing it there with `npm install --ignore-scripts` on first use. Both clients use the same launcher. This was chosen over bundling the CLI's dependencies in the plugin (large downloads, heavy build) and over requiring a global install (the extra step this work exists to remove). It needs Node 20 or newer, network on first run, and a published package. Running `npx -y` on every hook fire was rejected: it cannot meet the 500 ms hook budget.

**D2. Cursor ships feedback-only enforcement first.** Cursor's `afterFileEdit` hook runs after the write and has no deny field; `preToolUse` may be able to block a Write, but its payload is not documented. The Cursor plugin ships rules, skills, MCP and an `afterFileEdit` hook that reports findings to the agent, and says in the support matrix that it does not block. Blocking is tried against a real Cursor install as a follow-up, and adopted only if it works. Claude Code keeps write-time blocking.

**D3. One setup skill, which is also the discovery-and-approval skill.** `/invariant:setup` walks a person through where the design system lives (an npm package, or in the same repo as the apps), discovers components and tokens, asks them to confirm, and hands the confirmed answers to the CLI to compile. The skill proposes and a person approves; the CLI writes and enforces. This replaces the separately planned discovery skill phase.

**D4. The plugins are generated, not hand-written.** `scripts/build-plugins.ts` builds both plugins from the same sources `agent init` uses, so rules, skills and hook definitions cannot drift between the CLI path and the plugin path. The generated plugin directories are committed under `plugins/` so a GitHub marketplace can serve them directly, and a test fails when they are stale.

**D5. Plugin skills and rules are generic; contract-specific guidance stays with the project.** The skills `agent init` writes today embed identifiers from the compiled contract (`safeFacts`). A plugin is installed before any contract exists and is shared across projects, so its skills describe the workflow and point the agent at the MCP tools. Contract-specific facts keep coming from the MCP server, and `agent init` still writes project-level files for teams that want them committed. This also keeps ADR-level trust intact: no free-form contract text is written into a distributed artifact.

**D6. Hooks are silent in projects that do not use Invariant.** A plugin installed at user scope fires its hooks in every repo. The launcher checks for an `invariant.config.json` up from the project directory before starting anything and exits quietly if there is none. The current `invariant hook` note on stderr for a missing config stays for direct use, and the plugin passes `--quiet`.

**D7. A client adapter in the hook, not a second hook.** `invariant hook --client cursor` parses Cursor's payload (`file_path`, `edits`, `workspace_roots`) and answers in Cursor's shape. Claude Code stays the default. Validation, baselines, overrides, the card and the enforcement log are shared, as ADR 0003 D2 requires.

**D8. Distribution, in order of effort.**
1. A Claude Code marketplace in this repository (`/plugin marketplace add <owner>/<repo>`), which needs no review.
2. A downloadable zip per client on the website: Claude Code loads it with `--plugin-dir` or `--plugin-url`; Cursor loads a folder under `~/.cursor/plugins/local/`. Cursor's docs do not describe zip installs, so the Cursor download is documented as "unzip into that folder".
3. Anthropic's directory (submission at claude.ai/directory/manage) and Cursor's marketplace (manual review). These are owner actions and are not on the critical path.

## Consequences

- `@invariant-ui/cli` must be published before the plugins can work. Publishing cannot be undone (a version number is never reusable), so it is an owner action, not something the build does.
- The launcher is code that runs `npm install` on a user's machine, outside the clients' sandboxes. It pins an exact version, passes `--ignore-scripts`, writes only under `~/.invariant/`, takes a lock so concurrent hooks do not race, and fails open. The spec lists its failure modes.
- Plugins add their skill and agent descriptions to the model's context on every turn in Claude Code. The plugin keeps its skill count small.
- `agent init` and `setup` keep working unchanged for people who use the CLI directly.
- The support matrix gains a "via plugin" column and must stay honest: Cursor does not block writes until D2's follow-up proves it.

## Package name (2026-11-11)

The package is published as `@invariant-ui/cli` under the owner's new npm organization `invariant-ui`, not as the unscoped `invariant-ui`. The earlier npm account was locked, and an org-owned package cannot be stranded by one account. The installed command is still `invariant`. `NPM_PACKAGE` in `apps/cli/src/version.ts` is the source of truth for the build; the launcher's `PACKAGE` constant mirrors it and a test should keep the two equal.

## Alternatives considered

- **Bundle the CLI in the plugin.** Works offline but is heavy, and every CLI change forces a plugin rebuild and re-download for users.
- **MCP-only plugins.** Smallest, but loses the write-time hook, which is the product's strongest guarantee.
- **A VS Code extension for Cursor.** Cursor's own plugin system now covers skills, hooks and MCP, which is what is needed here.

## Open items for the owner

1. Publish `@invariant-ui/cli` (name, account, first version). The owner is locked out of the npm account (2026-11-11) and is waiting on npm support. Until then the launcher can install from a tarball URL (a GitHub release asset) instead; the plugin should not depend on npm being available.
2. Confirm the GitHub repository that serves the Claude marketplace (the existing site links to `mcarlucci/invariant`).
3. Plugin name: `invariant`, confirmed by the owner 2026-11-11 (the npm package name `@invariant-ui/cli` is separate; plugin names are per marketplace). The marketplace repository is `mcarlucci/invariant`, confirmed.
