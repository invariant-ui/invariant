import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { MANIFEST_PATH, manifestSchema, renderArtifacts, writeArtifacts } from "./index.js"

const manifest = {
  tool: { name: "invariant", version: "0.0.0" },
  generatedAt: "2026-01-01T00:00:00.000Z",
  sources: []
}

describe("renderArtifacts", () => {
  it("renders canonical JSON, sorted by path, and a manifest of hashes", () => {
    const out = renderArtifacts(
      [
        { path: "b.json", value: { z: 1, a: 2 } },
        { path: "ir/a.ir.json", value: [1] }
      ],
      manifest
    )
    expect(out.map((a) => a.path)).toEqual(["b.json", "ir/a.ir.json", MANIFEST_PATH])
    expect(out[0]?.text).toBe('{\n  "a": 2,\n  "z": 1\n}\n')
    const parsed = manifestSchema.parse(JSON.parse(out[2]?.text ?? ""))
    expect(parsed.artifacts.map((a) => a.path)).toEqual(["b.json", "ir/a.ir.json"])
    expect(parsed.artifacts[0]?.sha256).toBe(out[0]?.sha256)
  })

  it("is independent of entry order", () => {
    const a = { path: "a.json", value: { x: 1 } }
    const b = { path: "b.json", value: { y: 2 } }
    expect(renderArtifacts([a, b], manifest)).toEqual(renderArtifacts([b, a], manifest))
  })

  it("rejects duplicate, reserved and unsafe paths", () => {
    expect(() =>
      renderArtifacts(
        [
          { path: "a.json", value: 1 },
          { path: "a.json", value: 2 }
        ],
        manifest
      )
    ).toThrow(/Duplicate/)
    expect(() => renderArtifacts([{ path: MANIFEST_PATH, value: 1 }], manifest)).toThrow(/generated/)
    for (const bad of ["../x.json", "/abs.json", "a//b.json", "a\\b.json", "./x.json", ""]) {
      expect(() => renderArtifacts([{ path: bad, value: 1 }], manifest)).toThrow(/Unsafe/)
    }
  })
})

describe("writeArtifacts", () => {
  const dir = mkdtempSync(join(tmpdir(), "invariant-artifacts-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it("writes files including nested directories", async () => {
    const out = renderArtifacts([{ path: "ir/a.ir.json", value: { a: 1 } }], manifest)
    await writeArtifacts(dir, out)
    expect(readFileSync(join(dir, "ir/a.ir.json"), "utf8")).toBe('{\n  "a": 1\n}\n')
    expect(JSON.parse(readFileSync(join(dir, MANIFEST_PATH), "utf8")).artifacts).toHaveLength(1)
  })

  it("refuses paths that escape the output directory", async () => {
    await expect(writeArtifacts(dir, [{ path: "../evil.json", text: "x", sha256: "" }])).rejects.toThrow(
      /Unsafe|escapes/
    )
  })
})
