# ADR 0004: Rendered preview with annotated findings

Status: **Proposed** (Phase D of the enforcement plan, 2026-11-11). No code is written. This needs an owner decision on D1 before the build starts.
Related: `docs/specifications/rendered-preview-v1.md`, `docs/decisions/0003-agent-enforcement-hooks.md`, `docs/specifications/browser-verification-v1.md`

## Context

The enforcement loop (hooks, cards, log, report) tells an agent and the person watching it what is wrong, in text. A picture of the rendered snippet with the violations outlined would show it faster. The plan proposes extending the MCP validate tool with an opt-in preview that renders the snippet in the existing Playwright harness, annotates findings by source position, and returns an MCP `image` content item.

Three existing commitments pull against that:

- **MCP stays read-only.** ADR 0003 holds that MCP tools do not write, call out, or run customer code, and every tool advertises `readOnlyHint: true`.
- **No execution of customer source code during static analysis** (`CLAUDE.md`). Rendering a snippet runs the customer's component implementations.
- **Static and runtime stay apart** (`browser-verification-v1.md`). A render is runtime behavior, and the validator's findings are static.

## Decision (proposed)

**D1. Rendering runs customer components, so it is consent-gated.** The preview executes the customer's component code in a controlled headless page, which `CLAUDE.md` forbids during *static analysis*. The preview is not static analysis, but this is the owner's call and it is **still open** (owner answered "not sure", 2026-11-11). Until it is decided, the design assumes the strictest reading: nothing renders unless a person turned it on for this project (`preview.enabled` in `invariant.config.json`, set through the guided setup below), and the config records who approved it. `compile`, `validate`, the default hook path and every existing MCP tool never render.

**D2. The MCP server is the primary surface, with a separate preview tool.** (Revised 2026-11-11 on owner direction: the CLI generates the deterministic contract and utilities; the MCP is the artifact AI clients use to enforce it, so the preview belongs there.) The preview is a *new* tool, `render_design_system_preview`, not a flag on `validate_design_system_compliance`, whose behavior and output stay unchanged. The tool is listed only when the project has `preview.enabled`; otherwise the server does not advertise it. It writes nothing to the project: it returns the card text, an `image` content item and `structuredContent` (what was drawn, what was unlocated), and the image lives only in the response. That keeps ADR 0003's "MCP is read-only" true in the sense clients rely on (it does not modify the project), and `readOnlyHint` stays true. What it adds is code execution, which is why D1 gates it, and the tool's description says so in plain words. `openWorldHint` stays false because the page is loopback-only. A CLI form (`invariant preview <file>`) shares the same implementation for CI and for people.

**D3. The preview annotates validator findings and adds none.** Annotations are drawn from findings the static validator already produced, located by instrumented source positions. A finding that cannot be located is listed as unlocated, never dropped and never shown as passed. The preview does not raise any finding's evidence level.

**D4. Position instrumentation, not heuristic matching.** The snippet is parsed and each JSX or HTML element in it gets a `data-invariant-loc` attribute for the preview render only. This was chosen over matching findings to elements by component and prop value, which cannot distinguish repeated identical uses and cannot place a literal color at all.

**D5. One harness for both repo shapes; the difference is discovery.** (Revised 2026-11-11.) A design system may live in its own repo and npm package, or in the same repo as the applications. The renderer does not care: it bundles the snippet with the project's own resolution, so `import { Button } from "@acme/ui"` resolves to `node_modules` in the first case and to a workspace package in the second. What differs is how the project says where the design system and its token CSS are. That is a configuration problem and is solved by guided discovery, not by two renderers:

- A skill walks the customer through where their design system lives, discovers its components and token stylesheets, and asks them to confirm. This builds on the existing `invariant-component-discovery` skill and `invariant setup`.
- The confirmed answers are written to `invariant.config.json` (`preview.stylesheets`, an optional `preview.wrapper` module exporting the providers a snippet needs, and `preview.enabled`) and then used by the CLI, which keeps the contract and the render deterministic and reviewable in a PR. The skill proposes; a person approves; the CLI persists and enforces. The same config serves agents at generation time and CI PR review.
- The bundler is the simplest thing that resolves imports: a small bundled step (esbuild is the candidate, and it is not a dependency today, so adding it needs approval at build time). The customer's own bundler is not invoked, because that would mean running arbitrary build config.

The first slice is React only. Storybook-based rendering stays an optional later source for the same config.

**D6. Controlled render environment, reusing browser verification's rules.** Headless, loopback only, other origins aborted, service workers blocked, a fresh context, bounded timeouts and snippet size, no environment variables or secrets in the bundle. The snippet is treated as untrusted because an agent wrote it.

**D7. Never on the hook's blocking path.** The hook holds a 500 ms budget; a bundle plus a browser launch takes seconds. The preview runs on demand, or asynchronously after a block, and writes its artifact under `.invariant/`.

## Alternatives considered

- **Add `include_preview` to the existing validate tool.** Matches the plan's wording. Rejected: a flag would make the default tool start a browser and execute code for anyone who passes it, with no per-project consent. A separate tool that is only advertised when enabled makes the consent visible (D2).
- **CLI only.** Rejected on owner direction: the MCP is the artifact AI clients use at generation time. The CLI form exists but is secondary.
- **Always render, with no opt-in.** Rejected: slow, needs Playwright everywhere, and executes code in places nobody asked.
- **Screenshot the running app instead of a snippet.** That is what `browser run` and a future scenario would do. It answers a different question (does the real page behave) and needs a running app, so it does not replace a snippet preview.
- **Render an SVG or HTML mock from the contract without a browser.** Rejected: it would show the contract's idea of the component, not the customer's implementation, and that risks fabricating what a component looks like, which the project's principles forbid.

## Consequences

If accepted:

- ADR 0003 is not amended: nothing in the project is written by the server, and `readOnlyHint` stays true for every tool. The code-execution consent is new and is carried by `preview.enabled` (D1), not by the hint.
- The tool list becomes dependent on config: a server without `preview.enabled` advertises exactly the tools it does today.
- `invariant.config.json` gains a `preview` section (a contract-adjacent config change: schema, validation and tests, but no change to the contract or IR, so no contract version bump).
- `browser-verify` gains screenshot, serve or set-content, and bounding-box capabilities on `PageHandle`. The Playwright driver must first be run against a real browser, which has never happened in this repo.
- The enforcement report can later embed an image for a blocked write.
- A bundler dependency is introduced and needs its own approval.
- A discovery-and-approval skill is a prerequisite for enabling the preview, and is new work outside Phase D.

If rejected: the card and report stay text-only.

## Open items for the owner

1. **Preview render versus "no customer code execution" (D1): undecided.** A narrow, per-project, person-approved opt-in is the proposal. A full "no" blocks the feature.
2. Can the person watching see an image in Claude Code's chat? MCP image content goes to the model and the client decides what to show. This is unverified and must be checked against current Claude Code before the build is planned. If chat cannot show it, the first place a person sees the image is the HTML report.
3. Approval of esbuild (or another bundler) when the build starts.
