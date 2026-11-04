import { irDocumentSchema, serializeIrDocument, verifyIrDocument } from "@invariant/compiler-ir"
import { canonicalStringify, hasErrors } from "@invariant/shared"
import type { SourceAdapter } from "../adapter.js"
import { type CompileOptions, compile } from "../compile.js"
import { discoverProject } from "../discovery/index.js"

export { memoryFs, type ReadonlyFs } from "../fs.js"

/** A clock that always returns the same instant, for reproducible artifacts in tests. */
export const FIXED_CLOCK = (): string => "2026-01-01T00:00:00.000Z"

/**
 * Conformance checks every source adapter must pass. Returns human-readable violations (empty when
 * the adapter conforms), so it works with any test runner.
 */
export async function checkAdapterConformance(
  adapter: SourceAdapter,
  options: Pick<CompileOptions, "fs">
): Promise<string[]> {
  const violations: string[] = []
  const project = await discoverProject({ fs: options.fs })
  const before = canonicalStringify(project)
  const typed = adapter
  const first = await typed.discover({ fs: options.fs, project })
  const second = await typed.discover({ fs: options.fs, project })
  if (canonicalStringify(first) !== canonicalStringify(second))
    violations.push("discover() is not deterministic")
  const ids = new Set<string>()
  for (const source of first.sources) {
    if (source.type !== adapter.type)
      violations.push(`source ${source.id} has type ${source.type}, adapter declares ${adapter.type}`)
    if (ids.has(source.id)) violations.push(`duplicate source id ${source.id}`)
    ids.add(source.id)
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(source.id))
      violations.push(`source id ${source.id} is not a valid slug`)
    if (!/^[0-9a-f]{64}$/.test(source.inputHash))
      violations.push(`source ${source.id} has no valid inputHash`)

    const context = { fs: options.fs, project, source, clock: FIXED_CLOCK }
    const a = await typed.extract(context, source.config)
    const b = await typed.extract(context, source.config)
    if (!irDocumentSchema.safeParse(a.ir).success) {
      violations.push(`extract(${source.id}) returned an IR document that fails the schema`)
      continue
    }
    if (serializeIrDocument(a.ir) !== serializeIrDocument(b.ir))
      violations.push(`extract(${source.id}) is not deterministic`)
    if (a.ir.source.id !== source.id)
      violations.push(`IR source id ${a.ir.source.id} differs from discovered ${source.id}`)
    if (a.ir.source.adapter.name !== adapter.id)
      violations.push(`IR names adapter ${a.ir.source.adapter.name}, expected ${adapter.id}`)
    const problems = verifyIrDocument(a.ir)
    if (hasErrors(problems))
      violations.push(
        `IR for ${source.id} has errors: ${problems
          .filter((p) => p.severity === "error")
          .map((p) => p.code)
          .join(", ")}`
      )
    const validation = await typed.validate({ project, source, ir: a.ir })
    if (!Array.isArray(validation)) violations.push(`validate(${source.id}) did not return diagnostics`)
  }
  if (canonicalStringify(project) !== before)
    violations.push("an adapter mutated the shared project discovery")
  return violations
}

/**
 * Compiles twice with different clocks. Everything except evidence capture times must match, and the
 * time-independent IR content hashes must be equal.
 */
export async function checkCompileDeterminism(options: Omit<CompileOptions, "clock">): Promise<string[]> {
  const violations: string[] = []
  const a = await compile({ ...options, clock: () => "2026-01-01T00:00:00.000Z" })
  const b = await compile({ ...options, clock: () => "2031-06-30T12:34:56.000Z" })
  if (canonicalStringify(a.project) !== canonicalStringify(b.project))
    violations.push("project discovery differs between runs")
  if (canonicalStringify(a.diagnostics) !== canonicalStringify(b.diagnostics))
    violations.push("diagnostics differ between runs")
  if (canonicalStringify(a.sources) !== canonicalStringify(b.sources))
    violations.push("source summaries (including irContentHash) differ between runs")
  const strip = (text: string): string => text.replace(/"capturedAt": "[^"]+"/g, '"capturedAt": "-"')
  a.irDocuments.forEach((doc, i) => {
    const other = b.irDocuments[i]
    if (!other || strip(serializeIrDocument(doc)) !== strip(serializeIrDocument(other)))
      violations.push(`IR ${doc.source.id} differs beyond capture times`)
  })
  return violations
}
