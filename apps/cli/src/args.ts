import { parseArgs } from "node:util"
import { CliError } from "./errors.js"

const OPTIONS = {
  cwd: { type: "string" },
  config: { type: "string" },
  dir: { type: "string" },
  "trust-config": { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  force: { type: "boolean" },
  id: { type: "string" },
  to: { type: "string" },
  fresh: { type: "boolean" },
  watch: { type: "boolean" },
  "keep-ir": { type: "boolean" },
  severity: { type: "string" },
  type: { type: "string" },
  subject: { type: "string" },
  evidence: { type: "boolean" },
  command: { type: "string" },
  "command-arg": { type: "string", multiple: true },
  "dry-run": { type: "boolean" },
  format: { type: "string" },
  "fail-on": { type: "string" },
  framework: { type: "string" },
  as: { type: "string" },
  role: { type: "string" },
  reference: { type: "string" },
  note: { type: "string" },
  source: { type: "string" },
  kind: { type: "string" }
} as const

export interface Parsed {
  positionals: string[]
  values: {
    cwd?: string
    config?: string
    dir?: string
    "trust-config"?: boolean
    json?: boolean
    help?: boolean
    version?: boolean
    force?: boolean
    id?: string
    to?: string
    fresh?: boolean
    watch?: boolean
    "keep-ir"?: boolean
    severity?: string
    type?: string
    subject?: string
    evidence?: boolean
    command?: string
    "command-arg"?: string[]
    "dry-run"?: boolean
    format?: string
    "fail-on"?: string
    framework?: string
    as?: string
    role?: string
    reference?: string
    note?: string
    source?: string
    kind?: string
  }
}

export function parse(argv: string[]): Parsed {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true
    })
    return { values, positionals }
  } catch (error) {
    throw new CliError((error as Error).message.replace(/\. To specify.*$/, ""))
  }
}
