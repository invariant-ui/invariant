import { describe, expect, it } from "vitest"
import {
  colorFunctionLiterals,
  colorKey,
  lengthKey,
  namedColorLiterals,
  normalizeColorFunction,
  spacingLiterals,
  tokenValueKeys,
  typographyLiterals
} from "./literals.js"

describe("colors", () => {
  it("normalizes rgb and hsl to the same key as the equivalent hex", () => {
    expect(normalizeColorFunction("rgb(0, 87, 255)")).toBe("#0057ff")
    expect(normalizeColorFunction("rgb(0 87 255)")).toBe("#0057ff")
    expect(normalizeColorFunction("rgb(0% 34.1% 100%)")).toBe("#0057ff")
    expect(normalizeColorFunction("rgba(255, 0, 0, 0.5)")).toBe("#ff000080")
    expect(normalizeColorFunction("rgb(255 0 0 / 50%)")).toBe("#ff000080")
    expect(normalizeColorFunction("rgba(255,0,0,1)")).toBe("#ff0000")
    expect(normalizeColorFunction("hsl(0, 100%, 50%)")).toBe("#ff0000")
    expect(normalizeColorFunction("hsl(120deg 100% 25%)")).toBe("#008000")
    expect(normalizeColorFunction("hsla(240, 100%, 50%, 0.5)")).toBe("#0000ff80")
  })

  it("rejects anything that is not fully literal", () => {
    for (const bad of [
      "rgb(var(--r), 0, 0)",
      "rgb(1,2)",
      "rgb(a b c)",
      "hsl(0, 100, 50)",
      "color(srgb 1 0 0)"
    ])
      expect(normalizeColorFunction(bad), bad).toBeUndefined()
  })

  it("keys token values: hex long form, functions, names; nothing else", () => {
    expect(colorKey("#FFF")).toBe("#ffffff")
    expect(colorKey("rgb(255,255,255)")).toBe("#ffffff")
    expect(colorKey("Tomato")).toBe("tomato")
    expect(colorKey("16px")).toBeUndefined()
    expect(colorKey("transparent")).toBeUndefined()
  })

  it("finds rgb and hsl calls anywhere and skips variable arguments", () => {
    const found = colorFunctionLiterals(`a { color: rgb(0 0 0); b: hsl(0 0% 100%); c: rgb(var(--x) 0 0) }`)
    expect(found.map((f) => f.text)).toEqual(["rgb(0 0 0)", "hsl(0 0% 100%)"])
    expect(found.map((f) => f.keys[0])).toEqual(["#000000", "#ffffff"])
  })

  it("finds named colors only as the value of a color-bearing property", () => {
    const text = (s: string) => namedColorLiterals(s).map((f) => f.text)
    expect(text(`color: red;`)).toEqual(["red"])
    expect(text(`border: 1px solid tomato`)).toEqual(["tomato"])
    expect(text(`<path fill="teal" />`)).toEqual(["teal"])
    expect(text(`const s = { backgroundColor: "navy" }`)).toEqual(["navy"])
    // Bare words, class names, file names and identifiers are not colors.
    expect(text(`const red = 1; const label = "red alert"`)).toEqual([])
    expect(text(`background: url(red.png)`)).toEqual([])
    expect(text(`color: var(--red)`)).toEqual([])
    expect(text(`color: inherit; fill: none; background: transparent`)).toEqual([])
    // Several properties on one line are all read, and prose in a sibling string is not a color.
    expect(text(`{ color: "red", border: "1px solid tomato", label: "Orange juice" }`)).toEqual([
      "red",
      "tomato"
    ])
  })
})

describe("lengths", () => {
  it("compares px, rem and em on a 16px root and treats unitless as px only when asked", () => {
    expect(lengthKey("16px", false)).toBe("16px")
    expect(lengthKey("1rem", false)).toBe("16px")
    expect(lengthKey("0.5em", false)).toBe("8px")
    expect(lengthKey("12", true)).toBe("12px")
    expect(lengthKey("12", false)).toBeUndefined()
    expect(lengthKey("auto", true)).toBeUndefined()
    expect(lengthKey("50%", true)).toBeUndefined()
  })
})

describe("spacing", () => {
  const keys = (s: string) => spacingLiterals(s).map((f) => `${f.property}=${f.keys[0]}`)

  it("reads margin, padding and gap in CSS and in style objects", () => {
    expect(keys(`padding: 8px 1rem;`)).toEqual(["padding=8px", "padding=16px"])
    expect(keys(`const s = { marginTop: 12, gap: "4px", columnGap: 0 }`)).toEqual([
      "marginTop=12px",
      "gap=4px"
    ])
    expect(keys(`<Box style={{ padding: 6 }} />`)).toEqual(["padding=6px"])
  })

  it("skips zero, auto, percentages, variables and calc", () => {
    expect(keys(`margin: 0 auto;`)).toEqual([])
    expect(keys(`padding: 50%;`)).toEqual([])
    expect(keys(`gap: var(--space-2);`)).toEqual([])
    expect(keys(`padding: calc(8px + 2px);`)).toEqual([])
  })

  it("reports the column of each value", () => {
    const [f] = spacingLiterals(`  padding: 13px;`)
    expect(f?.column).toBe(12)
  })
})

describe("typography", () => {
  const keys = (s: string) => typographyLiterals(s).map((f) => `${f.property}=${f.keys.join("|")}`)

  it("reads size, weight, line height, letter spacing and the first font family", () => {
    expect(keys(`font-size: 14px; font-weight: bold; line-height: 1.5; letter-spacing: 0.02em;`)).toEqual([
      "font-size=14px",
      "font-weight=700",
      "line-height=1.5",
      "letter-spacing=0.32px"
    ])
    expect(keys(`const t = { fontSize: 16, fontWeight: 600, fontFamily: "Inter, sans-serif" }`)).toEqual([
      "fontSize=16px",
      "fontWeight=600",
      "fontFamily=inter"
    ])
  })

  it("skips variables, clamp and keywords it cannot compare", () => {
    expect(
      keys(`font-size: var(--text-md); font-size: clamp(1rem, 2vw, 2rem); font-weight: inherit;`)
    ).toEqual([])
  })
})

describe("token value keys", () => {
  it("flattens literals, numbers and composite typography values", () => {
    const k = tokenValueKeys({
      fontFamily: "Inter, sans-serif",
      fontSize: "1rem",
      fontWeight: 600,
      lineHeight: 1.5
    })
    expect(k).toEqual(expect.objectContaining({ size: expect.any(Number) }))
    for (const want of ["inter", "16px", "600", "1.5"]) expect(k.has(want), want).toBe(true)
  })

  it("ignores references it cannot resolve", () => {
    expect(tokenValueKeys("var(--x)").size).toBe(0)
    expect(tokenValueKeys("calc(1rem + 2px)").size).toBe(0)
  })
})
