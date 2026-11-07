# Storybook compiler and Storybook/code reconciliation (v1)

Status: implemented in `packages/compiler-storybook` and `packages/reconciliation` (plan Phase 4). Output is IR 1.2.0; no contract is generated yet.

## What was verified against Storybook's documentation

Checked on 2026-10-31 against storybook.js.org, and the design follows from it:

- A story is identified by its **named export**. Its display name is the `name` option, otherwise a label derived from the export. The documentation does not specify `toId`/sanitize, and its own examples disagree on how digits are split in the derived label. This adapter therefore never synthesizes a story id or a derived display name: identity is `exportName`, and `story.name` is present only when it is explicit (`name`, or `storyName` in CSF 2).
- `component` is documented as required in meta (it feeds addons' prop tables). `title` is optional and, when omitted, is inferred from the story's path on disk; that inference is reported (`storybook.title-auto`), not reproduced.
- Args can be set at global, component (meta) and story level; story args override component args. Merge depth is not specified (only object spread is shown), and global (preview) and URL args are outside static analysis. No "effective args" are computed.
- With `argTypes.mapping`, an arg value is a **key** into the mapping, not the real prop value. A story with a mapped arg is never checked against the prop's declared values.
- `includeStories`/`excludeStories` are arrays or regular expressions; precedence when both match is not documented.
- `index.json` is not documented as public API (the page describing indexers does not describe the file's format). It is read tolerantly (`entries` or the older `stories`) as optional evidence about which story files a build contained, never as a source of story identity.

## Safety

Story files and MDX are parsed, never executed or imported. A test confirms a story file containing top-level `throw` and `process.exit` is read without effect. The type checker covers only project files (and the workspace packages they import by name, mapped to their entry files), not `node_modules`.

## Source and identity

One source of type `storybook` per Storybook config that matches story files (id `stories-<dir>`; the inventory adapter's `storybook-<dir>` source describes the config itself). Entities:

| Kind | Ref | Meaning |
|---|---|---|
| `story-group` (new in IR 1.2.0) | `storybook:<file>` | A CSF `meta` (default export) |
| `story` | `storybook:<file>#<exportName>` | One story |
| `doc-page` | `storybook:<file>` | An MDX page |

## Facts

Prose written by a person (JSDoc on a story, `parameters.docs.description`, `argTypes.*.description`, MDX text) is `authored`; everything else is `extracted`.

**Group** (`group.*`): `file`, `title` (or `titleAuto: true`), `component` (`{ text, via: component | type-argument, file, name }` when it resolves to a project declaration, else `external` for a package outside the analysis or `unresolvedModule` for a relative import that does not resolve), `args.<name>`, `argsUnresolved`, `argsSpies`, `argTypes.<prop>.{declared, control, options, optionsUnresolved, description, defaultSummary, mappingKeys, action, hidden, category}`, `argTypesUnresolved`, `parameters.{keys, a11y, layout, controls}`, `docs.description`, `tags`, `hasDecorators`, `hasLoaders`, `excludedExports`, `selectionUncertain`, and `index.entries` when a built index exists.

**Story** (`story.*`): `exportName`, `file`, `shape` (`object`, `function`, `template`), `group`, `name` (explicit only), `description`, `hasRender`, `args.<name>`, `argsUnresolved`, `argsSpies`, the same argTypes/parameters/tags facts as a group, `play.{present, calls, steps}` (statically visible call names such as `userEvent.click` and `expect().toBeEnabled`, and `step("…")` titles), and `composes` (components rendered by the story, as `{ file, name, count }`).

**MDX** (`doc.*`): `kind: storybook-mdx`, `title`, `meta.title`, `meta.of` (the imported stories file), `blocks` (`Canvas`, `Controls`, …), `stories` (stories referenced by blocks), and `sections.sN` (`{ heading, level, text }`, bounded). MDX is scanned line by line, not compiled; fenced code is ignored.

### Static evaluation

`args`, `argTypes` and `parameters` are evaluated by a small static evaluator. It resolves string, number, boolean and null literals, objects and arrays, `const` identifiers (including across files), property access into resolvable objects, and object spread (a later spread overrides an earlier key, and a later key overrides a spread). It never guesses: functions, JSX, calls, template literals with substitutions and unresolvable identifiers are listed in `argsUnresolved` (or the matching `…Unresolved`) by key path. An array with any unresolvable element is wholly unresolved. `fn()` and `action()` calls are recorded in `argsSpies` and are also unresolved. Documents with unresolved members are `partial`.

### Supported forms

CSF 3 object stories, CSF 2 function stories, `Template.bind({})` stories, function declarations, and CSF 2 assignment annotations (`Story.args = …`, `.storyName`, `.parameters`, `.play`, and so on). Meta may be a default-exported object literal, an identifier, or wrapped in `satisfies`/`as`/parentheses/type annotation. When `component` is absent, `Meta<typeof X>` is used as a fallback (`via: type-argument`).

## Reconciliation (`@invariant/reconciliation`)

A first, deliberately narrow slice of plan Phase 7: cross-source comparison of story IR with component IR. It consumes IR documents only and depends on no adapter.

**Linking.** A story group links to a code component when `group.component.{file,name}` equals the component's `implementations.<fw>.extensions.<fw>.{file,localName}`. That neutral key is published by the React adapter now and is the contract for Vue and Angular later. Display names are never used. A group whose component resolves to a file but matches no compiled component is reported (`component-unlinked`, info); groups with no resolved component were already reported by the adapter.

**Checks.** Each finding carries evidence ids from both sides and the Storybook-side source location. Warnings are claims about disagreement; infos are coverage or uncertainty.

| Code (`reconcile.storybook.…`) | Severity | Meaning |
|---|---|---|
| `arg-undeclared` | warning | A story or meta arg is not a prop, variant or `children` of a component whose props are fully known |
| `arg-value-not-allowed` | warning | A literal arg is outside the prop's declared literal values (skipped for mapped args and non-literals) |
| `control-undeclared` | warning | A visible control is documented for a prop the component does not declare (props fully known) |
| `control-option-not-allowed` | warning | A control offers values the component does not declare (skipped when options are mapped or unresolved) |
| `default-mismatch` | warning | `table.defaultValue.summary` differs from the code default (quotes and type spelling ignored) |
| `deprecated-demonstrated` | warning | An arg or control uses a deprecated prop, or a story group demonstrates a deprecated component |
| `prop-not-demonstrated` | info | Declared props (excluding `children`, refs and event handlers) that no linked story passes or documents |
| `value-not-demonstrated` | info | Declared values no linked story or control shows (not claimed when the story side is uncertain) |
| `unverifiable-names` | info | Names that could not be checked, with the reason |
| `component-unlinked` | info | See linking |

**What is never claimed, and why.**

- A Storybook control or arg is never taken as proof that an API exists, and an absent prop is never concluded from an incomplete props set: undeclared-name claims require `propsComplete: true` on the code side.
- Arg-level claims (`arg-undeclared`, `arg-value-not-allowed`, deprecated args) apply only to stories that use the **default render**. With a custom render (a function or template story, or `render:`), args go to that function and may belong to a different component entirely, so they are reported as unverifiable instead. Meta-level args are claimed only when at least one story uses the default render. This was found on a real design system, where a story rendered `PureFormErrorState` while its meta named `FormErrorState`. Controls describe the meta component's own props table, so control checks do not depend on the render.
- A `mapping` declared at meta level also suppresses value checks on story args.

## Real-library validation

Run on Storybook's own public design system (`storybookjs/design-system`, 49 story/MDX files): 46 story groups and 209 stories extracted, 29 groups linked to components, 7 informational "unlinked" (components with stories that are not exported from the package entry), no Storybook-vs-code warnings, and 12 "unverifiable" notes. This run is not part of the test suite (it needs a network clone). It found and fixed two defects the fixtures did not: a crash when annotations came from CSF 2 assignments (a synthetic syntax node reached evidence creation), and the false positive described above.

## Known limitations

- Story identity is the export only; ids and derived display names from Storybook are not reproduced, so a static story cannot be matched to an individual built-index entry (only to its file).
- Global (`preview`) args, parameters and decorators, URL args, and dynamically generated stories are outside static analysis.
- Interaction (`play`) analysis lists visible calls and steps; it does not model behavior.
- MDX is scanned, not compiled; JSX components in MDX other than the listed doc blocks are ignored.
- Component linking needs the component to be public in a compiled React source. Stories for internal components are reported as unlinked.
- Without third-party types, most real components inherit props the compiler cannot enumerate (see the React spec), so many arg and control checks degrade to `unverifiable-names`. The checks are precise where they speak and silent where they cannot.
- The reconciliation is a first slice: it reports discrepancies and links but does not yet produce contract conflict records, resolve identities across all sources, or apply governance.
