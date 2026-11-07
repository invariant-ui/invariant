# Validation and governance (v1)

Status: implemented in `packages/validation`, `packages/governance`, and the CLI commands `validate`, `verify`, `rules`, `policy` and `review` (plan Phase 10). The contract schema is unchanged.

## `invariant validate <path...>`

Checks application code against the compiled contract. Paths are files or directories inside the project; directories are walked, skipping `node_modules`, build output, symbolic links, `.d.ts` files and `validation.ignore` globs. Recognized files: `.tsx .jsx .ts .js .mjs .cjs .vue .html`. The framework comes from the file name (`.vue`, `.component.html`, `.html`), then `--framework`, then the contract's only framework, then React.

```
invariant validate src                                  # text report, exit 1 on any error
invariant validate src --format json|github|sarif       # machine-readable output
invariant validate src --fail-on warning|never          # change the failing threshold
```

Nothing is executed or imported: JSX is parsed with the TypeScript API, templates with a linear scanner. Only literal values are verified; expressions and bindings are counted as unverified and never guessed. Exit codes: 0 pass, 1 findings at or above the threshold, 2 bad usage. `invariant verify` is the former Phase 8 `validate`: it checks the compiled output itself.

### What each violation says

File, line and column; the rule code; the subject (component or token id); an explanation; a suggested correction; the evidence (`path:line` in the library source, from the contract) or the approved policy and the policy file; and the `basis` of the claim (`discovered`, `documented`, `inferred`, `approved`, or `heuristic`). Text output:

```
app/App.tsx:4:5 error prop-value-not-allowed
  Button.variant is "danger", which is not one of "primary", "secondary", "ghost"
  fix: Use one of "primary", "secondary", "ghost" (closest: "primary").
  evidence src/Button.tsx:28 (discovered); subject component:button
```

### The eleven rules

| Plan rule | Codes | Default severity | Needs |
|---|---|---|---|
| Unknown component | `component-unknown`, `framework-not-implemented` | error | A React import from a package the contract publishes. A tag without such an import is never called unknown. |
| Unknown property | `unknown-prop` (`unverifiable-prop` when the API listing is incomplete) | warning, info | Standard HTML attributes, `aria-*`, `data-*`, and event or slot names are never flagged. |
| Invalid property value | `prop-value-not-allowed`, `prop-type-mismatch` | error, warning | Declared allowed values or kind. |
| Deprecated component | `component-deprecated` | warning | `lifecycle: deprecated`. |
| Deprecated property | `prop-deprecated` | warning | A deprecation fact on the prop. |
| Unsupported composition | `composition-parent-required` (contract `requires-parent`), `composition-not-allowed` (policy) | error | A non-inferred `requires-parent` relationship, or an approved policy. No compiler produces `requires-parent` yet. |
| Missing required property | `required-prop-missing` | error | Required props; not claimed when props may be spread or children are unknown. |
| Hardcoded color | `color-not-in-tokens` (`color-matches-token` suggests the token whose value is equal) | warning, info | At least one token with a literal color value. Reads hex, `rgb()`/`rgba()`, `hsl()`/`hsla()` and CSS named colors; see "Literal values" below. |
| Unapproved token | `unknown-css-variable`, `token-deprecated`, `token-forbidden` (policy) | warning, warning, error | Tokens in the contract. A variable declared in the same file is not unknown. |
| Missing accessibility requirement | `accessibility-requirement-missing` | error | An approved `require-attribute` policy with category `accessibility`. No compiler produces accessibility requirements yet. |
| Invalid layout pattern | `layout-pattern-invalid` | error | An approved `allowed-children` policy with category `layout`. Pattern entities are not validated (none exist). |

### Literal values

Beyond the eleven rules, `validate` compares literal values with tokens of the matching category. Every comparison needs at least one token of that category with a literal value; without one the check is skipped and the report's limitations say so. Only literals are read: anything containing `var(`, `calc(`, `clamp(` or a binding is skipped, never guessed.

| Kind | Codes | Severity | Reads |
|---|---|---|---|
| Color | `color-not-in-tokens`, `color-matches-token` | warning, info | Hex (`#rgb` to `#rrggbbaa`), `rgb()`/`rgba()` and `hsl()`/`hsla()` with literal numbers in comma or space syntax, and CSS named colors. Functional and hex colors are compared by value after normalizing to hex (`rgb(0 87 255)` equals `#0057ff`). Named colors are read only as the value of a color property (`color`, `background`, `border`, `fill`, `stroke`, `outline` and similar) and compared with a token by name; a name never equals a hex token. |
| Spacing | `spacing-not-in-tokens`, `spacing-matches-token` | warning, info | Lengths in `margin*`, `padding*` and `gap` declarations, in CSS or style objects. `px` as is, `rem` and `em` against a 16px root, a bare number in a style object as px. Zero, `auto`, percentages, `var()` and `calc()` are skipped. Compared with tokens whose category is `spacing`. |
| Typography | `typography-not-in-tokens`, `typography-matches-token` | warning, info | `font-size`, `font-weight` (numbers, `normal`, `bold`), `line-height`, `letter-spacing` and the first `font-family` name. Compared with tokens whose category is `typography`, including the parts of a composite value (`fontFamily`, `fontSize`, `fontWeight`, `lineHeight`, `letterSpacing`). |

These checks have no code in the original eleven, so `invariant rules` lists them under the plan label `Hardcoded value` (spacing and typography) and `Hardcoded color` (colors).

### Pattern rules

An approved policy whose constraint is of a pattern kind (`required-child`, `forbidden-child`, `requires-parent`, `required-region`, `ordering`, `cardinality`) becomes a structural rule over the element tree of a file. Only approved policies are enforced: a pattern with no policy, or a constraint whose `details` cannot be read (reported under limitations as "Not enforced"), is not. Severity comes from the policy, lowered by enforcement, and `validation.rules` overrides apply by code.

| Constraint | Code | What it checks |
|---|---|---|
| `required-child` | `pattern-required-child-missing` | Each `parent` element contains at least `min` (default 1) `child` elements, at any depth. |
| `forbidden-child` | `pattern-child-forbidden` | No `child` element appears anywhere inside a `parent` element. |
| `requires-parent` | `pattern-parent-required` | Each `child` element sits inside one of `parents`. |
| `required-region` | `pattern-region-missing` | A region of the pattern is present in the file. |
| `ordering` | `pattern-order-violated` | Every `before` element precedes every `after` element in source order, within the file or within each `within` element. Ancestors are not ordered against their descendants. |
| `cardinality` | `pattern-cardinality-violated` | The number of `target` elements is within `min` and `max`, in the file or in each `within` element. `max: 0` forbids the element. |
| `required-state` | `pattern-state-missing` | An interaction in the file represents a state its workflow requires. See "Interaction checks" below. |

These cover the guide's composition rules: a required component is `cardinality` with `min` or `required-child`; a prohibited component is `cardinality` with `max: 0` or `forbidden-child`. Roles on a pattern's composition parts are not enforced by themselves; write a constraint.

**Which files.** A policy applies to a file when its `scope.frameworks` include the file's framework (or are empty) and its `scope.paths` match the project-relative path (or are empty). Pattern definitions copy `appliesTo` into these. A file the policy does not apply to has no result for it. A rule that is about a whole file (`required-region`, and `ordering` or `cardinality` without `within`) needs `paths`: the paths are how Invariant knows the file is an instance of the pattern, so without them the result is `skipped`. Rules about an element (`required-child`, `forbidden-child`, `requires-parent`, and `ordering` or `cardinality` with a component in `within`) apply wherever the element appears.

**What a check can say.** Each check on a file is recorded as an evaluation:

| Status | Meaning |
|---|---|
| `pass` | It was evaluated and holds. |
| `fail` | It was evaluated and is violated. Produces a finding with the policy's severity. |
| `warning` | It holds only if conditionally rendered elements render, or it might be exceeded by a list or conditional. Produces a finding capped at `warning`. |
| `not-verifiable` | This analysis cannot establish it. Produces no finding and is never counted as a pass. |
| `skipped` | It applies to the file but cannot be evaluated; the reason says why (no paths, nothing to order, templates). |

**What makes a scope trustworthy.** A scope is closed when nothing in it can hide elements. It is not closed if it contains a component from outside the design system, a component the contract does not know, an element whose children come from an expression that contains no JSX (`{children}`, `{renderRows()}`), a spread, or a `children` prop. Absence, a correct order and an upper bound are only reported as `pass` in a closed scope; otherwise the check is `not-verifiable`. Presence is proof: a required child that is there passes even in an open scope. A violation that is visible (a forbidden child, an element out of order, more certain elements than the maximum) fails regardless.

Elements inside `{...}` (`cond && <A/>`, `.map(...)`, a render prop) are conditional or repeated: they never prove presence, and a repeated element can never prove an upper bound. An element handed to its parent as a prop (`icon={<Icon/>}`) is counted as present. JSX that is not returned (a variable, an argument) is not placed in the tree.

`requires-parent` follows the existing `required-parent` policy rule: it fails when a different design-system element encloses the child and none of the allowed parents does, and is `not-verifiable` when no design-system element encloses it in the file. A wrapper outside the file can make the first case a false positive.

**Not evaluated yet** (each is `not-verifiable`, with the reason): a pattern as a reference in a constraint (occurrences of a pattern are not detected), `within` a region for `ordering` and `cardinality`, and a region with no composition part that is a component (nothing recognizes it). Regions are recognized by the components of the pattern's composition parts that name them.

**Frameworks.** React JSX only. Vue, Angular and HTML templates give `skipped` results saying so.

**Output.** `validate --format json` adds `evaluations` and `summary.patternRules` (`pass`, `fail`, `warning`, `notVerifiable`, `skipped`). Text output prints the tally and lists every not-verifiable and skipped check with its reason. `--format github` prints annotations for findings only and the tally in its last line. SARIF carries findings only, and the tally under the run's `properties`. Exit codes are unchanged: not-verifiable and skipped checks do not fail a run. The MCP tool `validate_design_system_compliance` returns `evaluations`; give it `filename`, or path-scoped rules are `skipped`.

### Interaction checks

A `required-state` constraint (code `pattern-state-missing`) says that each place a workflow occurs in a file must represent one of its states. It is enforced like every pattern rule: through an approved policy, for React files the policy's paths and frameworks select, one file at a time. Where the workflow does not occur there is no result.

The first slice looks for three workflows, each found in the JSX and handlers of the file:

| Workflow | Found as | States |
|---|---|---|
| `form-submission` | An element with an `onSubmit` handler. | `submitting` (a pending flag the interface shows), `error` (an error the interface shows, or an alert region), `success` (a success flag, or a navigation or toast call after the await), `guarded` (the submit control is disabled while pending, or the handler returns early). |
| `destructive-confirmation` | An element with an `onClick` or `onPress` whose handler calls something named delete, remove, destroy, discard, erase or purge, or whose text says Delete, Remove, Destroy or Discard. Elements inside a dialog are the confirm action, not a second trigger. | `confirming` (the handler opens a dialog that reacts to its state, or calls `confirm` before deleting), `cancellable` (the dialog has a cancel or close affordance). |
| `search-results` | A search input: `type="search"`, a component named like SearchField, or an input bound to a query-named state. | `connected` (the search text feeds a filter or a request, or is used elsewhere), `loading`, `empty`, `error` (flags the interface shows, hook results included), `clearable` (a clear control, or a native search input). |

**How much a result establishes.** A result that found its state says at what level, in `level`, with what was seen in `evidence`:

| Level | Meaning |
|---|---|
| `structural` | The code has the piece and the interface shows it. Some of this rests on names (a state called `isSubmitting` that the JSX reads). |
| `static-inferred` | A handler's code shows it happening: a flag set to true before an `await` and back to false after, a catch block that sets the error, a delete call reachable only from the dialog's confirm action. |
| `runtime-verified` | Reserved for results that come from running the code. Static analysis never produces it. |

`minimum` on the constraint says the weakest level that satisfies it (default `structural`). A state found at a lower level than the minimum is a `warning`. A state found at or above it is a `pass`. A state not found is a `fail` when nothing in the file could be hiding it, and `not-verifiable` when something could: a handler passed in from outside (`props.onSubmit`), a custom hook, a spread on the form, a form `action` (a child may read its status), or a component from another file inside the form or the component. A design-system component is not a reason, because its content is known.

What the checks do and do not mean:

- They show that a state is represented in the code, not that it works. A pending flag that is set and shown can still be wrong at runtime. Nothing here runs the code, and no result is called runtime verified.
- Name matching is part of `structural` evidence (flags named like pending, error or success; handlers named like delete). The evidence names the identifier, so a reviewer can judge it.
- `guarded` and `submitting` are judged on one component and its handlers. Pending state kept in a parent or a store is invisible and gives `not-verifiable` or a failure only when nothing else could supply it.
- Handlers are read when defined in the file (a function, an arrow, `useCallback`, a single delegation, react-hook-form's `handleSubmit(fn)`), including promise chains and functions declared inside an effect.

The text report adds a line with the tally by level (`interaction evidence: ... structural or better (N statically inferred, M structural only, 0 runtime verified; static analysis does not run the code)`), and the JSON summary gains `interactionEvidence`. Each evaluation carries `level` and `evidence` when it found something.

Helper findings: `component-ambiguous` (a name several components share, narrowed by the import's package when possible), `native-element-has-equivalent` (a name match such as `<button>` and `Button`: `heuristic`, confidence 0.5, info), `input-too-large`. Helper findings repeat per use, so each is reported once per file. `invariant rules` lists every code with its default severity, origin, and plan rule.

**Severity.** `validation.rules` in `invariant.config.json` sets a severity or `off` per code; unknown codes are rejected with a suggestion. Policy rules take the policy's severity, lowered by enforcement: `warn` caps at warning, `report-only` is info. `validation.failOn` sets the default threshold.

## Policies

Organizational rules are written by people in `invariant.policies.json` (path configurable with `governance.policiesFile`), in version control:

```json
{ "version": 1, "policies": [ {
  "id": "icon-buttons-need-labels",
  "name": "Icon-only buttons need an accessible name",
  "statement": "A button without text content must have aria-label or aria-labelledby.",
  "severity": "error",
  "enforcement": "block",
  "approval": { "approvedBy": "Jane Doe", "approvedAt": "2026-01-05T00:00:00.000Z", "role": "design-system lead", "reference": "RFC-7" },
  "rule": { "kind": "require-attribute", "components": ["Button"], "anyOf": ["aria-label", "aria-labelledby"], "unlessChildren": true, "category": "accessibility" }
} ] }
```

Rule kinds: `require-attribute`, `forbid-prop`, `forbid-prop-value`, `forbid-component`, `forbid-token`, `allowed-children` (`category` `layout` or `composition`), `required-parent`. A policy without `approval` is rejected: nothing infers or auto-approves a policy. `compile` adds each policy as a contract `policy` plus a `constraint` carrying the normalized rule (`extensions.invariant.rule`), so the contract stays self-contained and `validate` reads only the contract. A policy naming a component or token the contract lacks is kept and reported (`governance.policy-unknown-component`); that part cannot fire. `invariant policy list` shows approved policies.

Composition checks are conservative: `required-parent` only fires when the element sits inside other design-system components and none is an allowed parent, because at the top of a file the real parent may be in another file. `allowed-children` checks only design-system children.

## Pattern definitions

Layouts, interactions, page archetypes and compositions are written in `invariant.patterns.json` (path configurable with `governance.patternsFile`) and compiled into patterns, constraints and, when approved, policies. See `pattern-definitions-v1.md`. A constraint's `enforce` creates a policy only when the pattern carries an approval. `validate` evaluates those constraints; see "Pattern rules" below.

## Decisions

`invariant review list|show` lists what needs a person: open conflicts and every inferred fact, with evidence. Decisions are written to `invariant.decisions.json` (path configurable) and applied on every `compile`:

| Command | Effect at compile |
|---|---|
| `review approve <id>` | An inferred (or other) fact becomes `approved`, layered over its prior status, with the contract's own fingerprint and `--role`/`--reference`/`--note`. |
| `review reject <id>` | An inferred containment link, inferred guideline link, or inferred token category is removed. Other inferred facts (for example a cross-framework identity) cannot be rejected; the reason says how to fix it at the source. |
| `review resolve\|accept\|dismiss <id> [--source s]` | Records the conflict's resolution (`resolved` means fixed at the source, `accepted` a known difference, `dismissed` not a real conflict). The kept value is not rewritten; the conflict disappears on recompile once the source is fixed. |

Every decision needs `--as <name>` (or `INVARIANT_USER`) and records when. A decision records the value or claims it was made about. If they change, the decision is **stale**: it is not applied, `compile` reports `governance.decision-stale`, and the item returns to the queue. A decision whose target is gone is reported (`governance.decision-target-missing`). Array-item targets are found by value, so reordering does not break them. The last decision about a target replaces earlier ones in the file.

**Authorization is not authentication.** The recorded name is asserted. `governance.approvers` (optional) restricts which names the CLI will record and `compile` will apply; a decision by another name is rejected at compile (`governance.unauthorized`). Real enforcement is your repository's review process over `invariant.policies.json` and `invariant.decisions.json` (for example CODEOWNERS). Open decision U14 remains.

## CI

Exit codes plus formats are the integration: `--format github` prints workflow-command annotations, `--format sarif` prints SARIF 2.1.0 for code scanning, `--format json` is for scripts. Run `invariant compile` then `invariant validate <paths> --format github` in a job. No workflow file is generated because the tool is not published and an install step would be invented.

## Verification

- `packages/validation` (55 tests), `packages/governance` (20), CLI governance tests (19), `scripts/phase10.e2e.test.ts` (6) with a committed fixture application and golden report (`fixtures/validation/`).
- The end-to-end test runs the real CLI on one fixture file and requires a violation for each of the eleven plan rules; requires file, line, column, explanation and a suggested correction on every violation; requires evidence or a policy reference on every contract-based one; checks clean code passes with `--fail-on warning`; and checks output is byte-identical across runs.
- Real libraries: 43 Radix story files and 282 reka-ui demo files validate in well under a second. Reka-ui's demos showed a correct finding (a component with a required prop its demo omits) and two false-positive classes that were fixed (standard HTML attributes, and CSS variables declared in the same file).

## Known limitations

- Interaction checks cover three workflows in React and read one component at a time; they show representation, never behavior, and some of their evidence rests on names.
- Pattern rules read one file's JSX. A check that depends on another file, or on children a file does not show, is `not-verifiable`; there is no cross-file composition, and no pattern occurrences, regions as scopes, or Vue and Angular templates yet.
- Validation sees one file at a time: no cross-file data flow, no resolution of wrapper components, no knowledge of which package an unimported tag comes from. React unknown-component detection depends on imports; Vue and Angular detect by name or selector only.
- Rules that need data no compiler produces yet (`requires-parent`, accessibility requirements, layout patterns) work only through approved policies.
- Policies cannot express arbitrary logic: seven rule kinds. Policy authoring is by hand; there is no `policy add`.
- Rejection cannot split an inferred identity between implementations.
- A conflict decision does not change the contract's kept value.
- Colors are not compared across formats by perception: `hsl()` is converted with rounding, so a token written in hex and a literal in hsl can differ by one step. Named colors match only a token with the same name. Other color functions (`oklch()`, `color()`, `lab()`) and Tailwind class names are not read. `rem` and `em` assume a 16px root, so a design system with a different root font size can see false matches or misses.
- `native-element-has-equivalent` and ambiguity findings are name heuristics.
