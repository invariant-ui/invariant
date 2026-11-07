# Primitiv analysis

Status: reconnaissance, pre-implementation.
Subject: https://github.com/AI-by-design/primitiv, cloned at commit `9b95d2c` (package version 2.21.2, Apache-2.0).

## Method and limits

I read the repository source, not just the README. Read in depth: `AGENTS.md`, `src/types.ts`, `src/contract/contract.ts`, the head of `src/contract/component-reconciliation.ts`, the entry points of the scanner, the Figma and Storybook adapters, the inferrer, `src/verify/verify.ts` (head), and the MCP tool registration list.

Not read in depth, so no claims are made about them: `src/rationale/*`, `src/discovery/*` internals, `src/lint/*`, `src/init/*` beyond framework detection, the Storybook static-value extraction, and the test suites. Any statement below about those areas is limited to what the file names and `AGENTS.md` say.

Source capabilities in this document were checked against Primitiv's code. External tool capabilities (Figma, Storybook, zeroheight, Vue, Angular) were checked against official documentation on 2026-10-30; see `system-architecture.md` for those.

## What Primitiv is

A single npm package (`@ai-by-design/primitiv`) with a CLI (`init`, `build`, `serve`, `verify`) and an MCP server. Data flow, from `AGENTS.md`:

```
Config -> scan() per source -> ContractBuilder.build() -> primitiv.contract.json -> MCP server
```

Stack: TypeScript strict, CommonJS output via `tsc`, Babel parser (`@babel/parser` ^8), `zod`, `glob`, `yaml`, `@modelcontextprotocol/sdk`, bun test, Biome.

## Contract model

Defined in `src/types.ts` (879 lines, "all shared types live here").

`PrimitivContract` fields: `version` ("0.3.0"), `generatedAt`, `sources`, `sourceRoot`, `configPath`, `tokens`, `components`, `componentNameIndex`, `componentNameResolutions`, `conflicts`, `inferredRules`, `violations`, `sourceStatuses`, `guidanceHealth`, `comparisonDiagnostics`.

- **Tokens** are a fixed-category map (`colors`, `spacing`, `sizes`, `typography`, `borderRadius`, `shadows`, `zIndex`, `breakpoints`, `motion`; `other` is created lazily). A token carries a single `value`, optional `modes` (theme variants), `references`, `rationale`, and a `source: SourceProvenance`.
- **Components** are keyed by a qualified id: codebase ids are path-derived (`components/ui/Card`, `#Name` suffix when the export name differs from the filename); Figma ids are `figma:<published-key>`; Storybook ids are `storybook:<manifest-title>`. Props carry `type`, `required`, `default`, finite `values`, a source-neutral `kind`, and explicit `incompleteFields` / `unsupportedFields` markers.
- **Component evidence** is bounded and labelled: `uses` (static JSX edge counts), `usage` (observed props at JSX sites), and `demonstrated` (Storybook stories, args, controls). The code comments say repeatedly that these are static source evidence, not runtime frequency.
- **Provenance** is `SourceProvenance { adapter, file?, line?, metadata? }`, one per token or component (plus `modeSources` per theme value).
- **Conflicts** carry `scope` (`cross-source` | `within-source`), `sources: ConflictEvidence[]` with per-source values, an optional field path, `resolution` (`auto` | `manual` | `pending`) and a `suggestedFix`.
- **Source status** (`ok` | `failed` | `skipped`) is recorded per source so "not configured" and "configured but failed" are distinguishable.
- **Boundary validation** uses zod "loose" schemas that check only the top-level shape. The comment says this is deliberate, to avoid walking thousands of tokens on every hot reload.

## Source adapters

Contract (rule 9 in `AGENTS.md`): every adapter is a class with `async scan(): Promise<{ tokens: TokenMap; components: ComponentMap }>`. "No variants, no overloads."

Verified adapter set: `SourceAdapter = "codebase" | "figma" | "storybook"`. There is no zeroheight, Angular, or Vue code anywhere in `src` (grep for `zeroheight|angular|vue` returns nothing outside framework-detection strings in `init.ts`, which also lists SvelteKit).

- **Codebase** (`src/scanner/scanner.ts`, `component-analysis.ts`, `component-type-resolution.ts`): globs files, sorts them for cross-machine determinism, parses `.ts/.tsx/.jsx` with Babel (`typescript` + `jsx` plugins, `errorRecovery`), and reads `.css` custom properties. Token extraction handles CSS variables, theme selectors (into `modes`), and object-literal token files, with a reference registry for aliases. Component analysis is JSX/React-shaped (JSX usage sites, `uses`, `usage`). Prop type resolution is, per its own doc comment, a "deliberately small, source-only subset of TypeScript prop shapes".
- **Figma** (`src/sources/figma/index.ts`): REST calls to `/files/:id/variables/local`, `/components`, `/component_sets`, and `/nodes`. Opt-in mappings (`numericUnits`, `tokenAliases`, `modeAliases`) keyed by Figma's publish-stable key; the config comment says these are never name-based inference.
- **Storybook** (`src/sources/storybook/*`): fetches `<url>/index.json`, falling back to `/stories.json`, over HTTP. Optionally reads story source files from `sourceRoot` and statically parses CSF with Babel to extract argTypes, args, and controls, with byte budgets (`demonstratedBudget.ts`) to bound output.

## Compiler architecture

There is no separate compiler stage. `build()` in `src/index.ts` runs each configured adapter's `scan()`, and `ContractBuilder.build()` does everything else in one pass:

1. Sort sources by name (determinism).
2. `mergeTokens`: per category and name, detect value disagreement using `valuesEquivalent` (a value normalizer in `src/normalize/value.ts`); on disagreement, record a conflict and, if the source is `governance.sourceOfTruth`, let it win.
3. `mergeComponents`, then `componentReconciliationGroups` (grouping cross-source components by explicit `componentMappings` first, then conservative display-name association), then `reconcileComponentFieldsWithDiagnostics` (field-level conflicts such as prop values and types, plus `could-not-compare` diagnostics).
4. Optional `auto-resolve` pass.
5. Fold in within-source token redefinition conflicts after auto-resolve, so a source cannot arbitrate itself.
6. `inferRules` (heuristics over merged tokens and components, with a confidence level and evidence strings).
7. Validate the generated contract against the zod boundary schema and write JSON.

Governance is configured as `sourceOfTruth` (`codebase | figma | storybook | manual`) and `onConflict` (`error | warn | auto-resolve`).

## Reconciliation approach

Principles stated in `AGENTS.md` and visible in code:

- Rule 11, "conflicts surface, never silence": even when governance picks a winner, the conflict and the losing source's provenance stay in the contract. Unresolved conflicts are `pending`.
- Rule 13, "provenance is mandatory".
- Failed sources and truncated evidence cannot prove that a fact was removed or a conflict resolved (README and `sourceStatuses`).
- Identity is conservative: explicit mappings beat name matching; ambiguous cases yield `could-not-compare` diagnostics rather than a guess.
- `verify` rebuilds the contract in memory and compares structurally against the saved contract. `--fast` falls back to mtimes. Exit codes: 0 clean, 1 stale, 2 conflicts/strict, 3 missing config or contract (and at least one further case near `verify.ts:359`, not inspected).

## MCP implementation

`PrimitivMCPServer` (`src/mcp/server.ts`, 1,440 lines) loads the saved contract JSON and registers read-only tools. Registered tool names: `get_component_catalog`, `find_components`, `get_component_context`, `get_design_context`, `get_token`, `get_component`, `get_conflicts`, `get_inferred_rules`, `get_violations`. Transport is stdio by default. Documented runtime features: 24-hour staleness warning, hot reload on contract change (about 50 ms debounce), a source-root mismatch warning, and a rule that new tools return both text `content` and typed `structuredContent`. MCP reads the contract; it does not drive the build. That separation is already correct and Invariant should keep it.

## Ideas worth adopting

1. **Conflicts surface, never silence** (rule 11), including the losing source's provenance.
2. **Explicit absence semantics**: `sourceStatuses` and `incompleteFields` / `unsupportedFields` / `truncated*` markers. A consumer can tell "not present" from "could not determine".
3. **Conservative identity**: explicit user-confirmed component mappings take precedence over name matching; ambiguity produces a diagnostic, not a merge.
4. **Static-only evidence labelled as such**: observed JSX props and Storybook args are bounded and documented as not representing runtime frequency.
5. **Determinism hygiene**: sorted inputs, sorted outputs, structural verify instead of mtime comparison.
6. **Stable machine identifiers and sanitization** (`safe-identifier.ts`, `safe-display.ts`): the contract is committed and fed to LLMs, so values are bounded and stripped of control and bidi characters.
7. **Data-only config mode** (strict JSON, never executes config or scanned modules).
8. **MCP as read-only consumer** with structured output and actionable error text.
9. **CI verification** as a first-class command with distinct exit codes.
10. **Mode-aware tokens**: theme variants as `modes` on one token, with separate provenance per mode, rather than separate tokens.

## Limitations Invariant should address

| #   | Primitiv limitation                                                                                                                                                                                     | Evidence                                                        | Invariant response                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | React/JSX only; no Angular, Vue, or zeroheight                                                                                                                                                          | Scanner is Babel plus JSX-site analysis; no references in `src` | Framework-neutral IR; one adapter per framework                                         |
| 2   | Adapters return final contract shapes, so there is no intermediate representation. Each adapter must pre-decide tokens/components shape, and new fact kinds require edits in `types.ts` and the builder | `Source.scan()` returns `TokenMap` and `ComponentMap`           | Adapters emit IR facts; the compiler builds the contract                                |
| 3   | Provenance is per entity (token or component), not per fact. A prop's `type` and `values` share the component's single `source`                                                                         | `Component.source`, `PropDefinition` has no provenance          | Evidence attached to every fact                                                         |
| 4   | No epistemic status. Rationale, inferred rules, and extracted facts live in separate structures; there is no `approved` state. `resolution: "manual"` exists on conflicts only                          | `InferredRules`, `Rationale`, `Conflict.resolution`             | One `status` on every fact, with approvals bound to fact fingerprints                   |
| 5   | Closed adapter vocabulary: `SourceAdapter` union, config type, and builder wiring must all change per adapter                                                                                           | `types.ts`, `index.ts`                                          | Adapter registry with declared capabilities                                             |
| 6   | Single package: CLI, scanner, adapters, builder, verify, and MCP ship together, so MCP concerns sit beside compiler concerns                                                                            | `package.json` has one `bin` and no workspaces                  | Small packages with enforced dependency direction                                       |
| 7   | Non-determinism in the artifact: `generatedAt` is inside the contract, so every build differs and verify must special-case it                                                                           | `contract.ts` `generatedAt: new Date().toISOString()`           | Timestamps in a separate build manifest, not in the contract body                       |
| 8   | Type resolution is a deliberately small subset implemented over a Babel AST, with no type checker                                                                                                       | `component-type-resolution.ts` header                           | Use the TypeScript checker (or a framework tool built on it)                            |
| 9   | Network-bound sources: Storybook is read from a served URL; Figma needs a live token                                                                                                                    | `fetchManifest`, `FigmaAdapter.baseUrl`                         | Snapshot-first adapters so compilation works offline and is replayable                  |
| 10  | Shallow boundary validation of the contract: `tokens` and `components` are validated as opaque objects                                                                                                  | comment above `primitivConfigSchema`                            | Full schema for the contract, published as JSON Schema; validate at compile and at read |
| 11  | Legacy config is executable JS loaded with `require` (a data-only mode exists but is opt-in)                                                                                                            | `ConfigMode` in `types.ts`                                      | Data-only config from day one                                                           |
| 12  | Conflict resolution mixes identity resolution (`resolved`) with field governance (`fieldResolution`) in one type, noted as a compatibility compromise                                                   | comments in `Conflict`                                          | Separate conflict records from resolution decisions                                     |
| 13  | Inferred rules are heuristic and unlabelled by method beyond a `confidence` string                                                                                                                      | `inferrer.ts`                                                   | Inferred facts carry the rule id, inputs, and `status: inferred`                        |

## Licensing note

Primitiv is Apache-2.0. Invariant should reimplement from the ideas above, not copy code. If any code is ever adopted, retain the NOTICE and attribution requirements.
