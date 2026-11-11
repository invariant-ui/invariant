# MCP server and agent integrations (v1)

Status: implemented in `packages/contract-query`, `packages/validation` (the validators; moved there in Phase 10), `packages/mcp`, `packages/agent-kit`, and the CLI commands `invariant mcp` and `invariant agent` (plan Phase 9). The contract does not know MCP exists: the server only reads the files `invariant compile` wrote.

## Running it

```
invariant compile
invariant mcp [--dir invariant]          # serves over stdio until stdin closes
invariant agent init <client|all>        # writes client configuration and skills
```

`agent init` writes an entry that launches `invariant mcp --dir <output dir>`. The default command is `invariant`, which must be on `PATH` (for example via `pnpm link` of `apps/cli`). Use `--command node --command-arg /path/to/apps/cli/dist/main.js` otherwise. `--dry-run` shows what would be written; `--force` replaces differing entries.

## Protocol

Transport: stdio, newline-delimited JSON-RPC. Only protocol messages go to stdout; logs go to stderr. The server exits when stdin closes. Lines over 2,000,000 characters are rejected.

The server is dual-era (checked against the specification text on 2026-10-31):

- **Modern revision, 2026-07-28.** Stateless. A request carries `_meta["io.modelcontextprotocol/protocolVersion"]`. `server/discover` returns `supportedVersions`, `capabilities`, `instructions`, and the server identity under `_meta["io.modelcontextprotocol/serverInfo"]`. Results carry `resultType: "complete"`. An unsupported version gets error `-32022` with `data.supported` and `data.requested`.
- **Legacy revisions, 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05.** `initialize` negotiates the version: a supported requested version is echoed, otherwise the latest legacy version is offered. `notifications/initialized` and `notifications/cancelled` are accepted and ignored. Results have no `resultType`.

Supported methods: `initialize`, `ping`, `server/discover`, `tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read`. Not supported (and not advertised): prompts, logging, completions, subscriptions, tasks, sampling, elicitation, pagination (lists are returned whole), HTTP transports. Unknown methods return `-32601`. Malformed JSON returns `-32700`; invalid requests, including batches, `-32600`.

Errors follow the specification: an unknown tool or missing resource is a protocol error (`-32602`); bad tool arguments and a missing or invalid contract are tool execution errors (`isError: true`) the model can act on.

## Tools

All eleven are read-only (`readOnlyHint: true`, `openWorldHint: false`) and deterministic. Results are JSON in `structuredContent` and in the text content, always with `contractHash`, and with `_meta["com.invariant/provenance"] = { untrustedContent: true, contractHash }`. The one exception: `validate_design_system_compliance` leads its text content with the enforcement card (the same one the Claude Code hooks show), ahead of the unchanged JSON; models should parse `structuredContent`. Lists take `offset` and `limit` (default 50, at most 200). Results over 400,000 characters are refused with advice to narrow the request.

| Tool | Returns |
|---|---|
| `get_design_system_overview` | Name, frameworks, sources and health, counts, open conflicts, inferred-fact count, and notes on what is not covered or incomplete. |
| `search_design_system` | Lexical hits over components (name, props, variants, slots, events, description), tokens, guidelines and patterns (name, intent, parts, regions, states), with score and what matched. Fixed ranking rules; no model or embeddings. Matching is lexical: exact words, plural and `-ing` stems, word prefixes, and one-letter typos (a word of five or more letters). An approximate match is ranked below exact ones and labeled `(approximate)` in `matchedOn`. |
| `get_component` | Implementations (with `apiComplete`), props with type, default, allowed values, status and source line, events, slots, variants, accessibility, conflicts, guidelines, notes. |
| `get_component_usage` | How to import, required props, variants and defaults, deprecated props, examples written in source, observed prop combinations (React only), related guidelines. |
| `get_component_composition` | What it contains and what contains it, with discovered or inferred status; slots. |
| `get_design_tokens` | Tokens filtered by category, text, theme, with alias chains and resolved values; cycles and missing targets are reported, not guessed. |
| `get_design_patterns` | Without `name`: the pattern catalog, filterable by `category`, derived `status` and `query`, paged. With a `name` or id: one pattern in full (parts, regions, behavior, accessibility, constraints, relationships, the policies that enforce it, conflicts, and every fact with its evidence). With `resolve: true`, or a `variation` name, the pattern read as a page blueprint instead: the patterns it composes expanded to six levels, regions with their parts, variations (a named one applied), required interaction states and whether each is enforced, responsive expectations, prohibited parts and combinations, the patterns it builds on with their status, and notes such as an approved archetype built on patterns that are not approved. An unknown variation is an error that lists the ones that exist. Every result says whether each pattern is approved, with notes that a pattern which is not fully approved is a proposal. An empty result says that none is defined. |
| `get_pattern_relationships` | The edges around a pattern, walked to `depth` (1 to 5, default 1) in `direction` `out`, `in` or `both`, optionally limited by `types`. Composition parts appear as `part` edges with their role. Each edge carries the status and source of the fact behind it. Nothing is inferred from names. |
| `get_design_guidelines` | Guideline titles, kinds and referenced documents; the response says page bodies are not included. |
| `validate_component_usage` | Checks one intended use: unknown component, unknown prop (only when the API listing is complete), value outside allowed values, type mismatch, deprecations, missing required props. |
| `validate_design_system_compliance` | Checks a snippet (React JSX/TSX, Vue, Angular, or HTML templates; at most 200,000 characters): component props and values, literal colors and CSS variables against tokens, and the structural rules of approved patterns. Pass `filename` so path-scoped pattern rules can apply; the result lists every pattern check with its status (`evaluations`), where not-verifiable and skipped checks are never passes. Its text content leads with the enforcement card — findings, fixes, and the closing next step — the same card the enforcement hooks show, so the chat reads identically whether the agent called the tool or the hook fired; the JSON body and `structuredContent` follow unchanged. |

**Validators.** (Provided by `packages/validation`; see `validation-and-governance-v1.md` for the full rule set, policies and decisions.) Static only: JSX is parsed with the TypeScript API, templates with a small linear scanner, and nothing is executed or imported. Only literal values are verified; expressions and bindings are counted in `unverifiedValues`. Each finding has a `basis`: `discovered`, `documented`, `inferred`, or `heuristic`. A native element with a similarly named component (`<button>` and `Button`) is `heuristic` at confidence 0.5 and `info` severity. A literal color equal to a token's value gets an `info` suggestion to use the token; a color that matches no token is a `warning`. Lowercase tags without a hyphen are native elements in every framework. The default framework comes from the file name, then the contract's only framework, then React. Approved policies in the contract are applied, with their policy reference; none exist unless the project defines them.

## Resources

`invariant://manifest` (verbatim `invariant.manifest.json`), `invariant://metadata`, `invariant://components`, `invariant://tokens`, `invariant://patterns`, `invariant://guidelines`, and the templates `invariant://component/{id}` (the id after `component:`, percent-encoded) and `invariant://pattern/{id}` (the id after `pattern:`, or a name; percent-encoded). All are `application/json`. A missing resource is `-32602` with the uri.

## Loading and reload

The server reads `invariant.contract.json`, `invariant.evidence.json` and the manifest from the output directory. It verifies the contract (structure, references, content hash, evidence) before serving and reloads when file modification times or sizes change, so a recompile is picked up without a restart. A missing, invalid or tampered contract is never partly served: tools and resources report what is wrong and to run `invariant compile`.

## Trust model

Contract text (names, descriptions, guideline titles, examples) is copied from the customer's source and documents and can contain instructions aimed at a model. The server states this in its `instructions`, marks results untrusted, and returns structured JSON instead of prose. Generated skills and rules never include that text: only identifiers matching `[A-Za-z][A-Za-z0-9._-]{0,63}` (at most 60 component names) and a short title, so a hostile description cannot be written into committed agent configuration. Tests cover hostile descriptions, component names and design-system names.

The server has no network listener, no authentication surface, and no write path. It does not run customer code.

## Generated agent configuration

| Client | Files written (all inside the project) | Notes |
|---|---|---|
| Claude Code | `.mcp.json` (merged), `.claude/skills/<skill>/SKILL.md` ×5 | Claude Code asks you to approve project servers on first use. Skills pre-approve `mcp__invariant__<tool>` for the tools they use. |
| Cursor | `.cursor/mcp.json` (merged, `type: "stdio"`), `.cursor/rules/invariant.mdc` | The rule is not always-applied: it carries a description so the agent applies it when relevant. |
| Codex | `.codex/config.toml` (table added), `AGENTS.md` (marked section) | Codex reads project config only for trusted projects. |
| Windsurf | `.windsurf/rules/invariant.md` | The location of Windsurf's MCP configuration could not be verified from current documentation, so the entry is printed, not written. Set the rule's activation mode in Windsurf. |

Skills: `invariant-build-ui`, `invariant-component-discovery`, `invariant-layout-composition`, `invariant-design-review`, `invariant-refactor-ui`. They name the design system and list component names, and carry the ground rules (statuses, incomplete APIs, untrusted text, no invented props, tokens over literals, pattern status, unresolved checks).

`invariant-build-ui` is a scoped workflow, not a dump of the contract: understand the task; find the page archetype (`get_design_patterns` with `category: "page"` or `query`, then `name` with `resolve: true` and `variation`); find interaction and layout patterns (and `get_pattern_relationships`); check status before following (approved patterns are followed, documented, inferred or mixed ones are proposals the user must agree to); get components and tokens; generate; validate with `validate_design_system_compliance` (pass `framework` and a project-relative `filename` so path-scoped pattern rules apply); correct and validate again; report. The report lists what passed, what was fixed, and what is unresolved: unfixed violations, every check reported `not-verifiable` or `skipped` with its reason, dynamic values, incomplete APIs, and unapproved patterns that were followed. It says static checks do not show runtime behavior and that the user can run `invariant browser run`.

Generated files list the ids of fully approved page archetypes (at most 20, ids only, filtered like component names; pattern names and descriptions never reach them) so an agent knows where to look. The rules for clients without skills carry the same steps in short form. Skills tell agents that candidates from `invariant discover` are not patterns: MCP does not expose them.

Writing is conservative. JSON is parsed and merged (other servers and keys are kept); JSON that does not parse is left alone. A differing existing entry is not replaced without `--force`. Generated files carry a `generated by invariant` marker; a file without it is never overwritten without `--force`. The `AGENTS.md` section lives between `<!-- invariant:begin -->` and `<!-- invariant:end -->` and is replaced on regeneration, leaving the rest of the file alone. Paths are checked to stay inside the project, symbolic links included.

## Verification

- `packages/contract-query` (38 tests), `packages/mcp` (28), `packages/agent-kit` (19), CLI (`agent.test.ts`, 8), and `scripts/phase9.e2e.test.ts` (4), which launches the built binary from the generated `.mcp.json` entry and speaks both protocol eras to it, runs an agent flow (search, read, reject wrong code, accept right code), and checks every skill's pre-approved tools exist.
- Real libraries: Radix (227 components) and reka-ui (395) answer in single-digit milliseconds after a first load of about 300 ms, and exit cleanly when stdin closes.

## Known limitations

- Protocol subset only; no HTTP transport, authentication, subscriptions, or pagination. Revisit if those are needed.
- Lexical search: it finds names and listed words, with stems, prefixes and one-letter typos, but no synonyms or meaning. Embeddings would add a model and make results non-deterministic.
- Validators check literal values in one snippet. They do not resolve imports, follow props through wrappers, or know which library an unfamiliar component comes from.
- The guidelines resource is large for big repositories (about 290 KB for reka-ui's 527 pages). Use `get_design_guidelines` with filters instead.
- Observed usage statistics exist only for React.
- Windsurf MCP configuration and activation are not automated.
- The server cannot record decisions (approve, reject): decisions are written by people with `invariant review`.
