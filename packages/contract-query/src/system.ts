import type {
  Component,
  Contract,
  Evidence,
  EvidenceFile,
  FactRecord,
  Pattern,
  Token,
  TokenValue
} from "@invariant/contract"
import type { JsonValue } from "@invariant/shared"

export interface FactView {
  status: FactRecord["status"]
  confidence?: number
  rule?: string
  /** First evidence location, `path:line`, when the evidence is a file. */
  source?: string
}

export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
export const normalize = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "")

/**
 * Read model over one compiled contract and its evidence. Pure and deterministic: it never touches the
 * file system, a network or a model, and everything it returns is plain JSON.
 */
export class DesignSystem {
  readonly contract: Contract
  readonly contentHash: string
  private readonly evidence = new Map<string, Evidence>()
  private readonly byId = new Map<string, Component>()
  private readonly patternsById = new Map<string, Pattern>()
  private readonly containers = new Map<string, Array<{ id: string; fact?: FactRecord }>>()

  constructor(contract: Contract, evidence?: EvidenceFile) {
    this.contract = contract
    this.contentHash = contract.integrity.contentHash
    for (const e of evidence?.evidence ?? []) this.evidence.set(e.id, e)
    for (const c of contract.components) this.byId.set(c.id, c)
    for (const p of contract.patterns) this.patternsById.set(p.id, p)
    for (const c of contract.components)
      c.composition.forEach((r, i) => {
        if (r.type !== "contains") return
        const list = this.containers.get(r.target) ?? []
        const fact = c.facts[`composition.${i}`]
        list.push({ id: c.id, ...(fact ? { fact } : {}) })
        this.containers.set(r.target, list)
      })
  }

  component(id: string): Component | undefined {
    return this.byId.get(id)
  }

  /** Resolves an id, an id without its prefix, or a name (ignoring case and separators). */
  findComponent(query: string): { match?: Component; candidates: Component[] } {
    const q = query.trim()
    const exact = this.byId.get(q) ?? this.byId.get(`component:${q.toLowerCase()}`)
    if (exact) return { match: exact, candidates: [exact] }
    const n = normalize(q)
    const named = this.contract.components.filter(
      (c) => normalize(c.name) === n || normalize(c.id.slice(10)) === n
    )
    if (named.length === 1) return { match: named[0] as Component, candidates: named }
    if (named.length > 1) return { candidates: named }
    const near = this.contract.components
      .filter((c) => n.length >= 2 && (normalize(c.name).includes(n) || n.includes(normalize(c.name))))
      .slice(0, 8)
    return { candidates: near }
  }

  pattern(id: string): Pattern | undefined {
    return this.patternsById.get(id)
  }

  /**
   * Resolves a pattern by id, by id without its prefix (`page.data-management`), by the part after the
   * category (`data-management`), or by name, ignoring case and separators. Several matches yield candidates only.
   */
  findPattern(query: string): { match?: Pattern; candidates: Pattern[] } {
    const q = query.trim()
    const exact = this.patternsById.get(q) ?? this.patternsById.get(`pattern:${q.toLowerCase()}`)
    if (exact) return { match: exact, candidates: [exact] }
    const n = normalize(q)
    const named = this.contract.patterns.filter((p) => {
      const body = p.id.slice("pattern:".length)
      const afterCategory = body.includes(".") ? body.slice(body.indexOf(".") + 1) : body
      return normalize(p.name) === n || normalize(body) === n || normalize(afterCategory) === n
    })
    if (named.length === 1) return { match: named[0] as Pattern, candidates: named }
    if (named.length > 1) return { candidates: named }
    const near = this.contract.patterns
      .filter((p) => n.length >= 2 && (normalize(p.name).includes(n) || n.includes(normalize(p.name))))
      .slice(0, 8)
    return { candidates: near }
  }

  /** The evidence entries for these ids, in the given order. Ids missing from the evidence file are skipped. */
  evidenceEntries(ids: readonly string[]): Evidence[] {
    return ids.flatMap((id) => {
      const e = this.evidence.get(id)
      return e ? [e] : []
    })
  }

  containedBy(id: string): Array<{ id: string; fact?: FactRecord }> {
    return this.containers.get(id) ?? []
  }

  location(ids: readonly string[]): string | undefined {
    for (const id of ids) {
      const e = this.evidence.get(id)
      if (!e) continue
      if (e.location.type === "file")
        return `${e.location.path}${e.location.line ? `:${e.location.line}` : ""}`
      return e.sourceRef
    }
    return undefined
  }

  factView(facts: Record<string, FactRecord>, path: string): FactView | undefined {
    const f = facts[path]
    if (!f) return undefined
    const source = this.location(f.evidenceIds)
    return {
      status: f.status,
      ...(f.confidence === undefined ? {} : { confidence: f.confidence }),
      ...(f.derivation ? { rule: f.derivation.rule } : {}),
      ...(source ? { source } : {})
    }
  }

  /** True when the implementation's props are fully enumerated, so an absent prop really is absent. */
  propsComplete(c: Component, framework?: string): boolean {
    const impls = c.implementations.filter((i) => !framework || i.framework === framework)
    if (impls.length === 0) return false
    return impls.every(
      (i) => (i.extensions?.[i.framework] as { propsComplete?: unknown } | undefined)?.propsComplete === true
    )
  }

  conflictsFor(subject: string): Contract["conflicts"] {
    return this.contract.conflicts.filter((c) => c.subject === subject)
  }

  /** Follows aliases to a literal. A cycle or a missing target yields no value rather than a guess. */
  resolveToken(token: Token, theme?: string): { value?: JsonValue; chain: string[]; note?: string } {
    const chain = [token.id]
    let current: Token | undefined = token
    for (let i = 0; i < 20 && current; i++) {
      const form: TokenValue = theme
        ? (current.modes?.[theme as keyof NonNullable<Token["modes"]>] ?? current.value)
        : current.value
      if (form.aliasOf === undefined) return { value: form.value as JsonValue, chain }
      const next: Token | undefined = this.contract.tokens.find((t) => t.id === form.aliasOf)
      if (!next)
        return {
          chain: [...chain, form.aliasOf],
          note: `alias target ${form.aliasOf} is not in the contract`
        }
      if (chain.includes(next.id)) return { chain: [...chain, next.id], note: "alias cycle" }
      chain.push(next.id)
      current = next
    }
    return { chain, note: "alias chain too long" }
  }
}

export const sanitizeName = (text: string): string => text.replace(/[^A-Za-z0-9 ._:/@-]/g, "").slice(0, 80)
