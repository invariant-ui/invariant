# Releasing to npm

Invariant is published as one package, `@invariant-ui/cli`, with a bin named `invariant`. The workspace stays split into packages so boundaries are checked; `scripts/build-npm.ts` assembles them into one tree (`dist-npm/`) by copying each package's compiled output and rewriting `@invariant/*` imports to relative paths. There is no bundler.

The name is set in one place, `NPM_PACKAGE` in `apps/cli/src/version.ts`. `invariant` itself is an unrelated package on npm.

## Check a build

```bash
pnpm build:npm                      # tsc -b, then assemble dist-npm/
cd dist-npm && npm pack --dry-run   # what would be published
```

`scripts/npm-package.e2e.test.ts` builds the package and runs it as a real process, and checks that no workspace import is left and every relative import resolves. Running the assembled package was also checked on Node 20 and Node 24, which is why `engines` says `>=20`.

## Publish by hand

1. Log in: `npm login` (the account that will own `@invariant-ui/cli`).
2. Bump the version in `apps/cli/package.json` and `apps/cli/src/version.ts` (keep them equal). Version strings appear in committed golden files, so run `UPDATE_GOLDEN=1 pnpm test` and review the diff: only versions and hashes should change.
3. `pnpm verify && pnpm build:npm`.
4. `cd dist-npm && npm publish --access public`.
5. Check it from a clean directory: `npx @invariant-ui/cli --version`.

## Publish from CI

`.github/workflows/publish.yml` publishes with provenance when a tag matching the version is pushed. Add an npm automation token as the `NPM_TOKEN` repository secret first, then `git tag v0.1.0 && git push origin v0.1.0`. Publishing cannot be undone: a version number, once used, is never reusable.

## Using it

```bash
npx @invariant-ui/cli setup      # nothing to install first
npm install -g @invariant-ui/cli # or install it, then run: invariant setup
```

`invariant agent init` writes an MCP entry that starts the server with `invariant mcp`. If `invariant` is not on PATH (npx use), it writes `npx -y @invariant-ui/cli mcp` instead. `--command` overrides both.
