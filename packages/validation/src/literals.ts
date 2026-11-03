/**
 * Literal values in application code that could have been design tokens: colors written as rgb(), hsl() or a
 * CSS name, spacing lengths and typography values. Pure text scanning. Only literal values are read; anything
 * that contains `var(`, `calc(` or a binding is skipped, never guessed.
 */

export interface Found {
  /** As written in the code. */
  text: string
  /** Normalized form compared with token values. */
  keys: string[]
  /** 1-based column of the value. */
  column: number
}

export interface SpacingOrTypeFound extends Found {
  property: string
}

const ROOT_PX = 16

const round = (n: number): number => Math.round(n)
const hex2 = (n: number): string =>
  Math.max(0, Math.min(255, round(n)))
    .toString(16)
    .padStart(2, "0")

function channel(raw: string): number | undefined {
  const m = /^(-?\d*\.?\d+)(%?)$/.exec(raw)
  if (!m) return undefined
  const n = Number(m[1])
  return m[2] ? (n / 100) * 255 : n
}

function alpha(raw: string | undefined): number | undefined {
  if (raw === undefined) return 1
  const m = /^(-?\d*\.?\d+)(%?)$/.exec(raw)
  if (!m) return undefined
  const n = Number(m[1])
  return Math.max(0, Math.min(1, m[2] ? n / 100 : n))
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360
  const a = s * Math.min(l, 1 - l)
  const f = (n: number): number => {
    const k = (n + hue / 30) % 12
    return (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255
  }
  return [f(0), f(8), f(4)]
}

/** `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` to the long lowercase form. */
export function expandHex(hex: string): string {
  const h = hex.slice(1).toLowerCase()
  return `#${h.length <= 4 ? [...h].map((c) => c + c).join("") : h}`
}

/** Opaque colors end up as `#rrggbb`, translucent ones as `#rrggbbaa`, so equal colors compare equal. */
function toHex(r: number, g: number, b: number, a: number): string {
  const base = `#${hex2(r)}${hex2(g)}${hex2(b)}`
  return a >= 1 ? base : `${base}${hex2(a * 255)}`
}

/** Normalizes a literal rgb()/rgba()/hsl()/hsla() call, comma or space syntax. Anything else is undefined. */
export function normalizeColorFunction(text: string): string | undefined {
  const m = /^(rgba?|hsla?)\(\s*([^()]*?)\s*\)$/i.exec(text.trim())
  if (!m) return undefined
  const fn = (m[1] as string).toLowerCase()
  const parts = (m[2] as string).split(/\s*[,/]\s*|\s+/).filter((p) => p !== "")
  if (parts.length !== 3 && parts.length !== 4) return undefined
  const a = alpha(parts[3])
  if (a === undefined) return undefined
  if (fn.startsWith("rgb")) {
    const ch = parts.slice(0, 3).map((p) => channel(p))
    if (ch.some((c) => c === undefined)) return undefined
    const [r, g, b] = ch as [number, number, number]
    return toHex(r, g, b, a)
  }
  const hue = /^(-?\d*\.?\d+)(deg)?$/.exec(parts[0] as string)
  const sat = /^(\d*\.?\d+)%$/.exec(parts[1] as string)
  const lig = /^(\d*\.?\d+)%$/.exec(parts[2] as string)
  if (!hue || !sat || !lig) return undefined
  const [r, g, b] = hslToRgb(Number(hue[1]), Number(sat[1]) / 100, Number(lig[1]) / 100)
  return toHex(r, g, b, a)
}

/** The CSS named colors (CSS Color Module Level 4), without `transparent` and `currentcolor`. */
const NAMED_COLORS = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown " +
    "burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan " +
    "darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid " +
    "darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet " +
    "deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro " +
    "ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
    "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow " +
    "lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray " +
    "lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine " +
    "mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen " +
    "mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace " +
    "olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred " +
    "papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue " +
    "saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey " +
    "snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow " +
    "yellowgreen"
  ).split(" ")
)

export const isNamedColor = (name: string): boolean => NAMED_COLORS.has(name.toLowerCase())

/** Key used to compare a token value with a literal: hex and functional colors by value, names by name. */
export function colorKey(value: string): string | undefined {
  const v = value.trim()
  if (/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v)) return expandHex(v)
  const fn = normalizeColorFunction(v)
  if (fn) return fn
  if (isNamedColor(v)) return v.toLowerCase()
  return undefined
}

const COLOR_FN = /\b(?:rgba?|hsla?)\(\s*[^()]*?\s*\)/gi
const COLOR_PROP =
  /(?<![\w-])(?:background(?:-?color)?|(?:border|outline|caret|accent|text-decoration|column-rule)(?:-?color)?|color|fill|stroke|border(?:-?(?:top|right|bottom|left))?(?:-?color)?)\s*[:=]\s*["'{`]*\s*([^;},\n]*)/gi

/** rgb()/rgba()/hsl()/hsla() calls with literal numbers, in any text. */
export function colorFunctionLiterals(line: string): Found[] {
  const out: Found[] = []
  for (const m of line.matchAll(COLOR_FN)) {
    const key = normalizeColorFunction(m[0])
    if (key) out.push({ text: m[0], keys: [key], column: (m.index ?? 0) + 1 })
  }
  return out
}

/**
 * Named colors, only where the value of a color-bearing property is written: `color: red`,
 * `border: 1px solid tomato`, `fill="teal"`. A bare word elsewhere is never a color.
 */
export function namedColorLiterals(line: string): Found[] {
  const out: Found[] = []
  for (const m of line.matchAll(COLOR_PROP)) {
    const value = m[1] as string
    const start = (m.index ?? 0) + m[0].length - value.length
    for (const w of value.matchAll(/(?<![\w./#-])[A-Za-z]+(?![\w.(-])/g)) {
      if (isNamedColor(w[0]))
        out.push({ text: w[0], keys: [w[0].toLowerCase()], column: start + (w.index ?? 0) + 1 })
    }
  }
  return out
}

/** A length as pixels: `px` as is, `rem` and `em` against a 16px root. Unitless is only px when `unitlessPx`. */
export function lengthKey(raw: string, unitlessPx: boolean): string | undefined {
  const m = /^(-?\d*\.?\d+)(px|rem|em)?$/.exec(raw.trim())
  if (!m) return undefined
  const n = Number(m[1])
  const unit = m[2]
  if (unit === undefined && !unitlessPx) return undefined
  const px = unit === "rem" || unit === "em" ? n * ROOT_PX : n
  return `${Number(px.toFixed(3))}px`
}

const SPACING_PROP =
  /(?<![\w-])((?:margin|padding)(?:-?(?:top|right|bottom|left|inline|block)(?:-?(?:start|end))?)?|(?:row-?|column-?|grid-?)?gap)\s*[:=]\s*(["'{`]*)\s*([^;}\n,]*)/gi

/** Spacing lengths in margin, padding and gap declarations. Zero, `auto`, `var()` and `calc()` are skipped. */
export function spacingLiterals(line: string): SpacingOrTypeFound[] {
  const out: SpacingOrTypeFound[] = []
  for (const m of line.matchAll(SPACING_PROP)) {
    const quoted = (m[2] as string) !== "" && /["'`]/.test(m[2] as string)
    if (/\(/.test(m[3] as string)) continue
    const value = (m[3] as string).replace(/["'`]+\s*$/, "")
    const start = (m.index ?? 0) + m[0].length - (m[3] as string).length
    for (const t of value.matchAll(/\S+/g)) {
      const key = lengthKey(t[0], !quoted)
      if (key === undefined || Number.parseFloat(key) === 0) continue
      out.push({
        property: m[1] as string,
        text: t[0],
        keys: [key],
        column: start + (t.index ?? 0) + 1
      })
    }
  }
  return out
}

const TYPE_PROP =
  /(?<![\w-])(font-?size|font-?weight|line-?height|letter-?spacing|font-?family)\s*[:=]\s*(["'{`]*)\s*/gi

function typeKeys(prop: string, raw: string, quoted: boolean): string[] {
  const p = prop.toLowerCase().replace("-", "")
  const v = raw.trim().replace(/["'`,)]+$/, "")
  if (v === "" || /(?:var|calc|clamp|min|max)\(/i.test(v)) return []
  if (p === "fontweight") {
    if (v === "normal") return ["400"]
    if (v === "bold") return ["700"]
    return /^\d{3}$/.test(v) ? [v] : []
  }
  if (p === "fontfamily") {
    const first = v
      .split(",")[0]
      ?.trim()
      .replace(/^["']|["']$/g, "")
    return first ? [first.toLowerCase()] : []
  }
  if (p === "lineheight" && /^\d*\.?\d+$/.test(v)) return [String(Number(v))]
  const key = lengthKey(v, !quoted)
  return key ? [key] : []
}

/**
 * The text of a value that starts at `from`. A quoted value ends at its closing quote, so a font-family list
 * keeps its commas; an unquoted one ends at `;`, `}` or, in a style object, `,`.
 */
function valueText(line: string, from: number, quote: string, isFamily: boolean): string {
  const rest = line.slice(from)
  const q = quote.replace(/[{\s]/g, "").slice(-1)
  if (q) {
    const end = rest.indexOf(q)
    return end === -1 ? rest : rest.slice(0, end)
  }
  const end = rest.search(isFamily ? /[;}]/ : /[;},]/)
  return end === -1 ? rest : rest.slice(0, end)
}

/** font-size, font-weight, line-height, letter-spacing and the first font-family name. */
export function typographyLiterals(line: string): SpacingOrTypeFound[] {
  const out: SpacingOrTypeFound[] = []
  for (const m of line.matchAll(TYPE_PROP)) {
    const from = (m.index ?? 0) + m[0].length
    const quote = m[2] as string
    const value = valueText(line, from, quote, /family/i.test(m[1] as string))
    const keys = typeKeys(m[1] as string, value, /["'`]/.test(quote))
    if (keys.length === 0) continue
    out.push({ property: m[1] as string, text: value.trim(), keys, column: from + 1 })
  }
  return out
}

/** Every comparable key a token value can match: lengths as px, plain numbers, names, and composite parts. */
export function tokenValueKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === "number") {
    into.add(String(value))
    into.add(`${value}px`)
  } else if (typeof value === "string") {
    const v = value.trim()
    const len = lengthKey(v, false)
    if (len) into.add(len)
    else if (/^\d*\.?\d+$/.test(v)) into.add(String(Number(v)))
    else if (v !== "" && !/^(?:var|calc)\(/i.test(v)) {
      into.add(v.toLowerCase())
      const first = v
        .split(",")[0]
        ?.trim()
        .replace(/^["']|["']$/g, "")
      if (first) into.add(first.toLowerCase())
    }
  } else if (Array.isArray(value)) for (const x of value) tokenValueKeys(x, into)
  else if (value && typeof value === "object") for (const x of Object.values(value)) tokenValueKeys(x, into)
  return into
}
