# Pattern definitions (v1)

Status: implemented in `packages/governance` (`patterns-file.ts`, `patterns.ts`) and the CLI pipeline (pattern-contract Phase 3). Reads `invariant.patterns.json` and compiles it into the contract's `patterns`, `constraints` and `policies`. The contract schema is described in `contract-v1.md`, "Patterns (1.1.0)".

Pattern definitions are written by people, like `invariant.policies.json` and `invariant.decisions.json`. They are not extracted from source, so they are not an adapter and do not pass through the IR.

## The file

`invariant.patterns.json` in the project root, or the path in `governance.patternsFile`. JSON, no code.

```json
{
  "$schema": "./schema/patterns-file-v1.schema.json",
  "version": 1,
  "patterns": [
    {
      "id": "page.data-management",
      "name": "Data management page",
      "category": "page",
      "description": "A page to find, review and act on a collection of records.",
      "intent": "Let a person search a collection and act on what they find.",
      "layout": { "regions": [{ "name": "header", "required": true }, { "name": "results", "required": true }] },
      "composition": {
        "parts": [
          { "name": "toolbar", "ref": "Table toolbar", "role": "required", "region": "results" },
          { "name": "table", "ref": "DataTable", "role": "required", "region": "results" }
        ]
      },
      "relationships": [{ "id": "tools", "type": "composes", "target": "composition.table-toolbar" }],
      "constraints": [
        {
          "id": "single-table",
          "kind": "cardinality",
          "description": "A data management page shows exactly one table.",
          "details": { "target": "DataTable", "min": 1, "max": 1, "within": "region:results" },
          "enforce": { "severity": "error", "enforcement": "block" }
        }
      ],
      "appliesTo": { "paths": ["src/pages/**"], "frameworks": ["react"] },
      "approval": { "approvedBy": "design-system-owners", "approvedAt": "2026-11-03T10:00:00.000Z", "reference": "DS-210" }
    }
  ]
}
```

`invariant export --to <dir>` writes the JSON Schema (`schema/patterns-file-v1.schema.json`). Point `$schema` at it and an editor validates the file as you type. The compiler validates it again.

### Fields of a definition

| Field | Meaning |
|---|---|
| `id` | Stable id: `page.data-management`, or with the prefix, `pattern:page.data-management`. Becomes `pattern:<id>`. |
| `name`, `category`, `description` | Required. `category` is one of the contract's pattern categories. |
| `intent` | One sentence: what the pattern is for. |
| `composition.parts` | `name`, `ref`, `role` (`required`, `optional`, `prohibited`), optional `region`. |
| `layout.regions` | `name`, `required`, optional `parent`, `accepts`, `width`, `align`, `grid`, `spacing`, `responsive`. |
| `behavior` | `initial`, `states`, `transitions`, as in the contract. |
| `accessibility.requirements` | `id`, `statement`, optional `verifiableBy`. |
| `variations` | `name`, optional `description` and `when`, and `roles` (`part`, `role`) and/or `parts` (like `composition.parts`, references resolved the same way). At least one of `roles` or `parts`. |
| `relationships` | `id`, `type`, `target`, optional `description`. |
| `constraints` | `id` (local to the pattern), optional `name`, `kind`, `description`, `details`, optional `enforce`. A `required-state` constraint requires an interaction state (`workflow`, `state`, optional `minimum`) instead of naming components; its details are kept as written. |
| `guidelines` | Guidelines the pattern relates to, by id or name. |
| `appliesTo` | Optional `paths` and `frameworks`. Stored on the pattern and copied into the scope of the policies it generates. |
| `inheritsConstraints` | Optional boolean, default off. Needs `appliesTo.paths` and an approval. See "Page archetypes". |
| `approval` | Optional: `approvedBy`, `approvedAt`, `role`, `reference`. See "Approval". |

Unknown fields are rejected, so a misspelled key is an error, not a silent no-op.

## References

Wherever a definition points at a component, pattern, token or guideline, it can write an id or a name. Compiling resolves it, in this order:

1. An exact id (`component:data-table`).
2. A name or id body, ignoring case and separators (`DataTable`, `data table`, `data-table`).
3. The part of a pattern id after its category (`data-management` for `pattern:page.data-management`).

A stricter match beats a looser one. Several matches at the same level are an error, not a guess: write the full id. A reference with an explicit prefix (`component:...`, `pattern:...`) is never matched loosely. A part's `ref` and a region's `accepts` may name a component or a pattern, and so may a `contains` or `uses` relationship. The other relationship types (`requires`, `extends`, `composes`, `alternative-to`, `prohibited-with`, `supersedes`) must name a pattern. A definition can refer to another definition in the same file, in any order, and to patterns already in the contract.

Tokens are referenced by id (`token:spacing.md`) or name. In constraint `details`, a value written `region:<name>` refers to a region of the same pattern.

The pattern's `components` list is not written by hand. It is the sorted set of components the definition mentions.

## What compiling produces

For each definition:

- a **pattern** entity with `intent`, `composition`, `layout`, `behavior`, `accessibility` and `relationships` as written, references resolved;
- a **constraint** `constraint:<pattern>.<id>` per constraint, with `details` checked against its kind;
- a **policy** `policy:<pattern>.<id>` per constraint that has `enforce`, when the pattern is approved;
- **facts** with evidence;
- one contract **source** `patterns` (type `patterns`, location the file, version the SHA-256 of its text, health `ok` or `degraded`).

Nothing that was already in the contract is changed. An id that already exists (from another source, or defined twice in the file) is an error and the later definition is left out.

### Facts and evidence

There is one fact per authored section: `description`, `intent`, `composition`, `layout`, `behavior`, `accessibility`, `variations.<name>` and `relationships.<id>`; for a constraint, `description` and `details`. Each cites one evidence entry per pattern: source `patterns`, method `manual`, location the file, `sourceRef` `invariant.patterns.json#<id>`, and a short excerpt of the name and intent. Line numbers are not recorded.

### Approval

A file in the repository is not an approval by itself.

- **Without `approval`:** every fact is `documented`. The pattern appears in `patterns list` as not approved. Each fact is a `pattern-fact` item in the review queue; `invariant review approve <id> --as <name>` records a decision that makes that fact `approved` at the next compile. `reject` does not apply to a definition you wrote: edit or remove it. A decision goes stale if the value it approved changes.
- **With `approval`:** every fact is `approved`, layered over `documented`, with a fingerprint like any approval. Changing the definition without updating the approval is stale, and verification reports `contract.approval-stale`.

The approver name is asserted, not authenticated, as everywhere in governance. Who may edit the file is decided by your repository's review process.

### Enforcement

A constraint becomes enforceable only through a policy, and a policy needs an approval that nothing infers. So `enforce` creates a policy only when the pattern has an `approval`. Otherwise compiling warns (`governance.pattern-policy-needs-approval`) and adds the constraint without a policy.

`enforce` takes `severity` (`error`, `warning`, `info`) and `enforcement` (`block`, `warn`, `report-only`, default `block`). The policy's scope is the pattern, plus `appliesTo.paths` and `appliesTo.frameworks`.

`invariant validate` evaluates these policies against React files: which files, what each constraint kind checks, and what is reported as not verifiable are in `validation-and-governance-v1.md`, "Pattern rules". `appliesTo.paths` is what marks a file as an instance of the pattern, so a constraint about a whole file (`required-region`, or `ordering` and `cardinality` without `within`) needs it.

## Page archetypes

A page archetype is an ordinary definition with `category: "page"`. It composes other patterns by naming them as parts or in `relationships`, and the contract's verification follows them to any depth (see `contract-v1.md`, "Page archetypes"). A complete example, with a data management page, a detail page and a create/edit form that share an application shell, a page header, a table toolbar, a destructive confirmation and a form workflow, is in `fixtures/page-archetypes/invariant.patterns.json`.

- **Regions and parts.** Declare the regions a page has and place each part in one with `region`. A required region with no part gets a warning.
- **Variations** say what may differ without making a second pattern: `read-only` can make an `actions` part prohibited, `create` can prohibit a `remove` part, `bulk-actions` can add a part. Give each a `when`.
- **Required interaction states** are `required-state` constraints on the archetype or on the interaction patterns it `uses`. `invariant patterns resolve` lists them, and whether a policy enforces each.
- **Responsive expectations** are region `responsive` entries; resolving collects them from everything the archetype builds on.
- **Approval** is per pattern. An approved archetype does not approve the patterns it builds on, and resolving says which of them are not approved.

`invariant patterns resolve <name> [--variation name]` and the MCP tool `get_design_patterns` with `name` and `resolve` (or `variation`) return the resolved blueprint.

By default the constraints of the patterns an archetype composes are not applied to a page file because the file matches the archetype's paths: each constraint is enforced by its own policy, with its own paths. Set `inheritsConstraints: true` next to `appliesTo.paths` to opt in. Files matching those paths are then also held to the rules of everything the archetype composes (parts and variation parts, through patterns they use). It has effect only when the definition is approved, it adds no policy, and a rule already scoped to the file by its own policy is evaluated once, under its own scope. Results of inherited rules carry `inheritedFrom`.

## Diagnostics

All are errors unless noted, and every one names the file. Compiling collects every problem in a definition before leaving it out, then adds `governance.pattern-skipped`. A skipped pattern marks the `patterns` source `degraded`. The other definitions are still added, and `compile` exits 1.

| Code | When |
|---|---|
| `governance.invalid-file` | The file is not valid JSON, or does not fit the schema (the message gives the path, such as `patterns.0.category`). Nothing is compiled. |
| `governance.pattern-unknown-component`, `-unknown-pattern`, `-unknown-token`, `-unknown-guideline` | A reference matches nothing. The message names where (for example `composition.parts.title.ref`) and suggests close names. |
| `governance.pattern-ambiguous-reference` | A reference matches several entities at the same level. |
| `governance.pattern-constraint-invalid` | `details` do not fit the constraint's kind. |
| `governance.pattern-unknown-region` | A `region:<name>` in `details` is not a region of the pattern. |
| `governance.pattern-duplicate-id` | An id appears twice in the file. The first is kept. |
| `governance.pattern-id-taken` | The pattern, constraint or policy id already exists in the contract. |
| `governance.pattern-invalid` | The resolved pattern does not fit the contract schema. |
| `governance.pattern-skipped` | A definition was left out; follows the errors that caused it. |
| `governance.pattern-policy-needs-approval` (warning) | A constraint has `enforce` but the pattern has no `approval`. |

Semantic problems that only show up across patterns (a cycle, a duplicate region name, a state machine with an unknown state) are reported by the contract's own verification as `contract.pattern-*` errors. Those patterns are in the contract, so fix the definition and compile again.

## Determinism

The same file and contract compile to the same bytes. Entities are sorted by id. Evidence ids are content-addressed. Only the evidence `capturedAt` comes from the clock, like every other adapter.

## Known limitations

- One file. A directory of files is not read.
- JSON only. There is no YAML.
- A second producer of patterns (documents, discovery) is not built, so there is no cross-source conflict handling for patterns yet. A clash of ids is reported, not resolved.
- No `invariant patterns add` or `patterns check`: `compile` is the check.
- Facts are per section, not per field, so approving `layout` approves all of it.
- Validation covers React JSX and six constraint kinds, one file at a time. Composition parts are not enforced on their own: write a constraint.
