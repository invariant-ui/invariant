export type Severity = "error" | "warning" | "info"

export interface RuleInfo {
  code: string
  title: string
  /** Which of the plan's eleven initial rules this implements, `Hardcoded value` for the spacing and typography checks and `Pattern composition` for the structural pattern checks added after them, or `support` for helpers. */
  plan: string
  severity: Severity
  /** `policy` rules take their severity and reference from an approved policy. */
  origin: "contract" | "policy" | "heuristic"
}

export const RULES: readonly RuleInfo[] = [
  {
    code: "component-unknown",
    title: "Component is not in the design system",
    plan: "Unknown component",
    severity: "error",
    origin: "contract"
  },
  {
    code: "component-ambiguous",
    title: "Name matches several components",
    plan: "support",
    severity: "info",
    origin: "contract"
  },
  {
    code: "framework-not-implemented",
    title: "Component has no implementation in this framework",
    plan: "Unknown component",
    severity: "error",
    origin: "contract"
  },
  {
    code: "unknown-prop",
    title: "Property is not declared by the component",
    plan: "Unknown property",
    severity: "warning",
    origin: "contract"
  },
  {
    code: "unverifiable-prop",
    title: "Property could not be verified (incomplete API listing)",
    plan: "support",
    severity: "info",
    origin: "contract"
  },
  {
    code: "prop-value-not-allowed",
    title: "Property value is not one of the declared values",
    plan: "Invalid property value",
    severity: "error",
    origin: "contract"
  },
  {
    code: "prop-type-mismatch",
    title: "Property value has the wrong type",
    plan: "Invalid property value",
    severity: "warning",
    origin: "contract"
  },
  {
    code: "component-deprecated",
    title: "Component is deprecated",
    plan: "Deprecated component",
    severity: "warning",
    origin: "contract"
  },
  {
    code: "prop-deprecated",
    title: "Property is deprecated",
    plan: "Deprecated property",
    severity: "warning",
    origin: "contract"
  },
  {
    code: "required-prop-missing",
    title: "Required property is missing",
    plan: "Missing required property",
    severity: "error",
    origin: "contract"
  },
  {
    code: "color-not-in-tokens",
    title: "Literal color is not a design token",
    plan: "Hardcoded color",
    severity: "warning",
    origin: "contract"
  },
  {
    code: "color-matches-token",
    title: "Literal color equals a design token",
    plan: "Hardcoded color",
    severity: "info",
    origin: "contract"
  },
  {
    code: "spacing-not-in-tokens",
    title: "Literal spacing value is not a design token",
    plan: "Hardcoded value",
    severity: "warning",
    origin: "contract"
  },
  {
    code: "spacing-matches-token",
    title: "Literal spacing value equals a design token",
    plan: "Hardcoded value",
    severity: "info",
    origin: "contract"
  },
  {
    code: "typography-not-in-tokens",
    title: "Literal typography value is not a design token",
    plan: "Hardcoded value",
    severity: "warning",
    origin: "contract"
  },
  {
    code: "typography-matches-token",
    title: "Literal typography value equals a design token",
    plan: "Hardcoded value",
    severity: "info",
    origin: "contract"
  },
  {
    code: "pattern-required-child-missing",
    title: "Pattern requires a child that is missing",
    plan: "Pattern composition",
    severity: "error",
    origin: "policy"
  },
  {
    code: "pattern-child-forbidden",
    title: "Pattern forbids a child that is present",
    plan: "Pattern composition",
    severity: "error",
    origin: "policy"
  },
  {
    code: "pattern-parent-required",
    title: "Component is used outside the parent its pattern requires",
    plan: "Pattern composition",
    severity: "error",
    origin: "policy"
  },
  {
    code: "pattern-region-missing",
    title: "Pattern region is missing",
    plan: "Pattern composition",
    severity: "error",
    origin: "policy"
  },
  {
    code: "pattern-order-violated",
    title: "Elements are in the wrong order for the pattern",
    plan: "Pattern composition",
    severity: "error",
    origin: "policy"
  },
  {
    code: "pattern-cardinality-violated",
    title: "Number of elements breaks the pattern",
    plan: "Pattern composition",
    severity: "error",
    origin: "policy"
  },
  {
    code: "pattern-state-missing",
    title: "Interaction state the pattern requires is not represented",
    plan: "Pattern composition",
    severity: "error",
    origin: "policy"
  },
  {
    code: "unknown-css-variable",
    title: "CSS variable is not a design token",
    plan: "Unapproved token",
    severity: "warning",
    origin: "contract"
  },
  {
    code: "token-deprecated",
    title: "Token is deprecated",
    plan: "Unapproved token",
    severity: "warning",
    origin: "contract"
  },
  {
    code: "token-forbidden",
    title: "Token is forbidden by policy",
    plan: "Unapproved token",
    severity: "error",
    origin: "policy"
  },
  {
    code: "composition-parent-required",
    title: "Component is used outside the parent it requires",
    plan: "Unsupported composition",
    severity: "error",
    origin: "contract"
  },
  {
    code: "composition-not-allowed",
    title: "Component is not allowed inside this container",
    plan: "Unsupported composition",
    severity: "error",
    origin: "policy"
  },
  {
    code: "layout-pattern-invalid",
    title: "Layout structure is not allowed",
    plan: "Invalid layout pattern",
    severity: "error",
    origin: "policy"
  },
  {
    code: "accessibility-requirement-missing",
    title: "Accessibility requirement is not met",
    plan: "Missing accessibility requirement",
    severity: "error",
    origin: "policy"
  },
  {
    code: "policy-attribute-required",
    title: "Policy requires an attribute",
    plan: "support",
    severity: "error",
    origin: "policy"
  },
  {
    code: "prop-forbidden",
    title: "Property is forbidden by policy",
    plan: "support",
    severity: "error",
    origin: "policy"
  },
  {
    code: "prop-value-forbidden",
    title: "Property value is forbidden by policy",
    plan: "support",
    severity: "error",
    origin: "policy"
  },
  {
    code: "component-forbidden",
    title: "Component is forbidden by policy",
    plan: "support",
    severity: "error",
    origin: "policy"
  },
  {
    code: "native-element-has-equivalent",
    title: "Native element has a similarly named component",
    plan: "support",
    severity: "info",
    origin: "heuristic"
  },
  {
    code: "input-too-large",
    title: "Input exceeds the size limit",
    plan: "support",
    severity: "error",
    origin: "contract"
  }
]

export const ruleFor = (code: string): RuleInfo | undefined => RULES.find((r) => r.code === code)

export const PLAN_RULES = [
  "Unknown component",
  "Unknown property",
  "Invalid property value",
  "Deprecated component",
  "Deprecated property",
  "Unsupported composition",
  "Missing required property",
  "Hardcoded color",
  "Unapproved token",
  "Missing accessibility requirement",
  "Invalid layout pattern"
] as const

export type RuleOverrides = Record<string, Severity | "off">
