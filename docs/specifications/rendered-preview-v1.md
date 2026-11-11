# Rendered preview (v1, design only)

Status: **design only. Nothing here is built.** This is Phase D of the agent-enforcement plan. It is written so the build can start without re-deciding anything marked as decided. The matching decision record is `docs/decisions/0004-rendered-preview.md`, which is Proposed and needs approval before any code is written.

Related: `docs/specifications/agent-enforcement-v1.md`, `docs/specifications/browser-verification-v1.md`, `docs/specifications/mcp-and-agents-v1.md`.

## Goal

When an agent (or a person watching it) checks a snippet, show what it looks like, with each static finding drawn on the element it concerns. A red outline on the button that uses `#ff0000` communicates more in a chat than a line number does. The preview is evidence for a person. It is not a new validator.

## What exists today

- `validate_design_system_compliance` is a read-only MCP tool. It returns findings with `line` and, for some findings, `column`, and a card for the person watching (Phase B).
- `packages/browser-verify` drives a real browser through a `BrowserDriver` / `PageHandle` interface. The only implementation is `playwrightDriver`, which loads Playwright from the customer's project. Per `browser-verification-v1.md`, that driver has not been run against a real browser in this repository, so its behavior is reviewed but unproven here.
- `PageHandle` has no screenshot, no `evaluate`, and no way to load HTML the caller supplies. It navigates to a URL that must already be served.
- Findings carry source positions in the snippet. Nothing maps a source position to a DOM element.

## Decided

1. **Opt-in, per project, and separate from the existing MCP tools.** The preview is its own MCP tool, advertised only when the project enables it. The default `validate_design_system_compliance` never starts a browser and never returns an image. See ADR 0004.
2. **Playwright stays a customer-supplied optional dependency**, loaded from the project, exactly as `browser run` does. Invariant adds no dependency.
3. **The preview annotates; it never adds, removes or changes findings.** Every annotation comes from a finding the static validator already produced. A finding that cannot be located on the page is listed as unlocated, never dropped.
4. **Static and runtime stay apart** (the rule in `browser-verification-v1.md`). A preview image has no evidence level above `static` for the findings it shows. It does not make a finding runtime-verified.
5. **Phase D ships no code.** The first build slice is the design-system-repo case below.

## Proposed behavior

### Surface

The MCP server is the primary surface (owner direction, 2026-11-11): the CLI compiles the deterministic contract, and the MCP is what an AI client uses to enforce it. A new tool, `render_design_system_preview`, takes the same input as `validate_design_system_compliance` (`code`, optional `framework`, `filename`) plus an optional viewport, and returns, in order: the card text, an MCP `image` content item (base64 `image/png`) and `structuredContent` listing what was drawn and what was unlocated. It writes nothing to the project. It is advertised only when `preview.enabled` is set in `invariant.config.json`.

A CLI form shares the implementation, for CI and for people:

```
invariant preview <file> [--out <png>] [--viewport 1280x800] [--browser chromium]
```

The enforcement report (Phase C) can embed the PNG for a `blocked` event later.

### Pipeline

1. **Validate** the snippet with the existing `validateCode`. Output: findings with `line` and `column`.
2. **Instrument** (build step, not customer code execution): parse the snippet with the TypeScript compiler API and add a `data-invariant-loc="<line>:<column>"` attribute to every JSX element and HTML element in the snippet's own tree. Only intrinsic elements and component uses written in the snippet are marked.
3. **Bundle and render** in a controlled page (see Render harness). Components render with their real implementations and the customer's real token CSS.
4. **Locate**: for each finding with a position, find the element whose `data-invariant-loc` matches the finding's line and column. Nearest enclosing element if the finding points inside an attribute or text.
5. **Annotate**: take the element's bounding box in the page and draw the outline and a numbered badge. Draw by injecting an overlay element before the screenshot, so the annotation exists only in the image and never touches the customer's DOM state beyond the screenshot.
6. **Screenshot** the viewport, or the snippet's root clipped to its content with padding.
7. **Return** the PNG, a legend (badge number, rule code, message, fix), and an `unlocated` list.

Instrumentation is the one design choice that makes annotation exact rather than heuristic. The alternative, matching findings to elements by component name and prop value (find the `Button` whose rendered `variant` is `danger`), fails when the same component appears several times with the same props and cannot place a hardcoded color at all. Position attributes are deterministic and are stripped from nothing the customer ships, since they exist only in the preview render.

### Which findings can be located

| Finding kind | Located by | Notes |
| --- | --- | --- |
| Unknown prop, bad prop value, deprecated prop on a component use | The component use element | Exact. |
| Literal color or spacing outside tokens, on an element's `style` or class | The element carrying the value | Exact when the value is on a JSX attribute. |
| Literal color inside a CSS string not tied to one element | Not locatable | Listed as unlocated. |
| Pattern violations (structure, required parts) | The pattern root if it is in the snippet, else the snippet root | Drawn as a dashed outline to show it is structural. |
| Missing required interaction states | Not a visual property | Listed as unlocated. Never drawn as a pass. |
| A finding with no `line` | Not locatable | Listed as unlocated. |

The legend states for every finding whether it was drawn. A preview with unlocated findings says so in its first line.

## Render harness

The preview has to load the customer's real components and tokens, or it shows something that is not their design system. A design system may live in its own repo and npm package, or in the same repo as the applications, and the harness must handle both.

**One renderer, two discovery outcomes.** The renderer bundles the snippet using ordinary import resolution from the project root. `import { Button } from "@acme/ui"` resolves through `node_modules` when the design system is a package and through the workspace when it lives in the same repo; the renderer does not branch. What changes is how the project says where the design system's component entry and token stylesheets are. That is recorded once, in config:

```json
{
  "preview": {
    "enabled": true,
    "stylesheets": ["packages/tokens/dist/tokens.css"],
    "wrapper": "src/preview-wrapper.tsx"
  }
}
```

`stylesheets` are files the page loads so token variables exist. `wrapper` is optional: a module exporting the providers (theme, router) a snippet needs. Without a wrapper, a snippet that needs a provider fails to render and the tool says so; it never guesses a provider.

**Guided discovery.** A skill (built on the existing `invariant-component-discovery` skill and `invariant setup`) walks the customer through where the design system lives, finds the component entry and token stylesheets, and asks them to confirm. The skill proposes and a person approves; the answers are written to the config and used by the CLI, so the render is deterministic and reviewable in a pull request, and the same config serves agents at generation time and CI review. The skill is a prerequisite for enabling the preview and is new work outside Phase D.

**Bundler.** The simplest approach that resolves imports: a small bundling step Invariant ships (esbuild is the candidate; it is not a dependency today and needs approval at build time). The customer's own bundler is not invoked, because that would run arbitrary build config. Aliases, CSS modules and SVG imports the small bundler cannot resolve produce a "cannot render" result, not a finding.

**Serving.** The bundle is served on a loopback port and opened in the Playwright page under the controlled-environment rules.

**Later sources for the same config.** Storybook (render a generated story through the customer's iframe) and app-repo providers beyond a single wrapper. Neither is in the first build.

## Trust and safety

These are the constraints from `CLAUDE.md`, applied to rendering. Rendering executes the customer's component code, which the project forbids during static analysis. The ADR treats this as the central decision.

- Rendering never runs inside `compile`, `validate`, `mcp`, or the default hook path. It runs only on an explicit command, which is the same opt-in line `browser run` draws.
- The page is controlled: headless, loopback only, other origins aborted, service workers blocked, a fresh context per render, bounded timeouts, a bounded snippet size (the existing 200,000-character limit) and a bounded screenshot size.
- The snippet is agent-written text that is about to be bundled and executed in a browser. It must be treated as untrusted. An agent, or text injected into an agent's context, could write a snippet that reads the page, makes requests or loops forever. The origin blocking and the timeout limit the damage. The page has no credentials, and the render origin has no cookies. The renderer must not mount the customer's environment variables or secrets into the bundle.
- Annotations come from the deterministic validator. No model-written text is drawn on the image or written to disk except the validator's own messages.
- The preview image and sidecar are local artifacts under `.invariant/`, which is already self-ignoring. They are not committed and not uploaded.

## Open questions

1. **Does a preview count as "executing customer source code"?** `CLAUDE.md` forbids arbitrary execution during static analysis. A preview is not static analysis, but it does run customer components. The owner has not decided (2026-11-11). The design assumes the strictest workable reading: a per-project, person-approved opt-in. A flat no blocks the feature.
2. **Bundler approval.** esbuild is proposed. It is a new dependency, and how well a small bundler resolves real customer aliases, CSS modules and SVG imports is unproven.
3. **CSS delivery.** Token CSS may come from a package, a Sass build, a CSS-in-JS runtime, or Style Dictionary output that has to be generated first. How does the harness find the right stylesheets?
4. **Frameworks.** React is the framework patterns and interaction checks support today. Vue and Angular snippets need their own render paths; Angular in particular needs a compiler pass. The first build is React only.
5. **Determinism.** Fonts, animations and async data make screenshots vary. Golden tests of images are fragile. The tests should assert the sidecar (what was located, what was drawn, positions) and treat the PNG as a smoke check, not a golden.
6. **Size and token cost.** A base64 PNG in an MCP result counts against the client's context and the 400,000-character result limit. A 1280 by 800 PNG is often 50 to 300 KB, which would fit but would be costly for the model. Scaling, JPEG, or sending the image only to the human surface (not the model) need a decision.
7. **Who sees the image.** MCP image content goes to the model, and the client decides whether to show it to the person. The goal here is the person watching. Claude Code hooks cannot show an image in the chat today, so the hook path may only be able to write a file and print its path. This needs checking against current Claude Code behavior before building.
8. **Playwright driver is unproven in this repo.** The driver has never been run against a real browser here. Phase D's build must first run it, then extend `PageHandle` with `screenshot`, `setContent`/serve, and a bounding-box query.

## Risks

- **Bundling arbitrary customer code is the largest risk**: build config differs wildly, resolution fails in ways that look like findings, and the harness grows into a build system. Mitigation: React-only, design-system-repo-first, and a hard "cannot render" result that never implies a finding.
- **A preview that looks correct while a finding is not drawn** reads as a pass. Mitigation: the legend lists every finding and its status, and the first line states the unlocated count.
- **Misplaced annotations** if instrumentation attributes are lost by a component that does not forward unknown props to the DOM. Mitigation: mark and verify; a position that is not found in the DOM becomes unlocated. A component that swallows `data-*` attributes degrades to a root-level outline, not a wrong one.
- **Slow**: a bundle plus a browser launch is seconds, not the sub-500 ms budget the hook holds. The preview must never sit on the hook's blocking path. It is asynchronous or on demand.
- **Scope creep toward a visual regression tool.** Out of scope: pixel diffing, baselines, cross-browser comparison.

## Out of scope for the first build

- Vue, Angular and plain HTML snippets.
- App repos and provider wrappers.
- Multiple viewports in one preview.
- Interaction (hover, focus, open states). The preview is a static render.
- Any change to the contract, its schema, or the IR.

## Acceptance for the build round (not this round)

- The Playwright driver runs against a real browser in CI and its result is recorded.
- On `fixtures/monorepo/acme`, a snippet with a bad prop value and a hardcoded color renders, the two findings are outlined on the correct elements, and the sidecar lists both as located.
- A finding that cannot be located is reported as unlocated and appears in the legend.
- With Playwright missing, the command exits 2 with the existing install hint and writes nothing.
- No browser starts during `compile`, `validate`, `mcp` or the default hook path (asserted by a test).
- The default MCP validate tool is byte-for-byte unchanged.
