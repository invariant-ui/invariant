import { jsonValueSchema, TOKEN_CATEGORIES } from "@invariant/contract"
import {
  archetypeView,
  componentView,
  compositionView,
  type DesignSystem,
  guidelinesView,
  overview,
  patternRelationships,
  patternsView,
  patternView,
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

function resolvePattern(
  ds: DesignSystem,
  query: string
): { pattern: NonNullable<ReturnType<DesignSystem["pattern"]>> } | ToolResult {
  const found = ds.findPattern(query)
  if (found.match) return { pattern: found.match }
  return fail(
    found.candidates.length > 1
      ? `"${query}" matches several patterns; use the id.`
      : `No pattern matches "${query}".`,
    { candidates: found.candidates.map((p) => ({ id: p.id, name: p.name })) }
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
    title: "Search components, tokens, guidelines and patterns",
    description:
      "Lexical search over component names, props, variants, slots, token names and values, guideline titles, and pattern names, intents, parts, regions and states. Matches plurals, prefixes and one-letter typos. Ranked by fixed rules; results say what matched. Use it to find the component or pattern for a need before writing UI.",
    schema: z.strictObject({
      query: z.string().min(1).max(200),
      kinds: z
        .array(z.enum(["component", "token", "guideline", "pattern"]))
        .max(4)
        .optional(),
      limit: z.number().int().min(1).max(100).optional()
    }),
    run: (
      ds,
      a: { query: string; kinds?: Array<"component" | "token" | "guideline" | "pattern">; limit?: number }
    ) => {
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
      "Layouts, interactions, page archetypes and compositions the contract defines. With no name: lists patterns, filterable by category (layout, interaction, page, composition and others), status and text. With a name or id: that pattern in full, with its parts, regions, states, constraints, relationships, status and evidence. With a name and resolve true (or a variation): the pattern read as a page blueprint, with the patterns it composes expanded to any depth, its variations, the interaction states it requires, responsive expectations, prohibited combinations, and which of it is approved. Every result says whether the pattern is approved; treat anything else as a proposal. An empty list means none is defined, not that none applies.",
    schema: z.strictObject({
      name: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Pattern name or id, for example page.data-management"),
      category: z
        .enum([
          "layout",
          "navigation",
          "form",
          "data-table",
          "card",
          "dialog",
          "workflow",
          "composition",
          "interaction",
          "page",
          "other"
        ])
        .optional(),
      status: z
        .enum(["approved", "documented", "discovered", "inferred", "mixed", "none"])
        .optional()
        .describe("Derived from the pattern's facts; only approved means every fact is approved"),
      query: z.string().max(200).optional(),
      resolve: z
        .boolean()
        .optional()
        .describe("With a name: return the resolved blueprint, following composed patterns to any depth"),
      variation: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe("With a name: apply this named variation to the blueprint (implies resolve)"),
      ...paging
    }),
    run: (
      ds,
      a: {
        name?: string
        category?: string
        status?: string
        query?: string
        resolve?: boolean
        variation?: string
        offset?: number
        limit?: number
      }
    ) => {
      if (a.name === undefined) {
        if (a.resolve || a.variation) return fail("resolve and variation need a pattern name")
        return ok(patternsView(ds, a))
      }
      const r = resolvePattern(ds, a.name)
      if (!("pattern" in r)) return r
      if (!a.resolve && a.variation === undefined) return ok(patternView(ds, r.pattern))
      const blueprint = archetypeView(ds, r.pattern, { variation: a.variation })
      return blueprint.ok ? ok(blueprint.view) : fail(blueprint.message, { variations: blueprint.variations })
    }
  },
  {
    name: "get_pattern_relationships",
    title: "Pattern relationships",
    description:
      "What a pattern composes, contains, requires, uses, extends, replaces or conflicts with, and which patterns point at it, walked to a chosen depth. Composition parts appear as part edges with their role. Only stated relationships are returned; none is inferred from names. Each edge shows the status of the fact behind it.",
    schema: z.strictObject({
      name: z.string().min(1).max(200).describe("Pattern name or id"),
      direction: z.enum(["out", "in", "both"]).optional().describe("Default both"),
      depth: z.number().int().min(1).max(5).optional().describe("How many steps to follow (default 1)"),
      types: z
        .array(
          z.enum([
            "contains",
            "requires",
            "uses",
            "extends",
            "composes",
            "alternative-to",
            "prohibited-with",
            "supersedes",
            "part"
          ])
        )
        .max(9)
        .optional()
    }),
    run: (ds, a: { name: string; direction?: "out" | "in" | "both"; depth?: number; types?: string[] }) => {
      const r = resolvePattern(ds, a.name)
      return "pattern" in r ? ok(patternRelationships(ds, r.pattern, a)) : r
    }
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
    description: `Statically checks a code snippet (JSX/TSX, Vue, Angular or HTML template; at most ${MAX_CODE_CHARS} characters) against the contract: component props and values, literal colors, spacing and typography against tokens, and the structural rules and required interaction states of approved patterns (React only). Interaction results say how much they establish (structural or static-inferred); none is runtime verified. Nothing is executed. Only literal values are verified and the response lists what was not. Pass filename (project-relative) so path-scoped pattern rules can apply; the result's evaluations list every pattern check as pass, fail, warning, not-verifiable or skipped, and a check that cannot be established is never a pass.`,
    schema: z.strictObject({
      code: z.string().min(1).max(MAX_CODE_CHARS),
      framework: framework
        .optional()
        .describe("Defaults from the file name, else the contract's only framework, else react"),
      filename: z
        .string()
        .max(200)
        .optional()
        .describe(
          "Project-relative path, for example src/pages/Settings.tsx. Needed for path-scoped pattern rules."
        )
    }),
    run: (ds, a: { code: string; framework?: "react" | "vue" | "angular" | "html"; filename?: string }) =>
      ok(validateCode(ds, a) as unknown as Record<string, JsonValue>)
  }
]
