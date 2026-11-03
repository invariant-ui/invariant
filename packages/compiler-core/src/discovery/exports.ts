import ts from "typescript"
import type { ExportInfo } from "./schema.js"
import { cmp, type DiscoveryEnv, fileExists, hashText, posix, readBounded } from "./support.js"

export interface ExportListing {
  exports: ExportInfo[]
  complete: boolean
  parsedFiles: Array<{ path: string; contentHash: string }>
}

const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".vue"]
const PARSEABLE = /\.(?:[cm]?[jt]sx?)$/

/**
 * Enumerates the names a module exports, syntactically (no type checking, no execution). Follows
 * relative `export *` and `export {…} from` chains. Whether an export is a component is NOT decided here.
 */
export async function listExports(env: DiscoveryEnv, entryFile: string): Promise<ExportListing> {
  const state = {
    env,
    byName: new Map<string, ExportInfo>(),
    parsed: new Map<string, string>(),
    complete: true,
    visiting: new Set<string>()
  }
  await visitModule(state, entryFile)
  return {
    exports: [...state.byName.values()].sort((a, b) => cmp(a.name, b.name)),
    complete: state.complete,
    parsedFiles: [...state.parsed]
      .map(([path, contentHash]) => ({ path, contentHash }))
      .sort((a, b) => cmp(a.path, b.path))
  }
}

interface State {
  env: DiscoveryEnv
  byName: Map<string, ExportInfo>
  parsed: Map<string, string>
  complete: boolean
  visiting: Set<string>
}

async function visitModule(state: State, file: string): Promise<void> {
  if (state.visiting.has(file)) return
  if (state.parsed.size >= state.env.limits.maxParsedFilesPerEntry) {
    state.complete = false
    state.env.diagnostics.warning(
      "discovery.export-limit",
      `Stopped following re-exports after ${state.env.limits.maxParsedFilesPerEntry} files`,
      { location: { path: file } }
    )
    return
  }
  state.visiting.add(file)
  const text = await readBounded(state.env, file)
  if (text === undefined) {
    state.complete = false
    return
  }
  state.parsed.set(file, hashText(text))
  if (!PARSEABLE.test(file)) {
    // Assets (css, json, .vue) have no enumerable JS exports; the caller must not read "none" as "complete".
    if (state.visiting.size === 1) state.complete = false
    return
  }
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, false, scriptKind(file))
  const parseErrors = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? []
  if (parseErrors.length > 0) {
    state.complete = false
    state.env.diagnostics.warning(
      "discovery.parse-error",
      `Syntax errors in ${file}; exports may be incomplete`,
      { location: { path: file } }
    )
  }
  const locals = localDeclarationKinds(sf)
  const stars: string[] = []

  const record = (info: Omit<ExportInfo, "file" | "line">, node: ts.Node): void => {
    // Explicit exports (collected first, in this file) win over star re-exports; first definition wins.
    if (state.byName.has(info.name)) return
    state.byName.set(info.name, {
      ...info,
      file,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
    })
  }

  for (const statement of sf.statements) {
    if (ts.isExportDeclaration(statement)) {
      const spec =
        statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : undefined
      const external = spec !== undefined && !spec.startsWith(".")
      const clause = statement.exportClause
      if (!clause) {
        if (spec) stars.push(spec)
      } else if (ts.isNamespaceExport(clause)) {
        record(
          {
            name: clause.name.text,
            kind: "namespace",
            typeOnly: statement.isTypeOnly,
            ...(spec ? { reexportOf: { module: spec, external } } : {})
          },
          clause
        )
      } else {
        for (const element of clause.elements) {
          const typeOnly = statement.isTypeOnly || element.isTypeOnly
          const original = (element.propertyName ?? element.name).text
          const kind: Kind = spec
            ? original === "default"
              ? "default"
              : external
                ? "unknown"
                : await reexportedKind(state, file, spec, original)
            : (locals.get(original) ?? "unknown")
          record(
            {
              name: element.name.text,
              kind: typeOnly && kind === "unknown" ? "type" : kind,
              typeOnly,
              ...(spec ? { reexportOf: { module: spec, external } } : {})
            },
            element
          )
        }
      }
    } else if (ts.isExportAssignment(statement)) {
      if (statement.isExportEquals) {
        state.complete = false
        state.env.diagnostics.info(
          "discovery.unsupported-export-assignment",
          `'export =' in ${file} is not enumerated`,
          { location: { path: file } }
        )
      } else record({ name: "default", kind: "default", typeOnly: false }, statement)
    } else if (hasExportModifier(statement)) {
      for (const [name, kind] of declaredNames(statement))
        record({ name, kind, typeOnly: kind === "type" }, statement)
    }
  }

  for (const spec of stars) {
    if (!spec.startsWith(".")) {
      state.complete = false
      state.env.diagnostics.info(
        "discovery.external-reexport",
        `'export * from "${spec}"' in ${file} is not followed`,
        { location: { path: file } }
      )
      continue
    }
    const target = await resolveModule(state.env, file, spec)
    if (!target) {
      state.complete = false
      state.env.diagnostics.warning(
        "discovery.unresolved-module",
        `Could not resolve "${spec}" from ${file}`,
        { location: { path: file } }
      )
      continue
    }
    await visitModule(state, target)
  }
}

async function resolveModule(env: DiscoveryEnv, from: string, spec: string): Promise<string | undefined> {
  const base = posix.normalize(posix.join(posix.dirname(from), spec))
  const stripped = base.replace(/\.(?:[cm]?jsx?)$/, "")
  const candidates = [
    ...(/\.[a-z]+$/i.test(base) && base === stripped ? [base] : []),
    ...(stripped !== base ? [".ts", ".tsx", ".mts", ".cts", ".d.ts"].map((e) => stripped + e) : []),
    ...(stripped !== base ? [base] : []),
    ...SOURCE_EXTS.map((e) => base + e),
    ...[".ts", ".tsx", ".d.ts", ".js", ".jsx"].map((e) => `${base}/index${e}`)
  ]
  for (const candidate of candidates) {
    if (await fileExists(env, candidate)) return candidate
  }
  return undefined
}

/** Looks one level into a relative module to learn whether a re-exported name is a value, type or namespace. */
async function reexportedKind(state: State, from: string, spec: string, name: string): Promise<Kind> {
  const target = await resolveModule(state.env, from, spec)
  if (!target || !PARSEABLE.test(target)) return "unknown"
  const text = await readBounded(state.env, target)
  if (text === undefined) return "unknown"
  state.parsed.set(target, hashText(text))
  const sf = ts.createSourceFile(target, text, ts.ScriptTarget.ES2022, false, scriptKind(target))
  return localDeclarationKinds(sf).get(name) ?? "unknown"
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX
  if (/\.[cm]?js$/.test(file)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

type Kind = ExportInfo["kind"]

function localDeclarationKinds(sf: ts.SourceFile): Map<string, Kind> {
  const kinds = new Map<string, Kind>()
  for (const statement of sf.statements) {
    for (const [name, kind] of declaredNames(statement)) kinds.set(name, kind)
  }
  return kinds
}

function declaredNames(statement: ts.Statement): Array<[string, Kind]> {
  const isDefault =
    ts.canHaveModifiers(statement) &&
    !!ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((d) =>
      ts.isIdentifier(d.name) ? [[d.name.text, "value"] as [string, Kind]] : []
    )
  }
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
    if (isDefault) return [["default", "default"]]
    return statement.name ? [[statement.name.text, "value"]] : []
  }
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
    return [[statement.name.text, "type"]]
  if (ts.isEnumDeclaration(statement)) return [[statement.name.text, "value"]]
  if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name))
    return [[statement.name.text, "namespace"]]
  return []
}

function hasExportModifier(statement: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(statement) &&
    !!ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  )
}
