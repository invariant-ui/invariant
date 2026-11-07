import {
  type Analysis,
  createAnalysis,
  cssVariableReferences,
  declarationOf,
  type EntryPoint,
  isProjectNode,
  lineOf,
  type PropSpec,
  posix,
  relativeFileOf,
  resolveSymbol,
  tsconfigPaths,
  unwrap,
  type VariantSpec,
  variantsFromProps
} from "@invariant/compiler-core"
import type { Diagnostic } from "@invariant/shared"
import ts from "typescript"
import { analyzeDeclaredComponent } from "./declared.js"
import { analyzeOptionsDeclaration, analyzeScript, type ScriptInfo, type VueSlot } from "./script.js"
import { type ParsedSfc, parseSfc, sfcLocalName } from "./sfc.js"
import { analyzeTemplate, type TemplateInfo } from "./template.js"

export interface MergedSlot {
  name: string
  propsText?: string
  templateProps: string[]
  sources: Array<"defineSlots" | "template">
  node?: ts.Node
  line?: number
}

export interface VueStyling {
  variables: Array<{ name: string; line: number }>
  scoped: boolean
  module: boolean
  preprocessors: string[]
  blocks: number
}

export interface VueComponent {
  ref: string
  localName: string
  file: string
  line: number
  kind: "sfc" | "defineComponent" | "declaration"
  exports: Array<{ subpath: string; name: string }>
  sfc?: ParsedSfc
  script: ScriptInfo
  template?: TemplateInfo
  templateLine?: number
  styling: VueStyling
  variants: VariantSpec[]
  slots: MergedSlot[]
  renders: Array<{ target: string; count: number }>
  propsComplete: boolean
  generic?: string
  /** Maps a node of the analyzed (virtual) script to its location in the source file. */
  locate(node: ts.Node): { file: string; line: number }
}

export interface PackageAnalysis {
  components: VueComponent[]
  diagnostics: Diagnostic[]
}

const NON_SOURCE = /\.(?:test|spec|stories)\.[cm]?[jt]sx?$|(?:^|\/)__(?:tests|mocks)__\//

/**
 * Finds the package's public Vue components (what its entry points export that is a `.vue` file or a
 * `defineComponent(...)` declaration) and analyzes each. Nothing is executed or built.
 */
export function analyzePackage(input: {
  /** Project-relative package directory (for tsconfig paths). */
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

  // 1. Public SFCs, from what the entry points re-export.
  const publicSfcs = new Map<string, Array<{ subpath: string; name: string }>>()
  const importCache = new Map<string, Map<string, string>>()
  for (const entry of input.entryPoints) {
    for (const exported of entry.exports) {
      const target = sfcTargetOf(exported, input.files, importCache)
      if (target)
        publicSfcs.set(target, [
          ...(publicSfcs.get(target) ?? []),
          { subpath: entry.subpath, name: exported.name }
        ])
    }
  }

  // 2. Parse each SFC and give its script to the type checker as a virtual module.
  const sfcs = new Map<string, ParsedSfc>()
  const files = new Map<string, string>()
  for (const [path, text] of input.files)
    if (/\.[cm]?[jt]sx?$/.test(path) && !NON_SOURCE.test(path)) files.set(path, text)
  // Every SFC gets a virtual module, public or not: a component's props type is often an interface exported
  // from another SFC's `<script>` block (`import type { XProps } from "../X"`, re-exported from `X.vue`).
  const moduleAliases: Record<string, string> = {}
  for (const path of [...input.files.keys()].filter((f) => f.endsWith(".vue")).sort()) {
    const sfc = parseSfc(path, input.files.get(path) as string)
    if (publicSfcs.has(path)) {
      sfcs.set(path, sfc)
      for (const message of sfc.errors)
        note("warning", "vue.sfc-parse-error", `${path}: ${message}`, { path })
    }
    if (sfc.script) {
      files.set(sfc.script.path, sfc.script.text)
      moduleAliases[path] = sfc.script.path
    }
  }
  const analysis = createAnalysis(files, {
    moduleAliases,
    paths: tsconfigPaths(input.files, input.packageDir)
  })

  const components: VueComponent[] = []
  const refOf = new Map<string, string>()
  for (const path of [...publicSfcs.keys()].sort()) refOf.set(path, `vue:${path}#${sfcLocalName(path)}`)

  for (const [path, sfc] of sfcs) {
    components.push(
      buildSfcComponent({
        analysis,
        sfc,
        exports: publicSfcs.get(path) ?? [],
        ref: refOf.get(path) as string,
        refOf,
        note,
        files: input.files
      })
    )
  }

  // 3. Components declared in TypeScript with defineComponent(...).
  for (const entry of input.entryPoints) {
    const sf = entry.file ? analysis.sourceFile(entry.file) : undefined
    const moduleSymbol = sf ? analysis.checker.getSymbolAtLocation(sf) : undefined
    if (!sf || !moduleSymbol) continue
    for (const exported of analysis.checker.getExportsOfModule(moduleSymbol)) {
      const decl = declarationOf(resolveSymbol(analysis.checker, exported))
      if (
        !decl ||
        !ts.isVariableDeclaration(decl) ||
        !ts.isIdentifier(decl.name) ||
        !isProjectNode(analysis, decl)
      )
        continue
      const init = decl.initializer ? unwrap(decl.initializer) : undefined
      if (!init) {
        // A declaration file's `declare const X: DefineComponent<…>`.
        const file = relativeFileOf(analysis, decl) as string
        const localName = declaredLocalName(decl.name.text, exported.name, file)
        const ref = `vue:${file}#${localName}`
        const existing = components.find((c) => c.ref === ref)
        if (existing) existing.exports.push({ subpath: entry.subpath, name: exported.name })
        else {
          const script = analyzeDeclaredComponent(analysis, decl)
          if (script)
            components.push(
              buildTsComponent({
                analysis,
                decl,
                script,
                ref,
                localName,
                kind: "declaration",
                exported: { subpath: entry.subpath, name: exported.name }
              })
            )
        }
        continue
      }
      if (
        !init ||
        !ts.isCallExpression(init) ||
        !ts.isIdentifier(init.expression) ||
        init.expression.text !== "defineComponent"
      )
        continue
      const file = relativeFileOf(analysis, decl) as string
      const ref = `vue:${file}#${decl.name.text}`
      const existing = components.find((c) => c.ref === ref)
      if (existing) existing.exports.push({ subpath: entry.subpath, name: exported.name })
      else {
        const script = analyzeOptionsDeclaration(analysis, decl)
        if (script)
          components.push(
            buildTsComponent({
              analysis,
              decl,
              script,
              ref,
              exported: { subpath: entry.subpath, name: exported.name }
            })
          )
      }
    }
  }

  if (components.some((c) => c.kind === "declaration"))
    note(
      "info",
      "vue.declaration-defaults-unavailable",
      "Components were read from declaration files, which carry types but no default values: prop defaults are not reported"
    )
  for (const c of components) {
    if (!c.propsComplete)
      note(
        "info",
        "vue.props-incomplete",
        `${c.localName}: props could not be fully enumerated${c.script.inheritsFrom.length ? ` (${c.script.inheritsFrom.join(", ")})` : c.script.notes[0] ? ` (${c.script.notes[0]})` : ""}`,
        { path: c.file, line: c.line }
      )
    if (c.template?.skipped)
      note("info", "vue.template-skipped", `${c.localName}: ${c.template.skipped}`, {
        path: c.file,
        line: c.templateLine ?? c.line
      })
    for (const s of c.template?.slots ?? [])
      if (s.dynamic)
        note(
          "info",
          "vue.dynamic-slot-name",
          `${c.localName}: a <slot> with a dynamic name was found and is not listed`,
          { path: c.file, line: s.line }
        )
  }
  components.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
  for (const c of components)
    c.exports.sort((a, b) =>
      a.subpath < b.subpath ? -1 : a.subpath > b.subpath ? 1 : a.name < b.name ? -1 : 1
    )
  return { components, diagnostics }
}

/** `declare const _default` (vue-tsc output for one `.vue` file) is named after its file; other names are kept. */
function declaredLocalName(declName: string, exportName: string, file: string): string {
  if (!declName.startsWith("_")) return declName
  if (exportName !== "default") return exportName
  return sfcLocalName(file.replace(/(?:\.vue)?\.d\.[cm]?ts$/, ".vue"))
}

function sfcTargetOf(
  exported: EntryPoint["exports"][number],
  files: ReadonlyMap<string, string>,
  cache: Map<string, Map<string, string>>
): string | undefined {
  const resolve = (spec: string, from: string): string | undefined => {
    if (!spec.startsWith(".")) return undefined
    const path = posix.normalize(posix.join(posix.dirname(from), spec))
    return path.endsWith(".vue") && files.has(path) ? path : undefined
  }
  if (exported.reexportOf) return resolve(exported.reexportOf.module, exported.file)
  // `import Button from "./Button.vue"; export { Button }`
  let imports = cache.get(exported.file)
  if (!imports) {
    imports = new Map()
    const text = files.get(exported.file)
    if (text) {
      const sf = ts.createSourceFile(exported.file, text, ts.ScriptTarget.ES2022, false)
      for (const statement of sf.statements) {
        if (
          ts.isImportDeclaration(statement) &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          statement.importClause?.name
        ) {
          imports.set(statement.importClause.name.text, statement.moduleSpecifier.text)
        }
      }
    }
    cache.set(exported.file, imports)
  }
  const spec = imports.get(exported.name)
  return spec ? resolve(spec, exported.file) : undefined
}

function buildSfcComponent(input: {
  analysis: Analysis
  sfc: ParsedSfc
  exports: Array<{ subpath: string; name: string }>
  ref: string
  refOf: ReadonlyMap<string, string>
  note: (
    severity: Diagnostic["severity"],
    code: string,
    message: string,
    location?: { path: string; line?: number }
  ) => void
  files: ReadonlyMap<string, string>
}): VueComponent {
  const { analysis, sfc, note } = input
  const { descriptor } = sfc
  const sf = sfc.script ? analysis.sourceFile(sfc.script.path) : undefined
  const script: ScriptInfo = sf
    ? analyzeScript(analysis, sf)
    : {
        props: [],
        emits: [],
        slots: [],
        exposed: [],
        options: {},
        inheritsFrom: [],
        complete: true,
        notes: [],
        optionsApi: false,
        imports: new Map()
      }
  const external = [descriptor.script, descriptor.scriptSetup].some((b) => b?.src)
  if (external) {
    script.complete = false
    script.notes.push("a script block loads its content from another file (src), which is not read")
    note("info", "vue.external-block", `${sfc.path}: a <script src> block is not read`, { path: sfc.path })
  }
  const template = analyzeTemplate(descriptor)
  const generic = descriptor.scriptSetup?.attrs.generic
  if (typeof generic === "string") script.notes.push(`generic component <${generic}>`)

  const localName = sfcLocalName(sfc.path)
  const slots = mergeSlots(script.slots, template)
  const variants = variantsFromProps(script.props.map(toSpec))
  return {
    ref: input.ref,
    localName,
    file: sfc.path,
    line: firstBlockLine(descriptor),
    kind: "sfc",
    exports: [...input.exports],
    sfc,
    script,
    template,
    ...(descriptor.template ? { templateLine: descriptor.template.loc.start.line } : {}),
    styling: stylingOf(descriptor),
    variants,
    slots,
    renders: rendersOf({ template, script, sfcPath: sfc.path, refOf: input.refOf }),
    propsComplete: script.complete && typeof generic !== "string",
    ...(typeof generic === "string" ? { generic } : {}),
    locate: (node) => {
      const virtual = relativeFileOf(analysis, node)
      const line = lineOf(node)
      const script = sfc.script
      return script && virtual === script.path
        ? { file: sfc.path, line: script.lineOf(line) }
        : { file: virtual ?? sfc.path, line }
    }
  }
}

function buildTsComponent(input: {
  analysis: Analysis
  decl: ts.VariableDeclaration
  script: ScriptInfo
  ref: string
  localName?: string
  kind?: VueComponent["kind"]
  exported: { subpath: string; name: string }
}): VueComponent {
  const { analysis, decl, script } = input
  const file = relativeFileOf(analysis, decl) as string
  return {
    ref: input.ref,
    localName: input.localName ?? (decl.name as ts.Identifier).text,
    file,
    line: lineOf(decl),
    kind: input.kind ?? "defineComponent",
    exports: [input.exported],
    script,
    styling: { variables: [], scoped: false, module: false, preprocessors: [], blocks: 0 },
    variants: variantsFromProps(script.props.map(toSpec)),
    slots: mergeSlots(script.slots, { slots: [] }),
    renders: [],
    propsComplete: script.complete,
    locate: (node) => ({ file: relativeFileOf(analysis, node) ?? file, line: lineOf(node) })
  }
}

function firstBlockLine(descriptor: ParsedSfc["descriptor"]): number {
  const lines = [descriptor.script, descriptor.scriptSetup, descriptor.template].flatMap((b) =>
    b ? [b.loc.start.line] : []
  )
  return lines.length > 0 ? Math.min(...lines) : 1
}

function toSpec(p: ScriptInfo["props"][number]): PropSpec {
  return {
    name: p.name,
    typeText: p.typeText,
    kind: p.kind,
    required: p.required,
    ...(p.default !== undefined ? { default: p.default } : {}),
    ...(p.allowedValues ? { allowedValues: p.allowedValues } : {})
  }
}

function mergeSlots(declared: readonly VueSlot[], template: Pick<TemplateInfo, "slots">): MergedSlot[] {
  const byName = new Map<string, MergedSlot>()
  for (const s of declared)
    byName.set(s.name, {
      name: s.name,
      ...(s.propsText ? { propsText: s.propsText } : {}),
      templateProps: [],
      sources: ["defineSlots"],
      node: s.node
    })
  for (const s of template.slots) {
    if (s.dynamic || !s.name) continue
    const existing = byName.get(s.name)
    if (existing) {
      existing.sources.push("template")
      existing.templateProps = [...new Set([...existing.templateProps, ...s.props])].sort()
      existing.line ??= s.line
    } else byName.set(s.name, { name: s.name, templateProps: s.props, sources: ["template"], line: s.line })
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

function stylingOf(descriptor: ParsedSfc["descriptor"]): VueStyling {
  const variables = new Map<string, number>()
  for (const block of descriptor.styles) {
    for (const ref of cssVariableReferences(block.content))
      if (!variables.has(ref.name)) variables.set(ref.name, block.loc.start.line + ref.line - 1)
  }
  return {
    variables: [...variables]
      .map(([name, line]) => ({ name, line }))
      .sort((a, b) => (a.name < b.name ? -1 : 1)),
    scoped: descriptor.styles.some((s) => s.scoped),
    module: descriptor.styles.some((s) => s.module),
    preprocessors: [...new Set(descriptor.styles.flatMap((s) => (s.lang ? [s.lang] : [])))].sort(),
    blocks: descriptor.styles.length
  }
}

/** Component tags used in the template, resolved through the script's imports to other public components. */
function rendersOf(input: {
  template: TemplateInfo
  script: ScriptInfo
  sfcPath: string
  refOf: ReadonlyMap<string, string>
}): Array<{ target: string; count: number }> {
  const { template, script, sfcPath, refOf } = input
  const byLocal = new Map<string, string>()
  for (const [local, spec] of script.imports) {
    if (!spec.startsWith(".") || !spec.endsWith(".vue")) continue
    byLocal.set(local, posix.normalize(posix.join(posix.dirname(sfcPath), spec)))
  }
  const counts = new Map<string, number>()
  for (const { tag, count } of template.components) {
    const pascal = tag.includes("-")
      ? tag
          .split("-")
          .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
          .join("")
      : tag
    const file = byLocal.get(pascal) ?? byLocal.get(tag)
    const target = file ? refOf.get(file) : undefined
    if (target && target !== refOf.get(sfcPath)) counts.set(target, (counts.get(target) ?? 0) + count)
  }
  return [...counts]
    .map(([target, count]) => ({ target, count }))
    .sort((a, b) => (a.target < b.target ? -1 : 1))
}
