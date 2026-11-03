export interface BuiltIndexEntry {
  id: string
  type: string
  title?: string
  name?: string
  importPath: string
  tags: string[]
}

/**
 * Reads a built Storybook's `index.json`. Its format is not documented as public API, so parsing is
 * tolerant (`entries` or the older `stories`) and uses only the fields below. It is optional evidence
 * about which story files a build contained, never a source of story identity.
 */
export function parseBuiltIndex(
  text: string
): { entries: BuiltIndexEntry[]; format: "entries" | "stories" } | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const record = parsed as { entries?: unknown; stories?: unknown }
  const format =
    record.entries !== undefined ? "entries" : record.stories !== undefined ? "stories" : undefined
  const raw = format === "entries" ? record.entries : record.stories
  if (!format || typeof raw !== "object" || raw === null) return undefined
  const values = Array.isArray(raw) ? raw : Object.values(raw)
  const entries: BuiltIndexEntry[] = []
  for (const value of values) {
    if (typeof value !== "object" || value === null) continue
    const e = value as Record<string, unknown>
    const importPath = typeof e.importPath === "string" ? e.importPath : undefined
    if (!importPath || typeof e.id !== "string") continue
    entries.push({
      id: e.id,
      type: typeof e.type === "string" ? e.type : "story",
      ...(typeof e.title === "string" ? { title: e.title } : {}),
      ...(typeof e.name === "string" ? { name: e.name } : {}),
      importPath,
      tags: Array.isArray(e.tags) ? e.tags.filter((t): t is string => typeof t === "string") : []
    })
  }
  return { entries: entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), format }
}
