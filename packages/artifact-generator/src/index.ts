import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { canonicalStringify, type JsonValue, sha256Hex } from "@invariant/shared"
import { z } from "zod"

export const MANIFEST_VERSION = "1.0.0"
export const MANIFEST_PATH = "invariant.manifest.json"

/**
 * A file to emit. `value` is rendered as canonical JSON; `text` is written verbatim (for non-JSON
 * artifacts such as the HTML report) and must already be deterministic.
 */
export type ArtifactEntry =
  | {
      /** POSIX path relative to the output directory. */
      path: string
      value: JsonValue
    }
  | { path: string; text: string }

export interface RenderedArtifact {
  path: string
  text: string
  sha256: string
}

export interface ManifestInput {
  tool: { name: string; version: string }
  /** Build time. Lives only in the manifest, so every other artifact stays reproducible. */
  generatedAt: string
  sources: Array<{
    id: string
    type: string
    adapterId: string
    adapterVersion: string
    inputHash: string
    irContentHash: string
    completeness: "complete" | "partial" | "failed"
  }>
}

export const manifestSchema = z.strictObject({
  manifestVersion: z.literal(MANIFEST_VERSION),
  tool: z.strictObject({ name: z.string(), version: z.string() }),
  generatedAt: z.iso.datetime(),
  sources: z.array(
    z.strictObject({
      id: z.string(),
      type: z.string(),
      adapterId: z.string(),
      adapterVersion: z.string(),
      inputHash: z.string(),
      irContentHash: z.string(),
      completeness: z.enum(["complete", "partial", "failed"])
    })
  ),
  artifacts: z.array(
    z.strictObject({ path: z.string(), sha256: z.string(), bytes: z.number().int().nonnegative() })
  )
})
export type Manifest = z.infer<typeof manifestSchema>

/**
 * Renders entries to canonical, pretty-printed JSON (sorted keys, trailing newline) and appends a
 * manifest listing every artifact's SHA-256. Output is sorted by path, so it never depends on call order.
 */
export function renderArtifacts(
  entries: readonly ArtifactEntry[],
  manifest: ManifestInput
): RenderedArtifact[] {
  const seen = new Set<string>()
  const rendered: RenderedArtifact[] = []
  for (const entry of entries) {
    assertSafePath(entry.path)
    if (entry.path === MANIFEST_PATH) throw new Error(`${MANIFEST_PATH} is generated; do not supply it`)
    if (seen.has(entry.path)) throw new Error(`Duplicate artifact path: ${entry.path}`)
    seen.add(entry.path)
    const text = "text" in entry ? entry.text : `${canonicalStringify(entry.value, 2)}\n`
    rendered.push({ path: entry.path, text, sha256: sha256Hex(text) })
  }
  rendered.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const body: Manifest = {
    manifestVersion: MANIFEST_VERSION,
    tool: manifest.tool,
    generatedAt: manifest.generatedAt,
    sources: [...manifest.sources].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    artifacts: rendered.map((a) => ({
      path: a.path,
      sha256: a.sha256,
      bytes: Buffer.byteLength(a.text, "utf8")
    }))
  }
  const text = `${canonicalStringify(manifestSchema.parse(body), 2)}\n`
  return [...rendered, { path: MANIFEST_PATH, text, sha256: sha256Hex(text) }]
}

/** Writes artifacts under `outDir`, refusing any path that would land outside it. */
export async function writeArtifacts(outDir: string, artifacts: readonly RenderedArtifact[]): Promise<void> {
  const root = path.resolve(outDir)
  for (const artifact of artifacts) {
    assertSafePath(artifact.path)
    const target = path.resolve(root, artifact.path)
    if (!target.startsWith(root + path.sep))
      throw new Error(`Artifact path escapes output directory: ${artifact.path}`)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, artifact.text, "utf8")
  }
}

function assertSafePath(p: string): void {
  if (
    p === "" ||
    p.startsWith("/") ||
    p.includes("\\") ||
    /^[A-Za-z]:/.test(p) ||
    p.split("/").some((s) => s === ".." || s === "." || s === "")
  ) {
    throw new Error(`Unsafe artifact path: ${JSON.stringify(p)}`)
  }
}
