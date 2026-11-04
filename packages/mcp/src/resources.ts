import {
  catalog,
  componentView,
  type DesignSystem,
  guidelinesView,
  overview,
  patternsView,
  patternView,
  tokensView
} from "@invariant/contract-query"
import type { JsonValue } from "@invariant/shared"
import type { Loaded } from "./loader.js"

export interface ResourceDef {
  uri: string
  name: string
  title: string
  description: string
  mimeType: "application/json"
}

export const RESOURCES: ResourceDef[] = [
  {
    uri: "invariant://manifest",
    name: "manifest",
    title: "System manifest",
    description: "Compiled sources, input hashes, and artifact hashes.",
    mimeType: "application/json"
  },
  {
    uri: "invariant://metadata",
    name: "metadata",
    title: "Contract metadata",
    description: "Contract version, content hash, frameworks, sources and counts.",
    mimeType: "application/json"
  },
  {
    uri: "invariant://components",
    name: "components",
    title: "Component catalog",
    description: "Every component with its frameworks, prop counts and variants.",
    mimeType: "application/json"
  },
  {
    uri: "invariant://tokens",
    name: "tokens",
    title: "Token catalog",
    description: "Every design token with resolved values.",
    mimeType: "application/json"
  },
  {
    uri: "invariant://patterns",
    name: "patterns",
    title: "Pattern catalog",
    description:
      "Layouts, interactions, page archetypes and compositions, each with its derived approval status (often empty).",
    mimeType: "application/json"
  },
  {
    uri: "invariant://guidelines",
    name: "guidelines",
    title: "Guidelines",
    description: "Guideline documents by title, kind and the components they apply to.",
    mimeType: "application/json"
  }
]

export const RESOURCE_TEMPLATES = [
  {
    uriTemplate: "invariant://component/{id}",
    name: "component",
    title: "Component",
    description: "One component's contract entry. The id is the part after `component:`.",
    mimeType: "application/json"
  },
  {
    uriTemplate: "invariant://pattern/{id}",
    name: "pattern",
    title: "Pattern",
    description: "One pattern in full. The id is the part after `pattern:`, percent-encoded.",
    mimeType: "application/json"
  }
]

const all = { offset: 0, limit: 200 }

function pages(read: (offset: number) => Record<string, JsonValue>): Record<string, JsonValue> {
  const first = read(0)
  const items = [...((first.tokens ?? first.guidelines) as JsonValue[])]
  let offset = items.length
  let truncated = first.truncated === true
  const key = first.tokens ? "tokens" : "guidelines"
  while (truncated && offset < 50_000) {
    const next = read(offset)
    const more = next[key] as JsonValue[]
    items.push(...more)
    offset += more.length
    truncated = next.truncated === true && more.length > 0
  }
  return { ...first, [key]: items, truncated: false }
}

export type ReadResult =
  | { ok: true; text: string }
  | { ok: false; reason: "not-found" | "unavailable"; message: string }

export function readResource(loaded: Loaded, uri: string): ReadResult {
  if (!loaded.ok) return { ok: false, reason: "unavailable", message: loaded.message }
  const ds: DesignSystem = loaded.ds
  const json = (value: unknown): ReadResult => ({
    ok: true,
    text: JSON.stringify({ contractHash: ds.contentHash, ...(value as object) }, null, 2)
  })
  switch (uri) {
    case "invariant://manifest":
      return loaded.manifest
        ? { ok: true, text: loaded.manifest }
        : { ok: false, reason: "not-found", message: "invariant.manifest.json is not present" }
    case "invariant://metadata":
      return json({
        ...overview(ds),
        metadata: ds.contract.metadata as unknown as JsonValue,
        integrity: ds.contract.integrity as unknown as JsonValue
      })
    case "invariant://components":
      return json({ components: catalog(ds) })
    case "invariant://tokens":
      return json(pages((offset) => tokensView(ds, { ...all, offset })))
    case "invariant://patterns":
      return json(patternsView(ds))
    case "invariant://guidelines":
      return json(pages((offset) => guidelinesView(ds, { ...all, offset })))
  }
  const m = /^invariant:\/\/component\/(.+)$/.exec(uri)
  if (m) {
    let id: string
    try {
      id = decodeURIComponent(m[1] as string)
    } catch {
      return { ok: false, reason: "not-found", message: "malformed component uri" }
    }
    const found = ds.findComponent(id)
    if (found.match) return json({ component: componentViewOf(ds, found.match.id) })
  }
  const pm = /^invariant:\/\/pattern\/(.+)$/.exec(uri)
  if (pm) {
    let id: string
    try {
      id = decodeURIComponent(pm[1] as string)
    } catch {
      return { ok: false, reason: "not-found", message: "malformed pattern uri" }
    }
    const found = ds.findPattern(id)
    if (found.match) return json({ pattern: patternView(ds, found.match) })
  }
  return { ok: false, reason: "not-found", message: `No resource ${uri}` }
}

function componentViewOf(ds: DesignSystem, id: string): JsonValue {
  const c = ds.component(id)
  return c ? componentView(ds, c) : null
}
