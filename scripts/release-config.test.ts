import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("..", import.meta.url))
const read = (rel: string): string => readFileSync(path.join(root, rel), "utf8")

describe("release-please configuration", () => {
  const config = JSON.parse(read("release-please-config.json"))
  const manifest = JSON.parse(read(".release-please-manifest.json"))
  const cli = JSON.parse(read("apps/cli/package.json"))

  it("tracks the published CLI at the version it has", () => {
    // Tracked at the repository root: every workspace package ships in the CLI, so a change to any of them is a
    // CLI change. Tracking only apps/cli would ignore commits that touch packages/**.
    expect(Object.keys(config.packages)).toEqual(["."])
    expect(manifest["."]).toBe(cli.version)
    expect(JSON.parse(read("package.json")).version).toBe(cli.version)
    expect(config.packages["."]["extra-files"]).toContainEqual({
      type: "json",
      path: "apps/cli/package.json",
      jsonpath: "$.version"
    })
    // A plugin-only change must not cause a CLI release (and an npm publish).
    for (const excluded of ["plugins", "plugin-src", ".claude-plugin", "packages/agent-kit/src/plugin.ts"])
      expect(config.packages["."]["exclude-paths"]).toContain(excluded)
    // The changelog names the package users install, not the workspace package.
    expect(config.packages["."]["package-name"]).toBe(
      /NPM_PACKAGE = "([^"]+)"/.exec(read("apps/cli/src/version.ts"))?.[1]
    )
    expect(config["include-component-in-tag"]).toBe(false)
  })

  it("rewrites CLI_VERSION in version.ts, which the plugins and tests read", () => {
    expect(config.packages["."]["extra-files"]).toContain("apps/cli/src/version.ts")
    const line = read("apps/cli/src/version.ts")
      .split("\n")
      .find((l) => l.includes("CLI_VERSION"))
    expect(line).toContain("x-release-please-version")
    expect(line).toContain(`"${cli.version}"`)
  })

  it("opens the release pull request and pushes to it with a personal token, so CI runs on it", () => {
    const workflow = read(".github/workflows/release.yml")
    expect(workflow.match(/secrets\.RELEASE_PLEASE_TOKEN/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it("also publishes to GitHub Packages, which needs the package scope to equal the repository owner", () => {
    const workflow = read(".github/workflows/release.yml")
    expect(workflow).toContain("registry-url: https://npm.pkg.github.com")
    expect(workflow).toContain("packages: write")
    const scope = /NPM_PACKAGE = "@([^/]+)\//.exec(read("apps/cli/src/version.ts"))?.[1]
    const owner = /github\.com\/([^/]+)\//.exec(read("scripts/build-plugins.ts"))?.[1]
    expect(owner).toBe(scope)
  })

  it("publishes to npm with trusted publishing, not a stored token", () => {
    const workflow = read(".github/workflows/release.yml")
    expect(workflow).not.toContain("NPM_TOKEN")
    expect(workflow).toContain("npm publish --provenance --access public")
    expect(workflow).toMatch(/id-token: write/)
  })

  it("publishes only after a release is created, and checks first", () => {
    const workflow = read(".github/workflows/release.yml")
    expect(workflow).toContain("release_created == 'true'")
    expect(workflow.indexOf("pnpm verify")).toBeLessThan(workflow.indexOf("npm publish"))
  })
})
