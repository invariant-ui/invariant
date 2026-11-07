# Reconciliation and semantic engine (v1)

Status: implemented in `packages/reconciliation` and `packages/semantic-engine` (plan Phase 7). Input is IR 1.3.0. Output is contract 1.0.0, an evidence file, and a review queue. Contract schema is unchanged.

## Pipeline

```
IR documents --reconcile--> contract draft + evidence + conflicts + diagnostics
             --enrich-----> same, plus inferred facts and entities
             --finalizeContract--> contract (content hash)
             --buildReviewQueue--> review items
```

`reconcile` and `enrich` are pure functions of their inputs and an injected clock. Both are deterministic: same IR documents, same options, same bytes.

## Reconciliation

### Sources and evidence

Every IR document's source becomes a contract source (`health`: complete is ok, partial is degraded, failed is failed). Every evidence entry cited by a fact in the contract is copied to the evidence file once, by id.

### Components

Components come from IR component entities that publish the framework link key. Entities without it are reported as a diagnostic, never guessed.

**Identity.** See the ADR Phase 7 addendum. Each merge across frameworks is recorded as an `inferred` fact at `implementations.<id>` and appears in the review queue.

**Facts.** For each neutral path an implementation states, the contract entity gets the value and a fact record. Status is `discovered` when the IR fact is `extracted` and `documented` when it is `authored`. Implementations that agree share one fact with the union of their evidence. Implementations that disagree produce a conflict.

Neutral paths mapped to contract fields: `name`, `description`, `lifecycle`, `props.*`, `events.*`, `slots.*`, `variants.*`, `accessibility.*`, `composition.subcomponents`, `composition.renders`. Framework detail goes to `implementations[].extensions.<fw>` and `props[].extensions.<fw>`. `styling.*`, `usage.*` and anything else without a contract field goes to `extensions.invariant` (open decision U17).

`composition.subcomponents` and `composition.renders` become `contains` relationships to resolved components. Targets that are not public components are dropped with an info diagnostic.

### Tokens

Only token entities with `value.*` facts (the design-token adapters) are merged; inventory-level token entries without values are skipped. Tokens from different files merge on a normalized name (`color.brand` equals `color-brand`) and the merge is an `inferred` fact. A different literal or alias for the same token, or the same theme, is a `token-value-mismatch`. Theme entities are created from mode names. `category` is a placeholder `other` with no fact until the semantic engine classifies it.

### Conflicts

Types used: `value-mismatch`, `existence-mismatch`, `deprecation-mismatch`, `identity-ambiguity`, `token-value-mismatch`. Ids are `conflict:<type>/<subject>/<path>`. Claims carry source, status, evidence and the value (absent means the source says it does not exist). Resolution starts `open`.

Storybook findings with evidence on both sides become conflicts: `arg-value-not-allowed`, `control-option-not-allowed`, `default-mismatch` (value-mismatch), `arg-undeclared`, `control-undeclared` (existence-mismatch), `deprecated-demonstrated` (deprecation-mismatch). Coverage findings (`prop-not-demonstrated`, `value-not-demonstrated`, `component-unlinked`, `unverifiable-names`) remain diagnostics.

### Review queue

`buildReviewQueue(contract)` returns one item per open conflict, per inferred fact, with kind, subject, path, confidence, evidence ids, reason, and `approvalRequired: true`. Sorted, deterministic. It is derived from the contract and is not stored in it.

## Semantic engine

All rules emit `inferred` facts with `derivation` (`rule`, `reasoning`, `inputs`) and `confidence`, citing existing evidence. Nothing is promoted to `approved`; no policy is produced.

| Rule | Output | Confidence |
|---|---|---|
| `token-category.dtcg-type` | token `category` from a declared DTCG `$type` of color, shadow, typography, border | 0.95 |
| `token-category.value-kind` | `category` from a CSS value kind (color) | 0.9 |
| `token-category.name-prefix` | `category` from a name prefix (`color`, `space`, `font`, `shadow`, `radius`, `breakpoint`, `duration`, ...) | 0.7 |
| `token-category.fallback` | `category` stays `other` | 0.2 |
| `document.classify` | guideline `kind` from keywords in the page title or file name (headings are not used: component pages routinely have an "Accessibility" or "Keyboard" section without being accessibility guidelines) | 0.6 to 0.7; `reference` is 0.4 |
| `document.names-component` | guideline `appliesTo` from a file stem equal to a component name (0.8) or a title containing the name as whole words (0.6); a title match is dropped when a longer component matches by file name | 0.8 stem, 0.6 title |
| `compound.name-prefix` | component `contains` child when child names start with the parent name and the parent has at least two such children in one package | 0.7 same file, 0.5 otherwise |

Guideline `statement` is the page title because the IR carries the title and headings, not body text. `kind` is `reference` unless keywords match. This is a limitation: deeper interpretation of documentation prose needs a model or the zeroheight and Figma sources.

**Additive guarantee.** After enrichment, `assertAdditive(before, after)` verifies that every fact record and value present before is unchanged, except a token `category` placeholder. A violation is an error diagnostic and enrichment is discarded.

## Verification

- Unit and fixture tests: `packages/reconciliation` (51), `packages/semantic-engine` (20), `scripts/phase7.e2e.test.ts` (5, with golden contracts in `fixtures/contract-golden/`).
- Exit-criterion test: one Button from React, Vue and Angular becomes one component with explained identity and one `info` disagreement; a design system's stories and code produce six conflicts with evidence on both sides; no fact is approved, no policy exists, every inferred fact has a rule, reasoning, confidence and evidence; output is identical whatever order the IR arrives in.
- Real libraries (`node scripts/compile-dev.ts <dir> <out> --contract ...`). Every contract below passes `verifyContract` with its evidence file.

| Library | Components | Tokens | Guidelines | Conflicts |
|---|---|---|---|---|
| reka-ui (Vue) | 395 | 24 | 527 | 0 |
| ng-bootstrap (Angular) | 52 | 100 | 8 | 3 token-value-mismatch (the same Sass variable defined with different values in different files) |
| Radix (React) | 227 | 6 | 155 | 0 |
| Storybook design system | 43 | 0 | 8 | 0 |

Real-data runs changed two rules: guideline kind no longer reads headings (63 reka-ui component pages had been classified as accessibility guidelines because of a "Keyboard Interactions" section), and duplicate claims inside one conflict are merged.

## Known limitations

- Patterns are not produced: a pattern needs a description of intent, which static facts and headings do not supply.
- Name-based identity is a heuristic and is marked as such. It cannot link `Buttons` to `Button` or `Button / Primary` to `Button`.
- No model-assisted classification. Review queue has no "rejected" state.
- Conflict precedence picks one value for the entity; consumers must read the conflict list.
- Token values are compared as the token adapter reports them, so a difference in whitespace alone is reported as a mismatch.
- Compound inference is naming-based and will propose some wrong parents (a component whose name extends another's, such as `Button` and `ButtonGroup`); such links get 0.4 to 0.7 confidence and are in the review queue.
- Guideline `kind` reads only the title and file name. Developer documents in a repository (changelogs, contributing guides) also become `reference` guidelines because the IR cannot tell them from design guidance.
- The review queue lists every inferred fact, so it is long on large libraries (437 items for Radix). Priority orders it; there is no filtering or batch approval yet (Phase 8 and 10).
