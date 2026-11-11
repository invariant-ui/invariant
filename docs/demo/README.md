# The enforcement demo

`pnpm demo` runs the whole loop in a scratch copy of the Acme fixtures: an agent is asked for a settings page with a delete button, and the real `invariant hook` process blocks three attempts (a prop value outside the contract, a hardcoded color, a pattern violation) before a clean write passes. It then prints `invariant enforcement report`. The script is `scripts/demo.ts`; the scenario is `scripts/demo-loop.ts`, shared with the e2e test `scripts/enforcement-loop.e2e.test.ts`, so what you see is what CI asserts.

It uses `fixtures/storybook/acme-ui` (components and the approved `page.settings` pattern from `fixtures/pattern-validation`) plus the token package from `fixtures/monorepo/acme`, because `monorepo/acme` has neither approved patterns nor a closed Button prop list.

## Regenerating the GIF

Install [VHS](https://github.com/charmbracelet/vhs), then from the repository root:

```bash
pnpm build
vhs docs/demo/demo.tape
```

This writes `docs/demo/enforcement-loop.gif`. The GIF is not committed yet: it has to be recorded on a machine with VHS installed.
