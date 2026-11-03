import path from "node:path"
import { parse } from "./args.js"
import * as commands from "./commands.js"
import * as governance from "./commands-governance.js"
import * as validation from "./commands-validate.js"
import { CliError } from "./errors.js"
import type { Io } from "./io.js"
import { CLI_NAME, CLI_VERSION } from "./version.js"

export const HELP = `${CLI_NAME} ${CLI_VERSION}: compile a design system into a machine-readable contract

usage: ${CLI_NAME} <command> [options]

  init                          detect sources and write invariant.config.json
  source add <type> [path]      add a source (react, vue, angular, storybook, tokens)
  source remove <id>            remove a configured source
  source list                   list configured sources
  analyze                       extract each source and report what was found
  compile                       build the contract, evidence, diagnostics, review and report [--watch recompiles when sources change]
  components list | inspect <name>
  tokens list
  patterns list
  conflicts list                [--severity s] [--type t] [--subject id]
  validate <path...>            check application code against the contract [--format text|json|github|sarif] [--fail-on error|warning|never]
  verify                        check the compiled output itself [--fresh recompiles and compares]
  rules                         list the validation rules
  policy list                   list approved policies (written in invariant.policies.json)
  review list | show <id>       what needs a human decision
  review approve|reject|resolve|accept|dismiss <id> --as <name>   record a decision in invariant.decisions.json
  export --to <dir>             write a portable copy of the artifacts
  mcp                           serve the compiled contract to AI tools over stdio (read-only)
  agent init <client|all>       write MCP config and skills for claude-code, cursor, codex, windsurf
  agent list                    list supported clients

options: --cwd <dir> --config <file> --dir <output dir> --json --force --trust-config --keep-ir --evidence
         agent init: --command <exe> --command-arg <arg> --dry-run
exit codes: 0 ok, 1 findings or invalid output, 2 bad usage or input
`

/** Runs one command line. Returns the process exit code and never throws. */
export async function run(argv: string[], io: Io): Promise<number> {
  try {
    const args = parse(argv)
    if (args.values.version) {
      io.stdout(`${CLI_VERSION}\n`)
      return 0
    }
    const [command] = args.positionals
    if (args.values.help || !command || command === "help") {
      io.stdout(HELP)
      return command || args.values.help ? 0 : 2
    }
    const context = { io, args, cwd: path.resolve(io.cwd, args.values.cwd ?? ".") }
    switch (command) {
      case "init":
        return await commands.init(context)
      case "source":
        return await commands.source(context)
      case "analyze":
        return await commands.analyze(context)
      case "compile":
        return await commands.compileCommand(context)
      case "components":
        return await commands.components(context)
      case "tokens":
        return await commands.tokens(context)
      case "patterns":
        return await commands.patterns(context)
      case "conflicts":
        return await commands.conflicts(context)
      case "validate":
        return await validation.validate(context)
      case "verify":
        return await commands.verify(context)
      case "rules":
        return await validation.rules(context)
      case "review":
        return await governance.review(context)
      case "policy":
        return await governance.policy(context)
      case "export":
        return await commands.exportCommand(context)
      case "mcp":
        return await commands.mcp(context)
      case "agent":
        return await commands.agent(context)
      default:
        throw new CliError(`unknown command "${command}". Run \`${CLI_NAME} help\`.`)
    }
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr(`error: ${error.message}\n`)
      return error.exitCode
    }
    io.stderr(`error: ${(error as Error).stack ?? String(error)}\n`)
    return 1
  }
}
