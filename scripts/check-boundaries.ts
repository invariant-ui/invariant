import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export interface WorkspacePackage {
  name: string
  dependencies: string[]
  imports: string[]
}

/**
 * Allowed workspace dependencies per package. A new workspace package must be registered here
 * (with the rule from docs/architecture/system-architecture.md) before it can pass CI.
 */
export const ALLOWED: Record<string, readonly string[]> = {
  "@invariant/shared": [],
  "@invariant/diagnostics": [],
  "@invariant/contract": ["@invariant/shared", "@invariant/diagnostics"],
  "@invariant/compiler-ir": ["@invariant/shared", "@invariant/diagnostics", "@invariant/contract"],
  "@invariant/compiler-core": [
    "@invariant/shared",
    "@invariant/diagnostics",
    "@invariant/contract",
    "@invariant/compiler-ir"
  ],
  "@invariant/artifact-generator": ["@invariant/shared"],
  "@invariant/compiler-tokens": [
    "@invariant/shared",
    "@invariant/diagnostics",
    "@invariant/contract",
    "@invariant/compiler-ir",
    "@invariant/compiler-core"
  ],
  "@invariant/compiler-storybook": [
    "@invariant/shared",
    "@invariant/diagnostics",
    "@invariant/contract",
    "@invariant/compiler-ir",
    "@invariant/compiler-core"
  ],
  "@invariant/compiler-vue": [
    "@invariant/shared",
    "@invariant/diagnostics",
    "@invariant/contract",
    "@invariant/compiler-ir",
    "@invariant/compiler-core"
  ],
  "@invariant/compiler-angular": [
    "@invariant/shared",
    "@invariant/diagnostics",
    "@invariant/contract",
    "@invariant/compiler-ir",
    "@invariant/compiler-core"
  ],
  "@invariant/reconciliation": [
    "@invariant/shared",
    "@invariant/diagnostics",
    "@invariant/contract",
    "@invariant/compiler-ir"
  ],
  "@invariant/cli": [
    "@invariant/shared",
    "@invariant/diagnostics",
    "@invariant/contract",
    "@invariant/compiler-ir",
    "@invariant/compiler-core",
    "@invariant/artifact-generator",
    "@invariant/compiler-tokens",
    "@invariant/compiler-react",
    "@invariant/compiler-storybook",
    "@invariant/compiler-vue",
    "@invariant/compiler-angular",
    "@invariant/reconciliation",
    "@invariant/semantic-engine",
    "@invariant/mcp",
    "@invariant/agent-kit",
    "@invariant/validation",
    "@invariant/governance",
    "@invariant/contract-query"
  ],
  "@invariant/contract-query": ["@invariant/shared", "@invariant/contract"],
  "@invariant/validation": ["@invariant/shared", "@invariant/contract", "@invariant/contract-query"],
  "@invariant/governance": [
    "@invariant/shared",
    "@invariant/diagnostics",
    "@invariant/contract",
    "@invariant/validation"
  ],
  "@invariant/mcp": [
    "@invariant/shared",
    "@invariant/contract",
    "@invariant/contract-query",
    "@invariant/validation"
  ],
  "@invariant/agent-kit": ["@invariant/shared", "@invariant/contract"],
  "@invariant/semantic-engine": [
    "@invariant/shared",
    "@invariant/diagnostics",
    "@invariant/contract",
    "@invariant/compiler-ir"
  ],
  "@invariant/compiler-react": [
    "@invariant/shared",
    "@invariant/diagnostics",
    "@invariant/contract",
    "@invariant/compiler-ir",
    "@invariant/compiler-core"
  ]
}

export function checkBoundaries(packages: readonly WorkspacePackage[], allowed = ALLOWED): string[] {
  const errors: string[] = []
  for (const pkg of packages) {
    const rule = allowed[pkg.name]
    if (!rule) {
      errors.push(`${pkg.name}: no boundary rule registered in scripts/check-boundaries.ts`)
      continue
    }
    const declared = new Set(pkg.dependencies)
    for (const dep of declared) {
      if (dep !== pkg.name && !rule.includes(dep)) errors.push(`${pkg.name}: may not depend on ${dep}`)
    }
    for (const imported of new Set(pkg.imports)) {
      if (imported === pkg.name) continue
      if (!rule.includes(imported)) errors.push(`${pkg.name}: may not import ${imported}`)
      else if (!declared.has(imported))
        errors.push(`${pkg.name}: imports ${imported} but does not declare it`)
    }
  }
  return errors
}

export function loadWorkspace(root: string): WorkspacePackage[] {
  const packages: WorkspacePackage[] = []
  for (const group of ["apps", "packages"]) {
    const groupDir = join(root, group)
    if (!isDirectory(groupDir)) continue
    for (const entry of readdirSync(groupDir)) {
      const dir = join(groupDir, entry)
      if (!isDirectory(dir)) continue
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<
        string,
        Record<string, string> | string
      >
      const deps = ["dependencies", "devDependencies", "peerDependencies"].flatMap((field) =>
        Object.keys((manifest[field] as Record<string, string> | undefined) ?? {})
      )
      packages.push({
        name: String(manifest.name),
        dependencies: deps.filter((d) => d.startsWith("@invariant/")),
        imports: sourceFiles(dir).flatMap(workspaceImports)
      })
    }
  }
  return packages
}

function sourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const sub of ["src", "test"]) {
    const base = join(dir, sub)
    if (!isDirectory(base)) continue
    for (const entry of readdirSync(base, { recursive: true, encoding: "utf8" })) {
      if (/\.(ts|tsx|mts)$/.test(entry)) files.push(join(base, entry))
    }
  }
  return files
}

function workspaceImports(file: string): string[] {
  const text = readFileSync(file, "utf8")
  return [...text.matchAll(/from\s+["'](@invariant\/[^"'/]+)/g)].map((m) => m[1] as string)
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url))
  const errors = checkBoundaries(loadWorkspace(root))
  if (errors.length > 0) {
    console.error(`Package boundary violations:\n${errors.map((e) => `  - ${e}`).join("\n")}`)
    process.exit(1)
  }
  console.log("Package boundaries OK")
}
