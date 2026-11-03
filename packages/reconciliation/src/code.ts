import type { IrDocument } from "@invariant/compiler-ir"
import { FactIndex } from "./facts.js"

export interface CodeProp {
  name: string
  required?: boolean
  default?: unknown
  allowedValues?: Array<string | number | boolean>
  deprecated: boolean
  role?: string
  evidence: { default: string[]; allowedValues: string[]; deprecated: string[]; declared: string[] }
}

export interface CodeComponent {
  ref: string
  sourceId: string
  framework: string
  file: string
  localName: string
  name: string
  props: Map<string, CodeProp>
  /** False when props are inherited from types the adapter could not enumerate: absence proves nothing. */
  propsComplete: boolean
  variantNames: Set<string>
  slotNames: Set<string>
  deprecated: boolean
  index: FactIndex
}

const FILE = /^implementations\.([^.]+)\.extensions\.\1\.file$/

/**
 * Components from any framework adapter that publish the neutral link key
 * `implementations.<fw>.extensions.<fw>.{file,localName}`. Sources are matched on that key, never on a
 * display name, so renamed or aliased components still link correctly.
 */
export function codeComponents(docs: readonly IrDocument[]): CodeComponent[] {
  const out: CodeComponent[] = []
  for (const doc of docs) {
    const index = new FactIndex(doc)
    for (const entity of doc.entities.filter((e) => e.kind === "component")) {
      const filePath = [...doc.facts.filter((f) => f.subject === entity.ref).map((f) => f.path)].find((p) =>
        FILE.test(p)
      )
      const framework = filePath ? (FILE.exec(filePath)?.[1] as string) : undefined
      if (!filePath || !framework) continue
      const prefix = `implementations.${framework}.extensions.${framework}`
      const file = index.value<string>(entity.ref, `${prefix}.file`)
      const localName = index.value<string>(entity.ref, `${prefix}.localName`)
      if (!file || !localName) continue
      const props = new Map<string, CodeProp>()
      for (const name of index.children(entity.ref, "props")) {
        const base = `props.${name}`
        const role = doc.facts.find(
          (f) =>
            f.subject === entity.ref && f.path.startsWith(`${base}.extensions.`) && f.path.endsWith(".role")
        )?.value
        const required = index.value<boolean>(entity.ref, `${base}.required`)
        const allowed = index.value<Array<string | number | boolean>>(entity.ref, `${base}.allowedValues`)
        const defaultValue = index.get(entity.ref, `${base}.default`)
        props.set(name, {
          name,
          ...(required === undefined ? {} : { required }),
          ...(defaultValue ? { default: defaultValue.value } : {}),
          ...(allowed ? { allowedValues: allowed } : {}),
          deprecated: index.get(entity.ref, `${base}.deprecated`) !== undefined,
          ...(typeof role === "string" ? { role } : {}),
          evidence: {
            default: index.evidenceIds(entity.ref, `${base}.default`),
            allowedValues: index.evidenceIds(entity.ref, `${base}.allowedValues`),
            deprecated: index.evidenceIds(entity.ref, `${base}.deprecated`),
            declared: index.evidenceIds(entity.ref, `${base}.type.text`)
          }
        })
      }
      out.push({
        ref: entity.ref,
        sourceId: doc.source.id,
        framework,
        file,
        localName,
        name: index.value<string>(entity.ref, "name") ?? entity.name,
        props,
        propsComplete: index.value<boolean>(entity.ref, `${prefix}.propsComplete`) === true,
        variantNames: new Set(index.children(entity.ref, "variants")),
        slotNames: new Set(index.children(entity.ref, "slots")),
        deprecated: index.value<string>(entity.ref, "lifecycle") === "deprecated",
        index
      })
    }
  }
  return out
}
