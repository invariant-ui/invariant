import { computeEvidenceId } from "@invariant/contract"
import { type Diagnostic, sortDiagnostics } from "@invariant/diagnostics"
import { canonicalStringify, hashJson } from "@invariant/shared"
import type { z } from "zod"
import { IR_VERSION, type IrDocument, irDocumentSchema } from "./ir.js"

export type ParseResult<T> = { ok: true; value: T } | { ok: false; diagnostics: Diagnostic[] }

export function parseIrDocument(input: unknown): ParseResult<IrDocument> {
  const version =
    typeof input === "object" && input !== null ? (input as { irVersion?: unknown }).irVersion : undefined
  if (typeof version === "string" && version.split(".")[0] !== IR_VERSION.split(".")[0]) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "ir.unsupported-version",
          severity: "error",
          message: `IR version ${version} is not supported; this build reads ${IR_VERSION}`
        }
      ]
    }
  }
  const result = irDocumentSchema.safeParse(input)
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, diagnostics: schemaDiagnostics(result.error) }
}

/** Sorts every collection so the same logical document always serializes identically. */
export function canonicalizeIrDocument(doc: IrDocument): IrDocument {
  return {
    ...doc,
    capabilities: [...new Set(doc.capabilities)].sort(),
    entities: [...doc.entities].sort((a, b) => cmp(a.ref, b.ref)),
    facts: [...doc.facts].sort(
      (a, b) =>
        cmp(a.subject, b.subject) ||
        cmp(a.path, b.path) ||
        cmp(canonicalStringify(a.value), canonicalStringify(b.value))
    ),
    evidence: [...doc.evidence].sort((a, b) => cmp(a.id, b.id)),
    diagnostics: sortDiagnostics(doc.diagnostics)
  }
}

/**
 * Content hash of an IR document excluding evidence capture times, so re-running extraction on
 * unchanged inputs yields the same hash even though `capturedAt` differs.
 */
export function computeIrContentHash(doc: IrDocument): string {
  const canonical = canonicalizeIrDocument(doc)
  return hashJson({
    ...canonical,
    evidence: canonical.evidence.map(({ capturedAt: _capturedAt, ...rest }) => rest)
  })
}

export function serializeIrDocument(doc: IrDocument): string {
  return `${canonicalStringify(canonicalizeIrDocument(doc), 2)}\n`
}

/** `*` matches exactly one path segment. */
export function matchesCapability(pattern: string, path: string): boolean {
  const p = pattern.split(".")
  const s = path.split(".")
  if (p.length > s.length) return false
  // A capability covers its subtree: `props.*.default` covers `props.size.default.text`.
  return p.every((segment, i) => segment === "*" || segment === s[i])
}

/** Semantic validation of an IR document. Never throws; returns diagnostics. */
export function verifyIrDocument(doc: IrDocument): Diagnostic[] {
  const found: Diagnostic[] = []
  const sourceId = doc.source.id
  const add = (severity: Diagnostic["severity"], code: string, message: string): void => {
    found.push({ code, severity, message, sourceId })
  }

  const refs = new Set<string>()
  for (const entity of doc.entities) {
    if (refs.has(entity.ref)) add("error", "ir.duplicate-entity-ref", `Duplicate entity ref ${entity.ref}`)
    refs.add(entity.ref)
  }

  const evidenceIds = new Set<string>()
  for (const evidence of doc.evidence) {
    if (evidenceIds.has(evidence.id))
      add("error", "ir.duplicate-evidence", `Duplicate evidence ${evidence.id}`)
    evidenceIds.add(evidence.id)
    if (computeEvidenceId(evidence) !== evidence.id)
      add("error", "ir.evidence-id-mismatch", `Evidence ${evidence.id} id does not match its content`)
    if (evidence.sourceId !== sourceId)
      add(
        "error",
        "ir.evidence-source-mismatch",
        `Evidence ${evidence.id} belongs to source ${evidence.sourceId}, not ${sourceId}`
      )
    if (evidence.method === "llm-assisted") {
      add(
        "error",
        "ir.llm-evidence",
        `Evidence ${evidence.id} is LLM-assisted; adapters must be deterministic (model output belongs to the semantic engine)`
      )
    }
  }

  const seen = new Map<string, string>()
  for (const fact of doc.facts) {
    if (!refs.has(fact.subject))
      add("error", "ir.unknown-subject", `Fact '${fact.path}' targets unknown entity ${fact.subject}`)
    for (const id of fact.evidenceIds) {
      if (!evidenceIds.has(id))
        add(
          "error",
          "ir.unknown-evidence",
          `Fact ${fact.subject} '${fact.path}' cites missing evidence ${id}`
        )
    }
    if (!doc.capabilities.some((pattern) => matchesCapability(pattern, fact.path))) {
      add(
        "warning",
        "ir.undeclared-capability",
        `Fact ${fact.subject} '${fact.path}' is outside the adapter's declared capabilities`
      )
    }
    const key = `${fact.subject}\u0000${fact.path}`
    const value = canonicalStringify(fact.value)
    const previous = seen.get(key)
    if (previous !== undefined && previous !== value) {
      add("warning", "ir.conflicting-facts", `Source disagrees with itself at ${fact.subject} '${fact.path}'`)
    }
    seen.set(key, value)
  }
  return sortDiagnostics(found)
}

function schemaDiagnostics(error: z.ZodError): Diagnostic[] {
  return sortDiagnostics(
    error.issues.map((issue) => ({
      code: "ir.invalid-schema",
      severity: "error" as const,
      message: `${issue.path.reduce<string>((acc, part) => (typeof part === "number" ? `${acc}[${part}]` : `${acc}.${String(part)}`), "$")}: ${issue.message}`
    }))
  )
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
