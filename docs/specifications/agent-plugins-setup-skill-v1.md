# The setup skill (`/invariant:setup`)

Status: **built as text in `packages/agent-kit/src/plugin.ts` (2026-11-11) and run end to end in headless Claude Code (see "Live run" below).** The draft below was refined while building: step 7 now passes `--no-agent`, `--posture` and `--only`. Part of P3 in `docs/specifications/agent-plugins-v1.md`. This is the skill a design-system leader runs after installing the plugin. It is the discovery-and-approval flow decided in ADR 0005 D3.

## Who it is for

A product, design or engineering leader who owns or sponsors an internal design system and wants every AI tool in the company to generate UI that follows it. They may not be comfortable in a terminal and should never need to be. The agent does the terminal work; the person answers a few plain questions and approves what matters.

## Facts about the CLI this script relies on

Checked against the code on 2026-11-11.

- `invariant setup` run **without a terminal and without `--yes`** compiles the contract, looks at the app code for recurring structures, prints the plan, and then stops with "not asking (no terminal). Nothing was added." This is the propose step: it changes nothing beyond writing `invariant.config.json` and the compiled output.
- `invariant setup --confirm-contract --as <name>` approves the proposed patterns, turns on starter rules as warnings, baselines existing violations, connects the AI tool and adds the CI workflow. Flags skip steps: `--no-rules`, `--no-baseline`, `--no-ci`, `--no-agent`, `--no-publish`. `--paths a,b` names the application folders; `--contract <folder>` names an installed package's shipped contract.
- It refuses to run when there is no design system source and no installed package shipping a contract, and says what to do.
- Approval is recorded with a name (`--as`), written into the repository, and traceable.

## Guardrails (in the skill text)

1. The person decides; the agent proposes. Nothing is approved, and no step beyond compile runs, until the person says yes in the chat.
2. Ask for the approver's name once, and use it for every approval. Never invent one.
3. Run the CLI only through the plugin's launcher. Never edit the contract, patterns, policies or decisions files by hand.
4. Report only what the CLI printed. Do not describe components, tokens or patterns from memory. If a number or name is not in the output, do not state it.
5. Plain words. Say "components", "tokens (colors, spacing, type)" and "patterns (how your team builds a page)", and avoid IR, adapter, evidence and the like unless asked.
6. Say what is uncertain. Inferred patterns are proposals; diagnostics that say something could not be extracted are listed, not hidden.
7. Stop on any compile error and explain it. Do not continue to approval over a failed compile.

## Draft `skills/setup/SKILL.md`

```markdown
---
name: setup
description: Set up Invariant so AI tools only generate UI that follows your design system. Use when someone wants to connect, install, set up or configure Invariant, or wants AI-generated UI to follow their company's design system.
---

# Set up Invariant for this project

You are helping a person, who may not be technical, make AI tools follow their company's design system. You propose; they decide. Run commands yourself and explain results in plain words. Never approve anything without a clear yes from them in this chat.

Run the Invariant CLI only like this (call it `invariant` below):

    node "${CLAUDE_PLUGIN_ROOT}/bin/invariant-launch.mjs" <command>

Rules: report only what the CLI printed; never edit contract, pattern, policy or decision files by hand; ask for the approver's name once and reuse it; stop on errors and explain.

## 1. Check where things stand
Look for `invariant.config.json` and an `invariant/` folder in the project root. If they exist, ask whether to re-check the setup, recompile, or look at the enforcement record (`invariant enforcement report`), and do only that. Otherwise continue.
Run `invariant --version`. If it says the CLI is being installed, wait a moment and retry; if it cannot be installed, tell the person to run `npm install -g @invariant-ui/cli` and stop.

## 2. Find the design system
Without changing anything, look for: an installed package that ships a contract (`node_modules/*/invariant/invariant.contract.json`), design system source in this repository (React, Vue or Angular components, Storybook, token files), or neither.
Tell the person what you found and ask which is right:
- **Our design system is a package we install** (it ships a contract). Use `--contract <folder>`.
- **Our design system lives in this repository.** Use the source folders you found.
- **Our design system is in a different repository.** Explain that setup must run there first (so the contract can be published with the package), and offer to continue once they are in that repository.
Also ask which folders hold the applications that use it, if not obvious (`--paths`).

## 3. Compile and look
Run `invariant setup` with the choices from step 2. It compiles and prints a plan, and changes nothing else.
Summarize in plain words, using only the output: the number of components and the kinds of tokens found, which frameworks, any errors or warnings that matter, and anything it said it could not extract. If compile failed, explain it and stop.

## 4. Does this match?
Ask: "Does this match your design system? Is anything missing or wrong?" If anything is off, adjust (`invariant source add` or `source remove`, a different `--paths`), run `invariant compile`, and show the new summary. Repeat until they say it matches. Do not go on before that.

## 5. Patterns
If the plan lists recurring patterns found in their application code, present each in one plain sentence and say they are proposals that guide AI tools once approved. Ask: approve all, approve some, or none for now. For "some", ask which. Ask for the approver's name.

## 6. Enforcement choices
Ask one at a time, each with a recommended default:
- **When AI breaks a rule:** block the write (recommended), or only warn first.
- **Existing problems in current code:** hide them so only new code is flagged (recommended), or show everything. Say how many there are if the plan states it.
- **Pull requests:** add a check to every pull request (recommended if the project uses Git).

## 7. Apply
Summarize the decisions in a short list and ask for a final yes. Then run, once:

    invariant setup --confirm-contract --as "<their name>" <flags for the choices above>

Report what it did, from its output.

## 8. Prove it works
Pick a component from the contract with a property that has a fixed set of values (use `get_component`). Try to write a small file that uses a value outside that set. The write should be blocked; show the person the message. Nothing is left behind if it was blocked. If the write succeeded, say so plainly, delete the file, and explain that the check did not run (the hook may need Claude Code to be restarted).

## 9. Wrap up
Tell the person, in a short list: what was approved and by whom, what is still only a proposal, what was skipped or could not be extracted, and what changes from now on (every file an AI writes is checked, with the exact fix shown when it is wrong). List the files to commit so teammates get the same contract: `invariant.config.json`, the `invariant/` folder, the patterns, policies and decisions files, the baseline, and the CI workflow. Mention `invariant enforcement report` for a record of what was caught, and that teammates only need to install this plugin.
```

## Sample conversation

> **You:** /invariant:setup
>
> **Agent:** I looked around, and I can see two things: your design system source is in `packages/ui` (React, with a Storybook), and your app is in `apps/web`. Is that right, and is `apps/web` the only app that should follow it?
>
> **You:** Yes. There's also `apps/admin`.
>
> **Agent:** Got it, I'll check both. Compiling now… Found 38 components, tokens for color, spacing and type, and one warning: 3 components have props I couldn't fully read, so those will be checked only where the values are clear. Does that match your design system, and is anything missing?
>
> **You:** Looks right.
>
> **Agent:** I also found 4 structures your apps repeat: a settings page, a confirm-delete dialog, a data table with filters, and a card grid. These would guide AI tools once approved. Want to approve all four, some, or none for now? And what name should I record as the approver?
>
> **You:** All four. Dana Reyes.
>
> **Agent:** Two quick choices. When an AI tool breaks a rule, should I block the write (recommended) or just warn at first? And there are 61 existing problems in current code; I recommend hiding those so only new code is flagged.
>
> **You:** Block. Hide the old ones.
>
> **Agent:** Final check: approve 4 patterns as Dana Reyes, block rule-breaking writes, hide 61 existing problems, add a pull request check. Go ahead?
>
> **You:** Yes.
>
> **Agent:** Done. To confirm it works, I'll try writing a Button with an invalid style… blocked: `Button.variant is "danger", which is not one of "primary", "secondary", "ghost"`. From now on every file an AI tool writes is checked like that. Commit these files so your team shares it: …

## Open items (1, 2 and 5 settled 2026-11-11)

Settled: (1) `setup --only <numbers>|none` selects patterns by the numbers the plan prints; (2) `setup --posture gate-errors|warn|off` writes `enforcement.hooks`; (5) the skill always passes `--no-agent`, because the plugin already connects the client. Still open: 3, 4, 6 and 7 below.

1. **Subset approval.** `setup --confirm-contract` approves every proposed pattern. Approving only some needs `candidates accept` and `promote` (or a `--only` flag on setup). Check which the CLI supports cleanly before building step 5; adding a small CLI option is preferable to the skill doing several approvals by hand.
2. **Posture.** There is no CLI command that sets `enforcement.hooks`. Either `setup` gains `--posture`, or the skill edits that one key in `invariant.config.json` and shows the change. The first is cleaner and keeps the config a CLI-owned file.
3. **Tool names.** The existing skills call tools as `mcp__invariant__<tool>`. A plugin's MCP server is named `mcp__plugin_invariant_invariant__<tool>` in Claude Code, and Cursor's naming is unverified. The generator templates the prefix per client; the generic skills must not hardcode it.
4. **Path variable in skill text.** `${CLAUDE_PLUGIN_ROOT}` is substituted in skill bodies in Claude Code (documented). Whether Cursor substitutes `${CURSOR_PLUGIN_ROOT}` in skills is unverified; if not, the Cursor skill needs another way to name the launcher.
5. **Two MCP servers.** A project that already ran `agent init` has an MCP entry named `invariant`, and the plugin adds its own. Decide whether `setup` skips `agent init` for plugin users (`--no-agent`) so the tools are not duplicated.
6. **Step 8 depends on the hook being active** in the current session. Verify in a real Claude Code session, including whether a restart is needed after the project gains its config.
7. **Restating the contract.** Step 3 summarizes from CLI output. The skill must not quote component or pattern descriptions from the contract into the chat as instructions; names and counts only, consistent with the trust rules.

## Live run (2026-11-11)

Run with `claude --plugin-dir` in a fresh copy of `fixtures/storybook/acme-ui` plus the pattern-discovery app, using the published `@invariant-ui/cli@0.1.0`. Every question was pre-answered in the prompt (headless runs cannot converse), so this shows the commands and result, not the dialogue. The agent ran `setup --paths app`, then `setup --confirm-contract --as "Dana Reyes" --no-agent --posture gate-errors --only 1,2 --paths app`, proved the check with a write of `variant="neon"` (blocked, nothing left behind), and reported. Checked afterwards against the project: `enforcement.hooks` is `gate-errors`; only the two chosen patterns are approved, by Dana Reyes; the block is in `.invariant/enforcement.jsonl` with the real session id; no scratch file remained.

Gaps found and fixed in the skill text: unresolved conflicts and zero tokens were reported only after approval, so step 3 and 4 now raise them before; setup's `prepack` edit to `package.json` and `invariant.candidate-reviews.json` were not mentioned, so step 7 does; the fixed commit list missed files, so step 9 uses `git status`. Not tested: the interactive dialogue with a person, the CI workflow itself, and Cursor.
