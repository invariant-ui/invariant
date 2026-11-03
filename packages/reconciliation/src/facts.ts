import type { IrDocument, IrFact } from "@invariant/compiler-ir"

/** Facts of one document grouped by subject and path, for cheap lookup. */
export class FactIndex {
  readonly doc: IrDocument
  private readonly bySubject = new Map<string, Map<string, IrFact[]>>()
  private readonly evidence = new Map<string, IrDocument["evidence"][number]>()

  constructor(doc: IrDocument) {
    this.doc = doc
    for (const e of doc.evidence) this.evidence.set(e.id, e)
    for (const fact of doc.facts) {
      const paths = this.bySubject.get(fact.subject) ?? new Map<string, IrFact[]>()
      paths.set(fact.path, [...(paths.get(fact.path) ?? []), fact])
      this.bySubject.set(fact.subject, paths)
    }
  }

  get(subject: string, path: string): IrFact | undefined {
    return this.bySubject.get(subject)?.get(path)?.[0]
  }

  value<T = unknown>(subject: string, path: string): T | undefined {
    return this.get(subject, path)?.value as T | undefined
  }

  /** Paths under `prefix.` for a subject, as the first segment after the prefix. */
  children(subject: string, prefix: string): string[] {
    const names = new Set<string>()
    for (const path of this.bySubject.get(subject)?.keys() ?? []) {
      if (path.startsWith(`${prefix}.`)) names.add(path.slice(prefix.length + 1).split(".")[0] as string)
    }
    return [...names].sort()
  }

  evidenceIds(subject: string, path: string): string[] {
    return this.get(subject, path)?.evidenceIds ?? []
  }

  location(evidenceId: string | undefined): { path: string; line?: number } | undefined {
    const location = (evidenceId ? this.evidence.get(evidenceId) : undefined)?.location
    if (location?.type !== "file") return undefined
    return { path: location.path, ...(location.line ? { line: location.line } : {}) }
  }
}
