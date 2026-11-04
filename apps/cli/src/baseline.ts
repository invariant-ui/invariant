import { existsSync, readFileSync, writeFileSync } from "node:fs"
import type { Violation } from "@invariant/validation"
import { z } from "zod"

export const BASELINE_FILE = "invariant.baseline.json"

const baselineSchema = z.strictObject({
  version: z.literal(1),
  /** Violations that existed when the baseline was taken. They are hidden, not fixed, and counted. */
  violations: z.array(
    z.strictObject({
      file: z.string(),
      code: z.string(),
      message: z.string(),
      count: z.number().int().positive()
    })
  )
})
export type Baseline = z.infer<typeof baselineSchema>

/** Line numbers are left out so moving code does not bring an old finding back as new. */
const keyOf = (v: Pick<Violation, "file" | "code" | "message">): string =>
  `${v.file}\u0000${v.code}\u0000${v.message}`

export function makeBaseline(violations: readonly Violation[]): Baseline {
  const counts = new Map<string, { file: string; code: string; message: string; count: number }>()
  for (const v of violations) {
    const k = keyOf(v)
    const held = counts.get(k)
    if (held) held.count++
    else counts.set(k, { file: v.file, code: v.code, message: v.message, count: 1 })
  }
  const list = [...counts.values()].sort((a, b) =>
    a.file !== b.file
      ? a.file < b.file
        ? -1
        : 1
      : a.code !== b.code
        ? a.code < b.code
          ? -1
          : 1
        : a.message < b.message
          ? -1
          : 1
  )
  return { version: 1, violations: list }
}

export function readBaseline(file: string): Baseline | undefined {
  if (!existsSync(file)) return undefined
  const parsed = baselineSchema.safeParse(JSON.parse(readFileSync(file, "utf8")))
  if (!parsed.success)
    throw new Error(
      `${file} is not a valid baseline. Regenerate it with \`invariant validate <path...> --update-baseline\`.`
    )
  return parsed.data
}

export const writeBaseline = (file: string, baseline: Baseline): void =>
  writeFileSync(file, `${JSON.stringify(baseline, null, 2)}\n`)

/** A violation is hidden only while the baseline still has room for one like it. A new one beyond the count shows. */
export function applyBaseline(
  violations: readonly Violation[],
  baseline: Baseline
): { fresh: Violation[]; hidden: number } {
  const room = new Map(baseline.violations.map((v) => [keyOf(v), v.count]))
  const fresh: Violation[] = []
  let hidden = 0
  for (const v of violations) {
    const left = room.get(keyOf(v)) ?? 0
    if (left > 0) {
      room.set(keyOf(v), left - 1)
      hidden++
    } else fresh.push(v)
  }
  return { fresh, hidden }
}
