<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="site/assets/logo-wordmark.svg">
    <source media="(prefers-color-scheme: light)" srcset="site/assets/logo-wordmark-light.svg">
    <img alt="Invariant" src="site/assets/logo-wordmark-light.svg" width="280">
  </picture>
</p>

<p align="center"><strong>Turn your design system into a contract that AI agents can read and check.</strong></p>

<p align="center">
  <a href="https://invariant-ui.com/">Website</a> &middot;
  <a href="https://invariant-ui.com/docs/">Documentation</a> &middot;
  <a href="docs/specifications">Specifications</a>
</p>

Invariant scans your existing design system (React, Vue, Angular, Storybook, design tokens) and compiles it into one machine-readable file: the **contract**. AI coding tools then use that contract to learn which components, props and tokens really exist, and to check that generated code follows them.

No cloud service, no account, no network access. Everything runs locally.

---

## Why use it?

AI assistants guess at design systems. They invent props, hard-code colors and use the wrong component. Invariant gives them the facts:

- **Accurate.** Components, props, events and tokens are extracted from your source code, not made up by an LLM.
- **Traceable.** Every fact points back to the file and line it came from.
- **Honest.** Each fact is labeled `discovered`, `documented`, `inferred` or `approved`. Guesses are never passed off as facts, and conflicting sources are reported, not hidden.
- **Portable.** The contract is plain JSON. It doesn't depend on a frontend framework or on MCP.
- **Safe.** Your code is analyzed statically. Nothing from your project is executed.

## How it works

```
 Your sources                 Invariant                    Consumers
┌──────────────┐        ┌───────────────────┐        ┌────────────────────┐
│ React / Vue  │        │ 1. Discover       │        │ AI agents (MCP)    │
│ Angular      │  ───▶  │ 2. Extract to IR  │  ───▶  │ CLI queries        │
│ Storybook    │        │ 3. Reconcile      │        │ Usage validation   │
│ Token files  │        │ 4. Write contract │        │ HTML report        │
└──────────────┘        └───────────────────┘        └────────────────────┘
```

Each source adapter turns what it finds into a shared intermediate representation (IR). A framework-independent compiler then merges those into the contract.

## Requirements

- Node.js 20 or newer to run it. To work on Invariant itself: Node 24 (see `.nvmrc`) and [pnpm](https://pnpm.io).

## Quick start

Fastest path, with nothing to install first. In your project:

```bash
npx @invariant-ui/cli setup
```

It compiles your design system, finds the patterns your code already repeats, and shows one plan. Answer yes once and it approves the patterns, turns on starter rules (as warnings), connects your AI tool, baselines existing violations and adds a GitHub Action. In a design system repository it also makes the published package carry the contract. Nothing is approved until you confirm the contract. To keep the command, run `npm install -g @invariant-ui/cli`, then `invariant setup`.

From a source checkout, or one step at a time:

```bash
# 1. Install and build (from a source checkout)
pnpm install
pnpm build

# 2. Go to the project you want to analyze and create a config
pnpm invariant init --cwd /path/to/your/project

# 3. Compile the contract
pnpm invariant compile --cwd /path/to/your/project

# 4. Explore it
pnpm invariant components list --cwd /path/to/your/project
pnpm invariant components inspect Button --cwd /path/to/your/project
pnpm invariant tokens list --cwd /path/to/your/project
```

`pnpm invariant` runs `node apps/cli/dist/main.js`.

Compiling writes these files to the `invariant/` folder:

| File | What it is |
|---|---|
| `invariant.contract.json` | The contract (the source of truth) |
| `invariant.evidence.json` | Where each fact came from |
| `invariant.diagnostics.json` | Anything unsupported, incomplete or wrong |
| `invariant.review.json` | Conflicts and guesses waiting for a human decision |
| `invariant.report.html` | A static, self-contained summary for people |
| `invariant.manifest.json` | Tool version and a hash of every file |

Compiling unchanged sources gives identical output, so the files are safe to commit and diff.

## Use it in your project

- **The design system is in your repo** (a package in a monorepo, or the repo itself): run `npx @invariant-ui/cli setup` at the root.
- **Your app uses a design system from npm:** the design system's repo compiles a contract and publishes its `invariant/` folder with the package. In your app, install the package and run `npx @invariant-ui/cli setup`. It finds the shipped contract, adds your own patterns on top, and writes a config with `"extends": { "contract": "node_modules/<package>/invariant" }`. `verify --fresh` flags the contract as stale when you upgrade the library.

## Configuration

`invariant init` writes `invariant.config.json` for you. You can also edit it by hand:

```json
{
  "name": "Acme Design System",
  "contractId": "acme-design-system",
  "sources": [
    { "id": "ui-library", "type": "react", "path": "packages/ui" },
    { "id": "storybook", "type": "storybook", "path": "packages/ui" },
    { "id": "tokens", "type": "tokens" }
  ],
  "output": { "directory": "invariant" }
}
```

Supported source types: `react`, `vue`, `angular`, `storybook`, `tokens`. Figma and zeroheight are not supported yet.

Add sources from the command line with `invariant source add <type> [path]`.

Optional sections: `validation` (see `invariant rules`; `ignore` globs, `rules` severity overrides, `failOn`), `governance` (approver lists and the governance files' paths) and `enforcement` (`hooks`: `gate-errors` by default, `warn` or `off` — what the Claude Code hooks do when an agent writes code that breaks the contract).

## Commands

| Command | What it does |
|---|---|
| `init` | Detect your project and write `invariant.config.json` |
| `source add` / `source remove` / `source list` | Manage configured sources |
| `analyze` | Extract and print what was found, without building a contract |
| `compile` | Run the full pipeline and write the contract and other files (`--watch` recompiles on change) |
| `components list` / `components inspect <name>` | Browse components (add `--evidence` to see source locations) |
| `tokens list`, `conflicts list` | Browse tokens and conflicts |
| `patterns list` / `inspect` / `resolve` / `search` / `relationships` | Browse patterns: parts, states, constraints, relationships, approval status and evidence; `resolve` reads a page archetype with everything it composes |
| `browser run` | Opt-in: check a running app in a headless browser (needs Playwright in your project). Runtime results, kept apart from `validate` |
| `setup` | One command: detect sources, compile, show what was found, propose patterns from your code, connect your AI tool, baseline existing violations and offer a GitHub Action that checks every pull request commit. Asks a few questions; nothing is approved until you confirm the contract |
| `discover <path...>` | Find structures that recur in your application code and write them as candidates to review. Nothing it finds is approved or enforced |
| `candidates list\|show\|accept\|reject\|defer\|promote` | Review candidates; `promote` adds an accepted one to `invariant.patterns.json` without approving it |
| `validate <path...>` | Check your application code against the contract and the structural rules of approved patterns |
| `verify` | Check the compiled output is intact (add `--fresh` to also detect stale sources and see what changed) |
| `rules`, `policy list` | List validation rules and approved policies |
| `review list\|show\|approve\|reject\|resolve\|accept\|dismiss` | Record human decisions on conflicts and inferred facts |
| `mcp` | Serve the contract to AI tools over stdio (read-only) |
| `hook` | Check an agent's Write/Edit against the contract and answer in its hook format (Claude Code runs this for you) |
| `agent init <client\|all>` | Write MCP config, skills, rules and enforcement hooks for Claude Code, Cursor, Codex and Windsurf |
| `export --to <dir>` | Copy the verified artifacts and JSON Schemas elsewhere |

Read commands accept `--json`. Global options: `--cwd`, `--config`, `--dir`, `--trust-config`.

Exit codes: `0` success, `1` findings or invalid output, `2` bad usage or input.

## Use it with an AI agent

```bash
invariant compile
invariant agent init claude-code   # or cursor, codex, windsurf, all
```

With Claude Code, you watch the contract being enforced. Ask an agent for a settings page with a delete button and every file it writes is checked before it lands:

![An agent is blocked three times, then passes: the enforcement loop in the terminal](docs/demo/enforcement-loop.gif)

```text
1. invariant blocked app/pages/Settings.tsx: 1 error against the @acme/ui contract
   ✗ prop-value-not-allowed: Button.variant is "danger", which is not one of "primary", "secondary", "ghost" (line 8)
       fix: Use one of "primary", "secondary", "ghost".
2. ✗ color-not-in-tokens: #ff0000 is a literal color that is not the value of any token (line 8)
3. ✗ pattern-required-child-missing: Modal at line 11 has no Button (pattern pattern:page.settings) (line 11)
4. invariant ✓ app/pages/Settings.tsx follows the @acme/ui contract (6 component uses checked)
```

Run `pnpm demo` in a checkout to replay exactly that, and `invariant enforcement report` (add `--format html --to report.html`) to get a forwardable timeline: `4 writes checked · 3 violations caught · 3 fixed · 0 outstanding`. See [See it working in your agent chat](https://invariant-ui.com/docs/#enforcement).

`agent init` installs the hooks for Claude Code: a write that would introduce an error-severity violation is blocked with the exact finding and fix; warnings show up right after the write; clean passes get a green line in the chat. The hooks fail open (if invariant cannot run, the write proceeds) and respect your baseline and rule overrides. Set `enforcement.hooks` to `warn` or `off` in `invariant.config.json` to soften or disable this.

| Client | How the contract is applied | Blocks a write |
| --- | --- | --- |
| Claude Code | Hooks on Write and Edit, plus MCP and skills | Yes |
| Cursor | MCP and rules; the agent is asked to validate | No |
| Codex, Windsurf | MCP and rules; the agent is asked to validate | No |
| Any client | `invariant validate` in CI | At pull request time |

The MCP server is read-only and gives the agent tools such as `get_component`, `get_design_tokens`, `search_design_system` and `validate_component_usage`. After a recompile, the server picks up the new contract without a restart. Whether the agent calls `validate_design_system_compliance` itself or a hook fires on its write, the chat shows the same enforcement card: the findings, the fixes, and what to do next. The enforcement report records hook checks only, not the agent's own MCP calls.

Contract text comes from your source and docs, so the server marks every result as untrusted content. Generated agent config never includes free-form descriptions from your code.

## Repository layout

```
apps/
  cli/                   The `invariant` command
packages/
  compiler-ir/           Shared intermediate representation
  compiler-core/         Pure compiler: IR to contract
  compiler-react/        React adapter
  compiler-vue/          Vue adapter
  compiler-angular/      Angular adapter
  compiler-storybook/    Storybook adapter
  compiler-tokens/       Design token adapter
  contract/              Contract schema and validation
  contract-query/        Read API over a compiled contract
  reconciliation/        Merging sources and surfacing conflicts
  semantic-engine/       Classification and inference, with evidence
  validation/            Usage validators and rules, and pattern discovery
  browser-verify/        Opt-in runtime checks in a browser
  governance/            Approvals, policies and decisions
  artifact-generator/    Writes the output files
  mcp/                   MCP server
  agent-kit/             Client configs, skills and rules
  shared/                Shared utilities and structured diagnostics
fixtures/                Test projects and golden files
docs/                    Architecture, ADRs and specifications
```

## Development

```bash
pnpm build             # tsc -b
pnpm test              # vitest
pnpm lint              # biome
pnpm typecheck
pnpm check:boundaries  # enforce package boundaries
pnpm verify            # lint + typecheck + boundaries + build + test
pnpm update:golden     # regenerate golden fixtures
```

## Documentation

- [Website](https://invariant-ui.com/) and [documentation site](https://invariant-ui.com/docs/)
- [System architecture](docs/architecture/system-architecture.md)
- [Pattern definitions](docs/specifications/pattern-definitions-v1.md): write layouts, interactions and page archetypes in `invariant.patterns.json`
- [Browser verification](docs/specifications/browser-verification-v1.md): opt-in runtime checks for focus, keyboard order, rendered composition and responsive layout
- [Pattern discovery](docs/specifications/pattern-discovery-v1.md): find recurring structures in your code and review them as candidates
- [ADR 0001: Foundational architecture](docs/decisions/0001-architecture.md)
- Specifications in [`docs/specifications/`](docs/specifications): [CLI](docs/specifications/cli-v1.md), [contract](docs/specifications/contract-v1.md), [MCP and agents](docs/specifications/mcp-and-agents-v1.md), [validation and governance](docs/specifications/validation-and-governance-v1.md), and more

## License

Invariant is source-available under the [Functional Source License, Version 1.1, ALv2 Future License](LICENSE) (FSL-1.1-ALv2).

You can read, run, modify and redistribute it for any purpose except a Competing Use: offering it in a commercial product or service that substitutes for Invariant or offers the same or similar functionality. Internal use, non-commercial education and research, and professional services for a licensee are always allowed.

Each version converts to Apache-2.0 two years after it is released.

Copyright 2026 Matt Carlucci.

## Principles

- The contract is the single source of truth.
- Extract deterministically. LLMs may help classify, but never supply APIs, props or token values.
- Keep evidence for every fact.
- Never hide conflicts, and never turn a guess into an approved rule automatically.
