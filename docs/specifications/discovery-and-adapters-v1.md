# Source discovery, adapter interface, and compiler orchestration (v1)

Status: implemented in `packages/compiler-core` and `packages/artifact-generator` (plan Phase 2). The Zod schema in `packages/compiler-core/src/discovery/schema.ts` is the source of truth; its JSON Schema is committed at `packages/compiler-core/schema/project-discovery-v1.schema.json`.

## Scope and what Phase 2 does not do

Phase 2 takes a project directory to IR without any framework adapter: discovery, adapter lifecycle, orchestration, diagnostics, and artifact generation. It stops at IR. Reconciliation, contract generation, framework extraction (React, Angular, Vue), Storybook story analysis, zeroheight, and the CLI belong to later phases. No build or rendering step exists yet, so "isolate build and rendering operations" has nothing to isolate; the invariant that matters now is that analysis only reads.

## Safety properties

- Analysis uses `ReadonlyFs`: `readFile`, `readDir`, `exists`. There is no write, exec, or network method in the interface adapters receive.
- `nodeFs` never follows symlinks while listing, rejects paths that escape the root, and refuses to read through a symlink whose target is outside the root.
- Customer code is never executed or imported. TypeScript is used only to parse (`ts.createSourceFile`), never to type-check or run. Storybook `main.*` is evaluated by a tiny static evaluator over the syntax tree (string, number, boolean, array, object, and the `getAbsolutePath("pkg")` idiom); anything else marks the property dynamic. A test confirms a config containing `throw` and `process.exit` is read without effect.
- Directories such as `node_modules`, `dist`, `.git`, and `storybook-static` are not walked. Existence checks use the walked file list because a case-insensitive filesystem would otherwise answer `exists("Button.ts")` for `button.ts`; only paths inside ignored directories fall back to the filesystem.

## Project discovery (`discoverProject`)

Deterministic, read-only, framework-neutral. Result (`ProjectDiscovery`, `discoveryVersion` 1.0.0):

| Field | Content |
|---|---|
| `packageManager` | npm, pnpm, yarn, bun, or `unknown`, with evidence (`packageManager` field and lockfiles). Several lockfiles without a field yields `unknown` and a diagnostic; a field that contradicts lockfiles yields a warning. |
| `workspaces` | `pnpm-workspace.yaml` (block-list `packages:`), `package.json` `workspaces` (array or object), or none. Negated patterns are honored. |
| `packages` | Per workspace package: name, version, directory, manifest hash, dependencies, script names, frameworks, build tools, entry points. |
| `packages[].frameworks` | React, Angular, or Vue from `react`, `@angular/core`, `vue`: declared range, dependency kind, manifest line, and installed version when `node_modules` exists (searched upward like Node). Never guessed. |
| `packages[].buildTools` | From dependencies and config files (vite, webpack, rollup, esbuild, tsup, parcel, rspack, angular-cli, ng-packagr, vue-cli, nx, turbo, typescript), each with its evidence. |
| `packages[].entryPoints` | From `exports` (condition-ranked: types, import, module, default, require, node, browser), else `types`/`typings`/`module`/`main`. Resolved in order: declared source file; built path mapped back through the package's `tsconfig.json` `outDir`/`rootDir`; declared built file; conventional roots (`src/index.ts`, `src/public-api.ts`, and similar). The resolution kind is recorded. A subpath with one `*` and a target with one `*` (`./*`, `./icons/*`) becomes one entry per file the target matches (a build-output target also matches the sources it maps back to); a pattern that matches nothing is reported as `discovery.entry-pattern-unmatched`, and any other pattern as `discovery.entry-pattern-unsupported`. |
| `entryPoints[].exports` | Names exported by the entry module, with kind (`value`, `type`, `namespace`, `default`, `unknown`), `typeOnly` (no runtime value), file, line, and re-export origin. Relative `export *` and `export { } from` chains, and ones through the package's own name (`primevue/accordion` inside `primevue`), are followed with cycle protection and a file limit. |
| `entryPoints[].exportsComplete` | False when enumeration is partial: external `export *`, unresolved module, `export =`, syntax error, limit reached, or a non-code entry such as CSS. A consumer must never read an empty export list as "no exports" unless this is true. |
| `storybooks` | Each `.storybook/main.{js,ts,mjs,cjs}`: framework, addons, story patterns, static dirs, dynamic properties, Storybook package range and installed version, built output (`storybook-static`, with whether `index.json` exists), and the story files the patterns match (bounded). Supports `@(a\|b)` extglob. |
| `tokenFiles` | CSS files with custom properties (name, enclosing selector or at-rule chain, line, raw value, alias target), JSON token files (shape heuristic: `dtcg-like`, `style-dictionary-like`, `unknown`), Style Dictionary and Tailwind config files. `package.json`, `tsconfig*.json`, and similar are never token files. Values are recorded raw, never evaluated. |
| `docFiles` | Markdown and MDX: kind (readme, changelog, mdx, markdown), title (frontmatter, else first H1), heading outline ignoring code fences, line count. |
| `graph` | Nodes (package, framework, build-tool, storybook-config, token-file, doc-file) and edges (depends-on for workspace-internal dependencies only, uses-framework, built-with, contains, configured-by, documents with story counts). Sorted. |
| `diagnostics` | Structured findings with locations. |

Every file the result depends on carries a content hash, so a source's `inputHash` changes exactly when its inputs change.

Limits (all configurable, all reported when hit): 50,000 files walked, 1 MB per file, 5,000 files followed per entry point, 5,000 CSS variables per file, 1,000 story files listed, 100 headings per document.

Known limits of discovery: only React, Angular, and Vue are detected as frameworks (no Preact, Svelte, or meta-frameworks); `tsconfig.json` `extends` is not followed; entry-point patterns with more than one `*` are not expanded; Storybook extglobs other than `@(…)` are unsupported; Nx, Lerna, and Yarn Berry workspace files other than the two supported forms are not read.

## Adapter interface

```ts
interface SourceAdapter<TConfig = unknown> {
  id: string; version: string; type: SourceType
  discover(ctx: DiscoveryContext): Promise<DiscoveryResult<TConfig>>
  extract(ctx: ExtractionContext, config: TConfig): Promise<ExtractionResult>
  validate(ctx: ValidationContext): Promise<Diagnostic[]>
}
```

- `discover` finds the sources this adapter can handle, using the shared `ProjectDiscovery` and `ReadonlyFs`. Each `DiscoveredSource` has a unique slug id, a type, a location, adapter-private JSON `config`, an optional version (never invented), and an `inputHash`.
- `extract` produces one `IrDocument` per source. The context supplies an injectable `clock` so output can be reproducible.
- `validate` returns diagnostics about a produced document.
- Adapters never build the contract and cannot see each other's output.

`IrBuilder` is the shared utility for writing IR: content-addressed, deduplicated evidence; mandatory evidence on every fact; canonical output. `checkAdapterConformance` (from `@invariant/compiler-core/testing`) is the shared conformance suite: deterministic `discover` and `extract`, valid slug ids and hashes, schema-valid IR with no verification errors, correct type and adapter name, and no mutation of the shared project discovery.

## Built-in inventory adapters

Four framework-neutral adapters project discovery into IR so a repository is representable before any framework adapter exists. They decide nothing about what is a component: exports are entities of kind `export`, never `component`.

| Adapter | Source type | One source per | Entities | Fact paths |
|---|---|---|---|---|
| `inventory-npm` | `npm` | workspace package | `package`, `export` | `package.name/version/private/directory/manager`, `frameworks`, `buildTools`, `entryPoints`; per export `export.name/kind/typeOnly/entry/reexportOf` |
| `inventory-storybook` | `storybook` | Storybook config | `config` | `config.path/framework/addons/stories/staticDirs/dynamicProperties/version/builtOutput/storyFileCount/storyFiles` |
| `inventory-tokens` | `tokens` | package with token files | `token-file`, `token` | `file.kind/format/tokenCount`; per CSS variable `name`, `extensions.css.scope/rawValue/aliasOf` |
| `inventory-markdown` | `markdown` | package with docs | `doc-page` | `doc.kind/title/headings/lineCount` (origin `authored`) |

Source ids are `<prefix>-<slug>`, unique within an adapter run (numeric suffix on collision). Facts about incompletely enumerated data carry `completeness: partial`, and a document is `partial` when any of its data is.

## Orchestration (`compile`)

1. Discover the project once.
2. Run each adapter's `discover` in adapter-id order; sort sources by id; reject duplicate source ids with `compile.duplicate-source-id`.
3. For each source, `extract`; validate the result against the IR schema (`compile.invalid-ir`), canonicalize, run `verifyIrDocument`, then the adapter's `validate`.
4. A throwing adapter never aborts the run: it produces a `failed` IR document and a `compile.adapter-failed` error, because a missing source is not evidence that its facts do not exist. Cancellation through `AbortSignal` does abort.
5. Merge diagnostics, dropping duplicates (a finding reported by discovery and forwarded by an adapter appears once, attributed to the source).

`CompileResult` carries `project`, per-source summaries (`inputHash`, `irContentHash`, completeness), IR documents, diagnostics, and `ok` (no error-severity diagnostics).

## Artifacts (`@invariant/artifact-generator`)

`toArtifactEntries` yields `invariant.project.json`, `ir/<sourceId>.ir.json`, and `invariant.diagnostics.json`; `renderArtifacts` renders canonical pretty JSON (sorted keys, trailing newline, sorted paths) and appends `invariant.manifest.json` (tool, `generatedAt`, per-source hashes and completeness, and each artifact's SHA-256 and size). Paths must be relative and free of `..`; `writeArtifacts` refuses anything that would leave the output directory. The contract file arrives with reconciliation and contract generation.

Determinism: with a fixed clock, all artifacts are byte-identical. With different clocks only evidence `capturedAt` values and the manifest differ; `irContentHash` (which excludes capture times) is equal. Both properties are tested.

Incremental compilation is not implemented. `inputHash` and `irContentHash` are recorded so a later change can skip unchanged sources.

## Developer entry point

`pnpm dev:compile <projectDir> [outDir]` (`scripts/compile-dev.ts`) runs the pipeline on any directory until the CLI exists (plan Phase 8).
