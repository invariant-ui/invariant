import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs"
import { dirname, join, posix, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Assembles the one package that gets published. The workspace is many packages so that boundaries are checked
 * (see check-boundaries.ts); users get a single install. Each package's compiled output is copied under
 * `dist/<name>/` and every `@invariant/<name>` import is rewritten to a relative path. No bundler is involved,
 * so the published code is the compiled code, file for file.
 */

/** The name on npm, read from the CLI so the two cannot drift. `invariant` is taken by an unrelated package. */
export const NPM_NAME = /NPM_PACKAGE = "([^"]+)"/.exec(
  readFileSync(new URL("../apps/cli/src/version.ts", import.meta.url), "utf8")
)?.[1] as string
export const BIN = "invariant"

const root = fileURLToPath(new URL("..", import.meta.url))

interface Pkg {
  name: string
  dir: string
  deps: Record<string, string>
}

function workspace(): Pkg[] {
  const out: Pkg[] = []
  for (const group of ["packages", "apps"])
    for (const entry of readdirSync(join(root, group))) {
      const file = join(root, group, entry, "package.json")
      if (!existsSync(file)) continue
      const json = JSON.parse(readFileSync(file, "utf8")) as {
        name: string
        dependencies?: Record<string, string>
      }
      out.push({
        name: json.name.replace(/^@invariant\//, ""),
        dir: join(root, group, entry),
        deps: json.dependencies ?? {}
      })
    }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1))
}

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* files(full)
    else yield full
  }
}

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])@invariant\/([a-z-]+)((?:\/[^"']*)?)\2/g

/** `@invariant/compiler-core` becomes `../compiler-core/index.js`; a subpath keeps its own `index.js`. */
function rewrite(code: string, fileInDist: string, names: ReadonlySet<string>): string {
  return code.replace(SPECIFIER, (_all, lead: string, quote: string, name: string, sub: string) => {
    if (!names.has(name))
      throw new Error(`${fileInDist} imports @invariant/${name}, which is not a workspace package`)
    const target = posix.join(name, sub === "" ? "index.js" : `${sub.slice(1)}/index.js`)
    let rel = posix.relative(posix.dirname(fileInDist.split(sep).join("/")), target)
    if (!rel.startsWith(".")) rel = `./${rel}`
    return `${lead}${quote}${rel}${quote}`
  })
}

export interface BuildResult {
  out: string
  files: number
  dependencies: Record<string, string>
}

export function buildNpmPackage(out = join(root, "dist-npm")): BuildResult {
  const pkgs = workspace()
  const names = new Set(pkgs.map((p) => p.name))
  rmSync(out, { recursive: true, force: true })
  let count = 0
  const external: Record<string, string> = {}
  for (const p of pkgs) {
    const dist = join(p.dir, "dist")
    if (!existsSync(dist)) throw new Error(`${p.name} has no dist. Run tsc -b first.`)
    for (const f of files(dist)) {
      if (!f.endsWith(".js")) continue
      const inDist = join(p.name, relative(dist, f))
      const target = join(out, "dist", inDist)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, rewrite(readFileSync(f, "utf8"), inDist, names))
      count++
    }
    for (const [dep, version] of Object.entries(p.deps)) {
      if (dep.startsWith("@invariant/")) continue
      if (external[dep] && external[dep] !== version)
        throw new Error(`${dep} has two versions: ${external[dep]} and ${version}`)
      external[dep] = version
    }
  }

  const cli = join(out, "dist", "cli", "main.js")
  if (!existsSync(cli)) throw new Error("the CLI entry point was not built")
  chmodSync(cli, 0o755)

  const cliJson = JSON.parse(readFileSync(join(root, "apps/cli/package.json"), "utf8")) as { version: string }
  const dependencies = Object.fromEntries(Object.entries(external).sort(([a], [b]) => (a < b ? -1 : 1)))
  const manifest = {
    name: NPM_NAME,
    version: cliJson.version,
    description:
      "Compile your design system, UX patterns and page layouts into a contract AI agents can read, and check code against it.",
    keywords: ["design-system", "ai-agents", "mcp", "design-tokens", "storybook", "linting", "ux-patterns"],
    license: "SEE LICENSE IN LICENSE",
    homepage: "https://mcarlucci.github.io/invariant/",
    repository: { type: "git", url: "git+https://github.com/mcarlucci/invariant.git" },
    bugs: { url: "https://github.com/mcarlucci/invariant/issues" },
    type: "module",
    bin: { [BIN]: "dist/cli/main.js" },
    files: ["dist", "README.md", "LICENSE"],
    engines: { node: ">=20" },
    dependencies
  }
  writeFileSync(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)

  // The README's images and links are relative to the repository, so point them at it.
  const base = "https://github.com/mcarlucci/invariant/blob/main/"
  const raw = "https://raw.githubusercontent.com/mcarlucci/invariant/main/"
  const readme = readFileSync(join(root, "README.md"), "utf8")
    .replace(/(srcset|src)="(site\/assets\/[^"]+)"/g, `$1="${raw}$2"`)
    .replace(/\]\((docs\/[^)]+|LICENSE)\)/g, `](${base}$1)`)
    .replace(/href="(docs\/[^"]+)"/g, `href="${base}$1"`)
  writeFileSync(join(out, "README.md"), readme)
  copyFileSync(join(root, "LICENSE"), join(out, "LICENSE"))
  return { out, files: count, dependencies }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = buildNpmPackage()
  process.stdout.write(
    `${r.files} files into ${relative(process.cwd(), r.out) || r.out}\ndependencies: ${Object.entries(
      r.dependencies
    )
      .map(([k, v]) => `${k}@${v}`)
      .join(", ")}\n`
  )
}
