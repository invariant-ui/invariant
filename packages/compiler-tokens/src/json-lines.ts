/** A parsed JSON object member with the 1-based line its key appears on. */
export interface JsonMember {
  key: string
  line: number
  value: JsonNode
}

export type JsonNode =
  | { type: "object"; members: JsonMember[]; line: number }
  | { type: "array"; items: JsonNode[]; line: number }
  | { type: "scalar"; value: string | number | boolean | null; line: number }

/** Minimal JSON parser that keeps key line numbers, for evidence locations. Throws on invalid JSON. */
export function parseJsonWithLines(text: string): JsonNode {
  let i = 0
  let line = 1
  const fail = (message: string): never => {
    throw new SyntaxError(`${message} at line ${line}`)
  }
  const skip = (): void => {
    while (i < text.length) {
      const c = text[i]
      if (c === "\n") line++
      else if (c !== " " && c !== "\t" && c !== "\r") return
      i++
    }
  }
  const string = (): string => {
    const start = i
    i++
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1
    if (i >= text.length) fail("Unterminated string")
    i++
    return JSON.parse(text.slice(start, i)) as string
  }
  const value = (): JsonNode => {
    skip()
    const startLine = line
    const c = text[i]
    if (c === "{") {
      i++
      const members: JsonMember[] = []
      skip()
      if (text[i] === "}") {
        i++
        return { type: "object", members, line: startLine }
      }
      for (;;) {
        skip()
        if (text[i] !== '"') fail("Expected a string key")
        const keyLine = line
        const key = string()
        skip()
        if (text[i] !== ":") fail("Expected ':'")
        i++
        members.push({ key, line: keyLine, value: value() })
        skip()
        if (text[i] === ",") {
          i++
          continue
        }
        if (text[i] === "}") {
          i++
          return { type: "object", members, line: startLine }
        }
        fail("Expected ',' or '}'")
      }
    }
    if (c === "[") {
      i++
      const items: JsonNode[] = []
      skip()
      if (text[i] === "]") {
        i++
        return { type: "array", items, line: startLine }
      }
      for (;;) {
        items.push(value())
        skip()
        if (text[i] === ",") {
          i++
          continue
        }
        if (text[i] === "]") {
          i++
          return { type: "array", items, line: startLine }
        }
        fail("Expected ',' or ']'")
      }
    }
    if (c === '"') return { type: "scalar", value: string(), line: startLine }
    const literal = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i))
    if (!literal) return fail("Unexpected token")
    i += literal[0].length
    return { type: "scalar", value: JSON.parse(literal[0]) as boolean | null | number, line: startLine }
  }
  const root = value()
  skip()
  if (i < text.length) fail("Unexpected trailing content")
  return root
}

export function toJson(node: JsonNode): unknown {
  if (node.type === "scalar") return node.value
  if (node.type === "array") return node.items.map(toJson)
  return Object.fromEntries(node.members.map((m) => [m.key, toJson(m.value)]))
}
