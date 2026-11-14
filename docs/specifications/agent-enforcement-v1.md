# Agent enforcement hooks (v1)

Status: implemented in `apps/cli/src/commands-hook.ts` (the `invariant hook` command), `packages/agent-kit` (the `.claude/settings.json` entries `agent init` writes), the `enforcement.hooks` setting in `invariant.config.json`, and the shared enforcement card in `packages/validation/src/card.ts`, which the hook and the MCP `validate_design_system_compliance` tool both show. Claude Code is the only client with hooks today; this is the first two phases of the enforcement plan (gate at write time, cards done; enforcement log, live preview to follow).

## Running it

```
invariant compile
invariant agent init claude-code      # also writes the hooks below
invariant hook                       # reads one hook payload on stdin, answers on stdout
```

`agent init claude-code` adds two entries to `.claude/settings.json`: a `PreToolUse` and a `PostToolUse` matcher group on `Write|Edit`, each launching `invariant hook` (the same launch command as the MCP entry, `--command`/`--command-arg` respected) with a 30-second timeout. Claude Code pipes the event payload to the command's stdin and reads one JSON object from its stdout.

The command can also be run by hand for testing:

```
echo '{"hook_event_name":"PreToolUse","tool_name":"Write","cwd":"/repo","tool_input":{"file_path":"/repo/src/x.tsx","content":"…"}}' | invariant hook
```

## What it checks and when

The payload names the tool (`Write` or `Edit`), the absolute `file_path`, and the content: `Write` carries the whole file, `Edit` carries `old_string`/`new_string` (`replace_all` respected). The hook reconstructs what the file would contain after the write — for `Edit` by reading the file on disk and applying the change (an edit whose old text is missing or ambiguous stays silent: the agent's own Edit fails first) — and runs the same check as `invariant validate` on that one file: component uses with their literal props, literal colors and CSS variables against tokens, and the structural rules of approved patterns. `PostToolUse` reads the file that landed instead. The same file types are read (`.tsx`, `.jsx`, `.ts`, `.js`, `.mjs`, `.cjs`, `.vue`, `.html`), the same ignore globs from `validation.ignore` are honored, and the baseline and rule overrides (`validation.rules`) are applied, so pre-existing violations never block an agent forever and deliberate exceptions stay excepted.

The project is found without being told: `CLAUDE_PROJECT_DIR` (Claude Code exports it to hooks), then the payload's `cwd`, then the process directory. Files outside the project are ignored.

## Answers (verified against docs.claude.com/en/docs/claude-code/hooks on 2026-11-11)

- **`PreToolUse`, default posture (`gate-errors`)**: if error-severity findings remain after the baseline and rule overrides, the hook denies the write:

  ```json
  {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}
  ```

  The reason is a card the agent must act on: one line naming the file and the counts, then up to ten findings (`✗`/`⚠`/`ℹ`, rule code, message, line, `fix:` suggestion with the source pointer), a pointer to `invariant validate <file>` beyond that, and one closing line saying facts come from the contract, not guesses. A write with only warnings or info passes; warnings never block.
- **`PostToolUse`**: findings are reported next to the tool result (the write already happened), so the agent can fix them in a follow-up edit: `{"decision":"block","reason":"…"}` with the same card. A clean pass prints a green line to the person watching: `{"systemMessage":"invariant ✓ src/Save.tsx follows the @acme/ui contract (2 component uses checked)"}`.
- **Silent**: a clean `PreToolUse` (nothing to say yet), an ignored file (wrong type, ignored by glob, outside the project), a `warn`-posture `PreToolUse`, or any posture `off`.

Nothing is printed to stdout except the JSON object (Claude Code rejects anything else); human-readable notes go to stderr.

## The enforcement card

Every surface that tells the agent what to fix shows the same card, rendered by `packages/validation/src/card.ts` (`enforcementCard`, `passCard`): the hook's deny reason, the `PostToolUse` block reason, and the text content of the MCP `validate_design_system_compliance` tool. The person watching the chat reads one format everywhere a check happens:

```text
invariant checked src/Page.tsx: 1 error, 1 warning, 1 info against the @acme/ui contract

✗ prop-value-not-allowed: Button.variant is "danger", which is not one of "primary", "secondary", "ghost" (line 3)
    fix: Use one of "primary", "secondary", "ghost".
⚠ prop-deprecated: plain is deprecated (line 4)
ℹ color-matches-token: #fff equals the value of surface (line 6)

Fix these, then validate again. Facts and fixes come from the compiled contract, not guesses.
```

- One header line: `invariant blocked|checked <file|the snippet>: <counts> against the <contract> contract`. `blocked` when the write was denied, `checked` otherwise; `the snippet` when there is no file; counts by severity, each only when nonzero (info has no plural).
- Up to ten findings (`CARD_FINDINGS_LIMIT`), in file order: `✗`/`⚠`/`ℹ`, rule code, message, `(line N)` when known, `    fix:` suggestion when the contract states one. Findings beyond that get a pointer the caller chooses: the hook says `…and N more (run \`invariant validate <file>\`)`; the MCP tool says they follow in the JSON below.
- One closing line: the caller's next step — `Fix these, then write the file again.` (hook deny), `Fix these in a follow-up edit.` (hook post-write), `Fix these, then validate again.` (MCP tool) — plus the constant sentence that facts and fixes come from the compiled contract, not guesses.
- A clean pass shows the pass card instead: `invariant ✓ <file|the snippet> follows the <contract> contract (N component use(s) checked)`, or `no component uses checked` when none.

In the MCP tool the card is the text content, ahead of the JSON body with a blank line between them; `structuredContent` is unchanged, so clients of both protocol eras parse the same data, and the combined text stays under the 400,000-character limit. `validate_component_usage` stays JSON-only: it is a lookup the model reads programmatically, not something a person watches.

## Postures

`enforcement.hooks` in `invariant.config.json` (or `--posture` on the command, which wins). This is the setting's name. The enforcement plan called it `enforcement.posture`; it stays `enforcement.hooks` because 0.1.0 shipped with it, and renaming would break existing configs. `--posture` is the matching flag on `hook` and `setup`:

| Posture | PreToolUse | PostToolUse |
|---|---|---|
| `gate-errors` (default) | deny on errors | report findings, confirm clean passes |
| `warn` | silent | report findings, confirm clean passes |
| `off` | nothing is checked | nothing is checked |

## Latency

Measured 2026-11-11 on a copy of `fixtures/monorepo/acme`, compiled, with `node apps/cli/dist/main.js hook` fed a `Write` payload on stdin (whole process, cold start, 5 runs): 279–297 ms, under the 500 ms budget. That run loaded the contract and validated the file; the payload produced no finding, so the deny path (card rendering plus a log append) was not timed.

## Failure behavior

The hook fails open: a missing `invariant.config.json`, a missing or stale compiled contract, a payload it does not recognize (unknown tool or event), input over 2,000,000 characters, or a broken baseline file is noted on stderr and the write proceeds. A denied write is the only thing that can stop the agent's tool call, and it requires error-severity findings against a verified contract.

## Writing `.claude/settings.json`

The two entries are appended per event (`PreToolUse`, `PostToolUse`) as matcher groups on `Write|Edit`:

- Hooks the user configured are kept: our group is appended to theirs, never merged into it.
- An existing entry is recognized as ours by the status-message marker `"invariant: checking the design system contract"`, which survives launch-command changes. Identical means unchanged; ours-but-different is skipped with a pointer to `--force`, which replaces it.
- JSON that does not parse, a `hooks` key that is not an object, or an event key that is not an array is left alone with a reason; other keys in the file (such as `permissions`) are never touched.

Other clients (Cursor, Codex, Windsurf) have no hook entries in their plans; their generated configuration is unchanged.

## Verification

- `apps/cli/src/hook.test.ts` (14): deny on errors with the card contents; silence on clean writes, warnings-only, ignored files and unknown payloads; Edit reconstruction including the ambiguous case; baseline applied; warn and off postures; PostToolUse findings and the green pass line; `CLAUDE_PROJECT_DIR` resolution; fail-open on a missing contract.
- `apps/cli/src/agent.test.ts` (6 new): settings.json entries written for claude-code only; idempotent; custom launch command; user hooks kept; ours-but-different replaced only with `--force`; unparsable settings left alone.
- `packages/agent-kit/src/agent-kit.test.ts` (4 new): the plan with and without a hook launch; array-append semantics (user entries kept, ours replaced with `--force` across command changes, wrong shapes skipped).
- `packages/validation/src/card.test.ts` (8): the card's header, counts by severity, marks, line and fix lines, in file order; the snippet when no file; the cap, the default and caller-provided more pointer, and a smaller limit; the closing line; the pass card's pluralization and no-uses case.
- `packages/mcp/src/mcp.test.ts` (2 new): the validate tool's text content leads with the card and the JSON that follows still matches `structuredContent`; a clean snippet gets the pass card ahead of the JSON.
- `scripts/phase9.e2e.test.ts`: `textOf` reads `structuredContent` first, falling back to the JSON in the text content.

## The enforcement log and report

`invariant hook` appends one JSON line per checked write to `.invariant/enforcement.jsonl` in the project (`apps/cli/src/enforcement-log.ts`). The first write also creates `.invariant/.gitignore` containing `*`, so the directory ignores itself and the project's own `.gitignore` is never edited. Each event holds `time`, `session` (the payload's `session_id`), `file`, `outcome`, up to ten findings (`code`, `severity`, `message`, `line`, `fix`, text clipped to 200 characters), the count of findings left out, and the component uses checked. It never holds file contents.

- **`blocked`**: `PreToolUse` denied the write. **`warned`**: the write landed with findings (`PostToolUse`). **`passed`**: it landed clean. A clean `PreToolUse` logs nothing, since its `PostToolUse` follows, so each write counts once.
- **`fixed` is derived by the report, not stored.** A `passed` event after a `blocked` or `warned` event on the same file, in the same session, is shown as fixed. Reading the log on every hook run would cost latency for no gain.
- **Concurrency**: one `O_APPEND` write of one line under 4 KB, which POSIX keeps whole. The reader skips torn or foreign lines.
- **Failure**: a log write that fails is noted on stderr and never changes the hook's answer.
- **MCP does not log.** The MCP server stays read-only (ADR 0003), so `validate_design_system_compliance` calls do not appear in the log or the report. Only the hook's checks do.

`invariant enforcement report [--session <id>|--all] [--format text|html] [--to <file>]` prints the latest session (or the chosen one) as text, or as one self-contained HTML page (no scripts, no external requests, same page style as `invariant.report.html`). The headline reads `3 writes checked · 2 violations caught · 2 fixed · 0 outstanding`. A catch is a `blocked` or `warned` write; it is fixed when a later write to that file passes clean, outstanding otherwise. The timeline shows each write in order with what was caught (rule, message, line, fix) and, on the passing write, which rules it resolved. Verified by `apps/cli/src/enforcement-report.test.ts` (golden text and HTML in `fixtures/cli-golden/enforcement/`) and the block → rewrite → pass loop in `apps/cli/src/hook.test.ts`.

## Known limitations

- Claude Code only. Other clients have no write-time hook system to attach to; they keep MCP-only enforcement.
- `Edit` reconstruction reads the file on disk, so a `replace_all` edit that appears multiple times is applied wholesale (correct), while a non-`replace_all` edit whose old text occurs more than once stays silent and is caught after the write by `PostToolUse` instead.
- The hook validates one file per event; state shared across files (a wrapper component defined in another file) is not followed, the same as `validate`.
- A hook runs per Write/Edit, so a project without a compiled contract or config is never blocked (fail open) — enforcement assumes `invariant compile` has run.
- On Windows, Claude Code spawns hooks with `args` in exec form, which cannot run the `.cmd` shim npm installs. Pass `--command node --command-arg <path to main.js>` there (the same launch shape as the MCP entry).
- The generated skills tell agents a hook may block them; they cannot see the hook's posture, which only people configure.
