# CLI and artifacts (v1)

Status: implemented in `apps/cli` (plan Phase 8). Run it with `pnpm build && pnpm invariant <command>` (that is `node apps/cli/dist/main.js`). The CLI works from a local checkout with no account, network access, or cloud service.

## Commands

| Command | What it does |
|---|---|
| `init` | Runs project discovery and writes `invariant.config.json` with a detected source per framework package, Storybook, and token files. A repository with more than five packages of one framework gets one whole-project entry for it. Refuses to overwrite without `--force`. |
| `source add <type> [path] [--id id]` | Adds an entry to JSON configuration. Checks the type, that the path is a directory inside the project, and that the id is unique. |
| `source remove <id>` | Removes the entry with that id from JSON configuration. An unknown id lists the configured ids. |
| `source list` | Lists configured sources. |
| `analyze` | Discovers and extracts every source to IR, prints what was found and the diagnostics, writes the IR and project summary to `<output>/analysis/`. Builds no contract. |
| `compile` | The full pipeline: discover, extract, reconcile, enrich, verify. Writes the artifacts below. Exits 1 if any diagnostic is an error; the files are still written so the problem can be inspected. `--watch` compiles once, then recompiles after changes settle (250 ms quiet period) until Ctrl+C. It watches the project directory recursively and ignores the output directory, `node_modules`, `.git` and similar, so writing artifacts never triggers a cycle. Each cycle recompiles all sources and re-reads the configuration; a broken configuration or failed compile prints the error and keeps watching. Changes that arrive during a compile trigger exactly one more run. With `extends.contract` in the config (an app that uses a design system from a package), it starts from that shipped contract instead of reading sources: its components, tokens, patterns, evidence and approvals are kept, and this project's own pattern, policy and decision files are applied on top. `verify --fresh` recompiles the same way, so a new library version is reported as stale. A config with no sources and no `extends` is refused, and so is an `extends` folder with no contract. |
| `components list`, `components inspect <name\|id>` | Reads the compiled contract. `inspect` shows implementations, props with status, events, slots, variants, composition, conflicts; `--evidence` adds the source location of each fact. |
| `tokens list`, `conflicts list` | Reads the compiled contract. Inferred token categories are marked `*`. `conflicts list` filters with `--severity`, `--type`, `--subject`. |
| `patterns list\|inspect\|search\|relationships` | Reads the pattern definitions in the compiled contract. `list` filters with `--category` and `--status`; the status is derived from the pattern's facts, and a pattern that is not fully approved is marked `*`. `inspect <name\|id>` shows parts, regions, states and transitions, constraints, relationships, the policies that enforce it, and whether it is approved; `--evidence` adds the source of every fact. `resolve <name\|id> [--variation name]` reads a pattern as a page blueprint: regions with their parts, the composition followed through composed patterns, variations, required interaction states (and whether a policy enforces each), responsive expectations, prohibited combinations, and which of what it builds on is not approved. `search <query>` ranks patterns by name, intent, parts, regions and states. `relationships <name\|id>` shows edges in both directions by default (`--direction out\|in\|both`, `--depth 1-5`). A name may be an id, the id without its prefix, the part after the category (`data-management`), or the pattern's name. `--json` works on each; `list --json` still prints the patterns as written in the contract. Where no pattern is defined, they say so. `patterns validate` does not exist yet: enforcement arrives with structural validation. |
| `browser run` | Opt-in runtime checks of a running app in headless Playwright (not installed by Invariant). Reads `invariant.browser.json` (`--spec`), `--browser chromium\|firefox\|webkit`, `--url` overrides `baseUrl`. Writes `<output>/invariant.browser-results.json` (runtime results with browser, version, viewport, URL). Exit 1 on any fail or error, 2 if Playwright is missing or the spec is bad. See `browser-verification-v1.md`. |
| `setup [--yes] [--confirm-contract] [--as name] [--paths a,b] [--contract dir] [--no-agent] [--ci|--no-ci] [--no-rules] [--no-publish]` | Compiles (running `init` if there is no config), then plans and asks once. **Compile:** with no design system source in the project (or with `--contract`), it uses a contract shipped by an installed package (`node_modules/<package>/invariant/`), asks which if there are several, writes a config with `extends.contract`; with none it stops and creates nothing. **Look:** it finds recurring structures in `src`, `app`, `pages` and `apps` (or `--paths`), skipping a folder that holds the design system's own components, counts existing violations, and notes the AI tools (`.claude`, `.cursor`, `.codex`, `.windsurf`), a possible GitHub Action (a folder with `.git` or `.github`, or `--ci`), and, in a design system repository, publishing. **Ask once:** it prints the plan and asks `Looks right? [Y/n, or c to choose each step]`. Yes confirms the contract and does the whole plan. `n` stops with nothing added. `c` asks about each step. **The plan:** add the top five patterns (via `discover`, `candidates accept` and `promote`); approve them as the person (`--as`, `INVARIANT_USER` or `git config user.name`, recorded, not authenticated); turn on starter rules; hide existing violations in `invariant.baseline.json`; connect the AI tools; write `.github/workflows/invariant.yml`; and wire publishing. **Approval is gated:** patterns are approved and starter rules turned on only if the contract was confirmed (yes, or `--confirm-contract`). `--yes` takes the other defaults but never confirms, so patterns are added unapproved and no rule is turned on. No terminal and no `--yes`: it asks nothing and adds nothing. **Starter rules** restate what an observed arrangement did every time: a parent contains its non-optional children, and they come in the same order. They are written as `required-child` and `ordering` constraints on the approved pattern, scoped to the app folders, at warning severity and `warn` enforcement, so they annotate new code and do not fail a build until a person raises them. Arrangements with optional, repeated or open-ended children yield no rule for them. `--no-rules` skips them. **Publishing:** in a design system repository (not a consumer, not a private package), `setup` finds the package that holds the framework source (or the root) and adds `invariant` to its `files` (if it lists files) and a `prepack` script that runs `npx invariant-ui@<version> compile` (a package at the repository root) or, for a package in a monorepo, compiles at the root and `export`s into the package's `invariant/` folder. It leaves an existing `prepack` alone, skips a private package, and warns if `.gitignore` or `.npmignore` ignores `invariant/`. `--no-publish` skips it. **CI:** the workflow runs on `pull_request` (opened, synchronize, reopened) and pushes to `main`, runs `npx invariant-ui@<this version> verify --fresh` and `validate <app folders> --format github` with `contents: read` and no secrets, and in a consumer project installs dependencies first; an existing file is never overwritten. |
| `discover <path...>` | Finds structures that recur in React code (`.tsx`, `.jsx`) and writes them to `<output>/invariant.candidates.json`. Needs a compiled contract. Options: `--min-files` (default 3), `--min-uses` (3), `--similarity` (0.7), `--depth` (3). Prints a summary and diagnostics; `--json` prints the file. Identical input gives identical bytes. Other file types are skipped and counted. See `pattern-discovery-v1.md`. |
| `candidates list\|show\|accept\|reject\|defer\|promote` | `list` (`--status`, `--kind`, `--all` to include candidates inside larger ones) and `show <id>` (why, evidence, what varies) read the candidates file with recorded decisions applied; an id may be written without `candidate:` or as its hex suffix. `accept\|reject\|defer <id> --as <name> [--note] [--reference]` appends to `invariant.candidate-reviews.json`. `promote <id> --id <pattern id> --as <name> [--name] [--category] [--dry-run]` needs an accepted candidate and adds an unapproved definition with provenance to `invariant.patterns.json`. |
| `validate <path...>` | Checks application code against the compiled contract, including the structural rules of approved patterns; see `validation-and-governance-v1.md`. Pattern checks that cannot be established are listed as not verifiable and do not fail the run. `--update-baseline` writes `invariant.baseline.json` (existing violations by file, rule and message, with counts, not line numbers) and exits 0. While that file exists, matching violations are hidden, a note on stderr says how many, and a violation beyond the recorded count still fails. `--no-baseline` shows everything. |
| `verify` | Checks the compiled output without the sources: contract structure, cross-references, approval fingerprints, content hash, evidence ids, and every file's hash against the manifest. `--fresh` also recompiles; if the sources changed it reports `verify.stale` and then says what changed: per collection (components, tokens, sources and so on) the counts added, removed and changed, and each entity id with the top-level fields that differ. `--json` adds the same data as `changes`. |
| `rules`, `policy list` | Lists validation rules; lists approved policies. |
| `review list\|show\|approve\|reject\|resolve\|accept\|dismiss` | Records human decisions in `invariant.decisions.json`, applied at compile. The queue lists open conflicts, inferred facts, and the unapproved facts of patterns written in `invariant.patterns.json` (kind `pattern-fact`, which `approve` accepts and `reject` refuses). |
| `mcp` | Serves the compiled contract to AI tools over stdio (read-only). See `mcp-and-agents-v1.md`. |
| `agent init <client\|all>`, `agent list` | Writes MCP configuration, skills and rules for Claude Code, Cursor, Codex and Windsurf. |
| `export --to <dir>` | Verifies, then copies the artifacts plus `schema/` (the contract and evidence JSON Schemas and the pattern-definitions schema) to a directory. Refuses an invalid output, a non-empty target, or the output directory itself unless `--force`. |

Read commands accept `--json`. Global options: `--cwd`, `--config`, `--dir` (output directory), `--trust-config`.

Phase 10 renamed the former `validate` to `verify`.

Exit codes: 0 success, 1 findings or invalid output, 2 bad usage or input.

## Configuration

`invariant.config.json`, read as data:

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

- `type` is one of `react`, `vue`, `angular`, `storybook`, `tokens`. `zeroheight` and `figma` are rejected with a message that they are not supported yet.
- `path` limits an entry to sources found at or below that directory. Without it, the entry covers the whole project. Several entries of one type are combined. A type with no entry is not run.
- The project root is the configuration's directory, so files keep one set of project-relative paths. That is what lets a story link to its component by file and name.
- `id` is a label. Compiled source ids come from the adapters; `compile` and `analyze` print which compiled sources each entry produced, and a warning (`cli.source-matched-nothing`) when an entry matched none.
- All paths must be relative, with no `..`, no absolute paths, no backslashes. The output directory defaults to `invariant`.
- The neutral inventory adapters (packages, Markdown documentation, token files, Storybook configuration) always run.

**Code configuration.** `invariant.config.ts`, `.mts`, `.mjs` or `.js` with a default export is supported, but loading one executes it. It is only loaded with `--trust-config`, and `source add` and `source remove` never edit it: they stop and say to edit it by hand or to run `invariant init`, which writes `invariant.config.json`. A JSON file wins over code files, so it can replace a code configuration. Without the flag the CLI explains this and stops.

## Artifacts

`compile` writes to the output directory:

| File | Contents |
|---|---|
| `invariant.contract.json` | The canonical contract. |
| `invariant.evidence.json` | Evidence cited by the contract. |
| `invariant.diagnostics.json` | Every diagnostic from discovery, extraction, reconciliation, enrichment and verification. |
| `invariant.review.json` | `{ reviewVersion, items }`: open conflicts and inferred facts needing a decision. |
| `invariant.report.html` | A static summary for people. |
| `invariant.manifest.json` | Tool version, build time, compiled sources with input hashes, and the SHA-256 and size of every other artifact. |

`--keep-ir` adds `ir/` and `invariant.project.json`. Only the manifest holds the build time; all other files are reproducible, so recompiling unchanged sources gives identical bytes (tested). The contract stays canonical; the others support it.

The report is self-contained: no scripts, no external requests, a restrictive Content-Security-Policy, and every value from customer source HTML-escaped (tested with hostile names). Every table lists every row: the first 200 are visible and the rest sit in a `<details>` block, which needs no script.

## Safety

- Reads the project; writes only inside the output directory, and `export` only inside its `--to` directory. Artifact paths are checked against escaping.
- No customer code runs during analysis. The one exception is an explicitly trusted code configuration.
- `credentialRef`-style secrets have nowhere to go: configuration has no credential fields.

## Known limitations

- No incremental compile: every run, including each `compile --watch` cycle, recompiles all sources (Radix takes about 2.5 s, reka-ui about 1.5 s).
- `source add` and `source remove` cannot edit a code configuration, by design: editing it would mean running it.
- `init` detects by package manifests and discovery; unusual layouts need `source add` or hand edits.
