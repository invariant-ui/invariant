import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { type Contract, resolveFactPath } from "@invariant/contract"
import {
  addDecision,
  claimsHash,
  DECISIONS_FILE,
  type Decision,
  type DecisionsFile,
  parseDecisions,
  serializeDecisions
} from "@invariant/governance"
import { buildReviewQueue, type ReviewItem } from "@invariant/reconciliation"
import type { JsonValue } from "@invariant/shared"
import { type Context, json, outputDir, print } from "./commands.js"
import { loadConfig } from "./config.js"
import { CliError } from "./errors.js"
import { shortValue, table } from "./format.js"
import { loadCompiled } from "./store.js"
import { CLI_NAME } from "./version.js"

type Entity = { id: string; facts?: Record<string, unknown> }

function items(contract: Contract): ReviewItem[] {
  const { integrity: _i, ...draft } = contract
  return buildReviewQueue(draft)
}

function find(queue: readonly ReviewItem[], id: string): ReviewItem {
  const exact = queue.filter((i) => i.id === id)
  const hits = exact.length > 0 ? exact : queue.filter((i) => i.id.startsWith(id))
  if (hits.length === 0)
    throw new CliError(
      `no open review item "${id}". List them with \`${CLI_NAME} review list\`; decided items disappear after \`${CLI_NAME} compile\`.`,
      1
    )
  if (hits.length > 1) throw new CliError(`"${id}" matches ${hits.length} items; use more characters`, 1)
  return hits[0] as ReviewItem
}

export async function review(c: Context): Promise<number> {
  const [, sub, id] = c.args.positionals
  const { contract, evidence } = loadCompiled(await outputDir(c))
  const queue = items(contract)
  if (sub === "list") {
    const kind = c.args.values.kind
    const rows = queue.filter((i) => !kind || i.kind === kind)
    if (c.args.values.json) json(c, rows)
    else
      print(
        c,
        rows.length === 0
          ? "nothing to review"
          : table(
              ["id", "priority", "kind", "subject", "path", "confidence", "reason"],
              rows.map((i) => [
                i.id,
                i.priority,
                i.kind,
                i.subject,
                i.path ?? "",
                i.confidence ?? "",
                shortValue(i.reason, 60)
              ])
            )
      )
    return 0
  }
  if (sub === "show") {
    if (!id) throw new CliError("usage: invariant review show <id>")
    const item = find(queue, id)
    const evidenceById = new Map(evidence.evidence.map((e) => [e.id, e]))
    const where = item.evidenceIds
      .map((e) => evidenceById.get(e))
      .map((e) =>
        e?.location.type === "file"
          ? `${e.location.path}${e.location.line ? `:${e.location.line}` : ""}`
          : (e?.sourceRef ?? "")
      )
    if (c.args.values.json) {
      json(c, { ...item, evidence: where })
      return 0
    }
    print(c, `${item.id}  ${item.kind}  ${item.priority}`)
    print(c, `subject: ${item.subject}${item.path ? `  path: ${item.path}` : ""}`)
    if (item.rule) print(c, `rule: ${item.rule}  confidence: ${item.confidence}`)
    print(c, `reason: ${item.reason}`)
    print(c, `evidence: ${[...new Set(where)].join(", ") || "none"}`)
    if (item.conflictId) {
      const conflict = contract.conflicts.find((x) => x.id === item.conflictId)
      print(c, "claims:")
      for (const cl of conflict?.claims ?? [])
        print(
          c,
          `  ${cl.sourceId} (${cl.status}): ${cl.value === undefined ? "(absent)" : JSON.stringify(cl.value)}`
        )
    }
    return 0
  }

  const factActions = ["approve", "reject"]
  const conflictActions = ["resolve", "accept", "dismiss"]
  if (!sub || ![...factActions, ...conflictActions].includes(sub) || !id)
    throw new CliError(
      "usage: invariant review <list|show <id>|approve <id>|reject <id>|resolve <id>|accept <id>|dismiss <id>> --as <name> [--role r] [--reference ref] [--note n] [--source id]"
    )
  const loaded = await loadConfig({
    cwd: c.cwd,
    file: c.args.values.config,
    trustConfig: c.args.values["trust-config"] === true
  })
  const by = c.args.values.as ?? c.io.env?.INVARIANT_USER
  if (!by || by.trim() === "")
    throw new CliError(
      "say who is deciding: --as <name> (or set INVARIANT_USER). Names are recorded, not authenticated."
    )
  const approvers = loaded?.config.governance?.approvers
  if (approvers && approvers.length > 0 && !approvers.includes(by))
    throw new CliError(`"${by}" is not listed in governance.approvers`)
  const item = find(queue, id)
  const at = c.io.clock()
  const note = c.args.values.note
  let decision: Decision
  if (conflictActions.includes(sub)) {
    if (item.kind !== "conflict" || !item.conflictId)
      throw new CliError(
        `${sub} applies to conflicts; ${item.id} is an inferred fact (use approve or reject)`
      )
    const conflict = contract.conflicts.find((x) => x.id === item.conflictId)
    if (!conflict) throw new CliError("the conflict is no longer in the contract", 1)
    const source = c.args.values.source
    if (source && !conflict.claims.some((cl) => cl.sourceId === source))
      throw new CliError(`--source must be one of: ${conflict.claims.map((cl) => cl.sourceId).join(", ")}`)
    decision = {
      kind: "conflict",
      action: sub as "resolve",
      id: conflict.id,
      claimsHash: claimsHash(conflict),
      ...(source ? { chosenSourceId: source } : {}),
      by,
      at,
      ...(note ? { note } : {})
    }
  } else {
    if (item.kind !== "inferred-fact" || !item.path)
      throw new CliError(
        `${sub} applies to inferred facts; ${item.id} is a conflict (use resolve, accept or dismiss)`
      )
    const entity = [
      ...contract.components,
      ...contract.tokens,
      ...contract.guidelines,
      ...contract.patterns,
      ...contract.constraints
    ].find((e: Entity) => e.id === item.subject)
    const value = entity ? resolveFactPath(entity, item.path) : { found: false as const }
    if (!value.found) throw new CliError(`cannot read ${item.subject} ${item.path} from the contract`, 1)
    decision = {
      kind: "fact",
      action: sub as "approve",
      subject: item.subject,
      path: item.path,
      value: value.value as JsonValue,
      ...(c.args.values.role ? { role: c.args.values.role } : {}),
      ...(c.args.values.reference ? { reference: c.args.values.reference } : {}),
      by,
      at,
      ...(note ? { note } : {})
    }
  }
  const file = path.resolve(c.cwd, loaded?.config.governance?.decisionsFile ?? DECISIONS_FILE)
  let current: DecisionsFile | undefined
  if (existsSync(file)) {
    const parsed = parseDecisions(readFileSync(file, "utf8"))
    if (!parsed.ok) throw new CliError(parsed.message)
    current = parsed.value
  }
  writeFileSync(file, serializeDecisions(addDecision(current, decision)), "utf8")
  print(c, `recorded: ${sub} ${item.subject}${item.path ? ` ${item.path}` : ""} by ${by}`)
  print(c, `Run \`${CLI_NAME} compile\` to apply it, and commit ${path.relative(c.cwd, file)}.`)
  return 0
}

export async function policy(c: Context): Promise<number> {
  if (c.args.positionals[1] !== "list") throw new CliError("usage: invariant policy list")
  const { contract } = loadCompiled(await outputDir(c))
  if (c.args.values.json) {
    json(c, contract.policies)
    return 0
  }
  print(
    c,
    contract.policies.length === 0
      ? `no approved policies. Write them in invariant.policies.json and run \`${CLI_NAME} compile\`.`
      : table(
          ["id", "severity", "enforcement", "rule", "approved by", "approved at"],
          contract.policies.map((p) => {
            const rule =
              (
                contract.constraints.find((k) => k.id === p.basedOn[0])?.extensions?.invariant as
                  | { rule?: { kind?: string } }
                  | undefined
              )?.rule?.kind ?? ""
            return [
              p.id,
              p.severity,
              p.enforcement,
              rule,
              p.approval.approvedBy,
              p.approval.approvedAt.slice(0, 10)
            ]
          })
        )
  )
  return 0
}
