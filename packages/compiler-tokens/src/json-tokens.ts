import { type JsonMember, type JsonNode, toJson } from "./json-lines.js"

export interface JsonToken {
  /** Dotted path, for example `color.brand.primary`. */
  name: string
  line: number
  format: "dtcg" | "style-dictionary"
  value?: unknown
  /** Name of the referenced token when the value is a `{path}` reference. */
  aliasOf?: string
  type?: string
  description?: string
  deprecated?: { reason?: string }
}

const REFERENCE = /^\{([^{}]+)\}$/

/**
 * Walks a token tree. A node is a token when it has `$value` (W3C Design Tokens shape; `$type` is
 * inherited from enclosing groups) or a scalar/composite `value` (Style Dictionary shape).
 */
export function extractJsonTokens(root: JsonNode): JsonToken[] {
  const out: JsonToken[] = []
  const visit = (members: JsonMember[], path: string[], inheritedType: string | undefined): void => {
    const find = (key: string): JsonMember | undefined => members.find((m) => m.key === key)
    const groupType = scalarString(find("$type")?.value) ?? inheritedType
    for (const member of members) {
      if (member.key.startsWith("$") || member.value.type !== "object") continue
      const child = member.value.members
      const childPath = [...path, member.key]
      const dtcgValue = child.find((m) => m.key === "$value")
      const sdValue = dtcgValue ? undefined : child.find((m) => m.key === "value")
      const valueMember = dtcgValue ?? sdValue
      if (!valueMember) {
        visit(child, childPath, groupType)
        continue
      }
      const raw = toJson(valueMember.value)
      const alias = typeof raw === "string" ? REFERENCE.exec(raw.trim())?.[1] : undefined
      const type = dtcgValue
        ? (scalarString(child.find((m) => m.key === "$type")?.value) ?? groupType)
        : scalarString(child.find((m) => m.key === "type")?.value)
      const description =
        scalarString(child.find((m) => m.key === (dtcgValue ? "$description" : "comment"))?.value) ??
        scalarString(child.find((m) => m.key === "description")?.value)
      const deprecated = child.find((m) => m.key === "$deprecated")?.value
      out.push({
        name: childPath.join("."),
        line: member.line,
        format: dtcgValue ? "dtcg" : "style-dictionary",
        ...(alias ? { aliasOf: alias } : { value: raw }),
        ...(type ? { type } : {}),
        ...(description ? { description } : {}),
        ...(deprecated?.type === "scalar" && deprecated.value !== false
          ? { deprecated: typeof deprecated.value === "string" ? { reason: deprecated.value } : {} }
          : {})
      })
    }
  }
  if (root.type === "object") visit(root.members, [], undefined)
  return out
}

function scalarString(node: JsonNode | undefined): string | undefined {
  return node?.type === "scalar" && typeof node.value === "string" ? node.value : undefined
}
