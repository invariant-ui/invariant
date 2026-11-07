# Browser verification v1

`invariant browser run` checks a **running** app in a headless browser. It is opt-in and separate from compiling and from `invariant validate`. Static analysis cannot establish focus behavior, keyboard order, responsive layout or what actually renders; this can, for the scenarios someone writes.

## Opt-in

- Invariant does not depend on Playwright. `browser run` loads it from your project (`require.resolve("playwright")` from `--cwd`). If it is missing the command exits 2 and says: `npm install --save-dev playwright && npx playwright install chromium`.
- Nothing else (`compile`, `validate`, `discover`, `mcp`) imports or starts a browser.
- It starts nothing for you: the app must already be running at `baseUrl`.

## The spec: `invariant.browser.json`

Data only. Unknown keys are rejected, and there is no step that runs code, so a spec cannot carry a script.

```json
{
  "version": 1,
  "baseUrl": "http://localhost:3000",
  "browser": "chromium",
  "timeoutMs": 5000,
  "scenarios": [
    {
      "id": "edit-form-saves",
      "pattern": "pattern:page.edit-form",
      "constraint": "constraint:form.shows-success",
      "path": "/accounts/1/edit",
      "viewports": [{ "width": 375, "height": 700 }, { "width": 1280, "height": 800 }],
      "steps": [
        { "action": "fill", "selector": "#name", "value": "Ada" },
        { "action": "click", "selector": "button[type=submit]" }
      ],
      "expect": [
        { "kind": "visible", "selector": "[role=status]" },
        { "kind": "tab-order", "selectors": ["#name", "button[type=submit]"] }
      ]
    }
  ]
}
```

Steps: `click`, `fill`, `press`, `wait-for`. Expectations: `visible`, `hidden`, `text` (`equals` or `contains`), `focused`, `tab-order` (Tab from the current focus visits these in order), `contains` (rendered nesting), `count` (`min`, `max`). Each scenario runs once per viewport (default 1280 by 800), in a fresh page of a fresh context.

`pattern` and `constraint` record which approved pattern or constraint a scenario gives a runtime check for. They are written by a person, never inferred. A reference that is not in the compiled contract is reported as a note.

## Controlled environment

Headless; a new context per scenario (no cookies, storage or cache carried over); service workers blocked; every request to an origin other than the base URL's and `allowOrigins` is aborted. The base URL must be loopback (`localhost`, `127.0.0.1`, `::1`) unless its origin is also listed in `allowOrigins`, which says remote is intended. Timeouts are bounded. Selectors are the only text from the spec that reaches the page.

## Results

Written to `<output>/invariant.browser-results.json` with `kind: "runtime"`, and printed. Every result has `level: "runtime-verified"` and a `context` of browser, browser version, viewport and URL, plus the scenario, the check (`expect 2`, `step 1`), and any `pattern` and `constraint`. Statuses:

- `pass` and `fail` are findings about the page.
- `error` means the check could not be carried out (page did not load, a step failed, a selector never appeared). It says nothing about the pattern, is never counted as a pass, and the expectations after a failed step are not run.

Failures say what was seen: `Tab 1 should reach #save, but focus is on <input#name>`. Exit code 1 if anything failed or errored.

Static and runtime stay apart. `validate` results are never upgraded by a browser result, and browser results are not merged into its summary or SARIF; the `runtime-verified` evidence level appears only here.

## Not built, and not verified here

- **The Playwright driver has not been run against a real browser in this repository.** Playwright is not installed here, so the driver (`packages/browser-verify/src/playwright.ts`) is type-checked and reviewed but untested. The runner, spec, CLI and output are tested with a scripted fake driver. Run it once against your app before relying on it.
- Browser-level accessibility audits (for example axe) are not included; they need a dependency of their own.
- Deriving scenarios from approved patterns, mapping `required-state` constraints to runtime checks automatically, MCP exposure, screenshots and traces, a JSON Schema for the spec, and starting the app.
