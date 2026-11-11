import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { Context } from "./commands.js"
import { readEvents } from "./enforcement-log.js"
import { renderHtml, renderText, summarize } from "./enforcement-report.js"
import { CliError } from "./errors.js"

/**
 * `invariant enforcement report`: the session timeline from the enforcement log, as text (default) or one
 * self-contained HTML page (`--format html`, optionally `--to <file>`). Covers the latest session unless
 * `--session <id>` or `--all` says otherwise.
 */
export async function enforcement(c: Context): Promise<number> {
  const [, sub] = c.args.positionals
  if (sub !== "report")
    throw new CliError(
      "usage: invariant enforcement report [--session <id>|--all] [--format text|html] [--to <file>]"
    )
  const format = c.args.values.format ?? "text"
  if (format !== "text" && format !== "html") throw new CliError("--format must be text or html")
  const events = readEvents(c.cwd)
  const last = events.at(-1)
  const session = c.args.values.all ? "all" : (c.args.values.session ?? last?.session ?? "none")
  const chosen = c.args.values.all ? events : events.filter((e) => e.session === session)
  const summary = summarize(session, chosen)
  const out = format === "html" ? renderHtml(summary) : renderText(summary)
  const to = c.args.values.to
  if (to) {
    const file = path.resolve(c.cwd, to)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, out)
    c.io.stdout(`wrote ${path.relative(c.cwd, file) || to}\n`)
  } else c.io.stdout(out)
  return 0
}
