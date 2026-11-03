import { describe, expect, it } from "vitest"
import { canonicalStringify, hashJson, sha256Hex } from "./canonical.js"

describe("canonicalStringify", () => {
  it("sorts object keys at every depth and is insensitive to insertion order", () => {
    const a = { b: 1, a: { d: [1, { y: 1, x: 2 }], c: null } }
    const b = { a: { c: null, d: [1, { x: 2, y: 1 }] }, b: 1 }
    expect(canonicalStringify(a)).toBe('{"a":{"c":null,"d":[1,{"x":2,"y":1}]},"b":1}')
    expect(canonicalStringify(a)).toBe(canonicalStringify(b))
  })

  it("orders integer-like keys lexicographically, not numerically", () => {
    expect(canonicalStringify({ "10": 1, "9": 2, b: 3 })).toBe('{"10":1,"9":2,"b":3}')
  })

  it("preserves array order", () => {
    expect(canonicalStringify([3, 1, 2])).toBe("[3,1,2]")
  })

  it("omits undefined object members but rejects undefined array items", () => {
    expect(canonicalStringify({ a: undefined, b: 1 })).toBe('{"b":1}')
    expect(() => canonicalStringify([undefined])).toThrow(TypeError)
  })

  it("rejects non-finite numbers and unsupported types", () => {
    expect(() => canonicalStringify(Number.NaN)).toThrow(TypeError)
    expect(() => canonicalStringify({ a: Number.POSITIVE_INFINITY })).toThrow(TypeError)
    expect(() => canonicalStringify(10n)).toThrow(TypeError)
  })

  it("escapes strings like JSON", () => {
    expect(canonicalStringify({ "é\n": ' "' })).toBe(JSON.stringify({ "é\n": ' "' }))
  })

  it("pretty-prints with sorted keys and parses back to the same value", () => {
    const value = { z: [], y: {}, x: { b: [1, 2], a: "s" } }
    const pretty = canonicalStringify(value, 2)
    expect(pretty).toBe(
      [
        "{",
        '  "x": {',
        '    "a": "s",',
        '    "b": [',
        "      1,",
        "      2",
        "    ]",
        "  },",
        '  "y": {},',
        '  "z": []',
        "}"
      ].join("\n")
    )
    expect(JSON.parse(pretty)).toEqual(value)
    expect(hashJson(JSON.parse(pretty))).toBe(hashJson(value))
  })
})

describe("hashing", () => {
  it("matches the SHA-256 test vector for the empty object", () => {
    expect(sha256Hex("{}")).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a")
    expect(hashJson({})).toBe(sha256Hex("{}"))
  })

  it("changes when a value changes", () => {
    expect(hashJson({ a: 1 })).not.toBe(hashJson({ a: 2 }))
  })
})
