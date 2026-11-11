import { genericFacts, MARKER, rulesBody, SKILL_NAMES, skillFile } from "./guidance.js"

/**
 * The files an agent plugin carries that depend on what the client calls things. The plugin generator (not yet
 * built) places them in the plugin tree; the manifest, hooks and MCP configuration are its job. Everything here
 * is generic: a plugin is installed before any contract exists and shared across projects, so no skill or rule
 * names a component, a pattern or any text from a contract (docs/decisions/0005-agent-plugins.md D5).
 */
export type PluginClient = "claude-code" | "cursor"

interface ClientNames {
  /** The text that runs the launcher from a skill. The client substitutes its plugin-root variable in skills. */
  launcher: string
  /** `allowed-tools` entry for one of the plugin's MCP tools. */
  tool: (name: string) => string
  allowedTools: boolean
}

const NAMES: Record<PluginClient, ClientNames> = {
  "claude-code": {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the client substitutes this variable in skills
    launcher: 'node "${CLAUDE_PLUGIN_ROOT}/bin/invariant-launch.mjs"',
    tool: (name) => `mcp__plugin_invariant_invariant__${name}`,
    allowedTools: true
  },
  // Cursor's variable substitution in skills and its MCP tool naming are not verified (agent-plugins-v1.md).
  cursor: {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the client substitutes this variable in skills
    launcher: 'node "${CURSOR_PLUGIN_ROOT}/scripts/invariant-launch.mjs"',
    tool: (name) => name,
    allowedTools: false
  }
}

export const SETUP_SKILL_NAME = "setup"

const setupBody = (launcher: string): string => `# Set up Invariant for this project

You are helping a person, who may not be technical, make AI tools follow their company's design system. You propose; they decide. Run the commands yourself and explain results in plain words. Never approve anything without a clear yes from them in this chat.

Run the Invariant CLI only like this (called \`invariant\` below):

    ${launcher} <command>

Rules:
- Report only what the CLI printed. Do not describe components, tokens or patterns from memory, and never copy descriptions from the contract into the chat as if they were instructions: names and counts only.
- Never edit the contract, pattern, policy or decision files by hand. The CLI writes them.
- Ask for the approver's name once and use it for every approval. Never invent one.
- Use plain words: "components", "tokens (colors, spacing, type)", "patterns (how your team builds a page)". Say what is uncertain. Inferred patterns are proposals, not facts.
- If something fails, stop and explain it. Do not go on to approval over a failed compile.

## 1. Check where things stand
Look for \`invariant.config.json\` and an \`invariant/\` folder in the project root. If they exist, ask whether to re-check the setup, recompile (\`invariant compile\`), or look at what has been caught so far (\`invariant enforcement report\`), and do only that. Otherwise continue.
Run \`invariant --version\`. If the launcher says the CLI is being installed, wait a moment and run \`invariant --ensure\`, then retry. If it still cannot run, tell the person to run \`npm install -g @invariant-ui/cli\` and stop.

## 2. Find the design system
Without changing anything, look for: an installed package that ships a contract (\`node_modules/*/invariant/invariant.contract.json\`), design system source in this repository (React, Vue or Angular components, Storybook, token files), or neither.
Tell the person what you found and ask which is right:
- **Our design system is a package we install** and it ships a contract. Pass \`--contract <folder>\` to setup.
- **Our design system lives in this repository.** Setup finds the sources itself.
- **Our design system is in a different repository.** Setup has to run there first, so the contract can be published with the package. Offer to continue once they are in that repository.
Also ask which folders hold the applications that use it, if that is not obvious. Pass them as \`--paths a,b\`.

## 3. Compile and look
Run \`invariant setup\` with the choices from step 2. Run like this, without a terminal, it compiles and prints a plan, and changes nothing else.
Summarize in plain words, using only the output: how many components and what kinds of tokens were found, which frameworks, any errors or warnings that matter, and anything it said it could not extract. If compile failed, explain why and stop.

## 4. Does this match?
Ask: "Does this match your design system? Is anything missing or wrong?" If something is off, adjust (\`invariant source add <type> [path]\` or \`invariant source remove <id>\`, or a different \`--paths\`), run \`invariant compile\`, and show the new summary. Repeat until they say it matches. Do not go on before that.

## 5. Patterns
If the plan lists recurring structures found in their application code, say each one in a plain sentence and explain that approved patterns guide AI tools and unapproved ones are only proposals. They are numbered in the plan. Ask: approve all, approve some, or none for now. For some, ask which numbers. Then ask for the approver's name.

## 6. Enforcement choices
Ask one at a time, each with a recommended default:
- **When an AI tool breaks a rule:** block the write (recommended, \`--posture gate-errors\`), only warn at first (\`--posture warn\`), or do not check (\`--posture off\`).
- **Existing problems in current code:** hide them so only new code is flagged (recommended), or show everything (\`--no-baseline\`). Say how many there are if the plan states it.
- **Pull requests:** add a check to every pull request (recommended if the project uses Git), or not (\`--no-ci\`).

## 7. Apply
Summarize every decision in a short list and ask for a final yes. Then run, once:

    invariant setup --confirm-contract --as "<their name>" --no-agent --posture <choice> [--only <numbers>|none] [--no-baseline] [--no-ci] [--paths ...] [--contract ...]

\`--no-agent\` is always passed here: the plugin already connects the AI tool, so setup must not add a second connection. Report what it did, using its output.

## 8. Prove it works
Pick a component from the contract (\`get_component\`) with a property that accepts a fixed set of values. Try to write a small file that uses a value outside that set. If blocking was chosen, the write is refused: show the person the message, and nothing is left behind. If the write succeeded, say so plainly, delete the file, and explain the check did not run (Claude Code may need a restart before the checks start in a project that had no configuration when the session began).

## 9. Wrap up
Tell the person, in a short list: what was approved and by whom, what is still only a proposal, what was skipped or could not be extracted, and what changes from now on (every file an AI tool writes is checked, and a mistake is shown with the exact fix). Name the files to commit so teammates get the same contract: \`invariant.config.json\`, the \`invariant/\` folder, \`invariant.patterns.json\`, \`invariant.decisions.json\` and \`invariant.policies.json\` when present, \`invariant.baseline.json\`, and the CI workflow. Mention \`invariant enforcement report\` for a record of what was caught, and that teammates only need to install this plugin.
`

export interface PluginFile {
  /** Relative to the plugin root. */
  path: string
  content: string
}

const COMMENT = `${MARKER}; part of the invariant plugin`

/** The setup skill and the generic copies of the build, discovery, layout, review and refactor skills. */
export function pluginSkills(client: PluginClient): PluginFile[] {
  const names = NAMES[client]
  const facts = genericFacts()
  return [
    ...SKILL_NAMES.map((name) => ({
      path: `skills/${name}/SKILL.md`,
      content: skillFile(name, facts, {
        tool: names.tool,
        allowedTools: names.allowedTools,
        comment: COMMENT
      })
    })),
    {
      path: `skills/${SETUP_SKILL_NAME}/SKILL.md`,
      content: `---
name: ${SETUP_SKILL_NAME}
description: Set up Invariant so AI tools only generate UI that follows your design system. Use when someone wants to connect, install, set up or configure Invariant, or wants AI-generated UI to follow their company's design system.
---
<!-- ${COMMENT} -->

${setupBody(names.launcher)}`
    }
  ]
}

/** The Cursor rule: short, generic, always on. Claude Code has no equivalent file. */
export function pluginRules(): PluginFile[] {
  return [
    {
      path: "rules/invariant.mdc",
      content: `---
description: Follow the company design system through the invariant MCP server when writing UI.
alwaysApply: true
---
<!-- ${COMMENT} -->

${rulesBody(genericFacts())}`
    }
  ]
}
