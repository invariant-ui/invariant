/**
 * Minimal glob matcher for POSIX relative paths: `**`, `*`, `?`, `{a,b}`, `[abc]`, and the extglob
 * `@(a|b)` that Storybook story globs commonly use. Other extglobs are not supported.
 */
export function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${convert(pattern.replace(/^\.\//, ""))}$`)
}

export function matchesAny(path: string, matchers: readonly RegExp[]): boolean {
  return matchers.some((m) => m.test(path))
}

function convert(p: string): string {
  let out = ""
  for (let i = 0; i < p.length; i++) {
    const c = p[i] as string
    if (c === "*") {
      if (p[i + 1] === "*") {
        if (p[i + 2] === "/") {
          out += "(?:.*/)?"
          i += 2
        } else {
          out += ".*"
          i += 1
        }
      } else out += "[^/]*"
    } else if (c === "?") {
      out += "[^/]"
    } else if (c === "{") {
      const end = matching(p, i, "{", "}")
      if (end < 0) out += "\\{"
      else {
        out += `(?:${splitTopLevel(p.slice(i + 1, end), ",")
          .map(convert)
          .join("|")})`
        i = end
      }
    } else if (c === "@" && p[i + 1] === "(") {
      const end = matching(p, i + 1, "(", ")")
      if (end < 0) out += "@"
      else {
        out += `(?:${splitTopLevel(p.slice(i + 2, end), "|")
          .map(convert)
          .join("|")})`
        i = end
      }
    } else if (c === "[") {
      const end = p.indexOf("]", i + 1)
      if (end < 0) out += "\\["
      else {
        out += p.slice(i, end + 1)
        i = end
      }
    } else {
      out += c.replace(/[.+^$()|\\/]/g, (m) => (m === "/" ? "/" : `\\${m}`))
    }
  }
  return out
}

function matching(p: string, start: number, open: string, close: string): number {
  let depth = 0
  for (let i = start; i < p.length; i++) {
    if (p[i] === open) depth++
    else if (p[i] === close && --depth === 0) return i
  }
  return -1
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ""
  for (const c of text) {
    if (c === "{" || c === "(") depth++
    if (c === "}" || c === ")") depth--
    if (c === separator && depth === 0) {
      parts.push(current)
      current = ""
    } else current += c
  }
  parts.push(current)
  return parts
}
