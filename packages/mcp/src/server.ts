import { z } from "zod"
import type { ContractSource, Loaded } from "./loader.js"
import {
  ERROR,
  type Id,
  INSTRUCTIONS,
  LEGACY_VERSIONS,
  META_SERVER_INFO,
  META_VERSION,
  MODERN_VERSIONS,
  PROVENANCE_KEY,
  type Response,
  SERVER_NAME,
  SERVER_TITLE
} from "./protocol.js"
import { RESOURCE_TEMPLATES, RESOURCES, readResource } from "./resources.js"
import { TOOLS } from "./tools.js"

export const MAX_RESULT_CHARS = 400_000

export interface ServerOptions {
  source: ContractSource
  version: string
}

const CAPABILITIES = { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } }

const toolDefinition = (t: (typeof TOOLS)[number]): Record<string, unknown> => {
  const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(t.schema) as Record<string, unknown>
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema,
    annotations: {
      title: t.title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/**
 * A stdio MCP server over the compiled contract. Dual-era: a request carrying the modern `_meta` is served
 * under the stateless revision; `initialize` selects the handshake revisions. Read-only: no tool writes,
 * calls out, or runs customer code.
 */
export class McpServer {
  private readonly source: ContractSource
  private readonly version: string

  constructor(options: ServerOptions) {
    this.source = options.source
    this.version = options.version
  }

  /** Handles one line of input. Returns the line to write back, or undefined for a notification. */
  async handleLine(line: string): Promise<string | undefined> {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      return JSON.stringify(this.error(null, ERROR.parse, "Parse error"))
    }
    const response = await this.handle(message)
    return response ? JSON.stringify(response) : undefined
  }

  async handle(message: unknown): Promise<Response | undefined> {
    if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string")
      return this.error(
        isObject(message) && (typeof message.id === "string" || typeof message.id === "number")
          ? message.id
          : null,
        ERROR.invalidRequest,
        "Invalid Request"
      )
    const id = message.id
    if (id === undefined) return undefined
    if (typeof id !== "string" && typeof id !== "number")
      return this.error(null, ERROR.invalidRequest, "Invalid Request: id must be a string or number")
    const params = isObject(message.params) ? message.params : {}
    try {
      return await this.dispatch(id, message.method, params)
    } catch (error) {
      process.stderr.write(`[invariant-mcp] ${(error as Error).stack ?? String(error)}\n`)
      return this.error(id, ERROR.internal, "Internal error")
    }
  }

  private meta(params: Record<string, unknown>): { modern: boolean; requested?: string } {
    const meta = params._meta
    const requested = isObject(meta) ? meta[META_VERSION] : undefined
    return typeof requested === "string" ? { modern: true, requested } : { modern: false }
  }

  private ok(id: Id, result: Record<string, unknown>, modern: boolean): Response {
    return { jsonrpc: "2.0", id, result: modern ? { resultType: "complete", ...result } : result }
  }

  private error(id: Id | null, code: number, message: string, data?: unknown): Response {
    return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } }
  }

  private async dispatch(id: Id, method: string, params: Record<string, unknown>): Promise<Response> {
    if (method === "initialize") return this.initialize(id, params)
    if (method === "ping") return this.ok(id, {}, this.meta(params).modern)
    const { modern, requested } = this.meta(params)
    if (modern && !(MODERN_VERSIONS as readonly string[]).includes(requested as string))
      return this.error(id, ERROR.unsupportedVersion, "Unsupported protocol version", {
        supported: [...MODERN_VERSIONS],
        requested
      })
    switch (method) {
      case "server/discover":
        return this.ok(
          id,
          {
            supportedVersions: [...MODERN_VERSIONS],
            capabilities: CAPABILITIES,
            _meta: { [META_SERVER_INFO]: { name: SERVER_NAME, version: this.version } },
            instructions: INSTRUCTIONS
          },
          true
        )
      case "tools/list":
        return this.ok(id, { tools: TOOLS.map(toolDefinition) }, modern)
      case "tools/call":
        return this.callTool(id, params, modern)
      case "resources/list":
        return this.ok(id, { resources: RESOURCES }, modern)
      case "resources/templates/list":
        return this.ok(id, { resourceTemplates: RESOURCE_TEMPLATES }, modern)
      case "resources/read":
        return this.readResource(id, params, modern)
      default:
        return this.error(id, ERROR.methodNotFound, `Method not found: ${method}`)
    }
  }

  private initialize(id: Id, params: Record<string, unknown>): Response {
    const requested = params.protocolVersion
    if (typeof requested !== "string")
      return this.error(id, ERROR.invalidParams, "initialize requires protocolVersion")
    const known = (LEGACY_VERSIONS as readonly string[]).includes(requested)
    if (!known && (MODERN_VERSIONS as readonly string[]).includes(requested))
      return this.error(
        id,
        ERROR.invalidParams,
        `${requested} does not use initialize; send server/discover`,
        { supported: [...LEGACY_VERSIONS, ...MODERN_VERSIONS] }
      )
    return this.ok(
      id,
      {
        protocolVersion: known ? requested : LEGACY_VERSIONS[0],
        capabilities: CAPABILITIES,
        serverInfo: { name: SERVER_NAME, title: SERVER_TITLE, version: this.version },
        instructions: INSTRUCTIONS
      },
      false
    )
  }

  private loaded(): Loaded {
    return this.source.load()
  }

  private callTool(id: Id, params: Record<string, unknown>, modern: boolean): Response {
    const name = params.name
    if (typeof name !== "string")
      return this.error(id, ERROR.invalidParams, "tools/call requires a tool name")
    const tool = TOOLS.find((t) => t.name === name)
    if (!tool) return this.error(id, ERROR.invalidParams, `Unknown tool: ${name}`)
    const text = (message: string): Response =>
      this.ok(id, { content: [{ type: "text", text: message }], isError: true }, modern)
    const parsed = tool.schema.safeParse(params.arguments ?? {})
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return text(`Invalid arguments: ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}`)
    }
    const loaded = this.loaded()
    if (!loaded.ok) return text(loaded.message)
    const result = tool.run(loaded.ds, parsed.data as never)
    const data = { ...result.data, contractHash: loaded.ds.contentHash }
    const body = JSON.stringify(data, null, 2)
    if (body.length > MAX_RESULT_CHARS)
      return text("The result is too large. Narrow the request with a filter or a smaller limit.")
    return this.ok(
      id,
      {
        content: [{ type: "text", text: body }],
        structuredContent: data,
        isError: result.isError,
        _meta: { [PROVENANCE_KEY]: { untrustedContent: true, contractHash: loaded.ds.contentHash } }
      },
      modern
    )
  }

  private readResource(id: Id, params: Record<string, unknown>, modern: boolean): Response {
    const uri = params.uri
    if (typeof uri !== "string") return this.error(id, ERROR.invalidParams, "resources/read requires a uri")
    const read = readResource(this.loaded(), uri)
    if (!read.ok)
      return this.error(
        id,
        read.reason === "not-found" ? ERROR.invalidParams : ERROR.internal,
        read.reason === "not-found" ? "Resource not found" : read.message,
        { uri }
      )
    return this.ok(
      id,
      {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: read.text,
            _meta: { [PROVENANCE_KEY]: { untrustedContent: true } }
          }
        ]
      },
      modern
    )
  }
}
