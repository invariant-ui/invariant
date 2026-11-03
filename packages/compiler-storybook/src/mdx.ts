import { posix } from "@invariant/compiler-core"

export interface MdxDoc {
  path: string
  /** `<Meta title="…" />`. */
  metaTitle?: string
  /** `<Meta of={Stories} />`, resolved to the stories file when the import is relative. */
  metaOf?: { identifier: string; file?: string; line: number }
  /** Stories referenced by blocks such as `<Canvas of={Stories.Primary} />`. */
  storyRefs: Array<{ block: string; exportName: string; file?: string; line: number }>
  blocks: string[]
  title?: string
  sections: Array<{ heading: string; level: number; line: number; text: string }>
}

const BLOCKS = new Set([
  "Meta",
  "Canvas",
  "Story",
  "Controls",
  "ArgTypes",
  "Source",
  "Primary",
  "Stories",
  "Description",
  "Subtitle",
  "Title",
  "Markdown",
  "Unstyled",
  "ColorPalette",
  "IconGallery",
  "Typeset"
])
const MAX_SECTION_TEXT = 500

/**
 * Reads a Storybook MDX page with line-based scanning. It does not compile or evaluate MDX: it records
 * the imports, the doc blocks used and what they reference, and the prose outline.
 */
export function parseMdx(path: string, text: string, projectFiles: ReadonlySet<string>): MdxDoc {
  const lines = text.split("\n")
  const imports = readImports(path, text, projectFiles)
  const doc: MdxDoc = { path, storyRefs: [], blocks: [], sections: [] }
  const blocks = new Set<string>()
  let fence: string | undefined
  let current: MdxDoc["sections"][number] | undefined

  lines.forEach((raw, index) => {
    const line = index + 1
    const fenceMatch = /^\s*(```+|~~~+)/.exec(raw)
    if (fenceMatch) {
      const marker = (fenceMatch[1] as string).slice(0, 3)
      fence = fence === undefined ? marker : fence === marker ? undefined : fence
      return
    }
    if (fence !== undefined) return

    for (const match of raw.matchAll(/<([A-Z][A-Za-z]*)\b([^>]*?)\/?>/g)) {
      const block = match[1] as string
      if (!BLOCKS.has(block)) continue
      blocks.add(block)
      const attributes = match[2] as string
      const of = /\bof=\{\s*([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?\s*\}/.exec(attributes)
      if (block === "Meta") {
        const title = /\btitle=(?:"([^"]*)"|'([^']*)')/.exec(attributes)
        if (title) doc.metaTitle = (title[1] ?? title[2]) as string
        if (of) {
          const imported = imports.get(of[1] as string)
          doc.metaOf = {
            identifier: of[1] as string,
            ...(imported?.file ? { file: imported.file } : {}),
            line
          }
        }
      } else if (of?.[2]) {
        const imported = imports.get(of[1] as string)
        doc.storyRefs.push({
          block,
          exportName: of[2],
          ...(imported?.file ? { file: imported.file } : {}),
          line
        })
      }
    }

    if (/^\s*(?:import|export)\s/.test(raw) || /^\s*<[A-Za-z]/.test(raw)) return
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw)
    if (heading) {
      current = { heading: heading[2] as string, level: (heading[1] as string).length, line, text: "" }
      doc.sections.push(current)
      return
    }
    if (current && raw.trim() && current.text.length < MAX_SECTION_TEXT) {
      current.text = `${current.text}${current.text ? " " : ""}${raw.trim()}`.slice(0, MAX_SECTION_TEXT)
    }
  })
  doc.blocks = [...blocks].sort()
  const title = doc.metaTitle ?? doc.sections.find((s) => s.level === 1)?.heading
  if (title) doc.title = title
  return doc
}

function readImports(
  path: string,
  text: string,
  projectFiles: ReadonlySet<string>
): Map<string, { file?: string }> {
  const out = new Map<string, { file?: string }>()
  const resolve = (spec: string): string | undefined => {
    if (!spec.startsWith(".")) return undefined
    const base = posix.normalize(posix.join(posix.dirname(path), spec))
    const stripped = base.replace(/\.[cm]?[jt]sx?$/, "")
    return [
      base,
      ...[".stories.tsx", ".stories.ts", ".stories.jsx", ".stories.js", ".tsx", ".ts", ".jsx", ".js"].map(
        (e) => stripped + e
      ),
      ...[".tsx", ".ts", ".jsx", ".js"].map((e) => `${base}${e}`)
    ].find((c) => projectFiles.has(c))
  }
  for (const match of text.matchAll(/import\s+([^;]+?)\s+from\s+["']([^"']+)["']/g)) {
    const clause = match[1] as string
    const file = resolve(match[2] as string)
    const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause)
    if (namespace) out.set(namespace[1] as string, { ...(file ? { file } : {}) })
    const def = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause)
    if (def) out.set(def[1] as string, { ...(file ? { file } : {}) })
    for (const named of /\{([^}]*)\}/.exec(clause)?.[1]?.split(",") ?? []) {
      const alias = /(?:[\w$]+\s+as\s+)?([\w$]+)\s*$/.exec(named.trim())
      if (alias?.[1]) out.set(alias[1], { ...(file ? { file } : {}) })
    }
  }
  return out
}
