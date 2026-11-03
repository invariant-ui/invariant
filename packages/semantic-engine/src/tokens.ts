import type { Token } from "@invariant/contract"
import { cmp, type Inference, inferredFact, words } from "./infer.js"

type Category = Token["category"]

const DTCG: Record<string, Category> = {
  color: "color",
  shadow: "shadow",
  typography: "typography",
  fontFamily: "typography",
  fontWeight: "typography",
  fontSize: "typography",
  lineHeight: "typography",
  letterSpacing: "typography",
  border: "border",
  strokeStyle: "border",
  duration: "motion",
  cubicBezier: "motion",
  transition: "motion"
}

const NAME_PREFIX: Record<string, Category> = {
  color: "color",
  colour: "color",
  space: "spacing",
  spacing: "spacing",
  gap: "spacing",
  margin: "spacing",
  padding: "spacing",
  size: "sizing",
  sizing: "sizing",
  width: "sizing",
  height: "sizing",
  font: "typography",
  typography: "typography",
  line: "typography",
  letter: "typography",
  radius: "border",
  border: "border",
  stroke: "border",
  shadow: "shadow",
  elevation: "shadow",
  breakpoint: "breakpoint",
  screen: "breakpoint",
  duration: "motion",
  easing: "motion",
  motion: "motion",
  transition: "motion",
  animation: "motion"
}

function classify(token: Token): { category: Category; inference: Inference } | undefined {
  const evidence = (path: string): string[] => token.facts[path]?.evidenceIds ?? []
  const named = evidence("name")

  const dtcg = token.extensions?.dtcg?.type
  if (typeof dtcg === "string" && DTCG[dtcg] && evidence("extensions.dtcg.type").length > 0) {
    return {
      category: DTCG[dtcg],
      inference: {
        rule: "token-category.dtcg-type",
        confidence: 0.95,
        reasoning: `The token declares the DTCG type "${dtcg}", which is the ${DTCG[dtcg]} category`,
        inputs: ["extensions.dtcg.type"],
        evidenceIds: evidence("extensions.dtcg.type")
      }
    }
  }

  const css = token.extensions?.css as Record<string, unknown> | undefined
  if (css) {
    const kinds = Object.entries(css)
      .filter(
        ([, v]) => typeof v === "object" && v !== null && (v as { valueKind?: unknown }).valueKind === "color"
      )
      .map(([k]) => k)
    const path = kinds.map((k) => `extensions.css.${k}.valueKind`).find((p) => evidence(p).length > 0)
    if (path)
      return {
        category: "color",
        inference: {
          rule: "token-category.value-kind",
          confidence: 0.9,
          reasoning: "The CSS value is a colour literal or colour function",
          inputs: [path],
          evidenceIds: evidence(path)
        }
      }
  }

  const first = words(token.name.replace(/^-+/, ""))[0]
  if (first && NAME_PREFIX[first] && named.length > 0)
    return {
      category: NAME_PREFIX[first],
      inference: {
        rule: "token-category.name-prefix",
        confidence: 0.7,
        reasoning: `The token name starts with "${first}", which conventionally names the ${NAME_PREFIX[first]} category`,
        inputs: ["name"],
        evidenceIds: named
      }
    }

  return named.length > 0
    ? {
        category: "other",
        inference: {
          rule: "token-category.fallback",
          confidence: 0.2,
          reasoning: "No declared type, value kind or conventional name prefix identifies a category",
          inputs: ["name"],
          evidenceIds: named
        }
      }
    : undefined
}

/** Sets `category` on tokens that have only the reconciliation placeholder, and records why. */
export function classifyTokens(tokens: readonly Token[]): Token[] {
  return tokens.map((token) => {
    if (token.facts.category) return token
    const result = classify(token)
    if (!result) return token
    return {
      ...token,
      category: result.category,
      facts: Object.fromEntries(
        Object.entries({ ...token.facts, category: inferredFact(result.inference) }).sort((a, b) =>
          cmp(a[0], b[0])
        )
      )
    }
  })
}
