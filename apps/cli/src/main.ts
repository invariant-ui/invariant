#!/usr/bin/env node
import { createInterface } from "node:readline/promises"
import { run } from "./cli.js"

const stop = new AbortController()
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => stop.abort())

const code = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  clock: () => new Date().toISOString(),
  env: process.env,
  input: process.stdin,
  output: process.stdout,
  signal: stop.signal,
  ...(process.stdin.isTTY && process.stdout.isTTY
    ? {
        prompt: async (question: string) => {
          const rl = createInterface({ input: process.stdin, output: process.stdout })
          try {
            return await rl.question(question)
          } finally {
            rl.close()
          }
        }
      }
    : {})
})
process.exitCode = code
