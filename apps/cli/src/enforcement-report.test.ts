import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { readEvents } from "./enforcement-log.js"
import { headline, renderHtml, renderText, summarize } from "./enforcement-report.js"

const dir = path.join(fileURLToPath(new URL("../../..", import.meta.url)), "fixtures/cli-golden/enforcement")

function events() {
  const root = mkdtempSync(path.join(tmpdir(), "invariant-log-"))
  mkdirSync(path.join(root, ".invariant"), { recursive: true })
  writeFileSync(
    path.join(root, ".invariant/enforcement.jsonl"),
    readFileSync(path.join(dir, "enforcement.jsonl"))
  )
  return readEvents(root)
}

describe("enforcement report", () => {
  const all = events()
  const s1 = summarize(
    "s1",
    all.filter((e) => e.session === "s1")
  )

  it("skips torn lines and computes the headline across block → warn → pass", () => {
    expect(all).toHaveLength(6)
    expect(headline(s1)).toBe("5 writes checked · 3 violations caught · 2 fixed · 1 outstanding")
    expect(s1.steps.map((x) => x.outcome)).toEqual(["blocked", "warned", "fixed", "passed", "blocked"])
    expect(s1.steps[2]?.resolves).toEqual(["prop-value-not-allowed", "color-matches-token"])
  })

  it.each([
    ["enforcement.report.txt", () => renderText(s1)],
    ["enforcement.report.html", () => renderHtml(s1)]
  ])("matches the golden %s", (name, render) => {
    const golden = path.join(dir, name)
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(golden)) writeFileSync(golden, render())
    expect(render()).toBe(readFileSync(golden, "utf8"))
  })

  it("escapes finding text in the HTML", () => {
    expect(renderHtml(s1)).not.toContain("<b>#ff0000</b>")
  })
})
