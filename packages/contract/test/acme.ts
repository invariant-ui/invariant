import {
  type Component,
  type Contract,
  type ContractDraft,
  computeEvidenceId,
  computeFactFingerprint,
  createEvidenceFile,
  type Evidence,
  type EvidenceFile,
  type FactRecord,
  finalizeContract,
  resolveFactPath,
  type Source
} from "../src/index.ts"

const CAPTURED_AT = "2026-10-30T12:00:00.000Z"

type EvidenceInput = Omit<Evidence, "id" | "verificationStatus" | "capturedAt"> & { confidence?: number }

function evidence(input: EvidenceInput): Evidence {
  return { ...input, id: computeEvidenceId(input), verificationStatus: "unverified", capturedAt: CAPTURED_AT }
}

const extractor = (name: string) => ({ name, version: "0.1.0" })

export const acmeEvidence = {
  reactSize: evidence({
    sourceId: "ui-react",
    sourceRef: "packages/ui-react/src/Button.tsx#Button",
    location: { type: "file", path: "packages/ui-react/src/Button.tsx", line: 12, column: 3 },
    method: "compiler-api",
    extractor: extractor("react-props"),
    original: 'size?: "sm" | "md" | "lg"'
  }),
  angularSize: evidence({
    sourceId: "ui-angular",
    sourceRef: "packages/ui-angular/src/button.component.ts#AcmeButton",
    location: { type: "file", path: "packages/ui-angular/src/button.component.ts", line: 20 },
    method: "compiler-api",
    extractor: extractor("angular-inputs"),
    original: 'size = input<"sm" | "md" | "lg">("md")'
  }),
  vueSize: evidence({
    sourceId: "ui-vue",
    sourceRef: "packages/ui-vue/src/Button.vue",
    location: { type: "file", path: "packages/ui-vue/src/Button.vue", line: 8 },
    method: "compiler-api",
    extractor: extractor("vue-props"),
    original: 'size: { type: String as PropType<"sm" | "md" | "lg">, default: "md" }'
  }),
  docsDefault: evidence({
    sourceId: "zeroheight",
    sourceRef: "page/buttons",
    location: { type: "document", documentId: "buttons", title: "Buttons", section: "Sizes" },
    method: "document-parse",
    extractor: extractor("zeroheight-pages"),
    original: "The default button size is large."
  }),
  brandColor: evidence({
    sourceId: "ui-react",
    sourceRef: "packages/ui-react/src/tokens.css",
    location: { type: "file", path: "packages/ui-react/src/tokens.css", line: 3 },
    method: "structured-parse",
    extractor: extractor("css-variables"),
    original: "--acme-color-brand: #0057ff;"
  }),
  usage: evidence({
    sourceId: "ui-react",
    sourceRef: "packages/ui-react/src/LoginForm.tsx",
    location: { type: "file", path: "packages/ui-react/src/LoginForm.tsx", line: 31 },
    method: "ast",
    extractor: extractor("jsx-usage"),
    original: '<Button><Icon name="lock" />Sign in</Button>'
  }),
  guidance: evidence({
    sourceId: "zeroheight",
    sourceRef: "page/buttons",
    location: { type: "document", documentId: "buttons", title: "Buttons", section: "Usage" },
    method: "document-parse",
    extractor: extractor("zeroheight-pages"),
    original: "Use one primary button per view."
  })
}

const discovered = (...ev: Evidence[]): FactRecord => ({ status: "discovered", evidenceIds: ids(ev) })
const documented = (...ev: Evidence[]): FactRecord => ({ status: "documented", evidenceIds: ids(ev) })
const ids = (ev: Evidence[]): string[] => ev.map((e) => e.id).sort()

const button: Component = {
  id: "component:button",
  name: "Button",
  description: "Triggers an action.",
  lifecycle: "stable",
  implementations: [
    {
      id: "angular",
      framework: "angular",
      sourceId: "ui-angular",
      packageName: "@acme/ui-angular",
      exportName: "AcmeButton",
      extensions: {
        angular: { selector: "acme-button", standalone: true, inputKinds: { size: "signal-input" } }
      }
    },
    {
      id: "react",
      framework: "react",
      sourceId: "ui-react",
      packageName: "@acme/ui-react",
      exportName: "Button",
      extensions: { react: { forwardRef: true, polymorphic: false } }
    },
    {
      id: "vue",
      framework: "vue",
      sourceId: "ui-vue",
      packageName: "@acme/ui-vue",
      exportName: "default",
      importPath: "@acme/ui-vue/Button.vue",
      extensions: { vue: { api: "script-setup" } }
    }
  ],
  props: [
    { name: "disabled", type: { text: "boolean", kind: "boolean" }, required: false, default: false },
    {
      name: "size",
      type: { text: '"sm" | "md" | "lg"', kind: "enum" },
      required: false,
      default: "md",
      allowedValues: ["sm", "md", "lg"],
      extensions: { angular: { kind: "input" }, react: { kind: "prop" }, vue: { kind: "prop" } }
    }
  ],
  events: [
    {
      name: "press",
      payload: { text: "MouseEvent", kind: "object" },
      extensions: { angular: { output: "pressed" }, react: { prop: "onPress" }, vue: { emit: "press" } }
    }
  ],
  slots: [
    { name: "default", required: false },
    { name: "icon", accepts: ["component:icon"] }
  ],
  variants: [{ name: "size", values: ["sm", "md", "lg"], default: "md" }],
  states: [{ name: "disabled" }, { name: "loading" }],
  accessibility: { role: "button", keyboard: ["Enter", "Space"] },
  examples: [
    {
      id: "primary",
      title: "Primary",
      language: "tsx",
      code: '<Button size="md">Save</Button>',
      sourceId: "ui-react"
    }
  ],
  composition: [{ type: "commonly-used-with", target: "component:icon" }],
  facts: {}
}

const sizeAllowed = resolveFactPath(button, "props.size.allowedValues")
if (!sizeAllowed.found) throw new Error("fixture bug: props.size.allowedValues must resolve")

button.facts = {
  "props.size.allowedValues": {
    status: "approved",
    evidenceIds: ids([acmeEvidence.reactSize, acmeEvidence.angularSize, acmeEvidence.vueSize]),
    approval: {
      approvedBy: "design-system-owners",
      approvedAt: "2026-10-30T13:00:00.000Z",
      role: "owner",
      reference: "DS-142",
      priorStatus: "discovered",
      fingerprint: computeFactFingerprint({
        entityId: button.id,
        path: "props.size.allowedValues",
        value: sizeAllowed.value
      })
    }
  },
  "props.size.default": discovered(acmeEvidence.reactSize, acmeEvidence.angularSize, acmeEvidence.vueSize),
  "composition.0": {
    status: "inferred",
    evidenceIds: ids([acmeEvidence.usage]),
    confidence: 0.7,
    derivation: {
      rule: "co-usage",
      reasoning: "Icon appears inside Button in 1 of 1 observed JSX usages.",
      inputs: ids([acmeEvidence.usage])
    }
  }
}

const icon: Component = {
  id: "component:icon",
  name: "Icon",
  implementations: [
    {
      id: "react",
      framework: "react",
      sourceId: "ui-react",
      packageName: "@acme/ui-react",
      exportName: "Icon"
    }
  ],
  props: [{ name: "name", type: { text: "string", kind: "string" }, required: true }],
  events: [],
  slots: [],
  variants: [],
  states: [],
  examples: [],
  composition: [],
  facts: {}
}

const sourceBase: Pick<Source, "capabilities" | "health"> = {
  capabilities: ["props.*.required", "props.*.allowedValues"],
  health: { status: "ok", diagnosticCount: 0 }
} as const

const draft: ContractDraft = {
  contractVersion: "1.0.0",
  metadata: {
    contractId: "acme-design-system",
    name: "Acme Design System",
    description: "Sample contract spanning React, Angular, and Vue.",
    compilerVersion: "0.0.0",
    frameworks: ["angular", "react", "vue"],
    compiledAt: "2026-10-30T12:30:00.000Z"
  },
  sources: [
    {
      ...sourceBase,
      id: "ui-angular",
      type: "angular",
      location: "./packages/ui-angular",
      version: { kind: "git-commit", value: "9b95d2c" },
      lastSyncedAt: "2026-10-30T12:00:00.000Z"
    },
    {
      ...sourceBase,
      id: "ui-react",
      type: "react",
      location: "./packages/ui-react",
      version: { kind: "git-commit", value: "9b95d2c" },
      lastSyncedAt: "2026-10-30T12:00:00.000Z"
    },
    {
      ...sourceBase,
      id: "ui-vue",
      type: "vue",
      location: "./packages/ui-vue",
      version: { kind: "git-commit", value: "9b95d2c" },
      lastSyncedAt: "2026-10-30T12:00:00.000Z"
    },
    {
      ...sourceBase,
      id: "zeroheight",
      type: "zeroheight",
      location: "zeroheight://styleguide/acme",
      authentication: { method: "token", credentialRef: "env:ZEROHEIGHT_ACCESS_TOKEN" },
      lastSyncedAt: "2026-10-30T12:00:00.000Z",
      capabilities: ["guidelines.*"],
      health: { status: "degraded", diagnosticCount: 1 }
    }
  ],
  themes: [
    { id: "theme:dark", name: "Dark" },
    { id: "theme:light", name: "Light", default: true }
  ],
  components: [button, icon],
  tokens: [
    {
      id: "token:color.action.primary",
      name: "color.action.primary",
      category: "color",
      value: { aliasOf: "token:color.brand.primary" },
      facts: {}
    },
    {
      id: "token:color.brand.primary",
      name: "color.brand.primary",
      category: "color",
      value: { value: "#0057ff" },
      modes: { "theme:dark": { value: "#4d8dff" } },
      facts: { "value.value": discovered(acmeEvidence.brandColor) }
    },
    { id: "token:spacing.md", name: "spacing.md", category: "spacing", value: { value: "16px" }, facts: {} }
  ],
  patterns: [
    {
      id: "pattern:form.login",
      name: "Login form",
      category: "form",
      description: "Credentials form with a single primary action.",
      components: ["component:button", "component:icon"],
      guidelines: ["guideline:button.usage"],
      facts: {}
    }
  ],
  guidelines: [
    {
      id: "guideline:button.usage",
      name: "Button usage",
      kind: "usage",
      statement: "Use one primary button per view.",
      appliesTo: ["component:button"],
      examples: [{ kind: "do", text: "Pair one primary with secondary actions." }],
      references: [{ sourceId: "zeroheight", documentId: "buttons", title: "Buttons" }],
      facts: { statement: documented(acmeEvidence.guidance) }
    }
  ],
  constraints: [
    {
      id: "constraint:button.size-values",
      name: "Button size values",
      kind: "required-prop",
      description: "Button size must be one of the declared sizes.",
      subjects: ["component:button"],
      details: { prop: "size", allowed: ["sm", "md", "lg"] },
      facts: { description: documented(acmeEvidence.docsDefault) }
    }
  ],
  policies: [
    {
      id: "policy:button.single-primary",
      name: "Single primary button",
      statement: "A view must contain at most one primary button.",
      severity: "warning",
      enforcement: "warn",
      scope: { entities: ["component:button"], frameworks: ["react", "vue", "angular"] },
      basedOn: ["guideline:button.usage"],
      approval: {
        approvedBy: "design-system-owners",
        approvedAt: "2026-10-30T13:00:00.000Z",
        role: "owner",
        reference: "DS-143"
      }
    }
  ],
  conflicts: [
    {
      id: "conflict:button.size-default",
      type: "value-mismatch",
      severity: "warning",
      subject: "component:button",
      path: "props.size.default",
      claims: [
        { sourceId: "ui-react", value: "md", status: "discovered", evidenceIds: [acmeEvidence.reactSize.id] },
        {
          sourceId: "zeroheight",
          value: "lg",
          status: "documented",
          evidenceIds: [acmeEvidence.docsDefault.id]
        }
      ],
      suggestedResolution: "Update the documentation or the component default so they agree.",
      resolution: { state: "open" }
    }
  ]
}

export function buildAcme(): { contract: Contract; evidence: EvidenceFile } {
  const contract = finalizeContract(draft)
  return {
    contract,
    evidence: createEvidenceFile(contract.integrity.contentHash, Object.values(acmeEvidence))
  }
}

export function acmeDraft(): ContractDraft {
  return structuredClone(draft)
}
