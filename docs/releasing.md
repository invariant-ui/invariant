# Releasing

A release has two halves that share one version number: the CLI on npm, and the Claude Code and Cursor plugins that install it. The order of the steps matters, and the reason is in "Why the order matters" below.

| Artifact | Where it lives | How users get it |
| --- | --- | --- |
| CLI, `@invariant-ui/cli` (bin `invariant`) | npm, org `invariant-ui` | `npx @invariant-ui/cli setup`, or `npm install -g @invariant-ui/cli` |
| Claude Code plugin | `plugins/claude/invariant/` in this repository, listed by `.claude-plugin/marketplace.json` | `/plugin marketplace add mcarlucci/invariant`, then `/plugin install invariant@invariant` |
| Plugin zips | `site/downloads/invariant-claude-code.zip` and `invariant-cursor.zip`, served by the website | Download from the docs page "Install the plugin" |
| Cursor plugin | `plugins/cursor/invariant/` and the zip above | Unzip into `~/.cursor/plugins/local/invariant` (preview) |

The version is `CLI_VERSION` in `apps/cli/src/version.ts`. It must equal `version` in `apps/cli/package.json`. The plugin generator reads `CLI_VERSION` and writes it into both plugin manifests, the marketplace entry, and the launcher, which installs exactly that version of the CLI. So the plugins never run a CLI version other than the one they were built for.

The package name is set in one place, `NPM_PACKAGE` in `apps/cli/src/version.ts`. A test keeps the launcher's copy equal to it. (`invariant` on npm is an unrelated package.)

## Why the order matters

The launcher in a plugin pins an exact CLI version and installs it from npm on first use. If a plugin version reaches users before that CLI version is on npm, the install fails. The hook then lets every write through unchecked (it fails open, by design) and the MCP server does not start. Nothing tells the person except a line on stderr. So: **publish to npm first, confirm it, and only then push the plugins.**

## Release checklist

1. **Pick the version** (semantic versioning; before 1.0, a minor bump for anything users would notice). Edit `apps/cli/package.json` and `apps/cli/src/version.ts`, keeping them equal.
2. **Update the golden files.** Version strings appear in committed goldens: run `UPDATE_GOLDEN=1 pnpm test` and review `git diff`. Only versions and hashes should change.
3. **Update the pinned examples on the website.** The CI snippets use `npx @invariant-ui/cli@<version>` in `site/index.html` and `site/docs/index.html`. Find them with `grep -rn "cli@" site`.
4. **Verify everything:** `pnpm verify` (lint, typecheck, boundaries, build, tests). It must pass before anything is published.
5. **Check the npm package:** `pnpm build:npm`, then `cd dist-npm && npm pack --dry-run`. Look at the file list. `scripts/npm-package.e2e.test.ts` already runs the assembled package as a real process.
6. **Publish to npm** (see "Publishing to npm" below).
7. **Confirm it is live**, from a clean directory: `npx -y @invariant-ui/cli@<version> --version`. A new version can take a few minutes to appear. The registry returns 404 until it does. Wait for it.
8. **Regenerate the plugins:** `pnpm build:plugins`. This rebuilds, then rewrites `plugins/`, `.claude-plugin/marketplace.json` and `site/downloads/*.zip` with the new version. `scripts/plugins.test.ts` fails if any of them is stale, so CI catches a forgotten step.
9. **Validate the Claude plugin:** `claude plugin validate plugins/claude/invariant --strict` and `claude plugin validate . --strict`. The plugin test runs these too when `claude` is installed.
10. **Commit and push to `main`.** CI runs `pnpm verify`. GitHub serves the marketplace straight from the repository. The `Deploy site` workflow publishes `site/` (including the zips) whenever a push touches it.
11. **Check an install the way a user does**, without touching your own Claude settings:

    ```bash
    export CLAUDE_CONFIG_DIR=$(mktemp -d)
    cd $(mktemp -d)
    claude plugin marketplace add mcarlucci/invariant
    claude plugin install invariant@invariant --scope project
    claude plugin list        # invariant <version>, enabled
    ```

12. **Tag the release** if you publish from CI (below), or `git tag v<version>` afterwards for the record.

## Publishing to npm

**By hand.** Log in as an owner of the `invariant-ui` org (`npm login`). The account has two-factor authentication, so publishing needs a current code:

```bash
cd dist-npm
npm publish --access public --otp=<6-digit code>
```

`--access public` is required: scoped packages default to private.

**From CI.** `.github/workflows/publish.yml` publishes with provenance when a tag matching the version is pushed. It needs an npm automation token stored as the `NPM_TOKEN` repository secret. Then:

```bash
git tag v<version> && git push origin v<version>
```

The workflow checks that the tag equals `apps/cli/package.json`'s version before it publishes.

Publishing cannot be undone. A version number, once used, is never reusable, even if the package is unpublished. If a release is wrong, publish a new version and run `npm deprecate @invariant-ui/cli@<bad version> "reason"`.

Keep at least two owners on the `invariant-ui` org. The first npm account was locked for a while, and the project could not publish until it was recovered.

## Changing only the plugin

The plugin version is the CLI version, and Claude Code appears to decide whether an installed plugin has an update by comparing versions (this is expected from how marketplace entries carry a `version`; it has not been tested here). So **a change to a skill, the hook wiring, or the launcher that keeps the same version is likely not picked up by people who already installed it.** Today that means a plugin-only change still needs a new CLI version, with its npm publish (the new version can ship the same CLI code). This is a known cost of tying the two together. If plugin-only releases become common, give the plugin its own version and a separate pinned CLI version in the generator; that is a small change to `scripts/build-plugins.ts` and the launcher's `PINNED_VERSION`.

## What existing users do

- **Claude Code:** `claude plugin update invariant@invariant` (or the update action in `/plugin`). The launcher installs the new pinned CLI into `~/.invariant/cli/<version>/` on first use. Older versions stay on disk and can be deleted.
- **Cursor (local folder):** download the new zip and replace `~/.cursor/plugins/local/invariant`, then reload the window.
- **CLI users:** `npx` fetches the pinned or latest version; global installs run `npm install -g @invariant-ui/cli@latest`.
- **A copy of `invariant` already on a user's PATH wins over the plugin's pinned copy.** If it is older than the plugin expects, the hook runs the old one. The launcher does not check the version. Mention this in release notes when a release changes behavior the plugin depends on.

## Marketplace listings (owner actions)

Installing from this repository needs no review. Listing in a client's own directory does:

- **Anthropic's directory:** submit at claude.ai/directory/manage. It needs a paid claude.ai plan and runs a safety scan and policy review beyond `claude plugin validate`. How an update to an existing listing is submitted has not been checked here.
- **Cursor's marketplace:** submit at cursor.com/marketplace/publish. Every plugin is reviewed by hand. Cursor's own plugin behavior has not been verified in a real Cursor yet; run `docs/specifications/agent-plugins-cursor-checklist.md` first and record the result before submitting.

## Using it

```bash
npx @invariant-ui/cli setup      # nothing to install first
npm install -g @invariant-ui/cli # or install it, then run: invariant setup
```

`invariant agent init` writes an MCP entry that starts the server with `invariant mcp`. If `invariant` is not on PATH (npx use), it writes `npx -y @invariant-ui/cli mcp` instead. `--command` overrides both. The plugins do not use `agent init`: they carry their own MCP entry and hook through the launcher, and `/invariant:setup` always passes `--no-agent` so the two are never both added.
