import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { run } from "@invariant/cli"
import { FIXED_CLOCK } from "@invariant/compiler-core/testing"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("..", import.meta.url))
const made: string[] = []
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), "invariant-consumer-"))
  made.push(d)
  return d
}

async function cli(cwd: string, argv: string[]) {
  let out = ""
  let err = ""
  const code = await run(argv, {
    cwd,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    clock: FIXED_CLOCK,
    env: {}
  })
  return { code, out, err }
}

/** A design system repository, compiled, as it would be before publishing the package. */
let library = ""
beforeAll(async () => {
  library = tmp()
  cpSync(path.join(root, "fixtures/storybook/acme-ui"), library, {
    recursive: true,
    filter: (s) => !s.includes("storybook-static")
  })
  expect((await cli(library, ["init"])).code).toBe(0)
  expect((await cli(library, ["compile"])).code).toBe(0)
})

/** An application that installed that package. The library ships its `invariant/` folder. */
function app(pkg = "@acme/ui"): string {
  const dir = tmp()
  cpSync(path.join(root, "fixtures/pattern-discovery/app"), path.join(dir, "app"), { recursive: true })
  cpSync(path.join(library, "invariant"), path.join(dir, "node_modules", pkg, "invariant"), {
    recursive: true
  })
  writeFileSync(path.join(dir, "package-lock.json"), "{}")
  return dir
}
const json = (dir: string, file: string) => JSON.parse(readFileSync(path.join(dir, file), "utf8"))

describe("an application that uses a design system from a package", () => {
  it("setup uses the shipped contract instead of compiling an empty one", async () => {
    const dir = app()
    const r = await cli(dir, ["setup", "--yes", "--as", "ana", "--no-agent", "--ci"])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(
      /no design system source here\. Using the contract shipped in node_modules\/@acme\/ui\/invariant/
    )
    expect(r.out).toMatch(/compiled with your own patterns on top: 14 components/)
    expect(json(dir, "invariant.config.json")).toEqual({
      name: expect.any(String),
      sources: [],
      extends: { contract: "node_modules/@acme/ui/invariant" }
    })
    const contract = json(dir, "invariant/invariant.contract.json")
    expect(contract.components).toHaveLength(14)
    expect(contract.patterns.length).toBeGreaterThan(0)
    expect(json(dir, "invariant/invariant.manifest.json").sources[0]).toMatchObject({
      id: "extends",
      type: "contract"
    })
  })

  it("layers the app's own patterns on the library's contract, and the result verifies", async () => {
    const dir = app()
    await cli(dir, ["setup", "--yes", "--as", "ana", "--no-agent", "--no-ci"])
    const base = json(dir, "node_modules/@acme/ui/invariant/invariant.contract.json")
    const layered = json(dir, "invariant/invariant.contract.json")
    expect(layered.components.map((x: { id: string }) => x.id)).toEqual(
      base.components.map((x: { id: string }) => x.id)
    )
    expect(layered.integrity.contentHash).not.toBe(base.integrity.contentHash)
    const verify = await cli(dir, ["verify"])
    expect(verify.code).toBe(0)
    expect((await cli(dir, ["verify", "--fresh"])).code).toBe(0)
    const patterns = await cli(dir, ["patterns", "list", "--json"])
    expect(JSON.parse(patterns.out).length).toBeGreaterThan(0)
  })

  it("validates app code against the layered contract with no --dir", async () => {
    const dir = app()
    await cli(dir, ["setup", "--yes", "--as", "ana", "--no-agent", "--no-ci"])
    writeFileSync(
      path.join(dir, "app/pages/Bad2.tsx"),
      'import { Card } from "@acme/ui"\nexport const B = () => <Card tone="loud" />\n'
    )
    const r = await cli(dir, ["validate", "app/pages/Bad2.tsx", "--fail-on", "warning", "--no-baseline"])
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/Card does not declare a prop "tone"/)
  })

  it("reports a new library version as a stale contract", async () => {
    const dir = app()
    await cli(dir, ["setup", "--yes", "--as", "ana", "--no-agent", "--no-ci"])
    // The library ships a release with one more component.
    const next = tmp()
    cpSync(library, next, { recursive: true })
    writeFileSync(path.join(next, "src/Extra.tsx"), "export function Extra() { return <div /> }\n")
    writeFileSync(
      path.join(next, "src/index.ts"),
      `${readFileSync(path.join(next, "src/index.ts"), "utf8")}export { Extra } from "./Extra"\n`
    )
    await cli(next, ["compile"])
    cpSync(path.join(next, "invariant"), path.join(dir, "node_modules/@acme/ui/invariant"), {
      recursive: true
    })
    const stale = await cli(dir, ["verify", "--fresh"])
    expect(stale.code).toBe(1)
    expect(stale.out).toMatch(/verify\.stale/)
    expect((await cli(dir, ["compile"])).code).toBe(0)
    expect(json(dir, "invariant/invariant.contract.json").components).toHaveLength(15)
    expect((await cli(dir, ["verify", "--fresh"])).code).toBe(0)
  })

  it("makes CI install dependencies first, using the lockfile's package manager", async () => {
    const dir = app()
    await cli(dir, ["setup", "--yes", "--as", "ana", "--no-agent", "--ci"])
    const yaml = readFileSync(path.join(dir, ".github/workflows/invariant.yml"), "utf8")
    expect(yaml).toMatch(/- run: npm ci\n\s+# Fails if the committed contract/)
    const pnpm = app()
    rmSync(path.join(pnpm, "package-lock.json"))
    writeFileSync(path.join(pnpm, "pnpm-lock.yaml"), "")
    await cli(pnpm, ["setup", "--yes", "--as", "ana", "--no-agent", "--ci"])
    expect(readFileSync(path.join(pnpm, ".github/workflows/invariant.yml"), "utf8")).toMatch(
      /pnpm\/action-setup@v4\n\s+- run: pnpm install --frozen-lockfile/
    )
  })

  it("does not skip an app folder just because the library has a file with the same path", async () => {
    const dir = app()
    mkdirSync(path.join(dir, "src"))
    for (const n of ["A", "B", "C"])
      writeFileSync(
        path.join(dir, `src/${n}.tsx`),
        `import { Button } from "@acme/ui"\nexport const ${n} = () => <Button>x</Button>\n`
      )
    const r = await cli(dir, ["setup", "--yes", "--as", "ana", "--no-agent", "--no-ci"])
    expect(r.out).not.toMatch(/skipped src/)
  })
})

describe("setup without a contract to use", () => {
  it("stops, and leaves no empty contract or config behind", async () => {
    const dir = tmp()
    mkdirSync(path.join(dir, "src"))
    writeFileSync(path.join(dir, "src/A.tsx"), "export const A = () => <div />\n")
    const r = await cli(dir, ["setup", "--yes", "--as", "ana"])
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/no design system source found here, and no installed package ships a contract/)
    expect(existsSync(path.join(dir, "invariant"))).toBe(false)
    expect(existsSync(path.join(dir, "invariant.config.json"))).toBe(false)
  })

  it("asks which contract when several are installed, and --contract chooses", async () => {
    const dir = app("@acme/ui")
    cpSync(path.join(library, "invariant"), path.join(dir, "node_modules/other-ds/invariant"), {
      recursive: true
    })
    const r = await cli(dir, ["setup", "--yes", "--as", "ana", "--no-agent", "--no-ci"])
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/several installed packages ship a contract/)
    expect(r.err).toContain("node_modules/@acme/ui/invariant")
    expect(r.err).toContain("node_modules/other-ds/invariant")
    const ok = await cli(dir, [
      "setup",
      "--yes",
      "--as",
      "ana",
      "--no-agent",
      "--no-ci",
      "--contract",
      "node_modules/other-ds/invariant"
    ])
    expect(ok.code).toBe(0)
    expect(json(dir, "invariant.config.json").extends.contract).toBe("node_modules/other-ds/invariant")
  })

  it("compile refuses a config with no sources and no extends, instead of writing an empty contract", async () => {
    const dir = tmp()
    writeFileSync(path.join(dir, "invariant.config.json"), JSON.stringify({ name: "X", sources: [] }))
    const r = await cli(dir, ["compile"])
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/no sources, so there is nothing to compile/)
    expect(existsSync(path.join(dir, "invariant"))).toBe(false)
  })

  it("compile says so when the extended contract is not installed", async () => {
    const dir = tmp()
    writeFileSync(
      path.join(dir, "invariant.config.json"),
      JSON.stringify({ name: "X", sources: [], extends: { contract: "node_modules/@acme/ui/invariant" } })
    )
    const r = await cli(dir, ["compile"])
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/Install the design system package/)
  })
})

describe("writing next to a contract read from node_modules", () => {
  it("discover and browser results go to the project's own folder, never node_modules", async () => {
    const dir = app()
    const shipped = "node_modules/@acme/ui/invariant"
    const r = await cli(dir, ["discover", "app", "--dir", shipped])
    expect(r.code).toBe(0)
    expect(existsSync(path.join(dir, "invariant/invariant.candidates.json"))).toBe(true)
    expect(existsSync(path.join(dir, shipped, "invariant.candidates.json"))).toBe(false)
    const list = await cli(dir, ["candidates", "list", "--dir", shipped, "--json"])
    expect(list.code).toBe(0)
  })
})
