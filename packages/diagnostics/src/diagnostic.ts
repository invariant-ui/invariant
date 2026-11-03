import { z } from "zod"

export const severitySchema = z.enum(["error", "warning", "info"])
export type Severity = z.infer<typeof severitySchema>

export const diagnosticLocationSchema = z.strictObject({
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional()
})
export type DiagnosticLocation = z.infer<typeof diagnosticLocationSchema>

/** Codes are `area.kebab-name`, for example `contract.dangling-reference`. */
export const diagnosticCodeSchema = z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/)

export const diagnosticSchema = z.strictObject({
  code: diagnosticCodeSchema,
  severity: severitySchema,
  message: z.string().min(1),
  sourceId: z.string().min(1).optional(),
  entityId: z.string().min(1).optional(),
  location: diagnosticLocationSchema.optional(),
  hint: z.string().min(1).optional()
})
export type Diagnostic = z.infer<typeof diagnosticSchema>

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 }

export function diagnostic(input: Diagnostic): Diagnostic {
  return diagnosticSchema.parse(input)
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error")
}

/** Total order so diagnostic output is identical regardless of discovery order. */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort(compareDiagnostics)
}

function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    cmp(a.code, b.code) ||
    cmp(a.sourceId ?? "", b.sourceId ?? "") ||
    cmp(a.entityId ?? "", b.entityId ?? "") ||
    cmp(a.location?.path ?? "", b.location?.path ?? "") ||
    (a.location?.line ?? 0) - (b.location?.line ?? 0) ||
    (a.location?.column ?? 0) - (b.location?.column ?? 0) ||
    cmp(a.message, b.message)
  )
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export const DIAGNOSTICS_FILE_VERSION = "1.0.0"

export const diagnosticsFileSchema = z.strictObject({
  diagnosticsVersion: z.literal(DIAGNOSTICS_FILE_VERSION),
  diagnostics: z.array(diagnosticSchema)
})
export type DiagnosticsFile = z.infer<typeof diagnosticsFileSchema>

type Extra = Omit<Diagnostic, "code" | "severity" | "message">

/** Accumulates diagnostics during a run. Output is always sorted, so discovery order never leaks. */
export class DiagnosticCollector {
  private readonly items: Diagnostic[] = []
  private readonly defaults: Extra

  constructor(defaults: Extra = {}) {
    this.defaults = defaults
  }

  add(input: Diagnostic): void {
    this.items.push(diagnostic({ ...this.defaults, ...input }))
  }

  error(code: string, message: string, extra: Extra = {}): void {
    this.add({ ...extra, code, severity: "error", message })
  }

  warning(code: string, message: string, extra: Extra = {}): void {
    this.add({ ...extra, code, severity: "warning", message })
  }

  info(code: string, message: string, extra: Extra = {}): void {
    this.add({ ...extra, code, severity: "info", message })
  }

  addAll(inputs: readonly Diagnostic[]): void {
    for (const input of inputs) this.add(input)
  }

  hasErrors(): boolean {
    return hasErrors(this.items)
  }

  toArray(): Diagnostic[] {
    return sortDiagnostics(this.items)
  }
}
