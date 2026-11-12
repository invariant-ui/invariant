# Releasing

There are two things to release, and they have **separate versions**:

- **The CLI** (`@invariant-ui/cli` on npm). Its version is `CLI_VERSION` in `apps/cli/src/version.ts`, kept equal to `apps/cli/package.json` and the root `package.json` by release-please.
- **The plugins** for Claude Code and Cursor. Their version is `version` in `plugin-src/plugin-version.json`. The same file records `cliVersion`, the CLI version the plugins install, and a hash of the plugins' content.

A skill or hook fix is a plugin release and needs no npm publish. A CLI change is a CLI release and does not touch the plugins, which keep installing the CLI version they pin.

| Artifact | Where it lives | How users get it |
| --- | --- | --- |
| CLI, `@invariant-ui/cli` (bin `invariant`) | npm, and GitHub Packages, org `invariant-ui` | `npx @invariant-ui/cli setup`, or `npm install -g @invariant-ui/cli` |
| Claude Code plugin | `plugins/claude/invariant/` in this repository, listed by `.claude-plugin/marketplace.json` | `/plugin marketplace add invariant-ui/invariant`, then `/plugin install invariant@invariant` |
| Plugin zips | `site/downloads/invariant-claude-code.zip` and `invariant-cursor.zip`, served by the website | Download from the docs page "Install the plugin" |
| Cursor plugin | `plugins/cursor/invariant/` and the zip above | Unzip into `~/.cursor/plugins/local/invariant` (preview) |

The package name is set in one place, `NPM_PACKAGE` in `apps/cli/src/version.ts`. A test keeps the launcher's copy equal to it. (`invariant` on npm is an unrelated package.)

## Releasing the CLI (release-please)

Releases are driven by conventional commit messages (`feat:`, `fix:`, `feat!:` or a `BREAKING CHANGE:` footer) and `.github/workflows/release.yml`. Commits of other kinds (`docs:`, `chore:`, `test:`, `ci:`) do not trigger a release. Changes that only touch the plugins or the website (`plugins/`, `plugin-src/`, `.claude-plugin/`, `site/`, `docs/`, the plugin text in `packages/agent-kit/src/plugin.ts`, and the plugin generator and its test) are excluded, so a plugin fix never causes a CLI release. Every other workspace package ships in the CLI, so a change to any of them counts.

1. **Every push to `main`** runs release-please, which keeps a single open pull request titled `chore(main): release <version>`. It bumps the version in the root `package.json`, `apps/cli/package.json` and `apps/cli/src/version.ts`, and writes `CHANGELOG.md` from the commits. Before 1.0, a breaking change bumps the minor version, and a `feat` also bumps the minor.
2. **A `prepare` job then regenerates what depends on that version** and pushes it to the pull request: the golden files (`UPDATE_GOLDEN=1`) and the pinned `@invariant-ui/cli@<version>` examples on the website. Review the diff: apart from the changelog, only versions and hashes should change.
3. **You merge the release pull request.** release-please tags `v<version>` and creates the GitHub release.
4. **The `publish` job** (same workflow) checks out the merged commit, runs `pnpm verify`, checks the tag equals the package version, builds `dist-npm/`, and runs `npm publish --provenance --access public`. A second job, `publish-github`, then publishes the same package to GitHub Packages, so it shows in the repository's Packages section. It is separate so it can be re-run alone.
5. **Check it:** `npx -y @invariant-ui/cli@<version> --version` (wait a few minutes if it is a 404).

Setup that only an owner can do:
- **Secret `RELEASE_PLEASE_TOKEN`:** a fine-grained personal access token (github.com/settings/personal-access-tokens), limited to this repository, with **Contents: Read and write** and **Pull requests: Read and write**. Add it under the repository's Settings, Secrets and variables, Actions. release-please uses it to open the release pull request, and the `prepare` job uses it to push to that pull request. It is a personal token because the org setting "Allow GitHub Actions to create and approve pull requests" is disabled for this org and cannot be turned on; a token also makes CI run on the release pull request (commits pushed with the default `GITHUB_TOKEN` trigger no other workflow). The token stops working when it expires or when its owner leaves the organization: put its expiry date in a calendar, and re-create it before then.
- **npm trusted publishing:** configured once on npmjs.com, on the `@invariant-ui/cli` package's settings page, under Trusted Publisher, GitHub Actions: organization `invariant-ui`, repository `invariant`, workflow filename `release.yml`, environment blank. The workflow then publishes with no npm token, and there is nothing to expire. If the publish step fails with an authentication error, check that those four values match exactly and that the Node version in `.nvmrc` ships npm 11.5.1 or newer.
- A merge of the release pull request is the approval. Nothing publishes until a person merges it.

The `publish` job re-runs `pnpm verify` after the merge, before anything is published, so a bad release stops there.

## Releasing the plugins

A plugin release is a commit to `main`; nothing is published to a registry. GitHub serves the marketplace straight from the repository, and the `Deploy site` workflow publishes the zips whenever a push touches `site/`.

1. **Change a skill, hook or the launcher** (`packages/agent-kit/src/plugin.ts`, `plugin-src/invariant-launch.mjs`, or the generator `scripts/build-plugins.ts`).
2. **Record the release:** `pnpm plugin:bump patch` (or `minor`, `major`). It bumps `plugin-src/plugin-version.json`, regenerates `plugins/`, `.claude-plugin/marketplace.json` and the zips in `site/downloads/`, and records the content hash. `pnpm build:plugins` regenerates without bumping.
3. **`pnpm verify`.** A test compares the hash of what the plugins now contain with the recorded one and fails if the content changed but the version did not. This matters because Claude Code decides whether an installed plugin has an update by comparing versions (expected from how marketplace entries carry a `version`; not tested here), so an unbumped change would never reach people who already installed it.
4. **Validate the Claude plugin:** `claude plugin validate plugins/claude/invariant --strict` and `claude plugin validate . --strict`. The plugin test runs these too when `claude` is installed.
5. **Commit and push to `main`**, for example `fix(plugin): ...`, and open it as a pull request if you want review.
6. **Check an install the way a user does**, without touching your own Claude settings:

   ```bash
   export CLAUDE_CONFIG_DIR=$(mktemp -d)
   cd $(mktemp -d)
   claude plugin marketplace add invariant-ui/invariant
   claude plugin install invariant@invariant --scope project
   claude plugin list        # invariant <version>, enabled
   ```

### Raising the CLI version the plugins install

The launcher in a plugin installs exactly `cliVersion` from npm on first use. Raise it only when the plugins need something from a newer CLI, and **only after that CLI version is published and visible on npm**: if a plugin version reaches users before the CLI version it pins is on npm, the install fails, the hook then lets every write through unchecked (it fails open, by design), and the MCP server does not start. Nothing tells the person except a line on stderr.

1. Release the CLI first (above) and confirm `npx -y @invariant-ui/cli@<new version> --version` works.
2. `pnpm plugin:bump patch --cli <new version>`, then the steps above.

A test refuses a `cliVersion` newer than `CLI_VERSION` in the checkout, which catches the common mistake of pinning a version that has not been released.

## Manual CLI release (fallback)

Use this if the automation is unavailable.

1. **Pick the version** (semantic versioning). Edit the version in the root `package.json`, `apps/cli/package.json`, `apps/cli/src/version.ts` and `.release-please-manifest.json`, keeping them equal.
2. **Update the golden files:** `UPDATE_GOLDEN=1 pnpm test`, then review `git diff`. Only versions and hashes should change.
3. **Update the pinned examples on the website** (`grep -rn "cli@" site`).
4. **`pnpm verify`.** It must pass before anything is published.
5. **Check the npm package:** `pnpm build:npm`, then `cd dist-npm && npm pack --dry-run`. `scripts/npm-package.e2e.test.ts` already runs the assembled package as a real process.
6. **Publish to npm** (below), then confirm it is live from a clean directory.
7. **Commit, push, and tag** with `git tag v<version>`. Do not push a tag while release-please is active, or it will try to create the same release.

## Publishing to npm by hand

Log in as an owner of the `invariant-ui` org (`npm login`). The account has two-factor authentication, so publishing needs a current code:

```bash
cd dist-npm
npm publish --access public --otp=<6-digit code>
```

`--access public` is required: scoped packages default to private.

Publishing cannot be undone. A version number, once used, is never reusable, even if the package is unpublished. If a release is wrong, publish a new version and run `npm deprecate @invariant-ui/cli@<bad version> "reason"`.

Keep at least two owners on the `invariant-ui` org. The first npm account was locked for a while, and the project could not publish until it was recovered.

## What existing users do

- **Claude Code:** `claude plugin update invariant@invariant` (or the update action in `/plugin`). When the plugin pins a newer CLI, the launcher installs it into `~/.invariant/cli/<version>/` on first use. Older versions stay on disk and can be deleted.
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
