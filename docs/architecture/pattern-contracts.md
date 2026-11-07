# Pattern contracts: reconnaissance and gap analysis

Status: Phase 0 findings. Decisions D1 to D8 in section 9 were accepted as recommended on 2026-11-03. Phase 1 (contract specification), Phase 2 (query, MCP and CLI) and Phase 3 (authoritative definitions) and Phase 4 (static composition validation) and Phase 5 (interaction validation) and Phase 6 (page archetypes) and Phase 7 (pattern discovery) and Phase 8 (browser verification, driver untested against a real browser) and Phase 9 (agent integration) are implemented; see ADR 0002 for what was built and two refinements: no migration step was needed because every new field is optional, and the sample pattern contract is a separate fixture (`packages/contract/fixtures/patterns/`) instead of an addition to the Acme sample.
Date: 2026-11-03

## 1. Method and limits

Read for this analysis: `CLAUDE.md`, `README.md`, `docs/architecture/system-architecture.md`, `docs/decisions/0001-architecture.md` (headings and the Phase 7 to 10 addenda), all nine specifications under `docs/specifications/`, and the source of `packages/contract` (`knowledge.ts`, `components.ts`, `primitives.ts`, `validate.ts`, `evidence.ts`), `packages/compiler-ir/src/ir.ts`, `packages/validation` (`policy.ts`, `scan.ts`, `validate-code.ts`, `validate-usage.ts`, `rules.ts`), `packages/governance` (`policies.ts`, head of `decisions.ts`), `packages/reconciliation` (`reconcile.ts`, `review.ts`), `packages/semantic-engine` (`additive.ts`, `documents.ts`), `packages/contract-query/src/views.ts`, `packages/mcp` (`tools.ts`, `resources.ts`), `packages/agent-kit/src/guidance.ts`, and `apps/cli/src/commands.ts`.

Not read in depth, so no claims are made about them: the internals of `compiler-vue`, `compiler-angular` and `compiler-storybook` beyond the specifications, `compiler-core` discovery, the MCP protocol layer, the agent-kit skill and rule generators beyond `guidance.ts`, and most of reconciliation. Statements about those areas come from the specifications only.

## 2. What exists today

Patterns are a first-class entity in the contract, but nothing produces or consumes them in a meaningful way.

| Layer | What exists | Where |
|---|---|---|
| Contract schema | A `pattern` entity: `id` (`pattern:<name>`), `name`, `category`, `description`, `components` (component ids), `guidelines` (guideline ids), `facts`, `extensions`. Strict object. `category` is one of `layout, navigation, form, data-table, card, dialog, workflow, composition, other`. | `packages/contract/src/knowledge.ts:23` |
| Contract semantics | Duplicate ids, sort order, dangling references (`components` and `guidelines`), fact-path resolution and approval staleness are checked for patterns like any entity. | `packages/contract/src/validate.ts:210-245` |
| IR | Entity kind `pattern` exists. No adapter emits it. | `packages/compiler-ir/src/ir.ts:25` |
| Reconciliation | Always writes `patterns: []`. The review queue and governance decision collections already include `patterns`. | `reconcile.ts:155`, `review.ts:51`, `decisions.ts:95` |
| Semantic engine | `assertAdditive` allows enrichment to add pattern entities and forbids it from changing existing ones. No rule produces patterns ("a pattern needs a description of intent, which static facts and headings do not supply"). | `additive.ts:48`, `reconciliation-and-semantics-v1.md` |
| Query | `patternsView`: id, name, category, description, components, plus a note when empty. No lookup by id, search, filter or relationship traversal. | `contract-query/src/views.ts:338` |
| MCP | Tool `get_design_patterns` and resource `invariant://patterns`, both a dump of `patternsView`, described as "often empty". | `mcp/src/tools.ts:137`, `resources.ts:51` |
| Agent kit | Guidance tells agents that an empty pattern list "means no pattern is documented, not that none applies". | `agent-kit/src/guidance.ts:55,140` |
| CLI | `patterns list` only. | `apps/cli/src/commands.ts:413` |
| Validation | No pattern awareness. The nearest machinery: component-level policy rules `allowed-children` (code `layout-pattern-invalid` when `category: layout`, else `composition-not-allowed`) and `required-parent`, plus contract `requires-parent` relationships. | `validation/src/policy.ts` |

### What `patterns list` returns

Reads `contract.patterns` from the compiled contract. Table columns: `id`, `name`, `category`, number of components. With `--json` it prints the raw array. For every compiled contract today it prints "no patterns. Invariant does not infer patterns from code yet, and no source documents one." The empty result is the only observed behavior; no non-empty pattern appears outside `packages/contract/test/acme.ts` and unit tests.

### Reusable abstractions

- **Facts per field with status and evidence** (`facts.ts`): already attached to `Pattern`. Pattern fields can carry `discovered`, `documented`, `inferred` or `approved` without schema work.
- **Approval with fingerprint and `priorStatus`**, **review queue**, **decisions file** (`invariant.decisions.json`): already cover the `patterns` collection.
- **Conflict records** (`conflicts.ts`): `subject` is any entity id, so pattern conflicts need no new record type.
- **Policies and constraints**: human-approved policy, `basedOn` constraint ids, `scope.entities` can name pattern ids. Severity and enforcement (`block`, `warn`, `report-only`) already exist.
- **Component `composition` relationships** (`contains`, `requires-parent`, `commonly-used-with`, `extends`) with `facts["composition.<index>"]` for evidence. The model to copy for pattern relationships.
- **Validation front end**: `scanJsx` and `scanMarkup` produce a source-ordered list of elements with a `parent` index, line and column. Findings carry `code`, `severity`, `basis`, `policy`, `source`, `suggestion`. The `RULES` catalog, severity overrides and `invariant rules` listing exist.
- **Diagnostics, evidence ids, golden-fixture conventions** (`fixtures/validation` with `app/`, `expected/violations.json`, committed policy file).

## 3. Gap analysis against the guide

| Capability | State | Gap |
|---|---|---|
| Pattern categories (layout, interaction, page, composition) | Existing enum has nine UI-element-style categories and lacks `interaction` and `page`. | Reconcile the enums. See D2. |
| Intent | Only `description`. | Add `intent` or define `description` as the intent. |
| Composition constraints (required, optional, prohibited, regions, cardinality, ordering, parent/child) | Component-level `allowed-children` and `required-parent` only, written as policy rules. `Pattern.components` is a flat id list with no roles. | New constraint vocabulary; patterns must own constraints. |
| Layout contract (regions, width, grid, spacing, responsive) | Nothing. Spacing literal checks against tokens exist in `validate`. | New optional structure. Most of it cannot be verified statically. |
| Behavior contract (states, transitions, feedback) | Nothing. `compiler-react/src/behavior.ts` is slot derivation despite its name. No extraction of state, handlers or async calls. | New model; extraction is new work and only partly possible. |
| Pattern relationships (contains, requires, uses, extends, composes, alternative-to, prohibited-with, supersedes) | `components` and `guidelines` lists only. No relationship type, no pattern-to-pattern edge, no cycle detection. | New. |
| Evidence and approval | Reusable as is (per-field facts). | Pattern definitions need an evidence source (see D5). |
| Conflicts | Reusable. Reconciliation produces no pattern entities, so there is nothing to conflict yet. | Reconciler must merge pattern entities from more than one source (Phase 3 and 7). |
| Authoritative definitions (human-authored) | None. Policies are the only human-authored artifact (`invariant.policies.json`, JSON). | New file format and compiler step. |
| Static structural validation | Per-element rules in a flat list with parent links. No tree, sibling order, regions, cardinality or "which pattern applies to this file". | Extend the validator with a tree view, evaluation records and pattern applicability. |
| Rule outcomes (pass, fail, warning, not verifiable, skipped) | `Finding` has severity only. "Not verified" is expressed as `limitations` text and counters (`unverifiedValues`), and `unverifiable-prop` info findings. No per-rule pass or skipped record. | Additive outcome model so unsupported checks are never silent passes. |
| Behavioral and rendered verification | Nothing. | Later phases, opt-in. |
| MCP and CLI | One dump tool, one list command. | Query operations and focused tools. |
| Application-level analysis | Compilers analyze exported design-system components of packages, not application pages. Validation parses application files per file only. | Discovery (Phase 7) needs an application adapter that does not exist. |

## 4. Proposed canonical model

Extend `Pattern` additively rather than adding a second entity. Names below are proposals; all new fields are optional so existing patterns remain valid under the schema shape.

```text
Pattern (existing)         id, name, category, description, components, guidelines, facts, extensions
  + intent                 one sentence: what the pattern is for
  + composition            { regions?, rules? }       what must / may / must not appear, in what order and quantity
  + layout                 { regions?, constraints? } named regions, hierarchy, width/spacing/responsive references
  + behavior               { states, initial, transitions, feedback? }   explicit state machine
  + relationships[]        { type, target }           contains | requires | uses | extends | composes | alternative-to | prohibited-with | supersedes
  + constraints[]          constraint ids owned by this pattern (reuse constraintSchema)
```

Design points:

1. **Constraints are the enforcement vocabulary.** `constraintSchema` already has `subjects`, `details` (JSON) and `facts`. Add constraint kinds `required-child`, `forbidden-child`, `required-region`, `ordering`, `cardinality`, `requires-parent`. A pattern lists the constraints it owns. Today the same data lives in `constraint.extensions.invariant.rule`, which ADR 0001 (open decision U17) identifies as hiding framework-neutral data from consumers; promoting the rule shape to a first-class constraint `details` schema removes that.
2. **Enforcement stays in policies.** A policy (`basedOn` constraint ids, `scope.entities` pattern ids, `severity`, `enforcement`, mandatory approval) is how an organization makes a pattern's rule blocking. This reuses governance and satisfies "do not create a parallel approval system".
3. **Status stays per field.** The guide's single pattern `status` conflicts with U5 (fine-grained facts). A pattern's overall status becomes a derived view (for example "approved" when every constraint-bearing fact is approved) computed in `contract-query`, not a stored field that could disagree with its facts.
4. **Layouts, interactions, pages and compositions are one entity with a `category`**, not four types. A page archetype is a pattern whose relationships `compose` layout, composition and interaction patterns. Recursion and cycle detection run over `relationships`.
5. **Relationships follow the component pattern**: typed edge plus `facts["relationships.<index>"]` for evidence. No relationship is inferred from name similarity.
6. **Behavior is explicit and small**: named states, an initial state, transitions `{from, to, trigger?}`, optional required feedback per state. It is data, not an executable workflow. Each state or transition can carry a `verification` level (`structural`, `static-inferred`, `runtime-verified`) so a validator can never claim more than it established.

## 5. Integration with existing packages

**contract.** New fields, constraint kinds, relationship and cycle checks in `verifyContract` (`contract.pattern-cycle`, dangling relationship target, unknown constraint id). Contract version `1.1.0`. JSON Schema regenerated. This is the first schema change after `1.0.0`, so the migration registry that the specification says "is added with the first breaking schema change" is needed if the change is breaking (see D1).

**compiler-ir / compiler adapters.** No IR change is required for Phases 1 to 6: pattern definitions are human-authored governance input like policies, not extracted source. The IR `pattern` kind stays available for a later adapter that extracts patterns from documents or applications.

**governance.** Reads a pattern definitions file and compiles it into the draft the way `compilePolicies` does, with the same id-collision and unknown-reference diagnostics. Owns the file schema, as it owns `invariant.policies.json`.

**reconciliation.** Phase 3: merge pattern entities from more than one origin (a definition file and, later, documents or discovery) and emit conflicts. The review queue already lists pattern facts.

**semantic-engine.** No change until Phase 7. Its additive-only contract (`assertAdditive`) already protects authored patterns.

**validation.** Add (a) an element tree with ordered children, built from the data `scanJsx` and `scanMarkup` already produce, (b) rule evaluation that records an outcome per rule, not only violations, (c) pattern applicability, (d) rule codes for composition checks that use the existing catalog, severity overrides and policy reference machinery. Keep it in `packages/validation` (it already owns JSX and template scanning with the TypeScript API) rather than a new package. The guide asks that static checks "use the framework adapter"; today validation does not use the compiler adapters, it uses its own syntax scan. Moving it would add a dependency from validation to every compiler for no gain at this stage. See D4.

**contract-query / mcp / cli / agent-kit.** `contract-query`: lookup by id or name, category and status filters, text search over patterns (reusing the lexical search), relationship traversal with cycle protection, evidence retrieval. CLI: `patterns inspect`, `patterns search`, `patterns relationships`, and `patterns validate` mapped onto `validate`. MCP: extend `get_design_patterns` with optional filters rather than add four tools; add one relationship lookup. No domain logic in MCP. agent-kit: a `build-ui` skill in Phase 9.

## 6. What can and cannot be verified statically

| Requirement | Static AST | Notes |
|---|---|---|
| Required, prohibited component in a file | Yes, within one file | Cross-file composition (a page that imports its header from another file) is not visible: report not verifiable, never pass. |
| Parent and child constraints | Yes, same file | Existing `required-parent` already avoids false claims when no design-system ancestor is in the file. |
| Required region present | Yes when regions map to named components or slots | Regions defined by CSS only are not verifiable. |
| Ordering and cardinality | Yes for literal siblings | Conditional, mapped and spread children make a count unknowable: report not verifiable. |
| Spacing uses tokens | Yes for literals | Already implemented for spacing and typography literals. |
| Width constraint, responsive behavior | Largely no | Only literal CSS and breakpoint tokens. Mostly "not verifiable" until rendered verification. |
| States, transitions, feedback | Partially | A `useState` pending flag or an `aria-live` element can be seen. That shows presence, not behavior. Reported as `structural` or `static-inferred`, never `runtime-verified`. |
| Keyboard, focus, responsive rendering | No | Phase 8, opt-in. |

## 7. Compatibility risks

1. **Strict schema.** Every contract object is `strictObject`. A contract with new pattern fields is rejected by a build that only knows `1.0.0`. Readers also reject other major versions only; a minor bump is accepted by version check but still fails strict parsing. Mitigation: bump to `1.1.0`, ship readers and writers together, add the migration registry, keep `1.0.0` documents readable by the new build. Old tools cannot read new contracts; that is acceptable for a pre-release project with no published consumers, but it must be stated in the ADR.
2. **Category enum.** Adding `interaction` and `page` is additive; renaming or removing existing values would break `1.0.0` patterns (there are none outside tests).
3. **Golden fixtures.** Any change to the compiled contract shape touches `fixtures/contract-golden`, `fixtures/cli-golden` and the JSON Schemas. Each diff must be reviewed, not regenerated blindly.
4. **MCP tool shape.** Extending `get_design_patterns` with optional arguments is backward compatible. Replacing it is not.
5. **Validation result shape.** Adding `evaluations` to the result is additive. The `--format sarif` and `github` outputs must keep their current meaning; a "not verifiable" outcome must not become an error annotation.
6. **Rule catalog.** The Phase 10 end-to-end test requires one violation for each of the eleven plan rules via `PLAN_RULES`; new rules use their own plan label like `Hardcoded value` did, so that test is unaffected.
7. **Policy compilation.** Promoting rules from `extensions.invariant.rule` to first-class constraint details changes how existing policies are stored. Keep reading the old location for one version.

## 8. Phase 1 implementation plan (contract specification)

Scope: the canonical model and nothing else. No discovery, no validation, no CLI beyond what keeps `patterns list` working.

1. **ADR 0002** pattern contracts: the decisions in section 9, compatibility statement, version bump.
2. **`packages/contract`**
   - `knowledge.ts`: extend `patternSchema` with `intent`, `composition`, `layout`, `behavior`, `relationships`, `constraints`; extend `category` and constraint `kind` enums. New small schemas in a new `patterns.ts` to keep `knowledge.ts` focused.
   - `validate.ts`: reference checks for relationship targets and owned constraints, cycle detection over `contains`, `composes`, `requires` and `extends`, state-machine checks (initial state exists, transition endpoints exist, no unreachable state flagged as warning).
   - `CONTRACT_VERSION` to `1.1.0`, migration registry with a `1.0.0` to `1.1.0` step (adds empty defaults), `json-schema.ts` regenerated.
3. **Tests**: schema accept and reject cases, each new `verifyContract` code, migration round trip, determinism (parse, serialize idempotence), an approved pattern whose fingerprint goes stale.
4. **Fixtures**: add one hand-written `pattern:data-management-page` (plus a layout and an interaction pattern it composes) to the sample contract in `packages/contract/fixtures/acme/`, with evidence.
5. **Docs**: `contract-v1.md` updated, this document's section 4 moved into the specification, `docs/specifications` limitations updated.
6. **Packages touched**: `contract` only, plus fixture and documentation updates. `contract-query`, `mcp` and CLI keep compiling because their patterns code reads only existing fields.

Acceptance: patterns (all four categories) can be represented and validated; existing `1.0.0` artifacts still parse; evidence and approval metadata round-trip; unknown fields are rejected consistently with current policy; `pnpm verify` passes.

## 9. Decisions needed before Phase 1

| # | Decision | Recommendation | Why it matters |
|---|---|---|---|
| D1 | Bump `contractVersion` to `1.1.0` with a migration registry, or hold the new fields under `extensions.invariant`? | `1.1.0`, first-class fields. | Same trade-off as open decision U17: extensions keep the version but hide framework-neutral data from consumers and from schema validation. |
| D2 | Category enum: keep the nine existing values and add `interaction` and `page`, or replace with the guide's four? | Keep and add. | The existing values (`data-table`, `dialog`, `form`) describe composition subjects; replacing them breaks any `1.0.0` pattern. |
| D3 | Stored pattern `status` (guide) or derived from per-field facts (existing model)? | Derived. | A stored status can contradict field facts and breaks the "never collapse states" rule. |
| D4 | Keep structural validation in `packages/validation` using its own syntax scan, or route it through the compiler adapters? | Stay in `validation` for Phase 4 (React JSX and the existing template scanner). | Avoids a new dependency edge; the guide's "use the adapter" intent is met by AST analysis. Revisit when Angular and Vue need richer trees. |
| D5 | How do human-authored definitions get evidence and approval? Evidence method `manual` already exists. | Definitions compile to `documented` facts with `manual` evidence pointing at the file and line. An optional `approval` block (same shape as policies) makes the fact `approved`; without it the pattern stays `documented` until someone approves it through `review`. | A file in the repo is not an organizational approval; policies already require explicit approval metadata. |
| D6 | Definition file format: YAML (guide) or JSON (existing conventions, no new dependency)? | JSON first (`invariant.patterns.json`, mirroring `invariant.policies.json`), YAML later if wanted. | The repo has no YAML dependency and CLAUDE.md says no unnecessary dependencies. |
| D7 | Where do pattern rules live: first-class constraint `details` or the existing `extensions.invariant.rule`? | First-class, with a read fallback for the old location. | Consumers and schemas can see them. |
| D8 | How does a file declare which pattern applies (needed in Phase 4)? Options: policy `scope.paths` globs, an explicit comment annotation, or matching by root component. | Policy `scope.paths` first. Decide the rest at Phase 4. | Without applicability, a missing region cannot be called a violation. |

## 10. Non-goals confirmed

No pattern discovery, browser verification, LLM classification or new packages in Phases 1 to 3. The only new package-level work is inside `contract`, `governance`, `contract-query`, `mcp`, `apps/cli` and `validation`. No pattern-specific approval system is introduced: approvals, decisions, conflicts and the review queue are reused.
