import {
  createAnalysis,
  declarationOf,
  isProjectNode,
  jsxTargetDeclaration,
  lineOf,
  posix,
  relativeFileOf,
  resolveSymbol,
  subTarget,
  tsconfigPaths,
  unwrap
} from "@invariant/compiler-core"
import type { Diagnostic } from "@invariant/shared"
import ts from "typescript"
import {
  type AccessibilityInfo,
  accessibilityOf,
  type DocInfo,
  docsOf,
  type SlotInfo,
  slotsOf
} from "./behavior.js"
import { type Candidate, classifyCompound, classifyDeclaration } from "./detect.js"
import { extractProps, type PropsResult } from "./props.js"
import { type StylingInfo, stylingOf } from "./styling.js"
import { analyzeUsage, type UsageStats } from "./usage.js"
import { type VariantInfo, variantsOf } from "./variants.js"

export interface ComponentAnalysis {
  /** IR entity reference, unique within the package. */
  ref: string
  candidate: Candidate
  displayName: string
  file: string
  line: number
  exports: Array<{ subpath: string; name: string }>
  props: PropsResult
  variants: VariantInfo[]
  slots: SlotInfo[]
  accessibility?: AccessibilityInfo
  docs: DocInfo
  styling?: StylingInfo
  usage?: UsageStats
  renders: Array<{ target: string; count: number }>
  compoundParent?: string
  subcomponents: Array<{ key: string; ref: string }>
}

export interface PackageAnalysis {
  components: ComponentAnalysis[]
  diagnostics: Diagnostic[]
  /** Project files that were type-checked (excluding tests and stories). */
  analyzedFiles: string[]
}

const NON_SOURCE = /\.(?:test|spec|stories)\.[cm]?[jt]sx?$|(?:^|\/)__(?:tests|mocks)__\//

export interface PackageInput {
  packageName?: string
  /** Project-relative package directory, for tsconfig `paths`. */
  packageDir: string
  entryPoints: ReadonlyArray<{ subpath: string; file?: string | undefined; resolution: string }>
  /** Project-relative path -> text, for every source and CSS file of the package. */
  files: ReadonlyMap<string, string>
  /** Type packages the checker reads but whose declarations are not the package's own (`@types/react`, `csstype`). */
  typeFiles?: ReadonlyMap<string, string>
  tailwind: boolean
}

/** Finds the package's public React components (exports of its entry points) and analyzes each. */
export function analyzePackage(input: PackageInput): PackageAnalysis {
  const diagnostics: Diagnostic[] = []
  const analysis = createAnalysis(input.files, {
    paths: tsconfigPaths(input.files, input.packageDir),
    ...(input.typeFiles ? { externalFiles: input.typeFiles } : {})
  })
  const { checker } = analysis
  const note = (severity: Diagnostic["severity"], code: string, message: string, node?: ts.Node): void => {
    const file = node ? relativeFileOf(analysis, node) : undefined
    diagnostics.push({
      code,
      severity,
      message,
      ...(file && node ? { location: { path: file, line: lineOf(node) } } : {})
    })
  }

  // 1. Public candidates: whatever the entry points export.
  const candidates = new Map<ts.Node, Candidate & { exports: Array<{ subpath: string; name: string }> }>()
  for (const entry of input.entryPoints) {
    const sf = entry.file ? analysis.sourceFile(entry.file) : undefined
    if (!entry.file || entry.resolution === "unresolved" || !sf) {
      // Stylesheets, JSON and the like are entries a component library lists but not modules to analyze.
      if (entry.file && /\.[cm]?[jt]sx?$/.test(entry.file))
        note(
          "warning",
          "react.entry-not-analyzed",
          `Entry ${entry.subpath} (${entry.file}) is not a TypeScript or JavaScript module in the analyzed files`
        )
      continue
    }
    const moduleSymbol = checker.getSymbolAtLocation(sf)
    if (!moduleSymbol) continue
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const resolved = resolveSymbol(checker, exported)
      const decl = declarationOf(resolved)
      if (!decl || !isProjectNode(analysis, decl)) continue
      const result = classifyDeclaration(
        checker,
        decl,
        exported.name === "default" ? baseName(decl) : exported.name
      )
      if (!result) {
        // A declaration file's `{ Root: typeof X }` object: its members are the components.
        const compound = classifyCompound(
          checker,
          decl,
          exported.name === "default" ? baseName(decl) : exported.name
        )
        if (compound) {
          for (const { key, candidate } of compound) {
            const displayName = `${exported.name}.${key}`
            const existingChild = candidates.get(candidate.decl)
            const exportEntry = { subpath: entry.subpath, name: displayName }
            if (existingChild) existingChild.exports.push(exportEntry)
            else candidates.set(candidate.decl, { ...candidate, displayName, exports: [exportEntry] })
          }
          continue
        }
        if (looksLikeFactoryComponent(decl, exported.name)) {
          note(
            "info",
            "react.unclassified-export",
            `${exported.name} is a Pascal-case export created by a function call, so it could not be classified as a component statically`,
            decl
          )
        }
        continue
      }
      if ("hoc" in result) {
        note(
          "info",
          "react.higher-order-component",
          `${result.name} returns a component (a higher-order component) and was not analyzed`,
          result.node
        )
        continue
      }
      const key = result.decl
      const existing = candidates.get(key)
      if (existing) existing.exports.push({ subpath: entry.subpath, name: exported.name })
      else candidates.set(key, { ...result, exports: [{ subpath: entry.subpath, name: exported.name }] })
    }
  }

  // 2. Compound children become components of their own, named `Parent.Child`.
  const parents = new Map<Candidate, Candidate>()
  const children: Array<Candidate & { exports: Array<{ subpath: string; name: string }> }> = []
  const queue: Candidate[] = [...candidates.values()]
  for (let i = 0; i < queue.length; i++) {
    const parent = queue[i] as Candidate
    for (const sub of parent.subcomponents) {
      // A declaration file's `Item: (props: P) => JSX.Element` member is its own declaration.
      const decl = ts.isPropertySignature(sub.target) ? sub.target : subTarget(checker, sub.target)
      if (!decl) continue
      const child = classifyDeclaration(checker, decl, sub.key)
      if (!child || "hoc" in child || candidates.has(child.decl)) continue
      const named = { ...child, displayName: `${parent.displayName ?? parent.name}.${sub.key}`, exports: [] }
      parents.set(named, parent)
      children.push(named)
      queue.push(named)
    }
  }
  for (const child of children) candidates.set(child.decl, child)

  // 3. Per-component facts.
  const list = [...candidates.values()].sort((a, b) =>
    cmp(`${relOf(analysis, a.decl)}#${a.name}`, `${relOf(analysis, b.decl)}#${b.name}`)
  )
  const refs = new Map<Candidate, string>()
  const usedRefs = new Set<string>()
  for (const c of list) {
    let ref = `react:${relOf(analysis, c.decl)}#${c.name}`
    if (usedRefs.has(ref)) ref = `${ref}@${lineOf(c.decl)}`
    usedRefs.add(ref)
    refs.set(c, ref)
  }

  const sources = [...input.files.keys()]
    .filter((f) => /\.(?:[cm]?[jt]sx?)$/.test(f) && !NON_SOURCE.test(f))
    .sort()
  const byDecl = new Map<ts.Node, Candidate>()
  for (const c of list) {
    byDecl.set(c.decl, c)
    if (c.impl) byDecl.set(c.impl, c)
  }
  const propsByCandidate = new Map<Candidate, PropsResult>()
  for (const c of list) propsByCandidate.set(c, extractProps(analysis, c))

  const usage = analyzeUsage({
    analysis,
    files: sources,
    resolveTarget: (tag) => {
      const decl = jsxTargetDeclaration(checker, tag)
      return decl ? byDecl.get(decl) : undefined
    },
    enclosing: (node) => {
      for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
        const found = byDecl.get(n)
        if (found) return found
        if (ts.isVariableDeclaration(n) && byDecl.has(n)) return byDecl.get(n)
      }
      return undefined
    },
    declared: (c) => {
      const props = propsByCandidate.get(c)
      return { names: new Set(props?.props.map((p) => p.name) ?? []), closed: props?.complete === true }
    }
  })

  const components: ComponentAnalysis[] = list.map((c) => {
    const props = propsByCandidate.get(c) as PropsResult
    for (const name of props.skipped)
      note(
        "info",
        "react.unsupported-prop-name",
        `Prop "${name}" of ${c.name} cannot be addressed by a fact path and was skipped`,
        c.decl
      )
    if (props.props.length === 0 && !props.complete && props.notes.length > 0)
      note("warning", "react.props-unresolved", `${c.name}: ${props.notes[0]}`, c.decl)
    const parent = parents.get(c)
    const stats = usage.byTarget.get(c)
    const accessibility = accessibilityOf(c)
    const styling = stylingOf(analysis, c, { files: input.files, tailwind: input.tailwind })
    return {
      ref: refs.get(c) as string,
      candidate: c,
      displayName: c.displayName ?? c.name,
      file: relOf(analysis, c.decl),
      line: lineOf(c.decl),
      exports: [...c.exports].sort((a, b) => cmp(a.subpath, b.subpath) || cmp(a.name, b.name)),
      props,
      variants: variantsOf(analysis, c, props.props),
      slots: slotsOf(props.props),
      ...(accessibility ? { accessibility } : {}),
      docs: docsOf(analysis, c),
      ...(styling ? { styling } : {}),
      ...(stats ? { usage: stats } : {}),
      renders: [...(usage.renders.get(c) ?? [])]
        .map(([target, count]) => ({ target: refs.get(target) as string, count }))
        .sort((a, b) => cmp(a.target, b.target)),
      ...(parent ? { compoundParent: refs.get(parent) as string } : {}),
      subcomponents: c.subcomponents.flatMap((s) => {
        const child = children.find((x) => x.displayName === `${c.displayName ?? c.name}.${s.key}`)
        return child ? [{ key: s.key, ref: refs.get(child) as string }] : []
      })
    }
  })
  return { components, diagnostics, analyzedFiles: sources }
}

/** `export const Slot = createSlot(…)`: possibly a component made by a factory, which static analysis cannot confirm. */
function looksLikeFactoryComponent(decl: ts.Node, exportName: string): boolean {
  if (!ts.isVariableDeclaration(decl) || !decl.initializer || !ts.isIdentifier(decl.name)) return false
  const name = exportName === "default" ? decl.name.text : exportName
  const init = unwrap(decl.initializer)
  return /^[A-Z]/.test(name) && !/^[A-Z0-9_]+$/.test(name) && ts.isCallExpression(init)
}

function relOf(analysis: ReturnType<typeof createAnalysis>, node: ts.Node): string {
  return relativeFileOf(analysis, node) ?? node.getSourceFile().fileName
}

function baseName(decl: ts.Node): string {
  const base = posix.basename(decl.getSourceFile().fileName).replace(/\.[^.]+$/, "")
  return base.charAt(0).toUpperCase() + base.slice(1)
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
