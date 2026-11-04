import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { type MANIFEST_PATH, manifestSchema } from "@invariant/artifact-generator"
import {
  type Contract,
  type EvidenceFile,
  evidenceFileSchema,
  parseContract,
  verifyContract
} from "@invariant/contract"
import { type Diagnostic, DiagnosticCollector, sha256Hex } from "@invariant/shared"
import { CliError } from "./errors.js"

export interface Compiled {
  dir: string
  contract: Contract
  evidence: EvidenceFile
}

function readText(file: string, what: string): string {
  if (!existsSync(file)) throw new CliError(`${what} not found at ${file}. Run \`invariant compile\` first.`)
  return readFileSync(file, "utf8")
}

/** Loads the compiled contract and evidence from an output directory, checking structure only. */
export function loadCompiled(dir: string): Compiled {
  const contractText = readText(path.join(dir, "invariant.contract.json"), "contract")
  const evidenceText = readText(path.join(dir, "invariant.evidence.json"), "evidence file")
  let contractRaw: unknown
  let evidenceRaw: unknown
  try {
    contractRaw = JSON.parse(contractText)
    evidenceRaw = JSON.parse(evidenceText)
  } catch (error) {
    throw new CliError(`output in ${dir} is not valid JSON: ${(error as Error).message}`, 1)
  }
  const parsed = parseContract(contractRaw)
  if (!parsed.ok)
    throw new CliError(
      `invariant.contract.json is invalid: ${parsed.diagnostics[0]?.message ?? "schema error"}`,
      1
    )
  const evidence = evidenceFileSchema.safeParse(evidenceRaw)
  if (!evidence.success)
    throw new CliError(
      `invariant.evidence.json is invalid: ${evidence.error.issues[0]?.message ?? "schema error"}`,
      1
    )
  return { dir, contract: parsed.value, evidence: evidence.data }
}

/**
 * Everything that can be checked without recompiling: the contract's own rules with its evidence, and the
 * manifest's hashes against the files on disk.
 */
export function checkOutput(dir: string): { compiled: Compiled; diagnostics: Diagnostic[] } {
  const compiled = loadCompiled(dir)
  const collector = new DiagnosticCollector()
  collector.addAll(verifyContract(compiled.contract, compiled.evidence))
  const manifestFile = path.join(dir, "invariant.manifest.json" satisfies typeof MANIFEST_PATH)
  if (!existsSync(manifestFile)) {
    collector.warning(
      "verify.manifest-missing",
      "invariant.manifest.json is missing, so file hashes were not checked"
    )
  } else {
    const manifest = manifestSchema.safeParse(JSON.parse(readFileSync(manifestFile, "utf8")))
    if (!manifest.success)
      collector.error("verify.manifest-invalid", "invariant.manifest.json does not match its schema")
    else
      for (const a of manifest.data.artifacts) {
        const file = path.join(dir, a.path)
        if (!existsSync(file))
          collector.error("verify.artifact-missing", `${a.path} is listed in the manifest but missing`)
        else if (sha256Hex(readFileSync(file, "utf8")) !== a.sha256)
          collector.error("verify.artifact-modified", `${a.path} does not match its hash in the manifest`)
      }
  }
  return { compiled, diagnostics: collector.toArray() }
}
