# ADR 0003: Agent enforcement hooks (write-time gating)

Status: Accepted for Phases A–B of the enforcement plan, 2026-11-11
Related: `docs/specifications/agent-enforcement-v1.md`, `docs/specifications/mcp-and-agents-v1.md`, `docs/specifications/validation-and-governance-v1.md`

## Context

MCP gives agents read-only facts and validators, but nothing stops an agent from writing code that breaks the contract: the agent must choose to call `validate_design_system_compliance` after the fact, and a human has to run `invariant validate` to catch what it skipped. The enforcement plan (Phases A–E) starts with the strongest lever: Claude Code's `PreToolUse` hooks, which can deny a `Write`/`Edit` before it lands. The wow-factor goal is watching an agent get blocked mid-write, in the chat, with the exact fix from the contract.

## Decision

**D1. Gate at write time; warn after; never block on warnings.** `PreToolUse` denies a write only when error-severity findings remain after the baseline and rule overrides. Warnings and info never block; `PostToolUse` reports all findings next to the tool result so the agent can fix them in a follow-up edit, and confirms clean passes with a green line for the person watching. This mirrors `validate --fail-on error` (the default) rather than a stricter posture, and keeps every existing escape hatch (baseline, rule overrides, ignore globs) working unchanged.

**D2. `invariant hook` is a command, not a script.** Claude Code hooks launch a shell command and pipe the event JSON to its stdin. The command reuses the CLI's config loading, contract loading, validation, baseline and override machinery — a separate hook script would drift from `validate`. It answers in Claude Code's hook format only at the edges (payload parsing, the JSON output shapes); everything between is the same code `validate` runs.

**D3. Fail open.** Any problem — no config, no compiled contract, an unrecognized payload, oversized input, a broken baseline — is noted on stderr and the write proceeds. A design-system checker must never be the thing that bricks an agent session, and the deny path requires positive knowledge (a verified contract, real findings) rather than absence of errors. `onFailure: "block"` is deliberately not set on the generated entries.

**D4. Posture is configuration, `gate-errors` by default.** `enforcement.hooks` (`gate-errors` | `warn` | `off`) in `invariant.config.json`, overridable with `--posture`. Warn-first was considered for the default; rejected because the product's promise is enforcement, and the baseline plus rule overrides already keep false positives from nagging. `warn` exists for teams that want observation first.

**D5. Project root resolves itself.** `CLAUDE_PROJECT_DIR` (exported by Claude Code to hooks), then the payload `cwd`, then the process directory. The generated entries carry no `--dir`, so they work from any subdirectory and never hardcode a path into a committed settings file.

**D6. Appending to `.claude/settings.json` preserves user hooks.** A new planned-file kind, `json-array-append`, appends our matcher group per event and never merges into a user's group. Ownership is marked by the entry's `statusMessage` (`"invariant: checking the design system contract"`), chosen because it survives launch-command changes — an entry written with a different `--command` is still ours and is replaced with `--force`, rather than orphaned and duplicated. Trade-off: renaming that message in a future release orphans old entries (they become "user" hooks: kept, with ours appended). Identity could not live in the command line (it changes), in extra JSON fields (Claude Code's schema does not allow unknown fields to be relied on), or in a wrapper script (D2).

**D7. Edit reconstruction, not tool-result trust.** For `Edit`, the hook reads the file on disk and applies `old_string` → `new_string` to see what the write would produce. An edit whose old text is missing or ambiguous stays silent (the agent's own Edit fails first), and `PostToolUse` always reads what actually landed, which is also the safety net for reconstruction mistakes.

**D8. Claude Code only in this phase.** It is the only supported client with a write-time hook system. Cursor, Codex and Windsurf plans are unchanged. The hook payload parsing accepts the documented `Write`/`Edit` shapes only; nothing guesses at other clients' formats.

## Phase B: the shared enforcement card (2026-11-11)

- **One card renderer, not two.** `packages/validation/src/card.ts` (`enforcementCard`, `passCard`, `CARD_FINDINGS_LIMIT = 10`) renders the card the hook shows; the hook's local copy was deleted, not duplicated. `@invariant/validation` is already the package both `cli` and `mcp` may import, so the boundary rules needed no change.
- **The MCP validate tool shows the same card.** `validate_design_system_compliance` now answers with the card as its text content, ahead of the JSON body (`ToolResult` gained optional `text`; the server joins them with a blank line and the size check covers the combined text). `structuredContent` is byte-for-byte unchanged, so clients of both protocol eras parse the same data; the card is for the person watching the chat. Trade-off: a client that JSON-parses the text content of this one tool now sees the card first — the spec says to parse `structuredContent`, and our e2e helper was updated accordingly.
- **`validate_component_usage` stays JSON-only.** It is a lookup the model calls mid-task, not a moment a person watches; a card there is noise, and the two tools keep distinct jobs: one is a fact lookup, one is a verdict.
- **Counts by severity, caller-chosen closing.** The header counts errors, warnings and info separately (info has no plural); Phase A lumped info into warnings, which read wrong for real info findings such as `color-matches-token`. The closing `next` sentence and the pointer past the limit are parameters: the hook says "write the file again" / "follow-up edit" and points at `invariant validate <file>`; the MCP tool says "validate again" and points at the JSON below. The constant sentence — facts and fixes come from the compiled contract, not guesses — is shared, because it is the claim every surface makes.

Compatibility: no protocol or schema change; the tool's text content gained a card prefix. Clients that read `structuredContent` (the documented path) are unaffected.

## Consequences

- Enforcement is now guaranteed at write time for Claude Code users: the agent cannot land an error-severity violation without seeing the deny card, and the person watching sees the check run on every Write/Edit (spinner message) and the result inline.
- `agent init` and `setup` (which re-invokes `agent init`) write hooks automatically; the generated skills gained a ground rule so agents know a hook may block them and must fix rather than work around.
- Generated skills now mention hook behavior; agents reading them cannot tell the posture (a person's decision), which the spec records as a limitation.
- Phases B–E (enforcement cards shared with the MCP validate tool, an enforcement log and report, live rendered preview, scripted demo) build on this: they reuse the same findings and the same posture machinery.

## Verification

Phase A: full suite green — 63 files, 1056 tests (26 new across `hook.test.ts`, `agent.test.ts`, `agent-kit.test.ts`), plus lint, typecheck and boundaries on the changed files. Two pre-existing failures on `main` are untouched and reported separately (format in `compiler-react`/`reconciliation`, one type error in `reconcile.test.ts`).

Phase B: full suite green — 64 files, 1066 tests (10 new: `card.test.ts` × 8, MCP card assertions × 2, plus the e2e helper's `structuredContent` preference), `tsc -b` and boundaries clean. The same pre-existing `main` failures remain, still untouched.
