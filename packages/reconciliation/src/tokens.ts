import type { IrDocument, IrFact } from "@invariant/compiler-ir"
import type { Conflict, FactRecord, Theme, Token } from "@invariant/contract"
import type { DiagnosticCollector } from "@invariant/diagnostics"
import type { JsonValue } from "@invariant/shared"
import type { ConflictDraft } from "./components.js"
import type { IdentityLink } from "./resolve.js"
import { cmp, normalizeName, sameValue, setNested, slug, unique } from "./util.js"

type Form = { value: JsonValue } | { aliasOf: string }

interface TokenSource {
  doc: IrDocument
  ref: string
  name: string
  facts: IrFact[]
}

interface Claim {
  src: TokenSource
  form: Form
  status: "discovered" | "documented"
  evidenceIds: string[]
}

export interface TokenResult {
  tokens: Token[]
  themes: Theme[]
  /** Merges of differently spelled token names, to be recorded as inferred identity. */
  identities: Array<{ tokenId: string; link: IdentityLink }>
}

const STATUS = (f: IrFact): "discovered" | "documented" =>
  f.origin === "extracted" ? "discovered" : "documented"
const rank = (s: "discovered" | "documented"): number => (s === "discovered" ? 0 : 1)
const themeId = (mode: string): string => `theme:${slug(mode).replace(/\./g, "-")}`

/** Token entities from design-token adapters: the ones that state a value. Inventory entries do not. */
function sourcesOf(docs: readonly IrDocument[]): TokenSource[] {
  const out: TokenSource[] = []
  for (const doc of docs) {
    const bySubject = new Map<string, IrFact[]>()
    for (const f of doc.facts) bySubject.set(f.subject, [...(bySubject.get(f.subject) ?? []), f])
    for (const e of doc.entities.filter((x) => x.kind === "token")) {
      const facts = bySubject.get(e.ref) ?? []
      if (!facts.some((f) => f.path === "value.value" || f.path === "value.aliasOf")) continue
      const name = facts.find((f) => f.path === "name" && typeof f.value === "string")?.value
      out.push({ doc, ref: e.ref, name: typeof name === "string" ? name : e.name, facts })
    }
  }
  return out.sort((a, b) => cmp(a.doc.source.id, b.doc.source.id) || cmp(a.ref, b.ref))
}

export function buildTokens(
  docs: readonly IrDocument[],
  ctx: { diagnostics: DiagnosticCollector; conflicts: ConflictDraft[] }
): TokenResult {
  const sources = sourcesOf(docs)
  const groups = new Map<string, TokenSource[]>()
  for (const s of sources)
    groups.set(normalizeName(s.name), [...(groups.get(normalizeName(s.name)) ?? []), s])

  const ids = new Map<string, string>()
  const used = new Set<string>()
  const names = new Map<string, string>()
  for (const [key, members] of [...groups.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    const name = members.find((m) => m.name.includes("."))?.name ?? (members[0] as TokenSource).name
    let id = `token:${slug(name)}`
    for (let n = 2; used.has(id); n++) id = `token:${slug(name)}-${n}`
    used.add(id)
    ids.set(key, id)
    names.set(key, name)
  }

  const themes = new Map<string, Theme>()
  const identities: TokenResult["identities"] = []
  const tokens: Token[] = []

  for (const [key, members] of [...groups.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    const id = ids.get(key) as string
    const spellings = unique(members.map((m) => m.name)).sort()
    if (spellings.length > 1) {
      identities.push({
        tokenId: id,
        link: {
          rule: "name-match.token",
          confidence: 0.8,
          reasoning: `${spellings.map((s) => `"${s}"`).join(", ")} differ only in case or separators and are treated as one token`,
          inputs: members.map((m) => m.ref).sort(),
          evidenceIds: unique(
            members.flatMap((m) => m.facts.find((f) => f.path === "name")?.evidenceIds ?? [])
          ).sort()
        }
      })
    }

    const facts: Record<string, FactRecord> = {}
    const extensions: Record<string, Record<string, JsonValue>> = {}
    const slots = new Map<string, Claim[]>()
    let description: { value: string; claim: IrFact } | undefined
    let deprecated: { value: Record<string, JsonValue>; claim: IrFact } | undefined

    for (const src of members) {
      for (const f of src.facts) {
        const seg = f.path.split(".")
        if (
          f.path === "value.value" ||
          f.path === "value.aliasOf" ||
          (seg[0] === "modes" && seg.length === 3 && (seg[2] === "value" || seg[2] === "aliasOf"))
        ) {
          const slot = seg[0] === "modes" ? `modes.${themeId(seg[1] as string)}` : "value"
          if (seg[0] === "modes") {
            const tid = themeId(seg[1] as string)
            if (!themes.has(tid)) themes.set(tid, { id: tid as Theme["id"], name: seg[1] as string })
          }
          let form: Form
          if (seg[seg.length - 1] === "aliasOf") {
            const target = ids.get(normalizeName(String(f.value)))
            if (!target) {
              ctx.diagnostics.warning(
                "reconcile.token-alias-unresolved",
                `${id} aliases "${String(f.value)}", which is not a known token; its source text is kept as a literal`,
                { entityId: id, sourceId: src.doc.source.id }
              )
              const raw = src.facts.find((x) => /^extensions\.[^.]+\.(root\.)?rawValue$/.test(x.path))?.value
              form = { value: raw ?? String(f.value) }
            } else form = { aliasOf: target }
          } else form = { value: f.value }
          slots.set(slot, [
            ...(slots.get(slot) ?? []),
            { src, form, status: STATUS(f), evidenceIds: f.evidenceIds }
          ])
        } else if (f.path === "description" && typeof f.value === "string")
          description ??= { value: f.value, claim: f }
        else if (f.path === "deprecated") {
          deprecated ??= {
            value:
              typeof f.value === "object" && f.value !== null && !Array.isArray(f.value)
                ? (f.value as Record<string, JsonValue>)
                : {},
            claim: f
          }
        } else if (
          seg[0] === "extensions" &&
          seg.length >= 3 &&
          /^[a-z0-9][a-z0-9._-]*$/.test(seg[1] as string) &&
          seg[1] !== "invariant"
        ) {
          extensions[seg[1] as string] ??= {}
          if (setNested(extensions[seg[1] as string] as Record<string, JsonValue>, seg.slice(2), f.value))
            facts[f.path] = { status: STATUS(f), evidenceIds: f.evidenceIds }
        }
      }
    }

    const formOf = (slot: string): Form | undefined => {
      const claims = slots.get(slot)
      if (!claims) return undefined
      const win = [...claims].sort(
        (a, b) =>
          rank(a.status) - rank(b.status) ||
          cmp(a.src.doc.source.id, b.src.doc.source.id) ||
          cmp(a.src.ref, b.src.ref)
      )[0] as Claim
      const agreeing = claims.filter((c) => sameValue(c.form as JsonValue, win.form as JsonValue))
      const field = "aliasOf" in win.form ? "aliasOf" : "value"
      facts[slot === "value" ? `value.${field}` : `${slot}.${field}`] = {
        status: agreeing.some((c) => c.status === "discovered") ? "discovered" : "documented",
        evidenceIds: unique(agreeing.flatMap((c) => c.evidenceIds)).sort()
      }
      if (agreeing.length < claims.length) {
        ctx.conflicts.push({
          type: "token-value-mismatch",
          severity: "warning",
          subject: id as Conflict["subject"],
          path: slot,
          claims: claims
            .map((c) => ({
              sourceId: c.src.doc.source.id,
              value: c.form as JsonValue,
              status: c.status,
              evidenceIds: c.evidenceIds
            }))
            .sort(
              (a, b) => cmp(a.sourceId, b.sourceId) || cmp(JSON.stringify(a.value), JSON.stringify(b.value))
            ),
          suggestedResolution: "Decide which value is intended and remove the other definition."
        })
      }
      return win.form
    }

    const main = formOf("value") as Form
    const modes: Record<string, Form> = {}
    for (const slot of [...slots.keys()].filter((s) => s.startsWith("modes.")).sort()) {
      const form = formOf(slot)
      if (form) modes[slot.slice("modes.".length)] = form
    }
    const name = names.get(key) as string
    facts.name = {
      status: "discovered",
      evidenceIds: unique(
        members.flatMap((m) => m.facts.find((f) => f.path === "name")?.evidenceIds ?? [])
      ).sort()
    }
    if (description) {
      facts.description = { status: STATUS(description.claim), evidenceIds: description.claim.evidenceIds }
    }
    if (deprecated)
      facts.deprecated = { status: STATUS(deprecated.claim), evidenceIds: deprecated.claim.evidenceIds }

    tokens.push({
      id: id as Token["id"],
      name,
      category: "other",
      ...(description ? { description: description.value } : {}),
      value: main as Token["value"],
      ...(Object.keys(modes).length > 0 ? { modes: modes as Token["modes"] } : {}),
      ...(deprecated ? { deprecated: deprecated.value } : {}),
      facts: Object.fromEntries(Object.entries(facts).sort((a, b) => cmp(a[0], b[0]))),
      ...(Object.keys(extensions).length > 0 ? { extensions } : {})
    })
  }

  return {
    tokens: tokens.sort((a, b) => cmp(a.id, b.id)),
    themes: [...themes.values()].sort((a, b) => cmp(a.id, b.id)),
    identities
  }
}
