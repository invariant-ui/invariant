# Invariant contract v1

Status: implemented in `packages/contract` (milestone M1). Source of truth is the Zod schema; this document explains it. JSON Schemas are generated from the Zod definitions and committed under `packages/contract/schema/` and `packages/compiler-ir/schema/`.

## Artifacts

| File | Schema | Purpose |
|---|---|---|
| `invariant.contract.json` | `contract-v1.schema.json` | Canonical contract. |
| `invariant.evidence.json` | `evidence-v1.schema.json` | Evidence entries, referenced from the contract by id. |
| IR documents | `ir-v1.schema.json` | Adapter output, input to the compiler (see "IR"). |

The manifest, diagnostics, and report artifacts from the plan arrive with the milestones that produce them.

## Top level

`contractVersion` (`1.1.0`; `1.0.0` documents are also read, see "Versioning and migrations"), `metadata`, `sources`, `themes`, `components`, `tokens`, `patterns`, `guidelines`, `constraints`, `policies`, `conflicts`, `integrity`. All objects are strict: unknown fields are rejected. Framework-specific data is allowed only inside `extensions`, namespaced by framework or tool (`extensions.angular`, `extensions.react`, `extensions.vue`), and the core model never interprets it.

Collections are sorted by id. `verifyContract` rejects duplicates and unsorted collections, which is what makes serialization deterministic.

## Identity

- Entity ids are `<kind>:<canonical-name>`: `component:button`, `token:color.brand.primary`, `pattern:form.login`. Kinds: component, token, theme, pattern, guideline, constraint, policy, conflict. Names match `[a-z0-9][a-z0-9._-]*` with optional `/` segments. Theme ids contain no dots or slashes because they appear as keys inside dotted fact paths.
- Source ids are plain slugs (`ui-react`, `zeroheight`).
- One conceptual component has one id and many `implementations`, one per (framework, source). Implementation ids are slugs unique within the component.
- Evidence ids are `ev_` plus 24 hex characters of a SHA-256 over the immutable parts of an observation (source, source reference, location, method, extractor, original text). Confidence, verification status, and capture time are excluded because they can change.

## Facts: status, evidence, approval

Entities (components, tokens, patterns, guidelines, constraints) carry `facts`: a map from a fact path to a record describing how that one field is known. Values stay plain in the entity; the record carries trust metadata. This is per-field granularity (ADR U5).

```
status:      discovered | documented | inferred | approved
evidenceIds: at least one id into the evidence file
confidence:  0..1, required when inferred
derivation:  { rule, reasoning, inputs, model? }, required when inferred
approval:    { approvedBy, approvedAt, role?, reference?, fingerprint, priorStatus }, required when approved
```

Rules enforced by the schema:

- Every fact has at least one evidence id.
- `inferred` requires `derivation` and `confidence`. Status and confidence are separate fields and are never merged.
- `approved` requires `approval`; `approval` is rejected on any other status. Approval layers over the earlier status: `approval.priorStatus` keeps whether the fact was discovered, documented, or inferred.
- `approval.fingerprint` is a SHA-256 over (entity id, path, value) at approval time. `verifyContract` recomputes it and reports `contract.approval-stale` when the value changed, so an approval cannot silently outlive the thing it approved.

Fact paths are dot-separated (`props.size.default`, `modes.theme:dark.value`). A segment selects an object member; on an array it selects the item whose `name` (else `id`) equals the segment, else the item at that numeric index (`composition.0`). `resolveFactPath` implements this and `verifyContract` requires every fact path to resolve.

## Domains

- **metadata**: `contractId` (stable identity of the design system), `name`, `compilerVersion`, `frameworks`, `compiledAt`. The plan's "source versions" live on `sources[].version` rather than being duplicated in metadata.
- **sources**: `type`, `location`, optional `version` (kind plus value; absent when the source exposes none, never invented), `authentication` (method and `credentialRef` only; the schema has no field that could hold a credential), `lastSyncedAt`, declared `capabilities` (fact-path patterns), and `health`.
- **components**: `implementations`, `props` (type text and neutral kind, required, default, allowed values, deprecation), `events`, `slots`, `variants`, `states`, `accessibility`, `examples`, `composition` (contains, requires-parent, commonly-used-with, extends), `lifecycle`. Angular inputs and outputs, Vue props, emits, and slots, and React props and children all map onto these neutral collections; the original construct is kept in `extensions`.
- **tokens and themes**: category (color, typography, spacing, sizing, border, shadow, breakpoint, motion, other), a value that is either a literal or `aliasOf` another token (exactly one), and per-theme `modes`. Alias cycles are rejected per theme layer.
- **patterns**: see "Patterns (1.1.0)" below.
- **guidelines, constraints**: entity references plus documentation references.
- **policies**: organization-approved rules with severity, enforcement (`block`, `warn`, `report-only`), scope, and mandatory approval metadata. A policy without approval cannot be represented.
- **conflicts**: type, severity, subject and optional path, at least two claims (each with source, status, evidence, and a value that may be absent), a suggested resolution, and a resolution state. Resolution is stored on the conflict; losing claims are never deleted.

## Integrity and determinism

`integrity.contentHash` is a SHA-256 over canonical JSON of the contract without the `integrity` block, `metadata.compiledAt`, and `sources[].lastSyncedAt`. Canonical JSON sorts object keys by UTF-16 code unit, preserves array order, and omits `undefined`. Timestamps are therefore carried but cannot change the hash. The evidence file records the `contractContentHash` it belongs to.

Serialization is `canonicalStringify(value, 2)` plus a trailing newline. Parsing then serializing is idempotent and independent of input key order (tested).

## Patterns (1.1.0)

A pattern is a reusable arrangement of an interface: a layout, an interaction, a page archetype or a composition. It is one entity with a `category` (`layout`, `navigation`, `form`, `data-table`, `card`, `dialog`, `workflow`, `composition`, `interaction`, `page`, `other`). The fields below are all optional, so existing patterns stay valid. Nothing in them names a framework or says how a rule is evaluated.

| Field | Holds |
|---|---|
| `intent` | One sentence: what the pattern is for. |
| `composition.parts` | Named parts: `name`, `ref` (a component or pattern id), `role` (`required`, `optional`, `prohibited`), optional `region`. |
| `layout.regions` | Named regions: `name`, `required`, `parent` (hierarchy), `accepts`, `width` (min and max length), `align`, `grid` (columns, gap token), `spacing` token, `responsive` (breakpoint token and behavior). |
| `behavior` | A state machine: `initial`, `states` (name, `feedback`, `terminal`, `verifiableBy`) and `transitions` (`id`, `from`, `to`, `trigger`, `verifiableBy`). |
| `accessibility.requirements` | `id`, `statement`, `verifiableBy`. |
| `variations` | Named, approved ways the composition may differ, for page archetypes: `name`, optional `description` and `when` (when to use it), `roles` (a part of the composition whose role differs: `required`, `optional` or `prohibited`) and `parts` (parts that exist only in this variation). A variation must change at least one role or add a part. Evidence is addressed as `variations.<name>`. |
| `appliesTo` | Where the pattern applies: `paths` (globs) and `frameworks`. Evidence is addressed as `appliesTo`. |
| `inheritsConstraints` | Opt in (boolean). Files in `appliesTo.paths` are also held to the constraints of every pattern this one composes. Without `appliesTo.paths` it is an error; it has effect only while both this and `appliesTo` are approved. |
| `relationships` | Typed edges with an `id`: `contains`, `requires`, `uses`, `extends`, `composes`, `alternative-to`, `prohibited-with`, `supersedes`. |
| `constraints` | Ids of the constraints the pattern owns. A policy makes one enforceable. |

`verifiableBy` (`static`, `runtime`, `manual`) states the weakest method that can verify a requirement, so a validator never reports more than it established.

**Names.** Region, part, state, transition, relationship and requirement names are fact-path segments, so they match `[a-z0-9][a-z0-9_-]*` and contain no dots. Evidence for an item is addressed by that name or id, for example `layout.regions.results.required` or `relationships.delete`.

**Constraint kinds** added for patterns, each with typed `details` (validated by `verifyContract`). A reference is a component id, a pattern id, or `region:<name>` for a region of the pattern that owns the constraint.

| Kind | `details` |
|---|---|
| `required-child` | `parent`, `child`, optional `min` (at least 1) |
| `forbidden-child` | `parent`, `child` |
| `requires-parent` | `child`, `parents` (at least one) |
| `required-region` | `region` |
| `ordering` | `before`, `after`, optional `within` |
| `cardinality` | `target`, optional `within`, `min` and/or `max` (at least one; `max` not below `min`) |
| `required-state` | `workflow` (`form-submission`, `destructive-confirmation` or `search-results`), `state` (one of that workflow's states: form-submission has `submitting`, `error`, `success`, `guarded`; destructive-confirmation has `confirming`, `cancellable`; search-results has `connected`, `loading`, `empty`, `error`, `clearable`), optional `minimum` (`structural` or `static-inferred`, default `structural`). Names no component, so nothing in it is a reference. |

The older constraint kinds keep free-form `details`.

**Checks** added to `verifyContract`: `contract.pattern-duplicate-name`, `pattern-region-unknown`, `pattern-region-cycle`, `pattern-state-unknown`, `pattern-unreachable-state` (a warning), `pattern-self-relationship`, `pattern-relationship-target` (all types except `contains` and `uses` must target a pattern), `pattern-duplicate-relationship`, `pattern-cycle` (over `contains`, `requires`, `extends`, `composes`, `supersedes` and non-prohibited composition parts), `constraint-details-invalid`, and `field-newer-than-version`. Pattern references to components, patterns, constraints and tokens are checked as `contract.dangling-reference`.

**Page archetypes.** A page archetype is a pattern with category `page` that composes other patterns through its parts and its `composes`, `contains`, `uses` and `requires` relationships, to any depth. `verifyContract` follows those links (each pattern as written and once per variation) and reports:

| Code | Severity | When |
|---|---|---|
| `contract.pattern-prohibited-combination` | error | One blueprint composes two patterns that one declares `prohibited-with` the other. Reported once per blueprint, naming it, the pair and the declaration. |
| `contract.pattern-prohibited-conflict` | error | A blueprint (or a variation of it) prohibits a part whose component or pattern a pattern it composes brings back. Another part of the same pattern using the same component is not a conflict: a part is a slot. |
| `contract.pattern-superseded-reference` | warning | A blueprint builds on a pattern that another pattern `supersedes`. |
| `contract.pattern-region-unfilled` | warning | A required region has no composition part placed in it (only checked when the pattern has both a layout and a composition). |
| `contract.pattern-variation-unknown-part` | error | A variation changes a part the composition does not have. |

Variation names, the parts a variation adds, and their regions are checked like any other (`contract.pattern-duplicate-name`, `contract.pattern-region-unknown`, dangling references), and a part a variation adds can close a cycle (`contract.pattern-cycle`). The walks stop at a pattern they have already followed, so a cycle cannot make them loop. A nested pattern contributes its base composition; its own variations are not chosen for it.

Status stays per field in `facts`; there is no stored pattern status. See ADR 0002.

## Validation layers

1. **Structure** (`parseContract`): Zod schema, with a dedicated `contract.unsupported-version` diagnostic for other major versions. The generated JSON Schema covers structure only; refinements and cross-references are not representable in it.
2. **Semantics** (`verifyContract`): `contract.duplicate-id`, `unsorted`, `dangling-reference`, `unknown-source`, `unresolvable-fact-path`, `approval-stale`, `token-alias-cycle`, `framework-mismatch`, `hash-mismatch`, and, with an evidence file, `unknown-evidence`, `evidence-hash-mismatch`, `evidence-id-mismatch`.

## IR (`packages/compiler-ir`)

An IR document is one source's claims: `source` (including `inputHash`, adapter name and version), declared `capabilities`, `completeness` (`complete`, `partial`, `failed`), `entities` (adapter-local `ref`), `facts`, `evidence`, `diagnostics`. A fact is `(subject, path, value, origin, evidenceIds)` using the contract's fact-path grammar, so React, Angular, and Vue adapters emit the same neutral paths (`props.size.default`) with framework detail under `extensions.<framework>`.

- `origin` is `extracted` or `authored`. Adapters cannot emit `inferred` or `approved`.
- Evidence with method `llm-assisted` is rejected in IR (`ir.llm-evidence`): adapters are deterministic, and model output belongs to the semantic engine.
- A source that disagrees with itself produces `ir.conflicting-facts` rather than a dropped value.
- Facts outside declared capabilities produce `ir.undeclared-capability` (the basis for not treating a missing field as a conflict, used from M2).
- `canonicalizeIrDocument` sorts every collection; serialization is order-independent (tested).
- `computeIrContentHash` hashes an IR document without evidence `capturedAt`, so unchanged inputs compare equal across runs.
- Entity kinds: component, token, theme, pattern, guideline, constraint, doc-page, story, plus package, export, config, token-file for project inventory. An `export` is only a name that a module exports, never a claim that it is a component.

## Versioning and migrations

`contractVersion` is `1.1.0` and `irVersion` is `1.3.0` (1.3.0 added the entity kind `module`; 1.2.0 added the entity kind `story-group`; 1.1.0 added the entity kinds `package`, `export`, `config`, `token-file`, and `computeIrContentHash`). Readers reject other major versions. Contract 1.1.0 added optional pattern fields only, so a 1.0.0 document is also a valid 1.1.0 document: it is read as it is, and its content hash stays valid. A document that declares 1.0.0 but uses a 1.1.0 field is rejected (`contract.field-newer-than-version`). A build that only knows 1.0.0 cannot read 1.1.0 documents. No migration registry exists because nothing needed rewriting; it is added with the first breaking schema change, together with an ADR and updated fixtures, as `CLAUDE.md` requires. See ADR 0002.

## Known limitations

- Fact coverage is not enforced: the schema validates facts that are present, not that every meaningful field has one. The compiler (M2) is responsible for emitting them.
- The token model is deliberately simple (literal or alias, per-theme). Composite token types and a published token format are open (ADR U4).
- `approved` authorization is metadata only; nothing yet verifies the approver is authorized (ADR U14).
- Evidence `original` is capped at 2,000 characters.
- Only the first sample contract (`packages/contract/fixtures/acme/`) exists; it is hand-built from realistic data and not yet produced by a compiler.
