import { jsonValueSchema, TOKEN_CATEGORIES } from "@invariant/contract"
import {
  componentView,
  compositionView,
  type DesignSystem,
  guidelinesView,
  overview,
  patternsView,
  search,
  tokensView,
  usageView
} from "@invariant/contract-query"
import type { JsonValue } from "@invariant/shared"
import { MAX_CODE_CHARS, type PropValue, validateCode, validateUsage } from "@invariant/validation"
import { z } from "zod"

export interface ToolResult {
  isError: boolean
  /** The JSON object returned to the model, also serialized into the text content. */
  data: Record<string, JsonValue>
}

export interface Tool {
  name: string
  title: string
  description: string
  schema: z.ZodType
  run(ds: DesignSystem, args: never): ToolResult
}

const ok = (data: Record<string, JsonValue>): ToolResult => ({ isError: false, data })
const fail = (message: string, extra: Record<string, JsonValue> = {}): ToolResult => ({
  isError: true,
  data: { error: message, ...extra }
})

const name = z
  .string()
  .min(1)
  .max(200)
  .describe("Component name or id, for example Button or component:button")
const paging = {
  offset: z.number().int().min(0).max(100000).optional().describe("Items to skip"),
  limit: z.number().int().min(1).max(200).optional().describe("Items to return (default 50, at most 200)")
}
const framework = z.enum(["react", "vue", "angular", "html"])

function resolve(
  ds: DesignSystem,
  query: string
): { component: NonNullable<ReturnType<DesignSystem["component"]>> } | ToolResult {
  const found = ds.findComponent(query)
  if (found.match) return { component: found.match }
  return fail(
    found.candidates.length > 1
      ? `"${query}" matches several components; use the id.`
      : `No component matches "${query}".`,
    { candidates: found.candidates.map((c) => ({ id: c.id, name: c.name })) }
  )
}

const component =
  (
    fn: (ds: DesignSystem, c: NonNullable<ReturnType<DesignSystem["component"]>>) => Record<string, JsonValue>
  ) =>
  (ds: DesignSystem, args: { name: string }): ToolResult => {
    const r = resolve(ds, args.name)
    return "component" in r ? ok(fn(ds, r.component)) : r
  }

export const TOOLS: Tool[] = [
  {
    name: "get_design_system_overview",
    title: "Design system overview",
    description:
      "Start here. Returns the design system's name, frameworks, sources, counts, open conflicts between sources, how much is inferred, and what the contract does not cover.",
    schema: z.strictObject({}),
    run: (ds) => ok(overview(ds))
  },
  {
    name: "search_design_system",
    title: "Search components, tokens and guidelines",
    description:
      "Lexical search over component names, props, variants, slots, token names and values, and guideline titles. Ranked by fixed rules; results say what matched. Use it to find the component for a need before writing UI.",
    schema: z.strictObject({
      query: z.string().min(1).max(200),
      kinds: z
        .array(z.enum(["component", "token", "guideline"]))
        .max(3)
        .optional(),
      limit: z.number().int().min(1).max(100).optional()
    }),
    run: (ds, a: { query: string; kinds?: Array<"component" | "token" | "guideline">; limit?: number }) => {
      const r = search(ds, a.query, a.kinds, a.limit)
      return ok({ total: r.total, hits: r.hits as unknown as JsonValue })
    }
  },
  {
    name: "get_component",
    title: "Get a component",
    description:
      "The full contract entry for one component: implementations per framework, props with type, default, allowed values and where each is declared, events, slots, variants, accessibility, conflicts between sources, and notes about what is incomplete.",
    schema: z.strictObject({ name }),
    run: component((ds, c) => componentView(ds, c)) as Tool["run"]
  },
  {
    name: "get_component_usage",
    title: "How to use a component",
    description:
      "What is needed to use a component correctly: how to import it, required props, variants and defaults, deprecated props, source-written examples, and observed prop combinations when available.",
    schema: z.strictObject({ name }),
    run: component((ds, c) => usageView(ds, c)) as Tool["run"]
  },
  {
    name: "get_component_composition",
    title: "Component composition",
    description:
      "What a component contains and what contains it (with whether each link was discovered or inferred), plus its slots. Use it to build correct compound structures.",
    schema: z.strictObject({ name }),
    run: component((ds, c) => compositionView(ds, c)) as Tool["run"]
  },
  {
    name: "get_design_tokens",
    title: "Design tokens",
    description:
      "Design tokens with their resolved values and per-theme values. Filter by category, text, or theme. Always prefer a token over a literal value.",
    schema: z.strictObject({
      category: z.enum(TOKEN_CATEGORIES).optional(),
      query: z.string().max(200).optional(),
      theme: z.string().max(64).optional().describe("Theme name such as dark"),
      ...paging
    }),
    run: (ds, a: { category?: string; query?: string; theme?: string; offset?: number; limit?: number }) =>
      ok(tokensView(ds, a))
  },
  {
    name: "get_design_patterns",
    title: "Design patterns",
    description:
      "Documented design patterns. The list is empty when no source defines patterns; the response says so.",
    schema: z.strictObject({}),
    run: (ds) => ok(patternsView(ds))
  },
  {
    name: "get_design_guidelines",
    title: "Design guidelines",
    description:
      "Guideline documents known to the contract, filterable by kind, component, or text. Returns titles and the documents to read; page bodies are not included.",
    schema: z.strictObject({
      kind: z
        .enum(["usage", "accessibility", "composition", "visual-principle", "do-dont", "reference"])
        .optional(),
      component: z.string().max(200).optional(),
      query: z.string().max(200).optional(),
      ...paging
    }),
    run: (ds, a: { kind?: string; component?: string; query?: string; offset?: number; limit?: number }) =>
      ok(guidelinesView(ds, a))
  },
  {
    name: "validate_component_usage",
    title: "Validate a component usage",
    description:
      'Checks one intended use of a component against the contract: unknown component or prop, value outside the declared values, wrong type, deprecated use, missing required props. A prop is only called unknown when the component\'s API listing is complete. For a value you cannot evaluate, pass {"expression": "..."}.',
    schema: z.strictObject({
      component: name,
      framework: framework.optional(),
      props: z
        .record(z.string().max(100), jsonValueSchema)
        .optional()
        .describe('Prop values. Use {"expression":"text"} for dynamic values.'),
      hasChildren: z.boolean().optional().describe("Whether children or default slot content are present")
    }),
    run: (
      ds,
      a: {
        component: string
        framework?: "react" | "vue" | "angular" | "html"
        props?: Record<string, PropValue>
        hasChildren?: boolean
      }
    ) => {
      const r = validateUsage(ds, {
        component: a.component,
        framework: a.framework === "html" ? undefined : a.framework,
        props: a.props,
        hasChildren: a.hasChildren
      })
      const errors = r.findings.filter((f) => f.severity === "error").length
      return ok({
        valid: errors === 0,
        component: r.component ?? null,
        findings: r.findings as unknown as JsonValue,
        unverifiedValues: r.unverifiedValues
      })
    }
  },
  {
    name: "validate_design_system_compliance",
    title: "Validate code against the design system",
    description: `Statically checks a code snippet (JSX/TSX, Vue, Angular or HTML template; at most ${MAX_CODE_CHARS} characters) against the contract: component props and values, literal colors and CSS variables against tokens. Nothing is executed. Only literal values are verified and the response lists what was not.`,
    schema: z.strictObject({
      code: z.string().min(1).max(MAX_CODE_CHARS),
      framework: framework
        .optional()
        .describe("Defaults from the file name, else the contract's only framework, else react"),
      filename: z.string().max(200).optional()
    }),
    run: (ds, a: { code: string; framework?: "react" | "vue" | "angular" | "html"; filename?: string }) =>
      ok(validateCode(ds, a) as unknown as Record<string, JsonValue>)
  }
]
