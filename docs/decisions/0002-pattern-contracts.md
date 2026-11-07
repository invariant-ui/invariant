# ADR 0002: Pattern contracts

Status: Accepted for Phase 1 (contract specification), 2026-11-03
Related: `docs/architecture/pattern-contracts.md` (reconnaissance and gap analysis), `docs/specifications/contract-v1.md`

## Context

The contract already had a `pattern` entity, but it held only a category, a description and two id lists, nothing produced it, and no validator read it. The goal is to make UI/UX standards (layouts, interactions, page archetypes, compositions) machine-readable and enforceable, using the existing evidence, approval, conflict and policy machinery instead of a parallel one.

## Decisions

These are the eight decisions from the reconnaissance document, accepted as recommended.

**D1. Contract 1.1.0 with first-class fields.** New pattern data is part of the schema, not hidden under `extensions`. `CONTRACT_VERSION` is `1.1.0`; `SUPPORTED_CONTRACT_VERSIONS` is `1.0.0` and `1.1.0`.

Refinement made during implementation: no migration step is needed. Every new field is optional with no default, so a 1.0.0 document is already a valid 1.1.0 document. Reading it rewrites nothing and its `integrity.contentHash` stays valid. (A default such as `relationships: []` would have changed the parsed value and so the hash; the fields are optional for that reason.) A migration registry is still deferred to the first breaking change. To keep the version meaningful, `verifyContract` rejects a document that declares `1.0.0` but uses a 1.1.0 field, category or constraint kind (`contract.field-newer-than-version`).

**D2. Categories.** The nine existing categories stay; `interaction` and `page` are added. Layout, interaction, page and composition are one entity with a `category`. A page archetype is a pattern that composes others through `relationships`.

**D3. No stored pattern status.** Status stays per field in `facts`. An overall status is a derived view, computed in `contract-query` in Phase 2.

**D4. Structural validation stays in `packages/validation`** (Phase 4), using its own TypeScript scan.

**D5. Definitions and approval.** Human-authored definitions (Phase 3) compile to `documented` facts with `manual` evidence. An optional approval block, shaped like a policy's, makes a fact `approved`; otherwise it stays `documented` until approved through `review`.

**D6. JSON, not YAML,** for the definition file (Phase 3).

**D7. Constraint rules are first-class.** Six constraint kinds are added with typed `details`: `required-child`, `forbidden-child`, `requires-parent`, `required-region`, `ordering`, `cardinality`. The older kinds keep free-form `details`. The existing `extensions.invariant.rule` location of policy rules is untouched in this phase; unifying it is Phase 3 work.

**D8. Applicability** (which pattern applies to a file) is decided in Phase 4, starting from policy `scope.paths`.

## Schema added in Phase 1

On `Pattern`, all optional: `intent`, `composition.parts`, `layout.regions`, `behavior` (initial state, states, transitions), `accessibility.requirements`, `relationships`, `constraints`. Names of regions, parts, states, transitions and relationships are fact-path segments, so they cannot contain dots; relationships and transitions carry an `id`, so evidence is addressed as `relationships.<id>`.

Relationship types: `contains`, `requires`, `uses`, `extends`, `composes`, `alternative-to`, `prohibited-with`, `supersedes`. All except `contains` and `uses` must target a pattern. Cycles are rejected over `contains`, `requires`, `extends`, `composes` and `supersedes`, and over composition parts that are not `prohibited`.

`verifyContract` adds: `contract.pattern-duplicate-name`, `pattern-region-unknown`, `pattern-region-cycle`, `pattern-state-unknown`, `pattern-unreachable-state` (a warning), `pattern-self-relationship`, `pattern-relationship-target`, `pattern-duplicate-relationship`, `pattern-cycle`, `constraint-details-invalid`, and `field-newer-than-version`. Pattern references to components, patterns, constraints and tokens join the existing `contract.dangling-reference` check.

## Phase 2: query and consumers (2026-11-03)

Patterns became readable through the existing query layer, MCP and CLI. No schema change.

- **Derived status (D3).** `patternStatus` in `contract-query`: no facts is `none`, facts that share one status give that status, anything else is `mixed`. Only `approved` means every fact is approved. Every list and detail result carries it with an `approved` flag and a note that a pattern which is not fully approved is a proposal.
- **One flexible tool, not one per category.** `get_design_patterns` gained optional `name`, `category`, `status` and `query` (plus paging) and now serves what the guide called `get_layout_pattern`, `get_interaction_pattern` and `get_page_archetype`: `category` is `layout`, `interaction` or `page`. One tool was added, `get_pattern_relationships`. MCP holds no pattern logic; both tools call `contract-query`.
- **Search.** `pattern` is a new search kind and is included by default, so `search_design_system` now returns patterns unless `kinds` excludes them. Hits say what matched (name, intent, part, region, state).
- **Relationships** are walked breadth-first to a depth of at most 5. Components are leaves, a node is expanded once so the cyclic types (`uses`, `alternative-to`, `prohibited-with`) cannot loop, and the walk stops at 200 nodes. Composition parts appear as `part` edges with their role. Each edge carries the status and source of the fact behind it. Nothing is inferred from names.
- **Evidence retrieval.** A pattern's detail lists every fact with its status, confidence, rule and the evidence entries behind it (source, method, location, original text cut to 200 characters).
- **CLI.** `patterns list|inspect|search|relationships`. `patterns list --json` keeps printing the patterns as written in the contract. `patterns validate` is not added: enforcement is Phase 4, and a command that checked nothing would read as a pass.
- **Resource template** `invariant://pattern/{id}`.

Compatibility: the tool count goes from 10 to 11 and `search_design_system` accepts a fourth kind and returns pattern hits by default. Clients that list tools or pin the kinds enum will see the difference; the existing arguments and results of every other tool are unchanged. `get_design_patterns` with no arguments still returns `total`, `patterns[]` (with the earlier fields) and `notes`, plus status fields and paging.

## Phase 3: authoritative definitions (2026-11-03)

Organizations can write patterns directly. Specification: `docs/specifications/pattern-definitions-v1.md`.

- **A governance artifact, not an adapter.** `invariant.patterns.json` is human-written like the policies and decisions files, so it is read by `governance` and added to the contract after enrichment, not extracted into the IR. Patterns are compiled before policies so a policy can name them.
- **D5, as built.** Facts are `documented` with `manual` evidence (source `patterns`, the file, `sourceRef` `<file>#<id>`). An optional `approval` block makes them `approved` over `documented`. Without it, each fact is a new review item kind, `pattern-fact`, that `invariant review approve` can approve. `reject` does not apply to authored facts. Evidence has no line numbers: governance cannot depend on the JSON position parser in `compiler-tokens`.
- **D6, as built.** JSON, one file, with a published JSON Schema (`patterns-file-v1.schema.json`, written by `invariant export`) and an optional `$schema` key so editors validate it. No YAML dependency.
- **D7, as built.** The six pattern constraint kinds are first-class and validated. Policy rules written in `invariant.policies.json` still live in `extensions.invariant.rule`; migrating them was not needed to ship patterns and would change every compiled policy, so it is deferred. Pattern constraints carry no such rule, so the current validator reports their policies as "Not enforced" until Phase 4.
- **Enforcement needs approval.** A constraint's `enforce` creates a policy only when the pattern has an approval; otherwise compiling warns. Nothing infers an approval.
- **Skip whole, never half-resolve.** A definition with any unresolvable reference is left out whole, with every problem reported, so the contract never holds a half-resolved pattern. Valid definitions are still added and `compile` exits 1.
- **Reference matching** prefers an exact id, then a name or id body, then the part after the category; only a tie is ambiguous, and a prefixed id is never matched loosely.
- **New source type `patterns`** (contract `SOURCE_TYPES`), needed so evidence has a source. It is not an IR source type: `compiler-ir` excludes it, so the IR schema is unchanged and adapters cannot emit it. This widens the contract schema's `type` enum, so contract 1.1.0 changed after the Phase 1 entry above; additive, no external consumers yet.
- **Not done:** reconciling pattern entities from a second origin (nothing else produces patterns until Phase 7); a `patterns.check` command (compile reports everything); policy rules migrated to first-class details.

Compatibility: `compile` output gains a `patterns N, ...` line; the review queue gains the `pattern-fact` kind (additive); `review approve` now accepts documented pattern facts, and its error message for a wrong action changed from "inferred facts" to "facts".

## Phase 4: static composition validation (2026-11-03)

`invariant validate` evaluates approved pattern constraints against React files. Specification: `validation-and-governance-v1.md`, "Pattern rules".

- **D4, as built.** The rules live in `packages/validation` (`pattern-rules.ts`) and use its own TypeScript scan, extended with per-element nesting depth (`exprDepth`), callback depth (`loopDepth`) and an `opaque` flag. No new package and no dependency on the compilers. The glob matcher moved from `compiler-core` to `shared` so validation can use it (`compiler-core` re-exports it).
- **D8, as decided.** A policy's `scope.paths` and `scope.frameworks` say which files a rule applies to, and a file matching `paths` is treated as one instance of the pattern. Rules about a whole file need paths; element rules apply wherever the element appears. Pattern definitions carry `appliesTo` into these.
- **Only approved policies are enforced,** the same rule as elsewhere. A pattern with no policy is advice, not a check.
- **Outcomes, not just violations.** `validate` records an evaluation for each check that applied, with the status `pass`, `fail`, `warning`, `not-verifiable` or `skipped`. A requirement that cannot be established is never a pass. Absence, order and upper bounds are only reported as holding in a closed scope (no other-file components, no opaque children); presence and visible violations count regardless. Elements in lists or callbacks never prove an upper bound.
- **Constraints, not part roles.** The six constraint kinds cover required and prohibited components, parent and child rules, regions, order and counts. Roles on composition parts are not enforced on their own, because deriving constraints from them would be an inference nobody approved.
- **Not evaluated yet,** each reported as not verifiable: pattern references in constraints (occurrences of a pattern are not detected), `within` a region, and a region with no component part to recognize it. Vue, Angular and HTML templates are skipped. `requires-parent` reuses the existing `required-parent` compromise and can be a false positive when a wrapper lives in another file.
- **Output.** JSON gains `evaluations` and `summary.patternRules`; text lists not-verifiable and skipped checks; GitHub annotations and SARIF results stay findings-only. Exit codes are unchanged, so an unverifiable check never fails a run. Six rule codes (plan label `Pattern composition`) are in `invariant rules` and `validation.rules`.

Compatibility: the `validate` JSON report and the MCP `validate_design_system_compliance` result gain fields (`evaluations`, `summary.patternRules`); nothing was removed. The committed `fixtures/validation/expected/violations.json` changed only by those additions. A project with no pattern policies gets empty results.

## Phase 5: interaction validation (2026-11-03)

`invariant validate` checks that interactions are represented in React code. Specification: `validation-and-governance-v1.md`, "Interaction checks".

- **Evidence levels.** A result that found its state carries a level: `structural` (the code has the piece and the interface shows it) or `static-inferred` (a handler's code shows it happening). `runtime-verified` exists in the contract's `EVIDENCE_LEVELS` for future test results and is never produced by static analysis. The text report always says how many results are at each level and that static analysis does not run the code.
- **One new constraint kind, `required-state`** (`workflow`, `state`, optional `minimum`), enforced through an approved policy like every pattern rule. The three workflows and their states are fixed in the contract (`INTERACTION_STATES`): `form-submission`, `destructive-confirmation`, `search-results`. A pattern's own `behavior` state machine stays descriptive, and is not matched to code by name, so the model remains usable for future test integration. This adds an enum value to contract 1.1.0 after the earlier entries; additive, no external consumers, JSON Schema regenerated. Constraint details that name no component are no longer read as references (the reference check now looks only for `component:` and `pattern:` ids), and the governance compiler does not try to resolve them.
- **What static analysis can honestly say.** Found (at a level), absent (nothing in the file could hide it), or open (something could: a handler from outside, a custom hook, a spread, an action, a component from another file). Open is `not-verifiable`. Absence is only a `fail` when closed, and finding the state is a `pass` only at or above `minimum`; below it is a `warning`.
- **Name heuristics are explicit.** Flags named like pending, error or success, and handlers named like delete, are part of `structural` evidence, and the evidence names the identifier. Behavior-based evidence (a flag set around an await) does not depend on names.
- **Not built:** transition checks (the state machine is not compared with code), the guide's "submission feedback" and "error handling" as separate rules (they are the `success` and `error` states), checks outside React, cross-component and store state, and any runtime verification (Phase 8).

Compatibility: the contract schema gains the constraint kind (and `EVIDENCE_LEVELS`); `validate` evaluations gain optional `level` and `evidence`; the run summary gains an optional `interactionEvidence`, absent when no interaction check found anything. Seven pattern rule codes are listed by `invariant rules` (one more than after Phase 4).

## Phase 6: page archetypes (2026-11-03)

Page archetypes are patterns with category `page` that compose other patterns. Specification: `contract-v1.md` ("Page archetypes") and `pattern-definitions-v1.md`.

- **Variations are explicit.** A pattern may declare `variations`: named changes to part roles and parts that exist only in that variation, keyed by `name` (fact paths resolve array items by `name` before `id`, so a variation cannot carry both). This adds an optional field to contract 1.1.0 after the earlier entries; additive, no external consumers, JSON Schema regenerated.
- **Recursive validation is in the contract.** `verifyContract` follows what a pattern composes (parts that are patterns, and `composes`, `contains`, `uses`, `requires`) to any depth, for the pattern as written and for each variation. It rejects prohibited combinations and prohibitions defeated by a composed pattern (errors), and warns about superseded patterns and unfilled required regions. Cycles were already rejected; variation parts now count.
- **A part is a slot.** A blueprint prohibiting one part does not conflict with another part of the same pattern that uses the same component; only what a composed pattern brings in does. Without this a `create` variation could not prohibit a `remove` button while the form still has a `submit` button.
- **Resolved view.** `archetypeView` in `contract-query` returns the blueprint: regions with their parts, the composition expanded to six levels (cycles and the depth limit are marked, not hidden), variations, the patterns it builds on with their status, required interaction states and whether a policy enforces each, structural constraints, responsive expectations, prohibited parts and combinations, and notes. A named variation is applied to the blueprint's own parts. It is read-only and deterministic. Exposed as `invariant patterns resolve` and as `resolve` and `variation` arguments of `get_design_patterns`, not as a new tool.
- **Approval is not inherited.** An approved archetype that builds on patterns that are not approved is reported with exactly that note. This follows the existing rule that approval is per fact and never implied.
- **Constraint inheritance (decided and built after Phase 6, 2026-11-03).** Composed patterns' constraints apply to a page only when the page opts in. The contract stores `appliesTo` (paths, frameworks) on the pattern, and the page sets `inheritsConstraints: true`. Both are fact paths, so both must be `approved`; a definition that nobody approved enforces nothing. Inheritance follows composition and variation parts through every pattern they use, and puts each rule of those patterns, already carried by an approved policy, onto the page's paths. It creates no policy and so approves nothing. A file in both a policy's own paths and the page's is evaluated once, by the policy's own route; an inherited route beats no paths at all. Evaluations and findings of an inherited rule carry `inheritedFrom`. `inheritsConstraints` without `appliesTo.paths` is a contract error (`contract.pattern-inheritance-unscoped`); with nothing composed, a warning. Additive fields in 1.1.0, so no version change; a 1.0.0 document that uses them is rejected.
- **Not built:** starter archetypes shipped with Invariant (organizations define their own; the example is a fixture), selecting nested patterns' variations, a diff between variations, and any validation of application code beyond what the existing rules do.

Compatibility: the contract schema gains the optional `variations` field and five `contract.*` diagnostics; documents with none are unaffected, and existing sample contracts verify as before. `get_design_patterns` gains two optional arguments. `invariant patterns` gains `resolve`.

## Phase 7: pattern discovery (2026-11-03)

Specification: `pattern-discovery-v1.md`.

- **A new package, `@invariant/discovery`.** Discovery is neither validation nor governance, so it has its own boundary (shared, contract, contract-query, validation). The CLI is the only consumer. `validation` gains one export, `buildTree`, which resolves a file's elements to contract components with the logic `validateCode` already used; `validateCode` now shares the element-kind mapping instead of duplicating it.
- **Candidates are not contract content.** They are written to `invariant.candidates.json` in the output directory, `inferred` and with evidence, and the contract, evidence file and manifest are untouched. Putting them in the contract would have meant inferred pattern entities in a document whose consumers treat entities as approved or documented unless marked.
- **Deterministic methods only.** Exact canonical-form grouping, and complete-linkage grouping on feature overlap in path order. Both state their parameters. No language model is used, so no confidence is invented: counts and measured overlap are reported instead. Similarity is never equivalence (`equivalence: "not-established"` on every candidate).
- **Review decisions are their own file.** `invariant.candidate-reviews.json` is an append-only history keyed by a structure-derived candidate id. The existing decisions mechanism is tied to contract entities, fact paths and fingerprints, which candidates do not have. Stale decisions are reported, never dropped.
- **Promotion is explicit and never approves.** It writes a definition with provenance (`origin`, kept as `extensions.discovery`) and no approval, intent or constraints. Enforcement still requires a person to approve the pattern and write constraints.
- **Registered by hand.** The package was added without running `pnpm install` (offline): boundary rule, tsconfig references, vitest alias, CLI dependency, and a hand-edited lockfile importer. Run `pnpm install` once to confirm the lockfile.
- **Not built:** Vue and Angular, runtime or browser observation, language-model naming, constraint suggestions, an MCP tool, and grouping beyond design-system structure.

Compatibility: the definitions schema gains an optional `origin`; the contract is unchanged. New command groups `discover` and `candidates`, and the optional `governance.candidateReviewsFile`.

## Phase 8: browser verification (2026-11-03)

Specification: `browser-verification-v1.md`.

- **Opt-in by construction.** `@invariant/browser-verify` depends only on `shared` and `zod`. Playwright is loaded on demand from the checked project by `browser run`, and no other command touches it. A missing install exits 2 with the install command.
- **A scenario file, not inference.** Checks come from `invariant.browser.json`, written by a person: data only, no step that runs code. `pattern` and `constraint` links are authored, never guessed. Deriving scenarios from approved patterns is deferred.
- **Static and runtime stay distinguishable.** Results go to their own file, `kind: "runtime"`, level `runtime-verified` with browser, version, viewport and URL on every result. `validate` and its summaries are unchanged, and no browser result upgrades a static one. `error` (could not run) is separate from `fail` and never counts as a pass.
- **Controlled environment.** Headless, fresh context per scenario, service workers blocked, requests limited to the base origin and listed origins, loopback base URL unless the origin is listed.
- **A driver interface.** The runner talks to a `BrowserDriver`/`PageHandle`; Playwright is one implementation. Tests use a scripted fake, and `Io.browserDriver` lets the CLI tests inject it.
- **Limitation recorded honestly.** The Playwright driver was not run against a real browser (not installed, no network). It is the one untested piece.
- **Not built:** accessibility audits, scenario derivation, MCP exposure, screenshots and traces, a spec JSON Schema.

Compatibility: no contract or schema change. New command `browser run`, new package, new files `invariant.browser.json` and `invariant.browser-results.json`.

## Phase 9: agent integration (2026-11-03)

- **Extended the existing skill, did not add one.** `invariant-build-ui` already existed. Its body is now the guide's workflow (task, page archetype, patterns, components and tokens, generate, validate, correct, report) and its pre-approved tools include `get_design_patterns` and `get_pattern_relationships`. The other four skills and the rules file gained pattern awareness and corrected a ground rule that said the contract usually has no patterns.
- **Scoped retrieval.** The skill tells the agent to fetch one archetype with `resolve` and only the patterns the task needs. Generated files contain no contract text except identifiers: component names (as before) and ids of fully approved page archetypes, capped at 20 and passed through the same identifier filter.
- **Approved versus inferred.** Agents follow approved patterns and treat the rest as proposals to confirm. `not-verifiable` and `skipped` are reported as unresolved, never as passes. Discovery candidates are declared not to be patterns, and are not exposed over MCP.
- **Existing integrations unchanged in shape.** Same five skill names, same files per client, same write rules; `agent init` regenerates marked files. All earlier agent-kit, CLI and end-to-end tests pass unchanged.
- **Not built:** an MCP tool for candidates, a task-to-archetype recommender, and any agent-side enforcement beyond instructions. Skill text is guidance a model may ignore; enforcement is `invariant validate` in CI.

Compatibility: generated skill and rules text changed; regenerate with `invariant agent init`. No contract or schema change.

## Easy setup (2026-11-03)

- **`invariant setup`** orchestrates existing commands by running them (so it adds no second implementation of init, compile, discover, candidates or agent init) and keeps its own logic to detection, questions and gating.
- **Approval is gated on a human confirming the contract.** The contract summary is shown, and a person confirms it (interactive yes or `--confirm-contract`). Only then are discovered patterns offered for approval, with a second explicit yes or the same flag. `--yes` alone never confirms or approves. Approvals are written as definition `approval` blocks naming the person and the confirmation. Approved patterns guide agents; no rule is enforced, because discovery writes none.
- **Baseline for `validate`.** Existing violations are recorded by file, rule and message with counts. A baseline hides them visibly (stderr note), still fails on new ones, and is bypassed with `--no-baseline`.
- **Found and fixed while testing:** setup first treated the design system's own `src` as an app folder. It now skips a folder that holds the contract's component implementation files.
- **GitHub Action.** `setup` offers `.github/workflows/invariant.yml` (git projects, `--ci`, `--no-ci`). It runs `verify --fresh` and `validate --format github` on pull request commits, pins the exact version, requests `contents: read`, uses no secrets and no `pull_request_target`, and never overwrites an existing file. It relies on the committed contract and baseline, and setup says to commit them. The generated YAML is tested as text; it has not been run on GitHub.
- **Apps that use a design system from a package** (found by asking how to integrate into a real project). `compile` reads the design system's source, so an app repo cannot compile it. Three problems were found by running `setup` in one: it compiled an empty contract and reported no violations; an app could not add its own patterns, because definitions compile only over a contract draft; and `discover` would have written into `node_modules` when pointed there with `--dir`. The fixes: a config key `extends.contract` makes `compile` start from the contract the library ships (evidence and approvals untouched) and apply the app's own pattern, policy and decision files on top, writing a verified local contract. `verify --fresh` recompiles the same way, so a library upgrade is a stale contract. `setup` detects a project with no design system source, finds shipped contracts under `node_modules`, asks which if several, and stops, creating nothing, if there is none. `compile` also refuses a config with no sources and no `extends`. `discover` and `browser run` never write into `node_modules`. The generated workflow installs dependencies first (lockfile decides the package manager). When both the library and the app define patterns, the contract's single `patterns` source entry describes the app's file; verification passes and evidence stays attached to its facts, but the entry does not describe the library's file. The library still has to publish its `invariant/` folder; nothing automates that.
- **One question (2026-11-04).** `setup` gathers what it needs, prints a plan, and asks once: `Looks right? [Y/n, or c to choose each step]`. Yes confirms the contract and does everything; `n` stops with nothing added; `c` restores the earlier step-by-step questions. Approval is still gated on that confirmation, and `--yes` still never confirms.
- **Starter rules.** Approved patterns enforced nothing, so setup showed no result. It now turns on rules derived from what discovery observed, only for patterns the person approves: a parent contains the children it always had, in the order it always had them (`required-child` and `ordering`). Optional, repeated and open-ended children give no rule. They are warnings with `warn` enforcement, scoped to the app folders, and existing violations are hidden by the baseline, so they annotate new code without failing builds. This needed a machine-readable `structure.tree` on arrangement candidates. A rule is a generalization of an observation: a Modal that no other code wraps a Button in would be flagged, which is the point, and also the risk, so they are warnings and `--no-rules` skips them.
- **Publishing wiring.** In a design system repository `setup` offers to make the published tarball carry the contract: `invariant` in `files` and a `prepack` script (compile at the root, or compile and `export` into the package folder in a monorepo). Both forms were run for real, including the resulting `npm pack` file list. A private package is skipped, an existing `prepack` is left alone, and an ignored `invariant/` folder is warned about.
- **Not done:** a readable review summary for non-engineers. Packaging is in the next section.

## Packaging and consolidation (2026-11-03)

- **One published package, `invariant-ui`** (bin `invariant`), so `npx invariant-ui setup` works with nothing installed first. `invariant` is an unrelated package on npm, hence the name; it is set in `NPM_PACKAGE`.
- **No bundler.** `scripts/build-npm.ts` copies each workspace package's compiled JavaScript under `dist/<name>/` and rewrites `@invariant/<name>` imports to relative paths. The published code is the compiled code, file for file. Runtime dependencies are `typescript`, `zod` and `@vue/compiler-sfc`. A test builds it, checks no workspace import remains and every relative import resolves, and runs it as a process. It also ran on Node 20 and 24, so `engines` is `>=20`.
- **Consolidated two packages.** `diagnostics` into `shared` (121 lines, no reason to be separate) and `discovery` into `validation` (it is built on the validation scan and element resolution). Eighteen workspace packages remain. The rest were kept because each is a boundary the checker enforces or has different dependencies: the contract and IR must not know frameworks, each adapter has its own compiler dependency and must not import another, `mcp` must not run the compiler, and `browser-verify` must stay free of heavy dependencies. Merging them would trade enforced boundaries for fewer files.
- **Agent config under npx.** `agent init` writes `npx -y invariant-ui mcp` when `invariant` is not on PATH, and the plain command when it is (or `--command` is given).
- **Version.** The CLI version moved from `0.0.0` to `0.1.0` so `--version` matches the package. Golden files changed only in versions and hashes.
- **Not done:** the package is not published. That needs an npm login, and a name only you can claim. See `docs/releasing.md`; `.github/workflows/publish.yml` publishes on a version tag once an `NPM_TOKEN` secret exists.

## Compatibility

- **Readers.** A 1.1.0 build reads both versions. A build that only knows 1.0.0 cannot read a 1.1.0 document: its strict schema rejects the unknown fields. There are no published consumers, so this is accepted, but any external tool pinned to 1.0.0 must upgrade.
- **Writers.** Compiled contracts now declare `1.1.0`. Committed golden files for the sample projects changed in exactly three ways: the version string, the content hashes that depend on it, and the sizes and hashes in manifests. Nothing else in them changed.
- **JSON Schema.** The only changes to `contract-v1.schema.json` are additions (new optional fields, new enum values) and `contractVersion` changing from a constant to an enum of both versions. The file name keeps `v1` because the major version is unchanged.
- **Consumers.** `contract-query`, MCP, CLI and the validator read only fields that already existed and are unchanged.

## Consequences

- Patterns can be represented, validated, approved and evidenced with no new approval system.
- Nothing yet produces, queries or enforces them. Phases 2 to 4 do that. `patterns list` still prints "no patterns" for compiled projects.
- Static analysis cannot verify width, responsive behavior or runtime states. The model records how a requirement can be verified (`verifiableBy`: `static`, `runtime` or `manual`) so a validator never claims more than it established.
