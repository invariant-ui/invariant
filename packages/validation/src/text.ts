/** Edit distance, capped: returns `limit + 1` as soon as the distance must exceed `limit`. */
export function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(
        (prev[j] as number) + 1,
        (cur[j - 1] as number) + 1,
        (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
      cur.push(v)
      if (v < best) best = v
    }
    if (best > limit) return limit + 1
    prev = cur
  }
  return prev[b.length] as number
}

/** Up to `max` candidates close to `name`, nearest first. Case-insensitive; never suggests the name itself. */
export function nearest(name: string, candidates: readonly string[], max = 3): string[] {
  const n = name.toLowerCase()
  const limit = Math.max(2, Math.floor(n.length / 3))
  return [...new Set(candidates)]
    .filter((c) => c.toLowerCase() !== n)
    .map((c) => ({ c, d: distance(n, c.toLowerCase(), limit) }))
    .filter((x) => x.d <= limit)
    .sort((a, b) => a.d - b.d || (a.c < b.c ? -1 : 1))
    .slice(0, max)
    .map((x) => x.c)
}

export const quoteList = (values: readonly (string | number | boolean)[]): string =>
  values.map((v) => JSON.stringify(v)).join(", ")
