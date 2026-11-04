import { IR_VERSION, type IrDocument, type IrFact } from "@invariant/compiler-ir"
import { computeEvidenceId, type Evidence, type SourceType } from "@invariant/contract"
import type { JsonValue } from "@invariant/shared"

export interface RawEntity {
  ref: string
  kind: IrDocument["entities"][number]["kind"]
  name: string
  /** `[path, value]` or `[path, value, "authored"]`. */
  facts: Array<[string, JsonValue] | [string, JsonValue, "authored"]>
}

/** An IR document with one evidence entry per fact, for exact control over what a source claims. */
export function rawDoc(
  sourceId: string,
  type: Exclude<SourceType, "patterns">,
  entities: RawEntity[],
  options: { completeness?: IrDocument["completeness"] } = {}
): IrDocument {
  const evidence = new Map<string, Evidence>()
  const facts: IrFact[] = []
  let line = 1
  for (const e of entities) {
    for (const [path, value, origin] of e.facts) {
      const base = {
        sourceId,
        sourceRef: `${e.ref}#${path}`,
        location: { type: "file" as const, path: `src/${sourceId}.ts`, line: line++ },
        method: "ast" as const,
        extractor: { name: type, version: "1" }
      }
      const ev: Evidence = {
        ...base,
        id: computeEvidenceId(base),
        verificationStatus: "unverified",
        capturedAt: "2026-01-01T00:00:00.000Z"
      }
      evidence.set(ev.id, ev)
      facts.push({ subject: e.ref, path, value, origin: origin ?? "extracted", evidenceIds: [ev.id] })
    }
  }
  return {
    irVersion: IR_VERSION,
    source: {
      id: sourceId,
      type,
      location: ".",
      inputHash: "0".repeat(64),
      adapter: { name: type, version: "1" }
    },
    capabilities: ["*"],
    completeness: options.completeness ?? "complete",
    entities: entities.map((e) => ({ ref: e.ref, kind: e.kind, name: e.name })),
    facts,
    evidence: [...evidence.values()],
    diagnostics: []
  }
}

export interface ComponentSpec {
  name: string
  framework?: "react" | "vue" | "angular"
  file?: string
  packageName?: string
  propsComplete?: boolean
  extra?: Array<[string, JsonValue] | [string, JsonValue, "authored"]>
}

export function component(spec: ComponentSpec): RawEntity {
  const fw = spec.framework ?? "react"
  const file = spec.file ?? `src/${spec.name}.tsx`
  return {
    ref: `${fw}:${file}#${spec.name}`,
    kind: "component",
    name: spec.name,
    facts: [
      ["name", spec.name],
      [`implementations.${fw}.framework`, fw],
      [`implementations.${fw}.extensions.${fw}.file`, file],
      [`implementations.${fw}.extensions.${fw}.localName`, spec.name],
      [`implementations.${fw}.extensions.${fw}.propsComplete`, spec.propsComplete ?? true],
      ...(spec.packageName
        ? ([[`implementations.${fw}.packageName`, spec.packageName]] as RawEntity["facts"])
        : []),
      ...(spec.extra ?? [])
    ]
  }
}

export function token(
  name: string,
  facts: RawEntity["facts"],
  ref = `css:src/tokens.css#${name}`
): RawEntity {
  return { ref, kind: "token", name, facts: [["name", name], ...facts] }
}
