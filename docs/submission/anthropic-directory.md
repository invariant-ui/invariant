# Submitting the Invariant plugin to Anthropic's directory

Submit at https://claude.ai/directory/manage (needs a paid claude.ai plan; on Team and Enterprise an Owner submits). This page holds the text to paste, the facts a reviewer will want, and the things only you can decide. Facts below were checked against the repository on 2026-11-12.

I could not see the portal's form, so the field names below are my best guess. Paste each block into whichever field fits, and tell me about any field I have not covered.

## Before you submit

- [ ] `claude plugin validate plugins/claude/invariant --strict` and `claude plugin validate . --strict` pass (they do as of the last run). The portal also runs a safety scan and a policy review that this command does not.
- [ ] The plugin installs from the marketplace: `/plugin marketplace add invariant-ui/invariant`, then `/plugin install invariant@invariant` (verified with an isolated config on 2026-11-11, before the move to `invariant-ui`; re-check once).
- [ ] The CLI the plugin installs is on npm: `npx -y @invariant-ui/cli@0.1.0 --version`. It pins 0.1.0 (see `plugin-src/plugin-version.json`).
- [ ] Decide the open items at the end of this page (license, privacy policy, support contact).

## Listing text

**Name:** Invariant

**Tagline (one line):** Make AI tools generate UI that follows your design system.

**Short description:**
Invariant reads your design system and checks every file Claude writes against it. Wrong props, hardcoded colors and broken patterns are blocked with the exact fix, before they land.

**Long description:**

> AI assistants guess at design systems. They invent props, hard-code colors and use the wrong component, and someone has to catch it in review. Invariant gives Claude the facts and enforces them.
>
> **How it works**
> 1. Run `/invariant:setup`. It finds your design system (a package you install, or code in your repo), shows you what it found in plain words, and asks you to approve it. Nothing is approved without your yes, and every approval is recorded under your name.
> 2. From then on, every file Claude writes or edits is checked against your design system's contract. If it breaks a rule, the write is blocked and Claude is told exactly what is wrong and how to fix it. Claude fixes it and tries again. Clean writes get a one-line confirmation.
> 3. `invariant enforcement report` gives you a shareable timeline: "4 writes checked, 3 violations caught, 3 fixed, 0 outstanding".
>
> **What it checks:** component props and values, colors and spacing against your design tokens, and the page layouts and interaction patterns your team has approved.
>
> **What you stay in control of:** a posture setting (block errors, warn only, or off), a baseline so existing problems don't block anyone, and ignore rules. Everything runs on your machine, with no account and no cloud service.
>
> Works with React, Vue and Angular design systems, Storybook, and design token files. Needs Node.js 20 or newer.

**Category (suggestion):** Developer tools, or Design.

**Keywords:** design-system, ai, mcp, ui, enforcement

**Links**
- Homepage: https://invariant-ui.com/
- Documentation: https://invariant-ui.com/docs/
- Source: https://github.com/invariant-ui/invariant
- Issues and support: https://github.com/invariant-ui/invariant/issues
- License: FSL-1.1-ALv2 (see the open items)

**Version:** 0.1.0

**Icon:** `plugins/claude/invariant/.claude-plugin/icon.png` (512 by 512 PNG, already referenced in `plugin.json`).

**Screenshots:** `docs/submission/enforcement-loop.png` (1280 by 900, the enforcement loop: three blocked writes with their fixes, then a clean pass and the report). `docs/demo/enforcement-loop.gif` is the animated version. If the portal wants more, the useful second image is the chat itself showing a blocked write, which needs a screenshot from a real session (I cannot produce one from here).

## What it installs

| Component | What it does |
| --- | --- |
| Skills (6) | `setup` (the guided setup), plus `invariant-build-ui`, `invariant-component-discovery`, `invariant-layout-composition`, `invariant-design-review` and `invariant-refactor-ui`. They are generic: they name no component or pattern of any customer and read what they need through the MCP tools. |
| MCP server `invariant` | Read-only tools that describe the design system (components, props, tokens, patterns) and validate code snippets against it. It writes nothing and runs no project code. |
| Hooks | `PreToolUse` and `PostToolUse` on `Write` and `Edit`, to check each file written. `SessionStart`, to install the command line tool early in projects that use Invariant. All three run one script, `bin/invariant-launch.mjs`. |
| Launcher | A single dependency-free Node script that finds or installs the Invariant command line tool and runs it. |

## What a reviewer should know (data, network, permissions)

| Question | Answer |
| --- | --- |
| Does it send data anywhere? | No. The command line tool contains no network calls and no telemetry (checked by searching the shipped source). Code and contract content stay on the machine. |
| What network access does it use? | One: the first time it runs, the launcher runs `npm install --ignore-scripts` for the pinned `@invariant-ui/cli` from the npm registry into `~/.invariant/cli/<version>/`. If an `invariant` command is already on the user's PATH, that one is used and nothing is installed. |
| What does it write? | Under `~/.invariant/` (the installed tool), and in the project: the files the user approves during setup (`invariant.config.json`, the `invariant/` contract folder, pattern and decision files, a baseline, an optional CI workflow), and a local log `.invariant/enforcement.jsonl` (file paths and findings, never file contents) that ignores itself in git. |
| Does it run project code? | No. Analysis is static. The optional browser check (`invariant browser run`) is a separate command the user starts themselves, and nothing in the plugin runs it. |
| Do the hooks run outside Claude's sandbox? | Yes, as all plugin hooks do. They run the launcher, which runs the command line tool. In a project without an `invariant.config.json` the hook exits at once without loading anything. |
| Can a hook block the user's work? | Only when the project has opted in and the write has error-level findings against an approved contract. It fails open: if the tool is missing, crashes or is still installing, the write goes ahead and one line goes to stderr. The posture can be set to `warn` or `off`. |
| Does it modify Claude's settings or the user's other plugins? | No. It adds no entries to `.claude/settings.json` (the plugin's hooks and MCP server come from the plugin itself), and the setup skill passes `--no-agent` so no second MCP entry is created. |
| Can anything in a customer's source act as instructions to Claude? | Names and descriptions come from the customer's own code and documents. The MCP server marks them as untrusted content, and generated skills contain no text from a contract. |

## How to test it (for a reviewer)

Needs Node.js 20 or newer and network access for the first install. This uses a fixture from the repository, so no real design system is needed.

```bash
git clone https://github.com/invariant-ui/invariant.git
cp -R invariant/fixtures/storybook/acme-ui /tmp/invariant-review
cd /tmp/invariant-review
npx -y @invariant-ui/cli init
npx -y @invariant-ui/cli compile
claude --plugin-dir /path/to/invariant/plugins/claude/invariant
```

Then ask Claude: *Create the file `src/Danger.tsx` that renders `<Button variant="danger">Delete</Button>`, with `Button` imported from `@acme/ui`.*

Expected: the write is refused with a message like `invariant blocked src/Danger.tsx: 1 error against the @acme/ui contract` and `Button.variant is "danger", which is not one of "primary", "secondary", "ghost"`, followed by the fix. The file is not created. Asking for `variant="primary"` instead writes the file and shows `invariant ✓ ... follows the @acme/ui contract`.

The same loop, scripted, is `pnpm demo` in a checkout of the repository; its output is the screenshot above. To see the guided setup, run `/invariant:setup` in the same project.

## Limitations to be upfront about

- Write-time blocking works in Claude Code only. The Cursor version of the plugin reports after the edit and does not block.
- Analysis is static: it reads what is written in code. It does not prove runtime behavior, and it says which checks it could not establish.
- The pattern and layout rules are checked for React. Props, tokens and colors are checked for React, Vue, Angular and HTML.
- Needs Node.js 20 or newer, and a first-run network install unless `invariant` is already on the PATH.
- The plugin and the command line tool have separate versions. The plugin pins the tool version it installs.

## Open items only you can decide

1. **License.** The code is under FSL-1.1-ALv2, the Functional Source License. It is source-available, not an OSI-approved open source license, and each release becomes Apache 2.0 two years after it is published. I do not know whether the directory's policy accepts that. Read the directory's requirements before submitting; if it requires an OSI license, that is a decision about the project, not the plugin.
2. **Privacy policy.** The directory may require a privacy policy URL. None exists. The statements in the table above are accurate, but they are not a policy a lawyer has looked at. If one is required, tell me and I will draft it from those facts for you to review.
3. **Support contact.** The listing text uses the GitHub issues page. If the portal wants an email address, that is yours to choose.
4. **Publisher identity.** The plugin lists the author as "Invariant" with the GitHub URL. If the portal needs a legal or personal name, use whichever you want on a public listing.
5. **Re-submission.** How an update to a listed plugin is submitted has not been checked. The release guide (`docs/releasing.md`) says so too.
