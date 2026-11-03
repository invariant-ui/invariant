#!/usr/bin/env node
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
  signal: stop.signal
})
process.exitCode = code
