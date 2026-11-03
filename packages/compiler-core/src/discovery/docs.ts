import type { DocFile } from "./schema.js"
import { cmp, type DiscoveryEnv, hashText, posix, readBounded } from "./support.js"

/** Markdown and MDX files outside ignored directories, with title and heading outline. */
export async function discoverDocFiles(env: DiscoveryEnv): Promise<DocFile[]> {
  const out: DocFile[] = []
  for (const file of env.files) {
    if (!/\.(?:md|mdx)$/i.test(file)) continue
    const text = await readBounded(env, file)
    if (text === undefined) continue
    const { headings, title } = outline(text, env.limits.maxHeadings)
    out.push({
      path: file,
      kind: kindOf(file),
      ...(title ? { title } : {}),
      headings,
      lineCount: text.length === 0 ? 0 : text.split("\n").length,
      contentHash: hashText(text)
    })
  }
  return out.sort((a, b) => cmp(a.path, b.path))
}

function kindOf(file: string): DocFile["kind"] {
  const base = posix.basename(file)
  if (/^readme(\.|$)/i.test(base)) return "readme"
  if (/^changelog(\.|$)/i.test(base)) return "changelog"
  return /\.mdx$/i.test(base) ? "mdx" : "markdown"
}

function outline(text: string, maxHeadings: number): { headings: DocFile["headings"]; title?: string } {
  const lines = text.split("\n")
  let start = 0
  let frontmatterTitle: string | undefined
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---")
    if (end > 0) {
      for (const line of lines.slice(1, end)) {
        const match = /^title\s*:\s*(.+?)\s*$/.exec(line)
        if (match) frontmatterTitle = (match[1] as string).replace(/^["']|["']$/g, "")
      }
      start = end + 1
    }
  }
  const headings: DocFile["headings"] = []
  let fence: string | undefined
  for (let i = start; i < lines.length && headings.length < maxHeadings; i++) {
    const line = lines[i] as string
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line)
    if (fenceMatch) {
      const marker = (fenceMatch[1] as string).slice(0, 3)
      fence = fence === undefined ? marker : fence === marker ? undefined : fence
      continue
    }
    if (fence !== undefined) continue
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading)
      headings.push({ level: (heading[1] as string).length, text: heading[2] as string, line: i + 1 })
  }
  const firstH1 = headings.find((h) => h.level === 1)?.text
  const title = frontmatterTitle ?? firstH1
  return { headings, ...(title ? { title } : {}) }
}
