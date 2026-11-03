import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"
import type { McpServer } from "./server.js"

/** Hard cap on one input line, so a misbehaving client cannot make the server buffer without limit. */
export const MAX_LINE_CHARS = 2_000_000

/**
 * Newline-delimited JSON-RPC over streams. Only protocol messages are written to `output`; everything else
 * goes to `log`. Requests are handled in arrival order. Resolves when the input ends (the client's shutdown signal).
 */
export async function serveStdio(
  input: Readable,
  output: Writable,
  server: McpServer,
  log: (text: string) => void = () => {}
): Promise<void> {
  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
  let chain: Promise<void> = Promise.resolve()
  for await (const line of rl) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    chain = chain.then(async () => {
      if (trimmed.length > MAX_LINE_CHARS) {
        log("input line too large; ignored\n")
        output.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } })}\n`
        )
        return
      }
      const reply = await server.handleLine(trimmed)
      if (reply !== undefined) output.write(`${reply}\n`)
    })
  }
  await chain
}
