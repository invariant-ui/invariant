# Invariant system architecture (proposal)

Status: proposal, awaiting approval. Nothing here is implemented. See `docs/decisions/0001-architecture.md` for the decisions this depends on and `primitiv-analysis.md` for the prior art.

## Goals and constraints

Compile React, Angular, and Vue component libraries, Storybook, Figma, and zeroheight into a normalized, machine-readable, framework-independent design-system contract.

- Local-first CLI. No cloud infrastructure is required to compile.
- Deterministic extraction wherever possible: same inputs produce a byte-identical contract.
- Every meaningful fact has evidence and provenance.
- Every fact is exactly one of `discovered`, `documented`, `inferred`, `approved`.
- Source disagreements are detected and recorded explicitly.
- Each source is an independent adapter. MCP consumes the contract and is not part of the compiler.

## Alignment with the implementation plan

The implementation plan arrived after the first draft of this document. Where it differs from the draft, the plan wins unless noted below. Changes made:

| Plan requirement                                                                                                                                                                                                 | Draft said                                                | Resolution                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package layout: `apps/{cli,mcp-server,api}`, `packages/{contract,compiler-core,compiler-ir,compiler-<source>,source-connectors,semantic-engine,reconciliation,validation,diagnostics,artifact-generator,shared}` | `packages/*` with `core`, `ir`, `adapter-*`, `cli`, `mcp` | Plan names adopted (see "Proposed package structure"). Packages are created when first needed, not up front. `apps/api` is deferred (plan section 15).                                   |
| Contract metadata includes compilation timestamp; sources include last-synchronized timestamp; evidence includes timestamp                                                                                       | No timestamps in the contract                             | Timestamps stay, but are excluded from the contract's `contentHash` (ADR D3 revised). Determinism is defined over the hash, not over every byte.                                         |
| Artifacts: `contract.json`, `manifest.json`, `evidence.json`, `diagnostics.json`, `report.html`                                                                                                                  | Evidence inline on each fact                              | Evidence moves to `invariant.evidence.json`. Contract facts reference evidence by id (ADR D3 revised).                                                                                   |
| Evidence has confidence and verification status; "do not collapse statuses into a single confidence field"                                                                                                       | Status only                                               | Both. `status` (discovered, documented, inferred, approved) and `confidence` are separate fields. `confidence` is optional and only meaningful where a method is probabilistic.          |
| Adapter lifecycle `discover` / `extract` / `validate`                                                                                                                                                            | single `extract`                                          | Three-method lifecycle adopted.                                                                                                                                                          |
| Pipeline includes semantic analysis where LLMs may classify and connect evidence                                                                                                                                 | Fully deterministic compiler, no LLM stage                | Semantic analysis is a separate stage whose output is recorded, content-addressed, and replayed (ADR D11). The deterministic core never calls a model.                                   |
| Contract domains: Patterns, Guidelines, Constraints, Policies in addition to Components, Tokens                                                                                                                  | Components and tokens only at v1                          | All domains are specified in Phase 1. Only components, tokens, and conflicts are populated by early adapters; the rest are populated by zeroheight and the semantic engine.              |
| Config as `invariant.config.ts` or JSON                                                                                                                                                                          | JSON only                                                 | Both (ADR D7 revised).                                                                                                                                                                   |
| Incremental compilation (principle 9)                                                                                                                                                                            | not addressed                                             | Per-source IR documents carry input hashes, so unchanged sources can be skipped. Cross-source stages re-run on the changed IR set only.                                                  |
| Immutable, versioned published contracts traceable to source versions                                                                                                                                            | not addressed                                             | Contract metadata records source versions (git commit, package version, Storybook version, Figma file version, zeroheight page versions where exposed) and a `contentHash`. See ADR D12. |

## Pipeline

```
 sources                adapters (one per source)         IR                 compiler                 contract           consumers
 ---------------        ----------------------------      ----------------   --------------------    --------------     -----------
 React code      --->   adapter-react       --+
 Angular code    --->   adapter-angular     --+
 Vue code        --->   adapter-vue         --+--->  IR fact stream  --->   normalize -> merge  --->  invariant        CLI verify/diff
 Storybook       --->   adapter-storybook   --+       (per adapter,         -> identity link          contract.json    MCP server
 Figma           --->   adapter-figma       --+        validated)           -> conflict detect        (+ build         docs, lint, codegen
 zeroheight      --->   adapter-zeroheight  --+                             -> apply approvals        manifest)
                                                                            -> infer rules
```

Each arrow is a serializable boundary. Adapter output (the IR) can be written to disk, diffed, and replayed through the compiler without re-reading the source. That gives three properties: adapters are testable in isolation with golden IR files, the compiler is testable with hand-written IR, and network sources can be snapshotted (see "Offline and snapshots").

## Layer 1: Intermediate representation (IR)

The IR is the only interface between adapters and the compiler. It is flat and source-faithful: it says what a source claimed, not what the design system is.

```ts
interface IrDocument {
  irVersion: string
  source: { id: string; adapter: string; adapterVersion: string; inputHash: string }
  status: "ok" | "partial" | "failed" // partial/failed carry diagnostics; absence is not evidence of removal
  entities: IrEntity[]
  facts: IrFact[]
  diagnostics: IrDiagnostic[]
}

interface IrEntity {
  // something that can be referred to
  ref: string // adapter-local stable id, e.g. "react:src/Button.tsx#Button"
  kind: "component" | "token" | "token-set" | "theme" | "story" | "doc-page" | "figma-node"
  name: string
  evidence: Evidence[]
}

interface IrFact {
  subject: string // an IrEntity ref
  path: string[] // framework-neutral field path, e.g. ["props","size","values"]
  value: JsonValue // canonical JSON, ordering rules in the IR spec
  origin: "extracted" | "authored" // extracted = parsed from an artifact; authored = human prose/guidance
  evidence: Evidence[] // at least one
  completeness?: "complete" | "partial" | "unknown"
}

interface Evidence {
  source: string // IrDocument.source.id
  locator:
    | { type: "file"; path: string; line?: number; column?: number; endLine?: number }
    | { type: "url"; url: string; pointer?: string } // JSON pointer or node id
    | { type: "figma"; fileKey: string; nodeId?: string; variableKey?: string }
  extractor: { name: string; version: string } // rule or tool that produced it
  contentHash: string // hash of the evidence region, for staleness checks
}
```

Rules:

- No timestamps in IR facts or evidence. Capture time lives in the build manifest.
- `origin` is what the adapter can honestly say (`extracted` vs `authored`). It does not decide the final status.
- Adapters never merge, rank, or resolve. They do not know other adapters exist.
- A framework-specific concept (Angular `input.required()`, Vue `defineProps`, React `forwardRef`) is mapped to neutral paths by the adapter. The original construct is kept in evidence metadata, not in the fact path.

## Layer 2: Canonical contract

Framework-independent. A single JSON document, schema-validated, versioned, published as JSON Schema.

Top-level: `contractVersion`, `tokens`, `themes`, `components`, `documents` (guidance pages), `conflicts`, `diagnostics`, `sources` (identity and input hashes of each source, not timestamps).

The unit is the **fact**:

```ts
interface Fact {
  id: string // content-addressed over (subject, path, value)
  path: string[]
  value: JsonValue
  status: "discovered" | "documented" | "inferred" | "approved"
  evidence: Evidence[] // all sources that assert this exact value
  derivation?: { rule: string; inputs: string[] } // required when status = inferred
  approval?: { by: string; at: string; fingerprint: string } // required when status = approved
}
```

Status semantics (ADR-0001, decision D2):

| Status       | Meaning                                                                                                                | Produced by                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `discovered` | A machine parsed it from an artifact whose structure is the claim (source code, Storybook index, Figma variables API). | Adapters, `origin: extracted`                        |
| `documented` | A person wrote it as prose or guidance in a doc surface (zeroheight page text, Figma descriptions, MDX docs).          | Adapters, `origin: authored`                         |
| `inferred`   | Invariant derived it by a named deterministic rule from other facts. Never produced by an adapter.                     | Compiler inference stage                             |
| `approved`   | A human explicitly accepted a specific fact or a specific conflict resolution. Recorded in a committed approvals file. | `invariant approve`, bound to the fact's fingerprint |

An approval is bound to `(subject, path, value fingerprint)`. If the underlying evidence changes the fingerprint, the approval no longer matches and the fact reverts to its underlying status, with a diagnostic. Approvals are never silently carried over.

Components in the contract use neutral vocabulary: `props` (name, type, required, default, allowed values, kind), `events`, `slots`, `variants`, `states`, `relations` (uses, composes), `a11y`, `docs`. Angular `@Input`/`input()`, Vue props, and React props all become `props`; Vue `emits`, Angular `@Output`/`output()` become `events`; Vue slots, Angular `ng-content` select, and React `children`/named slot props become `slots`. What each framework can supply is declared per adapter (see capabilities).

## Layer 3: Compiler (`core`)

A pure function from `(IrDocument[], config, approvals) -> contract + build manifest`. No network, no source reads, no clock.

Stages, each independently testable:

1. **Validate** each IR document against the IR schema.
2. **Normalize** values (units, colors, casing, enum ordering) with a documented, versioned normalizer.
3. **Identity linking**: decide which entities across sources are the same component or token. Order of authority: explicit mapping file, then adapter-supplied stable cross-reference (for example a Storybook story's `importPath` resolving to a code file; any Figma-to-code link is unverified and not assumed), then exact normalized-name match when unambiguous. Ambiguity produces a `could-not-link` diagnostic and no merge.
4. **Merge** facts for each linked entity. Equal normalized values merge into one fact holding all evidence.
5. **Conflict detection**: unequal values at the same `(subject, path)` produce a `Conflict` record containing every asserted value with its evidence and status. Conflicts are never dropped. Presence-only differences (one source lacks the field) are reported separately from value conflicts, and only when the missing side's source status is `ok` and its completeness is `complete`.
6. **Policy and approvals**: the config's precedence and the approvals file select a `resolution` for each conflict. Resolution is stored as an overlay on the conflict (`pending | by-precedence | approved`), never by deleting the losing value.
7. **Inference**: named deterministic rules (for example scale detection in spacing tokens, naming conventions) emit `inferred` facts with `derivation`.
8. **Emit** canonical JSON: stable key order, stable array order, no timestamps. Hash the result.

The build manifest (separate file, not part of the contract hash) records: tool versions, per-source input hashes, snapshot identities, capture times, and timings.

## Layer 4: Adapters

Each adapter is its own package implementing one interface and declaring capabilities:

```ts
interface Adapter<Config> {
  id: string
  version: string
  capabilities: AdapterCapabilities // which entity kinds and fact paths it can produce
  extract(config: Config, ctx: AdapterContext): Promise<IrDocument>
}
```

`AdapterContext` supplies a read-only filesystem handle, a logger, an optional snapshot store, and an abort signal. Adapters get no access to other adapters' output.

Capabilities matter for conflict detection: if an adapter never produces `props.*.default`, a missing default is not evidence against other sources.

### Source capabilities, verified

Checked against official documentation on 2026-10-30. Anything not listed as verified is unverified and must not be assumed.

| Source     | Verified capability                                                                                                                                                                                                                                                                                                                                                                                                                   | Verified constraint                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Planned extraction                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vue        | `vue-component-meta` statically extracts props (name, description, type, default, required, JSDoc tags, schema), events, slots, and exposed members, via a `tsconfig.json` or inline JSON config, with TypeScript as a peer package (MIT).                                                                                                                                                                                            | Needs a TypeScript project.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Wrap `vue-component-meta` inside `adapter-vue`.                                                                                                                                                                                                                                                                                                                                                         |
| Angular    | Signal inputs are declared as class members via `input()` and `input.required()` (optional vs required, optional initial value, optional transform) per angular.dev.                                                                                                                                                                                                                                                                  | The `input()` page does not specify `model()`, `output()`, or the `@Input` decorator, so those need confirmation against angular.dev before implementation. Compodoc supports `-e json` export, but its output schema and filename were not confirmed.                                                                                                                                                                                                                                                                                                                                 | TypeScript compiler API walking decorators and `input`/`output`/`model` initializers; Compodoc evaluated later as a cross-check, not a dependency.                                                                                                                                                                                                                                                      |
| React      | No official extractor evaluated yet. Primitiv's evidence shows a Babel-only subset is limited in type resolution.                                                                                                                                                                                                                                                                                                                     | Needs TypeScript checker for real type resolution.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | TypeScript compiler API. `react-docgen-typescript` to be evaluated.                                                                                                                                                                                                                                                                                                                                     |
| Storybook  | Per Primitiv code, `index.json` (falling back to `stories.json`) is served by a running or built Storybook. A `components.json` manifest exists at `/manifests/components.json` with per-component `id`, `name`, `path`, `stories`, `import`, `jsDocTags`, `description`, and for React `reactDocgen` props. Per Storybook docs the manifest is generated by React frameworks, `@storybook/angular-vite`, and `@storybook/vue3-vite`. | The manifest schema is documented as "not yet stable and should not be considered a public API", is enabled by `features.componentsManifest`, and is served as 404 in dev when `experimentalDocgenServer` is on.                                                                                                                                                                                                                                                                                                                                                                       | Primary: read `index.json` from a built `storybook-static` directory (no server). Secondary: `components.json` when present, behind a version guard. Static CSF parsing for args/controls.                                                                                                                                                                                                              |
| Figma      | REST: `GET /v1/files/:key/variables/local` and `/variables/published`, scope `file_variables:read`.                                                                                                                                                                                                                                                                                                                                   | Variables endpoints are limited to full members of Enterprise orgs per Figma docs. Components endpoints (`/components`, `/component_sets`) are used by Primitiv; their plan requirements were not checked.                                                                                                                                                                                                                                                                                                                                                                             | REST adapter plus snapshot import (a saved JSON response) for users without Variables API access. A tokens-export file as an alternative input is an open question (decision D5).                                                                                                                                                                                                                       |
| zeroheight | REST API with Client ID and Access Token as headers; per the help center it provides read access for auth tokens, pages, page statuses, and styleguide categories.                                                                                                                                                                                                                                                                    | Plan requirement is contradictory across zeroheight's own pages: the help center says not available on Free or Starter plans (granular scopes Enterprise-only); the API Getting Started page, as quoted by search results, says an Enterprise plan is needed. Base URL and headers per Getting Started: `https://zeroheight.com/open_api/v3/` with `X-API-CLIENT` and `X-API-KEY`. Developers site lists Pages (List, Get, Search); Pages Get lists "Supported content", "HTML", "Markdown", and "Custom tags" sections, so content is likely HTML or Markdown, not structured blocks. | The developers site is a JavaScript app that could not be scraped, so endpoint paths, response shapes, pagination, and versions were NOT verified. The plan's expected extraction of design tokens, assets, and release/version information has NO verified API support. The help center describes token export as a separate feature (downloadable or automatable JSON), not as part of the pages API. | Pages as `doc-page` entities; component-to-page links only from explicit page metadata or configured mappings. Everything extracted from page prose is `documented`. Token and asset extraction is blocked on verification (ADR U9). Recorded fixtures are required before any parser is written. |

## Layer 5: Consumers

- **CLI** (`invariant`): `init`, `compile`, `verify`, `diff`, `conflicts`, `approve`, `explain <fact-or-id>`, `schema`. Local-only, data-only JSON config (no executed config files).
- **MCP server** (`@invariant/mcp`): read-only tools over a saved contract file. Imports only `@invariant/contract`. It does not import the compiler or any adapter. Each response states contract hash and each fact's status, so agents can weight `approved` over `inferred`.
- Later: lint, codegen, docs export. All consume the contract only.

## Offline and snapshots

Compilation never requires cloud infrastructure. Network adapters (Figma, zeroheight, a served Storybook) write a **snapshot** of the raw response to `.invariant/snapshots/<source>/<hash>.json`, and the adapter's `extract` can run from a snapshot (`--from-snapshot`). Committed snapshots make CI deterministic and keep tokens out of CI where policy requires. The IR records which snapshot it came from, never the credential.

## Determinism

- Contract content depends only on IR documents, config, and approvals.
- Sort everything (files, keys, arrays by documented key). Normalize paths to POSIX relative.
- No timestamps, absolute paths, or hostnames inside the contract. They belong in the build manifest.
- Content-addressed fact ids make diffs meaningful and approvals stable.
- `invariant verify` recompiles from IR (or sources) and compares contract hashes.

## Proposed package structure

pnpm workspace, ESM, Node per `.nvmrc`, strict TypeScript with project references.

```
invariant/
  apps/
    cli/                 Depends on: compiler-core, compiler-*, artifact-generator, validation, contract
    mcp-server/          Depends on: contract only (and the MCP SDK)
    api/                 DEFERRED (plan section 15). Not created.
  packages/
    contract/            zod schemas -> TS types + JSON Schema: contract, Fact, Evidence, Conflict, Policy. No logic.
    diagnostics/         Diagnostic type, code registry, severity. Depends on: nothing
    compiler-ir/         IR schemas, validators, canonical JSON, hashing. Depends on: contract, diagnostics
    compiler-core/       Orchestration, SourceAdapter interface, discovery, test harness. Depends on: compiler-ir, contract, diagnostics
    reconciliation/      Deterministic identity linking, merge, conflict detection. Depends on: compiler-ir, contract
    compiler-react/      Depends on: compiler-core, typescript (ts-morph only if it earns its place)
    compiler-storybook/  Depends on: compiler-core
    compiler-zeroheight/ Depends on: compiler-core
    compiler-figma/      Depends on: compiler-core
    compiler-vue/        Depends on: compiler-core, vue-component-meta
    compiler-angular/    Depends on: compiler-core, typescript
    semantic-engine/     Inferred semantics (deterministic rules today; model-assisted proposals later, through the same evidence, confidence and additive checks). Depends on: compiler-ir, contract
    validation/          Rules over application code vs contract. Depends on: contract, diagnostics
    artifact-generator/  Writes contract/manifest/evidence/diagnostics/report. Depends on: contract
    source-connectors/   Fetch and snapshot network or VCS sources (Figma, zeroheight, git, npm). Depends on: diagnostics
    shared/              ONLY small pure utilities (hashing, path normalization). Must not become a dumping ground.
  fixtures/              react, angular, vue, storybook, zeroheight (plan) plus recorded Figma responses
  docs/                  architecture, specifications, decisions, implementation
  CLAUDE.md
```

Dependency rules, enforced in CI (for example with `dependency-cruiser` or a package-boundary lint):

- `shared` and `diagnostics` depend on no workspace package. `contract` depends only on `shared` and `diagnostics`. `compiler-ir` depends only on those three. (Enforced today by `scripts/check-boundaries.ts`; a package must be registered there to pass CI.) `compiler-core` depends on `shared`, `diagnostics`, `contract`, and `compiler-ir`; `artifact-generator` depends only on `shared`.
- `compiler-<source>` packages depend on `compiler-core` and never on `reconciliation`, the CLI, or each other.
- `reconciliation` depends on no compiler-<source> package.
- `mcp-server` depends on `contract` only.
- Only `semantic-engine` may call a model, and only `apps/cli` wires it in.

Creation order, to honor "do not create abstractions solely for hypothetical future use": M0 and M1 created `shared`, `diagnostics`, `contract`, and `compiler-ir`; plan Phase 2 added `compiler-core` and `artifact-generator`; plan Phase 3 added `compiler-react` and `compiler-tokens`; plan Phase 4 added `compiler-storybook` and a first, narrow `reconciliation` (the rest of the reconciliation work is plan Phase 7) (tokens are not React-specific, so they are not folded into the React package). `apps/cli` begins at plan Phase 8. Then `reconciliation`, `compiler-react` at plan Phase 3, `compiler-storybook` at Phase 4, `semantic-engine` and `validation` when their milestones start. Packages with no code yet are not scaffolded. `source-connectors` begins when the first network source lands; until then connectors live inside their `compiler-<source>` package.

## Technology stack (proposed)

| Concern         | Choice                                                               | Why                                                                                               |
| --------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Language        | TypeScript strict, ESM only                                          | One language for all adapters; Primitiv's CommonJS output is a legacy constraint we do not share. |
| Runtime         | Node, version pinned by `.nvmrc`                                     | `.nvmrc` already exists in the repo.                                                              |
| Workspace       | pnpm workspaces                                                      | Strict dependency isolation suits the boundary rules above.                                       |
| Schemas         | zod, emitting JSON Schema                                            | Single definition for types, validation, and published schema.                                    |
| Static analysis | TypeScript compiler API (React, Angular); `vue-component-meta` (Vue) | Real type resolution; all three share one checker family.                                         |
| Tests           | Vitest, golden-file fixtures                                         | Fast, ESM-native. IR and contract goldens give regression safety.                                 |
| Lint/format     | Biome                                                                | Matches Primitiv; one tool.                                                                       |
| Build           | `tsc -b` for libraries, `tsup` or `esbuild` only for the CLI bundle  | Avoid a bundler until a package needs one.                                                        |
| CLI             | a small parser such as `cac` or `commander`                          | Decision deferred; low risk.                                                                      |
| MCP             | `@modelcontextprotocol/sdk`, stdio first                             | Same SDK Primitiv uses.                                                                           |
| Commits         | Conventional commits                                                 | Compatible with later release automation.                                                         |

## Milestones

Ordered by risk reduction and by what unblocks the next step. Each ends in something runnable and tested.

| #   | Milestone                                     | Exit criteria                                                                                                                                                                                                      |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M0  | Workspace scaffold (DONE)                         | pnpm workspace, TS project references, Biome, Vitest, CI running lint, typecheck, test, and a dependency-boundary check. Empty packages build.                                                                     |
| M1  | Contract and IR schemas (DONE)                    | `contract` and `compiler-ir` packages with zod schemas, JSON Schema output, canonical JSON, hashing. Schema docs. Golden tests for canonicalization.                                                                        |
| M1b | Compiler core and source discovery (plan Phase 2; DONE: see `docs/specifications/discovery-and-adapters-v1.md`) | Adapter interface, project discovery, inventory adapters, orchestration, artifact generation, test harness. A multi-framework monorepo is represented in IR with no framework adapter. |
| M1c | React compiler and token extraction (plan Phase 3; DONE: see `docs/specifications/react-and-tokens-v1.md`) | `compiler-react` (components, props, variants, slots, accessibility, styling, composition, usage, with evidence) and `compiler-tokens`, validated on a real library. |
| M1d | Storybook compiler and Storybook/code reconciliation (plan Phase 4; DONE: see `docs/specifications/storybook-v1.md`) | `compiler-storybook` (CSF 2/3, MDX, args, argTypes, controls, play structure, composition) and a first `reconciliation` slice (story-to-component linking and discrepancy checks), validated on a real design system. |
| M1e | Angular and Vue compilers (plan Phase 6; DONE: see `docs/specifications/angular-and-vue-v1.md`) | `compiler-angular` and `compiler-vue` emitting the same neutral facts as React, a cross-framework fixture and test, validated on ng-bootstrap and reka-ui. |
| M1f | Reconciliation and semantic engine (plan Phase 7; DONE for code, Storybook, tokens and Markdown: see `docs/specifications/reconciliation-and-semantics-v1.md`) | `reconciliation` builds the contract, evidence file, conflicts and review queue from IR; `semantic-engine` adds inferred token categories, guidelines and compound relationships, additively. zeroheight and Figma sources arrive later through the same path. |
| M1g | CLI and artifacts (plan Phase 8; DONE: see `docs/specifications/cli-v1.md`) | `apps/cli`: `init`, `source`, `analyze`, `compile`, `components`, `tokens`, `patterns`, `conflicts`, `validate`, `export`; JSON configuration; contract, evidence, diagnostics, review, manifest and HTML report artifacts. |
| M1h | MCP server and agent integrations (plan Phase 9; DONE: see `docs/specifications/mcp-and-agents-v1.md`) | `contract-query` (read model, search, validators), `mcp` (dual-era stdio server: 10 tools, 6 resources), `agent-kit` (skills and client configuration), `invariant mcp` and `invariant agent init`. |
| M1i | Validation and governance (plan Phase 10; DONE: see `docs/specifications/validation-and-governance-v1.md`) | `validation` (eleven rules, approved-policy evaluation, text/json/github/sarif reports), `governance` (policy compilation, approval and rejection decisions, conflict resolution), `invariant validate`, `verify`, `rules`, `policy`, `review`. |
| M2  | Compiler on hand-written IR                   | `core` compiles fixture IR documents: merge, conflict detection, status semantics, approvals overlay, deterministic emit. No real adapter yet. This validates the architecture before any extraction work.         |
| M3  | React adapter + CLI `compile`                 | `adapter-react` extracts props, defaults, variants, and JSX usage from a fixture library with the TS checker. `invariant compile` produces a contract end to end. Byte-identical across two runs and two machines. |
| M4  | Storybook adapter + first real reconciliation | Reads `index.json` from a built Storybook; args/controls from CSF. Code-vs-Storybook conflicts shown by `invariant conflicts`. `verify` and `diff`.                                                                |
| M5  | Approvals and `explain`                       | `invariant approve`, fingerprint binding, invalidation on evidence change, `explain` shows evidence chain.                                                                                                         |
| M6  | MCP server                                    | Read-only tools over the contract, structured output, status shown on every fact.                                                                                                                                  |
| M7  | Figma adapter                                 | Variables (live and snapshot), components; token conflicts against code.                                                                                                                                           |
| M8  | Vue adapter                                   | Via `vue-component-meta`. Same neutral fact paths as React, proven with a cross-framework fixture of the same component in all three.                                                                              |
| M9  | Angular adapter                               | Decorators and signal APIs, after confirming `model()`, `output()`, and `@Input` against angular.dev.                                                                                                              |
| M10 | zeroheight adapter                            | Pages as documented facts, explicit component mapping.                                                                                                                                                             |
| M11 | Inference rules and hardening                 | Named rules, performance on large libraries, error ergonomics, docs, release.                                                                                                                                      |

**Order change (2026-10-31):** zeroheight (plan Phase 5, milestone M10) is built after the last plan phase. The remaining build order is plan Phase 6 (Angular and Vue), 7 (semantic engine and reconciliation), 8 (CLI and artifacts), 9 (MCP), 10 (validation), then zeroheight.

Rationale for order: M2 before any adapter forces the IR and conflict model to stand on their own. React and Storybook come first because they exercise the code-vs-docs conflict path that justifies the product. Figma follows because token conflicts are the next most valuable and its access constraints need design (D5). Vue before Angular because a maintained extractor exists for Vue, while Angular needs custom work and has unverified API surface. zeroheight is last because its API surface is the least verified and it only produces `documented` facts.

## Risks

- **Type resolution cost and fidelity.** Using the real TypeScript checker is slower and needs a resolvable `tsconfig` in the target library. Libraries without one will need a fallback or explicit configuration.
- **Storybook manifest instability.** The `components.json` schema is documented as unstable. Depend on `index.json` plus static CSF first, and gate the manifest by version.
- **Access-gated sources.** Figma Variables and zeroheight are plan-gated. Snapshot import must be a first-class path, not an afterthought.
- **Identity linking errors.** A wrong merge is worse than no merge. Prefer diagnostics over guesses; make mappings explicit and reviewable.
- **Scope creep via the fact model.** Keep the neutral path vocabulary small and add paths only when two sources can supply them.
