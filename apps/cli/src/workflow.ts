import { CLI_VERSION, NPM_PACKAGE } from "./version.js"

export const WORKFLOW_PATH = ".github/workflows/invariant.yml"

/**
 * Steps that install a project's dependencies, for a project that gets its contract from a package. The package manager
 * is the one the lockfile says. Returns steps already indented for the workflow.
 */
export function installStepsFor(has: (file: string) => boolean): string[] {
  if (has("pnpm-lock.yaml"))
    return ["      - uses: pnpm/action-setup@v4", "      - run: pnpm install --frozen-lockfile"]
  if (has("yarn.lock")) return ["      - run: yarn install --frozen-lockfile"]
  if (has("package-lock.json")) return ["      - run: npm ci"]
  return ["      - run: npm install"]
}

/**
 * The GitHub Actions job `setup` offers to add. It runs on every pull request commit, pins the exact version it was
 * written for so a later release cannot change what CI does, and needs only Node: npx fetches the package. Paths are
 * quoted, since they come from the project's folder names.
 */
export function workflowYaml(paths: readonly string[], installSteps: readonly string[] = []): string {
  const targets = (paths.length > 0 ? paths : ["src"]).map((p) => `'${p.replace(/'/g, "''")}'`).join(" ")
  const run = `npx ${NPM_PACKAGE}@${CLI_VERSION}`
  return `# Added by \`invariant setup\`. Checks every commit on a pull request against your design system contract.
name: Invariant
on:
  pull_request:
    types: [opened, synchronize, reopened]
  push:
    branches: [main]
permissions:
  contents: read
concurrency:
  group: invariant-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  invariant:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
${installSteps.length > 0 ? `${installSteps.join("\n")}\n` : ""}      # Fails if the committed contract (the invariant/ folder) is stale or was edited by hand.
      - name: Verify the contract is current
        run: ${run} verify --fresh
      # Annotates the pull request. Violations listed in invariant.baseline.json are hidden; new ones fail the check.
      - name: Validate code against the contract
        run: ${run} validate ${targets} --format github
`
}
