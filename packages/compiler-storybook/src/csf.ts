import {
  type Analysis,
  collapse,
  componentNameFromFile,
  declarationOf,
  type Evaluated,
  evaluate,
  isProjectNode,
  jsxTargetDeclaration,
  lineOf,
  posix,
  relativeFileOf,
  resolveSymbol,
  topLevelAssignments,
  unwrap
} from "@invariant/compiler-core"
import type { JsonValue } from "@invariant/shared"
import ts from "typescript"

export interface ComponentTarget {
  /** Project-relative file and local declaration name of the implementation, when it resolves to the project. */
  file?: string
  name?: string
  /** Source text of the reference (`Button`, `Card.Header`). */
  text: string
  via: "component" | "type-argument"
  /** Module specifier when the component comes from a package outside the analysis. */
  external?: string
  /** Relative module specifier that did not resolve to a file. */
  unresolvedModule?: string
}

export interface ArgTypeInfo {
  control?: string | false
  options?: Array<string | number | boolean>
  optionsUnresolved?: boolean
  description?: string
  /** `table.defaultValue.summary`, the documented default shown in the props table. */
  defaultSummary?: string
  /** Keys of `mapping`: with a mapping, an arg value is a key, not the real prop value. */
  mappingKeys?: string[]
  action?: string
  /** `table.disable`: the row is hidden from the props table. */
  hidden?: boolean
  category?: string
}

export interface ParametersInfo {
  a11y?: JsonValue
  docsDescription?: { component?: string; story?: string }
  layout?: string
  controls?: JsonValue
  keys: string[]
}

export interface Annotations {
  args: Evaluated
  /** Per-key nodes for evidence; the whole `args` node is used for spread or computed keys. */
  argNodes: Map<string, ts.Node>
  argsNode?: ts.Node
  argTypes: Record<string, ArgTypeInfo>
  argTypeNodes: Map<string, ts.Node>
  argTypesUnresolved: string[]
  parameters: ParametersInfo
  parametersUnresolved: string[]
  tags?: string[]
  hasDecorators: boolean
  hasLoaders: boolean
  /** Nodes of the annotation properties, used as evidence locations. */
  nodes: { parameters?: ts.Node; tags?: ts.Node; decorators?: ts.Node; loaders?: ts.Node }
}

export interface CsfGroup extends Annotations {
  file: string
  line: number
  node: ts.Node
  title?: string
  component?: ComponentTarget
  componentNode?: ts.Node
}

export interface CsfStory extends Annotations {
  exportName: string
  line: number
  node: ts.Node
  shape: "object" | "function" | "template"
  /** Explicit `name` or `storyName` only. The derived display name is not reproduced. */
  name?: string
  description?: string
  play?: { calls: string[]; steps: string[] }
  hasRender: boolean
  composes: Array<{ file: string; name: string; count: number }>
}

export interface CsfFile {
  file: string
  group?: CsfGroup
  stories: CsfStory[]
  /** Exports that were excluded by `includeStories`/`excludeStories`. */
  excluded: string[]
  /** `includeStories`/`excludeStories` could not be evaluated, so story selection may be wrong. */
  selectionUncertain: boolean
}

const MAX_CALLS = 50

/** Statically reads a Component Story Format file (CSF 2 and 3). Nothing is executed. */
export function extractCsf(analysis: Analysis, sf: ts.SourceFile): CsfFile | undefined {
  const { checker } = analysis
  const file = relativeFileOf(analysis, sf)
  const moduleSymbol = checker.getSymbolAtLocation(sf)
  if (!file || !moduleSymbol) return undefined
  const exports = checker.getExportsOfModule(moduleSymbol)
  const defaultExport = exports.find((e) => e.name === "default")
  const meta = defaultExport ? findMeta(analysis, defaultExport) : undefined

  const group = meta ? readGroup(analysis, file, meta) : undefined
  const selection = meta ? readStorySelection(meta.object) : { uncertain: false }
  const assignments = topLevelAssignments(sf)
  const stories: CsfStory[] = []
  const excluded: string[] = []

  for (const exported of exports) {
    if (exported.name === "default" || exported.name === "__namedExportsOrder") continue
    if (!(exported.flags & ts.SymbolFlags.Value) && !(exported.flags & ts.SymbolFlags.Alias)) continue
    const resolved = resolveSymbol(checker, exported)
    const decl = declarationOf(resolved)
    if (!decl || !isProjectNode(analysis, decl)) continue
    if (!isSelected(exported.name, selection)) {
      excluded.push(exported.name)
      continue
    }
    const story = readStory(analysis, exported.name, decl, assignments)
    if (story) stories.push(story)
  }
  stories.sort((a, b) => a.line - b.line || (a.exportName < b.exportName ? -1 : 1))
  return {
    file,
    ...(group ? { group } : {}),
    stories,
    excluded: excluded.sort(),
    selectionUncertain: selection.uncertain
  }
}

interface MetaFound {
  object: ts.ObjectLiteralExpression
  typeArgument?: ts.TypeNode
  node: ts.Node
}

function findMeta(analysis: Analysis, symbol: ts.Symbol): MetaFound | undefined {
  const { checker } = analysis
  const decl = declarationOf(symbol)
  if (!decl) return undefined
  let expression: ts.Expression | undefined
  if (ts.isExportAssignment(decl)) expression = decl.expression
  else if (ts.isVariableDeclaration(decl)) expression = decl.initializer
  let typeArgument: ts.TypeNode | undefined
  let current = expression
  for (let hops = 0; current && hops < 8; hops++) {
    if (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) current = current.expression
    else if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
      typeArgument ??= metaTypeArgument(current.type)
      current = current.expression
    } else if (ts.isIdentifier(current)) {
      const target = declarationOf(resolveSymbol(checker, checker.getSymbolAtLocation(current)))
      if (!target || !ts.isVariableDeclaration(target) || !target.initializer) return undefined
      typeArgument ??= target.type ? metaTypeArgument(target.type) : undefined
      current = target.initializer
    } else break
  }
  if (!current || !ts.isObjectLiteralExpression(current)) return undefined
  return { object: current, ...(typeArgument ? { typeArgument } : {}), node: current }
}

/** `typeof Button` from `Meta<typeof Button>`. */
function metaTypeArgument(type: ts.TypeNode): ts.TypeNode | undefined {
  if (ts.isTypeReferenceNode(type) && type.typeArguments?.[0] && ts.isTypeQueryNode(type.typeArguments[0]))
    return type.typeArguments[0]
  return undefined
}

function readGroup(analysis: Analysis, file: string, meta: MetaFound): CsfGroup {
  const { checker } = analysis
  const props = objectProperties(meta.object)
  const title = props.get("title")
  const component = props.get("component")
  let target: ComponentTarget | undefined
  let componentNode: ts.Node | undefined
  if (component && ts.isPropertyAssignment(component)) {
    componentNode = component
    target = resolveTarget(analysis, component.initializer, "component")
  } else if (meta.typeArgument && ts.isTypeQueryNode(meta.typeArgument)) {
    componentNode = meta.typeArgument
    target = resolveTarget(analysis, meta.typeArgument.exprName, "type-argument")
  }
  return {
    file,
    line: lineOf(meta.node),
    node: meta.node,
    ...(title && ts.isPropertyAssignment(title) && ts.isStringLiteralLike(unwrap(title.initializer))
      ? { title: (unwrap(title.initializer) as ts.StringLiteralLike).text }
      : {}),
    ...(target ? { component: target } : {}),
    ...(componentNode ? { componentNode } : {}),
    ...annotations(checker, props)
  }
}

function readStory(
  analysis: Analysis,
  exportName: string,
  decl: ts.Node,
  assignments: Map<string, ts.Expression>
): CsfStory | undefined {
  const { checker } = analysis
  let shape: CsfStory["shape"] | undefined
  let object: ts.ObjectLiteralExpression | undefined
  let localName: string | undefined
  let renderNode: ts.Node | undefined

  if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && decl.initializer) {
    localName = decl.name.text
    const init = unwrap(decl.initializer)
    if (ts.isObjectLiteralExpression(init)) {
      shape = "object"
      object = init
    } else if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
      shape = "function"
      renderNode = init
    } else if (
      ts.isCallExpression(init) &&
      ts.isPropertyAccessExpression(init.expression) &&
      init.expression.name.text === "bind"
    ) {
      shape = "template"
      renderNode = init
    }
  } else if (ts.isFunctionDeclaration(decl) && decl.name) {
    localName = decl.name.text
    shape = "function"
    renderNode = decl
  }
  if (!shape) return undefined

  const props = object ? objectProperties(object) : new Map<string, ts.ObjectLiteralElementLike>()
  // CSF 2 style annotations: `Story.args = {…}`, `Story.storyName = "…"`, `Story.play = …`.
  const assigned = (key: string): ts.Expression | undefined =>
    localName ? assignments.get(`${localName}.${key}`) : undefined
  const synthetic = new Map(props)
  for (const key of [
    "args",
    "argTypes",
    "parameters",
    "tags",
    "decorators",
    "loaders",
    "play",
    "render",
    "name",
    "storyName"
  ]) {
    const expr = assigned(key)
    if (expr && !synthetic.has(key)) synthetic.set(key, fakeAssignment(key, expr))
  }

  const nameProp = synthetic.get("name") ?? synthetic.get("storyName")
  const nameExpr = nameProp && ts.isPropertyAssignment(nameProp) ? unwrap(nameProp.initializer) : undefined
  const play = synthetic.get("play")
  const playExpr =
    play && ts.isPropertyAssignment(play)
      ? unwrap(play.initializer)
      : play && ts.isMethodDeclaration(play)
        ? play
        : undefined
  const annotated = annotations(checker, synthetic)
  const symbol =
    ts.isVariableDeclaration(decl) || ts.isFunctionDeclaration(decl)
      ? checker.getSymbolAtLocation(decl.name as ts.Node)
      : undefined
  const doc = symbol ? ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim() : ""
  const description = annotated.parameters.docsDescription?.story ?? (doc || undefined)
  return {
    exportName,
    line: lineOf(decl),
    node: decl,
    shape,
    ...(nameExpr && ts.isStringLiteralLike(nameExpr) ? { name: nameExpr.text } : {}),
    ...(description ? { description } : {}),
    ...(playExpr ? { play: inspectPlay(playExpr) } : {}),
    hasRender: synthetic.has("render") || shape !== "object",
    composes: composedComponents(analysis, object ?? renderNode ?? decl),
    ...annotated
  }
}

/** Collects Annotations from a property map (object literal members, or CSF 2 assignments). */
function annotations(checker: ts.TypeChecker, props: Map<string, ts.ObjectLiteralElementLike>): Annotations {
  const expressionOf = (key: string): ts.Expression | undefined => {
    const p = props.get(key)
    return p && ts.isPropertyAssignment(p) ? p.initializer : undefined
  }
  const argsExpr = expressionOf("args")
  const args = argsExpr ? evaluate(checker, argsExpr) : { unresolved: [], spies: [] }
  const argNodes = new Map<string, ts.Node>()
  const argsObject = argsExpr ? unwrap(argsExpr) : undefined
  if (argsObject && ts.isObjectLiteralExpression(argsObject)) {
    for (const [k, p] of objectProperties(argsObject)) argNodes.set(k, p)
  }
  const argTypesExpr = expressionOf("argTypes")
  const argTypesEval = argTypesExpr ? evaluate(checker, argTypesExpr) : { unresolved: [], spies: [] }
  const argTypeNodes = new Map<string, ts.Node>()
  const argTypesObject = argTypesExpr ? unwrap(argTypesExpr) : undefined
  if (argTypesObject && ts.isObjectLiteralExpression(argTypesObject)) {
    for (const [k, p] of objectProperties(argTypesObject)) argTypeNodes.set(k, p)
  }
  const parametersExpr = expressionOf("parameters")
  const parametersEval = parametersExpr ? evaluate(checker, parametersExpr) : { unresolved: [], spies: [] }
  const tagsExpr = expressionOf("tags")
  const tagsEval = tagsExpr ? evaluate(checker, tagsExpr) : undefined
  return {
    args,
    argNodes,
    ...(argsExpr ? { argsNode: argsExpr } : {}),
    argTypes: readArgTypes(argTypesEval, syntacticMappingKeys(argTypeNodes)),
    argTypeNodes,
    argTypesUnresolved: argTypesEval.unresolved,
    parameters: readParameters(parametersEval),
    parametersUnresolved: parametersEval.unresolved,
    ...(Array.isArray(tagsEval?.value) && tagsEval.value.every((t) => typeof t === "string")
      ? { tags: tagsEval.value as string[] }
      : {}),
    hasDecorators: props.has("decorators"),
    hasLoaders: props.has("loaders"),
    nodes: {
      ...(evidenceNode(props.get("parameters"))
        ? { parameters: evidenceNode(props.get("parameters")) as ts.Node }
        : {}),
      ...(evidenceNode(props.get("tags")) ? { tags: evidenceNode(props.get("tags")) as ts.Node } : {}),
      ...(evidenceNode(props.get("decorators"))
        ? { decorators: evidenceNode(props.get("decorators")) as ts.Node }
        : {}),
      ...(evidenceNode(props.get("loaders"))
        ? { loaders: evidenceNode(props.get("loaders")) as ts.Node }
        : {})
    }
  }
}

function readArgTypes(
  evaluated: Evaluated,
  mappingKeys: ReadonlyMap<string, string[]>
): Record<string, ArgTypeInfo> {
  const out: Record<string, ArgTypeInfo> = {}
  const root = evaluated.value
  if (root === null || typeof root !== "object" || Array.isArray(root)) return out
  for (const [prop, raw] of Object.entries(root)) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      out[prop] = {}
      continue
    }
    const info: ArgTypeInfo = {}
    const control = raw.control
    if (typeof control === "string" || control === false) info.control = control
    else if (
      control &&
      typeof control === "object" &&
      !Array.isArray(control) &&
      typeof control.type === "string"
    )
      info.control = control.type
    if (
      Array.isArray(raw.options) &&
      raw.options.every((o) => ["string", "number", "boolean"].includes(typeof o))
    )
      info.options = raw.options as Array<string | number | boolean>
    if (
      evaluated.unresolved.some((p) => p === `${prop}.options` || p.startsWith(`${prop}.options.`)) ||
      (control &&
        typeof control === "object" &&
        evaluated.unresolved.some((p) => p.startsWith(`${prop}.control.options`)))
    )
      info.optionsUnresolved = true
    if (typeof raw.description === "string") info.description = raw.description
    const table = raw.table
    if (table && typeof table === "object" && !Array.isArray(table)) {
      const dv = table.defaultValue
      if (dv && typeof dv === "object" && !Array.isArray(dv) && typeof dv.summary === "string")
        info.defaultSummary = dv.summary
      if (table.disable === true) info.hidden = true
      if (typeof table.category === "string") info.category = table.category
    }
    // Mapping keys come from the syntax: a key whose value is JSX or `undefined` is still a key.
    const syntactic = mappingKeys.get(prop)
    if (syntactic) info.mappingKeys = syntactic
    else if (raw.mapping && typeof raw.mapping === "object" && !Array.isArray(raw.mapping))
      info.mappingKeys = Object.keys(raw.mapping).sort()
    else if (evaluated.unresolved.some((p) => p === `${prop}.mapping`)) info.mappingKeys = []
    if (typeof raw.action === "string") info.action = raw.action
    out[prop] = info
  }
  return out
}

function syntacticMappingKeys(argTypeNodes: ReadonlyMap<string, ts.Node>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [prop, node] of argTypeNodes) {
    if (!ts.isPropertyAssignment(node)) continue
    const argType = unwrap(node.initializer)
    if (!ts.isObjectLiteralExpression(argType)) continue
    const mapping = objectProperties(argType).get("mapping")
    const object = mapping && ts.isPropertyAssignment(mapping) ? unwrap(mapping.initializer) : undefined
    if (object && ts.isObjectLiteralExpression(object))
      out.set(prop, [...objectProperties(object).keys()].sort())
  }
  return out
}

function readParameters(evaluated: Evaluated): ParametersInfo {
  const root = evaluated.value
  if (root === null || typeof root !== "object" || Array.isArray(root)) return { keys: [] }
  const info: ParametersInfo = { keys: Object.keys(root).sort() }
  if (root.a11y !== undefined) info.a11y = root.a11y
  if (typeof root.layout === "string") info.layout = root.layout
  if (root.controls !== undefined) info.controls = root.controls
  const docs = root.docs
  if (docs && typeof docs === "object" && !Array.isArray(docs)) {
    const d = docs.description
    if (d && typeof d === "object" && !Array.isArray(d)) {
      info.docsDescription = {
        ...(typeof d.component === "string" ? { component: d.component } : {}),
        ...(typeof d.story === "string" ? { story: d.story } : {})
      }
    }
  }
  return info
}

function readStorySelection(object: ts.ObjectLiteralExpression): {
  include?: Matcher
  exclude?: Matcher
  uncertain: boolean
} {
  const props = objectProperties(object)
  const read = (key: string): { matcher?: Matcher; uncertain: boolean } => {
    const p = props.get(key)
    if (!p || !ts.isPropertyAssignment(p)) return { uncertain: false }
    const matcher = toMatcher(unwrap(p.initializer))
    return matcher ? { matcher, uncertain: false } : { uncertain: true }
  }
  const include = read("includeStories")
  const exclude = read("excludeStories")
  return {
    ...(include.matcher ? { include: include.matcher } : {}),
    ...(exclude.matcher ? { exclude: exclude.matcher } : {}),
    uncertain: include.uncertain || exclude.uncertain
  }
}

type Matcher = (name: string) => boolean

function toMatcher(node: ts.Expression): Matcher | undefined {
  if (ts.isRegularExpressionLiteral(node)) {
    const body = node.text.slice(1, node.text.lastIndexOf("/"))
    const flags = node.text.slice(node.text.lastIndexOf("/") + 1)
    try {
      const re = new RegExp(body, flags)
      return (name) => re.test(name)
    } catch {
      return undefined
    }
  }
  if (ts.isStringLiteralLike(node)) return (name) => name === node.text
  if (ts.isArrayLiteralExpression(node)) {
    const parts = node.elements.map((e) => toMatcher(unwrap(e)))
    return parts.every((p) => p !== undefined) ? (name) => parts.some((p) => (p as Matcher)(name)) : undefined
  }
  return undefined
}

function isSelected(name: string, selection: { include?: Matcher; exclude?: Matcher }): boolean {
  if (selection.include && !selection.include(name)) return false
  if (selection.exclude?.(name)) return false
  return true
}

function resolveTarget(analysis: Analysis, node: ts.Node, via: ComponentTarget["via"]): ComponentTarget {
  const { checker } = analysis
  const text = collapse(node.getText())
  const symbolNode =
    ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isQualifiedName(node)
      ? node
      : undefined
  const decl =
    symbolNode && !ts.isQualifiedName(symbolNode)
      ? jsxTargetDeclaration(checker, symbolNode as ts.JsxTagNameExpression)
      : undefinedDeclaration(checker, node)
  if (decl && isProjectNode(analysis, decl)) {
    const name = declarationName(decl)
    const file = relativeFileOf(analysis, decl)
    if (file && name) return { file, name, text, via }
  }
  const importSpecifier = importOf(checker, node)
  if (importSpecifier?.startsWith(".")) {
    // Single-file components (`./Button.vue`) are not TypeScript modules, so they are linked by file
    // and the PascalCase component name, the same key the Vue adapter publishes.
    const from = relativeFileOf(analysis, node)
    const resolved = from ? posix.normalize(posix.join(posix.dirname(from), importSpecifier)) : undefined
    if (resolved?.endsWith(".vue") && analysis.hasFile(resolved))
      return { file: resolved, name: componentNameFromFile(resolved), text, via }
  }
  if (importSpecifier) {
    return importSpecifier.startsWith(".")
      ? { text, via, unresolvedModule: importSpecifier }
      : { text, via, external: importSpecifier }
  }
  return { text, via }
}

function undefinedDeclaration(checker: ts.TypeChecker, node: ts.Node): ts.Node | undefined {
  const symbol = checker.getSymbolAtLocation(node)
  return declarationOf(resolveSymbol(checker, symbol))
}

/** Module specifier of the import that brought the leftmost identifier of `node` into scope. */
function importOf(checker: ts.TypeChecker, node: ts.Node): string | undefined {
  let root: ts.Node = node
  while (ts.isPropertyAccessExpression(root)) root = root.expression
  while (ts.isQualifiedName(root)) root = root.left
  const symbol = checker.getSymbolAtLocation(root)
  const decl = symbol?.declarations?.[0]
  let cursor: ts.Node | undefined = decl
  while (cursor && !ts.isImportDeclaration(cursor)) cursor = cursor.parent
  return cursor && ts.isImportDeclaration(cursor) && ts.isStringLiteral(cursor.moduleSpecifier)
    ? cursor.moduleSpecifier.text
    : undefined
}

function declarationName(decl: ts.Node): string | undefined {
  const named = decl as { name?: ts.Node }
  if (named.name && ts.isIdentifier(named.name)) return named.name.text
  if (ts.isExportAssignment(decl)) {
    const base = posix.basename(decl.getSourceFile().fileName).replace(/\.[^.]+$/, "")
    return base.charAt(0).toUpperCase() + base.slice(1)
  }
  return undefined
}

function composedComponents(analysis: Analysis, root: ts.Node): CsfStory["composes"] {
  const { checker } = analysis
  const counts = new Map<string, { file: string; name: string; count: number }>()
  const visit = (n: ts.Node): void => {
    if (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) {
      const tag = n.tagName
      if (!(ts.isIdentifier(tag) && /^[a-z]/.test(tag.text))) {
        const decl = jsxTargetDeclaration(checker, tag)
        if (decl && isProjectNode(analysis, decl)) {
          const file = relativeFileOf(analysis, decl)
          const name = declarationName(decl)
          if (file && name) {
            const key = `${file}#${name}`
            const entry = counts.get(key) ?? { file, name, count: 0 }
            entry.count++
            counts.set(key, entry)
          }
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(root)
  return [...counts.values()].sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : a.name < b.name ? -1 : 1
  )
}

function inspectPlay(node: ts.Node): { calls: string[]; steps: string[] } {
  const calls = new Set<string>()
  const steps: string[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = calleeName(n.expression)
      if (calls.size < MAX_CALLS) calls.add(callee)
      const first = n.arguments[0]
      if (callee === "step" && first && ts.isStringLiteralLike(first)) steps.push(first.text)
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return { calls: [...calls].sort(), steps }
}

/** `expect(x).toBe(y)` becomes `expect().toBe`, so call arguments never leak into the call list. */
function calleeName(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression))
    return `${calleeName(expression.expression)}.${expression.name.text}`
  if (ts.isCallExpression(expression)) return `${calleeName(expression.expression)}()`
  if (
    ts.isAwaitExpression(expression) ||
    ts.isParenthesizedExpression(expression) ||
    ts.isNonNullExpression(expression)
  )
    return calleeName(expression.expression)
  return "<expression>"
}

function objectProperties(object: ts.ObjectLiteralExpression): Map<string, ts.ObjectLiteralElementLike> {
  const out = new Map<string, ts.ObjectLiteralElementLike>()
  for (const p of object.properties) {
    const name = p.name
    if (name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name))) out.set(name.text, p)
  }
  return out
}

/** A real syntax node to cite as evidence: synthetic assignment wrappers are replaced by their initializer. */
function evidenceNode(property: ts.ObjectLiteralElementLike | undefined): ts.Node | undefined {
  if (!property) return undefined
  return (property as { synthetic?: boolean }).synthetic && ts.isPropertyAssignment(property)
    ? property.initializer
    : property
}

/** Adapts a `Story.key = value` assignment to the property-assignment shape the readers expect. */
function fakeAssignment(key: string, expression: ts.Expression): ts.PropertyAssignment {
  return {
    kind: ts.SyntaxKind.PropertyAssignment,
    name: { kind: ts.SyntaxKind.Identifier, text: key } as unknown as ts.Identifier,
    initializer: expression,
    synthetic: true
  } as unknown as ts.PropertyAssignment
}
