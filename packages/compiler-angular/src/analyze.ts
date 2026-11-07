import {
  createAnalysis,
  cssVariableReferences,
  declarationOf,
  type EntryPoint,
  isProjectNode,
  posix,
  resolveSymbol,
  tsconfigPaths
} from "@invariant/compiler-core"
import type { Diagnostic } from "@invariant/shared"
import ts from "typescript"
import { type AngularInput, type AngularOutput, type ClassMetadata, readClass } from "./classes.js"
import { readDeclaredClass } from "./declared.js"
import {
  matchesSelector,
  parseSelector,
  type SimpleSelector,
  scanTemplate,
  type TemplateInfo
} from "./template.js"

export interface AngularStyling {
  files: string[]
  variables: Array<{ name: string; file: string; line: number }>
  preprocessors: string[]
}

export interface AngularComponent {
  ref: string
  meta: ClassMetadata
  exports: Array<{ subpath: string; name: string }>
  inputs: AngularInput[]
  outputs: AngularOutput[]
  template?: { source: "inline" | "file"; file: string; line: number; info: TemplateInfo }
  accessibility: { roles: string[]; attributes: string[] }
  styling: AngularStyling
  renders: Array<{ target: string; count: number }>
  modules: { declaredIn: string[]; exportedBy: string[] }
  propsComplete: boolean
}

export interface AngularModule {
  ref: string
  meta: ClassMetadata
  public: boolean
}

export interface PackageAnalysis {
  components: AngularComponent[]
  modules: AngularModule[]
  diagnostics: Diagnostic[]
}

const NON_SOURCE = /\.(?:test|spec|stories)\.[cm]?[jt]sx?$|(?:^|\/)__(?:tests|mocks)__\//

/** Public components and directives (class exports of the entry points) plus every NgModule, read statically. */
export function analyzePackage(input: {
  packageName?: string
  /** Project-relative package directory, for tsconfig `paths`. */
  packageDir: string
  entryPoints: readonly EntryPoint[]
  files: ReadonlyMap<string, string>
}): PackageAnalysis {
  const diagnostics: Diagnostic[] = []
  const note = (
    severity: Diagnostic["severity"],
    code: string,
    message: string,
    location?: { path: string; line?: number }
  ): void => {
    diagnostics.push({ code, severity, message, ...(location ? { location } : {}) })
  }
  const codeFiles = new Map(
    [...input.files].filter(([path]) => /\.[cm]?[jt]sx?$/.test(path) && !NON_SOURCE.test(path))
  )
  // A library imports its own entry points by package name (`@scope/lib/accordion`): map those to files.
  const paths: Record<string, string[]> = { ...tsconfigPaths(input.files, input.packageDir) }
  if (input.packageName) {
    for (const entry of input.entryPoints) {
      if (entry.file)
        paths[
          entry.subpath === "."
            ? input.packageName
            : `${input.packageName}/${entry.subpath.replace(/^\.\//, "")}`
        ] = [entry.file]
    }
  }
  const analysis = createAnalysis(codeFiles, { paths })

  const publicClasses = new Map<ts.ClassDeclaration, Array<{ subpath: string; name: string }>>()
  for (const entry of input.entryPoints) {
    const sf = entry.file ? analysis.sourceFile(entry.file) : undefined
    const moduleSymbol = sf ? analysis.checker.getSymbolAtLocation(sf) : undefined
    if (!sf || !moduleSymbol) continue
    for (const exported of analysis.checker.getExportsOfModule(moduleSymbol)) {
      const decl = declarationOf(resolveSymbol(analysis.checker, exported))
      if (decl && ts.isClassDeclaration(decl) && isProjectNode(analysis, decl))
        publicClasses.set(decl, [
          ...(publicClasses.get(decl) ?? []),
          { subpath: entry.subpath, name: exported.name }
        ])
    }
  }

  const metas = new Map<ts.ClassDeclaration, ClassMetadata>()
  const modules: AngularModule[] = []
  for (const sf of analysis.program.getSourceFiles()) {
    if (!analysis.relativePath(sf.fileName)) continue
    for (const statement of sf.statements) {
      if (!ts.isClassDeclaration(statement)) continue
      const meta = readClass(analysis, statement) ?? readDeclaredClass(analysis, statement)
      if (!meta) continue
      metas.set(statement, meta)
      if (meta.kind === "module")
        modules.push({ ref: `angular:${meta.file}#${meta.name}`, meta, public: publicClasses.has(statement) })
    }
  }

  const publicComponents = [...publicClasses.keys()].flatMap((decl) => {
    const meta = metas.get(decl)
    return meta && meta.kind !== "module" ? [{ decl, meta }] : []
  })
  const selectors = new Map<string, SimpleSelector[]>()
  const refs = new Map<ts.ClassDeclaration, string>()
  for (const { decl, meta } of publicComponents) {
    refs.set(decl, `angular:${meta.file}#${meta.name}`)
    if (meta.selector) selectors.set(refs.get(decl) as string, parseSelector(meta.selector))
  }

  const components: AngularComponent[] = publicComponents.map(({ decl, meta }) => {
    const ref = refs.get(decl) as string
    const template = readTemplate(meta, input.files, note)
    const styling = readStyling(meta, input.files, note)
    const renders = new Map<string, number>()
    for (const element of template?.info.elements ?? []) {
      for (const [targetRef, parsed] of selectors) {
        if (targetRef !== ref && matchesSelector(element, parsed))
          renders.set(targetRef, (renders.get(targetRef) ?? 0) + 1)
      }
    }
    const { inputs, outputs, complete } = withMetadataMembers(meta)
    if (!meta.selector && meta.kind === "component")
      note("info", "angular.no-selector", `${meta.name} has no static selector`, {
        path: meta.file,
        line: meta.line
      })
    for (const message of meta.notes)
      note("info", "angular.unsupported", `${meta.name}: ${message}`, { path: meta.file, line: meta.line })
    if (meta.inheritsFrom.length > 0)
      note(
        "info",
        "angular.base-class-external",
        `${meta.name} extends ${meta.inheritsFrom.join(", ")}, whose inputs and outputs are not enumerated`,
        { path: meta.file, line: meta.line }
      )
    const a11y = accessibilityOf(template?.info)
    return {
      ref,
      meta,
      exports: (publicClasses.get(decl) ?? []).sort((a, b) =>
        a.subpath < b.subpath ? -1 : a.subpath > b.subpath ? 1 : a.name < b.name ? -1 : 1
      ),
      inputs,
      outputs,
      ...(template ? { template } : {}),
      accessibility: a11y,
      styling,
      renders: [...renders]
        .map(([target, count]) => ({ target, count }))
        .sort((a, b) => (a.target < b.target ? -1 : 1)),
      modules: modulesOf(meta, modules),
      propsComplete: complete && meta.inheritsFrom.length === 0 && meta.hostDirectives.length === 0
    }
  })
  components.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
  modules.sort((a, b) => (a.ref < b.ref ? -1 : 1))
  return { components, modules, diagnostics }
}

function readTemplate(
  meta: ClassMetadata,
  files: ReadonlyMap<string, string>,
  note: (
    severity: Diagnostic["severity"],
    code: string,
    message: string,
    location?: { path: string; line?: number }
  ) => void
): AngularComponent["template"] | undefined {
  const template = meta.template
  if (!template) return undefined
  if ("inline" in template)
    return {
      source: "inline",
      file: meta.file,
      line: template.line,
      info: scanTemplate(template.inline, template.line)
    }
  const file = posix.normalize(posix.join(posix.dirname(meta.file), template.url))
  const text = files.get(file)
  if (text === undefined) {
    note("warning", "angular.templateurl-missing", `${meta.name}: template file ${file} was not found`, {
      path: meta.file,
      line: meta.line
    })
    return undefined
  }
  return { source: "file", file, line: 1, info: scanTemplate(text, 1) }
}

function readStyling(
  meta: ClassMetadata,
  files: ReadonlyMap<string, string>,
  note: (
    severity: Diagnostic["severity"],
    code: string,
    message: string,
    location?: { path: string; line?: number }
  ) => void
): AngularStyling {
  const variables = new Map<string, { file: string; line: number }>()
  const styleFiles: string[] = []
  for (const s of meta.styles) {
    for (const ref of cssVariableReferences(s.text))
      if (!variables.has(ref.name)) variables.set(ref.name, { file: meta.file, line: s.line + ref.line - 1 })
  }
  for (const url of meta.styleUrls) {
    const file = posix.normalize(posix.join(posix.dirname(meta.file), url))
    const text = files.get(file)
    if (text === undefined) {
      note("warning", "angular.styleurl-missing", `${meta.name}: stylesheet ${file} was not found`, {
        path: meta.file,
        line: meta.line
      })
      continue
    }
    styleFiles.push(file)
    for (const ref of cssVariableReferences(text))
      if (!variables.has(ref.name)) variables.set(ref.name, { file, line: ref.line })
  }
  return {
    files: styleFiles.sort(),
    variables: [...variables].map(([name, v]) => ({ name, ...v })).sort((a, b) => (a.name < b.name ? -1 : 1)),
    preprocessors: [
      ...new Set(
        styleFiles.flatMap((f) =>
          /\.(scss|sass|less)$/.exec(f)?.[1] ? [/\.(scss|sass|less)$/.exec(f)?.[1] as string] : []
        )
      )
    ].sort()
  }
}

function accessibilityOf(info: TemplateInfo | undefined): { roles: string[]; attributes: string[] } {
  const roles = new Set<string>()
  const attributes = new Set<string>()
  for (const element of info?.elements ?? []) {
    // Native elements only: custom elements (with a dash) are Angular components.
    if (element.tag.includes("-") || /^[A-Z]/.test(element.tag) || element.tag === "ng-content") continue
    for (const a of element.attributes) {
      if (a.name === "role" && !a.bound && a.value) roles.add(a.value)
      if (a.name.startsWith("aria-")) attributes.add(a.name)
    }
  }
  return { roles: [...roles].sort(), attributes: [...attributes].sort() }
}

/** `inputs: ['a', 'b: alias']` and `outputs: [...]` in the decorator, for names with no declared member. */
function withMetadataMembers(meta: ClassMetadata): {
  inputs: AngularInput[]
  outputs: AngularOutput[]
  complete: boolean
} {
  const inputs = [...meta.inputs]
  const outputs = [...meta.outputs]
  for (const spec of meta.metadataInputs) {
    const [property = "", alias] = spec.split(":").map((s) => s.trim())
    const name = alias || property
    if (!property || inputs.some((i) => i.name === name)) continue
    inputs.push({
      name,
      property,
      kind: "input",
      typeText: "unknown",
      typeKind: "unknown",
      required: false,
      ...(alias ? { alias } : {}),
      node: meta.node
    })
  }
  for (const spec of meta.metadataOutputs) {
    const [property = "", alias] = spec.split(":").map((s) => s.trim())
    const name = alias || property
    if (!property || outputs.some((o) => o.name === name)) continue
    outputs.push({ name, property, kind: "output", ...(alias ? { alias } : {}), node: meta.node })
  }
  inputs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  outputs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { inputs, outputs, complete: true }
}

function modulesOf(
  meta: ClassMetadata,
  modules: readonly AngularModule[]
): { declaredIn: string[]; exportedBy: string[] } {
  const matches = (refs: ClassMetadata["declarations"]): boolean =>
    refs.some((r) => r.file === meta.file && r.localName === meta.name)
  return {
    declaredIn: modules
      .filter((m) => matches(m.meta.declarations))
      .map((m) => m.meta.name)
      .sort(),
    exportedBy: modules
      .filter((m) => matches(m.meta.exports))
      .map((m) => m.meta.name)
      .sort()
  }
}
