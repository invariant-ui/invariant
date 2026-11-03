import type { Readable, Writable } from "node:stream"

export interface Io {
  cwd: string
  stdout(text: string): void
  stderr(text: string): void
  /** ISO timestamp provider; injected so artifacts can be reproduced in tests. */
  clock: () => string
  /** Environment variables (for `INVARIANT_USER`). */
  env?: Record<string, string | undefined>
  /** Streams for `mcp`, which speaks JSON-RPC over them. Absent in contexts that cannot serve. */
  input?: Readable
  output?: Writable
  /** Stops long-running commands (`compile --watch`). Absent means they run until the process ends. */
  signal?: AbortSignal
}
