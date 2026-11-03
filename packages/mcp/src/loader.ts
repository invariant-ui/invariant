import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { evidenceFileSchema, parseContract, verifyContract } from "@invariant/contract"
import { DesignSystem } from "@invariant/contract-query"

export type Loaded = { ok: true; ds: DesignSystem; manifest?: string } | { ok: false; message: string }

const stamp = (file: string): string => {
  try {
    const s = statSync(file)
    return `${s.mtimeMs}:${s.size}`
  } catch {
    return "missing"
  }
}

/**
 * Loads the compiled contract from an output directory and reloads it when the files change, so a recompile
 * is picked up without restarting the server. A missing or invalid contract is reported, never half-served.
 */
export class ContractSource {
  readonly dir: string
  private key = ""
  private cached: Loaded | undefined

  constructor(dir: string) {
    this.dir = dir
  }

  load(): Loaded {
    const contractFile = path.join(this.dir, "invariant.contract.json")
    const evidenceFile = path.join(this.dir, "invariant.evidence.json")
    const manifestFile = path.join(this.dir, "invariant.manifest.json")
    const key = [contractFile, evidenceFile, manifestFile].map(stamp).join("|")
    if (this.cached && key === this.key) return this.cached
    this.key = key
    this.cached = this.read(contractFile, evidenceFile, manifestFile)
    return this.cached
  }

  private read(contractFile: string, evidenceFile: string, manifestFile: string): Loaded {
    if (!existsSync(contractFile) || !existsSync(evidenceFile))
      return { ok: false, message: `No compiled contract in ${this.dir}. Run \`invariant compile\` first.` }
    let contractRaw: unknown
    let evidenceRaw: unknown
    try {
      contractRaw = JSON.parse(readFileSync(contractFile, "utf8"))
      evidenceRaw = JSON.parse(readFileSync(evidenceFile, "utf8"))
    } catch (error) {
      return { ok: false, message: `The compiled output is not valid JSON: ${(error as Error).message}` }
    }
    const parsed = parseContract(contractRaw)
    if (!parsed.ok)
      return {
        ok: false,
        message: `The contract is invalid: ${parsed.diagnostics[0]?.message ?? "schema error"}`
      }
    const evidence = evidenceFileSchema.safeParse(evidenceRaw)
    if (!evidence.success)
      return { ok: false, message: "The evidence file is invalid. Run `invariant compile`." }
    const errors = verifyContract(parsed.value, evidence.data).filter((d) => d.severity === "error")
    if (errors.length > 0)
      return {
        ok: false,
        message: `The contract failed verification (${errors[0]?.code}: ${errors[0]?.message}). Run \`invariant compile\`.`
      }
    return {
      ok: true,
      ds: new DesignSystem(parsed.value, evidence.data),
      ...(existsSync(manifestFile) ? { manifest: readFileSync(manifestFile, "utf8") } : {})
    }
  }
}
