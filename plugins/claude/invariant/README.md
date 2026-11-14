# Invariant for Claude Code

Make AI tools generate UI that follows your design system. Checks every file the agent writes against your design system's contract.

Install:

```
/plugin install invariant --marketplace invariant-ui/cli
```

After installing, ask your AI tool to run `/invariant:setup` (or say "set up Invariant"). It finds your design system, shows you what it found, asks you to approve it, and turns on the checks. Nothing is approved without your yes.

Needs Node.js 20 or newer. The first time it runs, it installs the Invariant command line tool into `~/.invariant/`. If you already have `invariant` on your PATH, that one is used.

Source and documentation: https://github.com/invariant-ui/cli
