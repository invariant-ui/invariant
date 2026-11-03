<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="site/assets/logo-wordmark.svg">
    <source media="(prefers-color-scheme: light)" srcset="site/assets/logo-wordmark-light.svg">
    <img alt="Invariant" src="site/assets/logo-wordmark-light.svg" width="280">
  </picture>
</p>

<p align="center"><strong>Turn your design system into a contract that AI agents can read and check.</strong></p>

<p align="center">
  <a href="https://mcarlucci.github.io/invariant/">Website</a> &middot;
  <a href="https://mcarlucci.github.io/invariant/docs/">Documentation</a> &middot;
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

- Node.js 24 or newer (see `.nvmrc`)
- [pnpm](https://pnpm.io)

## Quick start

```bash
# 1. Install and build
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

## Commands

| Command | What it does |
|---|---|
| `init` | Detect your project and write `invariant.config.json` |
| `source add` / `source remove` / `source list` | Manage configured sources |
| `analyze` | Extract and print what was found, without building a contract |
| `compile` | Run the full pipeline and write the contract and other files (`--watch` recompiles on change) |
| `components list` / `components inspect <name>` | Browse components (add `--evidence` to see source locations) |
| `tokens list`, `patterns list`, `conflicts list` | Browse tokens, patterns and conflicts |
| `validate <path...>` | Check your application code against the contract |
| `verify` | Check the compiled output is intact (add `--fresh` to also detect stale sources and see what changed) |
| `rules`, `policy list` | List validation rules and approved policies |
| `review list\|show\|approve\|reject\|resolve\|accept\|dismiss` | Record human decisions on conflicts and inferred facts |
| `mcp` | Serve the contract to AI tools over stdio (read-only) |
| `agent init <client\|all>` | Write MCP config, skills and rules for Claude Code, Cursor, Codex and Windsurf |
| `export --to <dir>` | Copy the verified artifacts and JSON Schemas elsewhere |

Read commands accept `--json`. Global options: `--cwd`, `--config`, `--dir`, `--trust-config`.

Exit codes: `0` success, `1` findings or invalid output, `2` bad usage or input.

## Use it with an AI agent

```bash
invariant compile
invariant agent init claude-code   # or cursor, codex, windsurf, all
```

This registers a read-only MCP server that gives the agent tools such as `get_component`, `get_design_tokens`, `search_design_system` and `validate_component_usage`. After a recompile, the server picks up the new contract without a restart.

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
  validation/            Usage validators and rules
  governance/            Approvals, policies and decisions
  artifact-generator/    Writes the output files
  mcp/                   MCP server
  agent-kit/             Client configs, skills and rules
  diagnostics/           Structured diagnostics
  shared/                Shared utilities
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

- [Website](https://mcarlucci.github.io/invariant/) and [documentation site](https://mcarlucci.github.io/invariant/docs/)
- [System architecture](docs/architecture/system-architecture.md)
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
