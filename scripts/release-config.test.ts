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
    expect(Object.keys(config.packages)).toEqual(["apps/cli"])
    expect(manifest["apps/cli"]).toBe(cli.version)
    // The changelog names the package users install, not the workspace package.
    expect(config.packages["apps/cli"]["package-name"]).toBe(
      /NPM_PACKAGE = "([^"]+)"/.exec(read("apps/cli/src/version.ts"))?.[1]
    )
    expect(config["include-component-in-tag"]).toBe(false)
  })

  it("rewrites CLI_VERSION in version.ts, which the plugins and tests read", () => {
    expect(config.packages["apps/cli"]["extra-files"]).toContain("src/version.ts")
    const line = read("apps/cli/src/version.ts")
      .split("\n")
      .find((l) => l.includes("CLI_VERSION"))
    expect(line).toContain("x-release-please-version")
    expect(line).toContain(`"${cli.version}"`)
  })

  it("publishes only after a release is created, and checks first", () => {
    const workflow = read(".github/workflows/release.yml")
    expect(workflow).toContain("release_created == 'true'")
    expect(workflow.indexOf("pnpm verify")).toBeLessThan(workflow.indexOf("npm publish"))
  })
})
