import { createHash } from "node:crypto"

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, no insignificant whitespace
 * (or fixed-width indentation when `indent > 0`). Properties whose value is `undefined`
 * are omitted, matching JSON.stringify. Non-finite numbers and `undefined` array items throw.
 * Array order is preserved: producers are responsible for sorting arrays.
 */
export function canonicalStringify(value: unknown, indent = 0): string {
  return write(value, indent, 0)
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

export function hashJson(value: unknown): string {
  return sha256Hex(canonicalStringify(value))
}

function write(value: unknown, indent: number, depth: number): string {
  if (value === null) return "null"
  switch (typeof value) {
    case "string":
      return JSON.stringify(value)
    case "boolean":
      return value ? "true" : "false"
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`Cannot canonicalize non-finite number: ${value}`)
      return JSON.stringify(value)
    case "object":
      return Array.isArray(value) ? writeArray(value, indent, depth) : writeObject(value, indent, depth)
    default:
      throw new TypeError(`Cannot canonicalize value of type ${typeof value}`)
  }
}

function writeArray(items: unknown[], indent: number, depth: number): string {
  if (items.length === 0) return "[]"
  const parts = items.map((item) => {
    if (item === undefined) throw new TypeError("Cannot canonicalize undefined array item")
    return write(item, indent, depth + 1)
  })
  return wrap("[", "]", parts, indent, depth)
}

function writeObject(object: object, indent: number, depth: number): string {
  const record = object as Record<string, unknown>
  const parts: string[] = []
  for (const key of Object.keys(record).sort()) {
    const member = record[key]
    if (member === undefined) continue
    parts.push(`${JSON.stringify(key)}:${indent > 0 ? " " : ""}${write(member, indent, depth + 1)}`)
  }
  if (parts.length === 0) return "{}"
  return wrap("{", "}", parts, indent, depth)
}

function wrap(open: string, close: string, parts: string[], indent: number, depth: number): string {
  if (indent <= 0) return `${open}${parts.join(",")}${close}`
  const inner = " ".repeat(indent * (depth + 1))
  const outer = " ".repeat(indent * depth)
  return `${open}\n${inner}${parts.join(`,\n${inner}`)}\n${outer}${close}`
}
