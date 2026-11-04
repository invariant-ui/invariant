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
  type Pattern,
  resolveFactPath
} from "../src/index.ts"
import { acmeDraft, acmeEvidence } from "./acme.ts"

/**
 * A hand-written contract in the 1.1.0 shape: a data-management page that composes an application shell and a
 * table toolbar, with typed constraints, a state machine, and facts in all four statuses. It stands in for what
 * an organization would define; no compiler produces it yet.
 */

const CAPTURED_AT = "2026-11-03T09:00:00.000Z"

type EvidenceInput = Omit<Evidence, "id" | "verificationStatus" | "capturedAt">
const evidence = (input: EvidenceInput): Evidence => ({
  ...input,
  id: computeEvidenceId(input),
  verificationStatus: "unverified",
  capturedAt: CAPTURED_AT
})
const extractor = (name: string) => ({ name, version: "0.1.0" })

export const patternEvidence = {
  standard: evidence({
    sourceId: "zeroheight",
    sourceRef: "page/data-management",
    location: { type: "document", documentId: "data-management", title: "Data management pages" },
    method: "document-parse",
    extractor: extractor("zeroheight-pages"),
    original: "Every data management page has a header, a results region and a toolbar above the table."
  }),
  toolbarUsage: evidence({
    sourceId: "ui-react",
    sourceRef: "packages/ui-react/src/CustomerList.tsx",
    location: { type: "file", path: "packages/ui-react/src/CustomerList.tsx", line: 18 },
    method: "ast",
    extractor: extractor("jsx-usage"),
    original: "<TableToolbar><SearchField /></TableToolbar><DataTable />"
  }),
  confirm: evidence({
    sourceId: "ui-react",
    sourceRef: "packages/ui-react/src/CustomerList.tsx",
    location: { type: "file", path: "packages/ui-react/src/CustomerList.tsx", line: 52 },
    method: "ast",
    extractor: extractor("jsx-usage"),
    original: "<ConfirmDialog onConfirm={remove} />"
  })
}

const ids = (...ev: Evidence[]): string[] => ev.map((e) => e.id).sort()
const documented = (...ev: Evidence[]): FactRecord => ({ status: "documented", evidenceIds: ids(...ev) })

const component = (id: string, name: string): Component => ({
  id: id as Component["id"],
  name,
  implementations: [
    { id: "react", framework: "react", sourceId: "ui-react", packageName: "@acme/ui-react", exportName: name }
  ],
  props: [],
  events: [],
  slots: [],
  variants: [],
  states: [],
  examples: [],
  composition: [],
  facts: {}
})

const shell: Pattern = {
  id: "pattern:layout.application-shell",
  name: "Application shell",
  category: "layout",
  description: "Navigation, content and an optional footer.",
  intent: "Give every screen the same frame.",
  components: ["component:page-header"],
  guidelines: [],
  layout: {
    regions: [
      { name: "nav", required: true },
      {
        name: "content",
        required: true,
        width: { max: { value: 1200, unit: "px" } },
        spacing: "token:spacing.md"
      },
      { name: "footer", required: false, parent: "content" }
    ]
  },
  facts: { intent: documented(patternEvidence.standard) }
}

const toolbar: Pattern = {
  id: "pattern:composition.table-toolbar",
  name: "Table toolbar",
  category: "composition",
  description: "Search and actions above a table.",
  intent: "Keep filtering and bulk actions next to the data they act on.",
  components: ["component:button", "component:search-field"],
  guidelines: [],
  composition: {
    parts: [
      { name: "search", ref: "component:search-field", role: "required" },
      { name: "actions", ref: "component:button", role: "optional" }
    ]
  },
  facts: { intent: documented(patternEvidence.standard) }
}

const confirmation: Pattern = {
  id: "pattern:interaction.destructive-confirmation",
  name: "Destructive confirmation",
  category: "interaction",
  description: "Ask before deleting, then report the result.",
  intent: "Stop accidental data loss.",
  components: ["component:button", "component:confirm-dialog"],
  guidelines: [],
  behavior: {
    initial: "idle",
    states: [
      { name: "idle" },
      { name: "confirming", feedback: "Name what will be deleted and offer Cancel.", verifiableBy: "static" },
      { name: "deleting", feedback: "Show progress.", verifiableBy: "runtime" },
      { name: "done", terminal: true, feedback: "Confirm the result." },
      { name: "failed", feedback: "Explain the failure and allow a retry." }
    ],
    transitions: [
      { id: "ask", from: "idle", to: "confirming", trigger: "user chooses Delete" },
      { id: "cancel", from: "confirming", to: "idle", trigger: "user chooses Cancel" },
      { id: "confirm", from: "confirming", to: "deleting", trigger: "user confirms" },
      { id: "succeed", from: "deleting", to: "done" },
      { id: "fail", from: "deleting", to: "failed" },
      { id: "retry", from: "failed", to: "deleting", trigger: "user chooses Retry" },
      { id: "dismiss", from: "failed", to: "idle" }
    ]
  },
  accessibility: {
    requirements: [
      {
        id: "focus-moves",
        statement: "Focus moves into the dialog and returns on close.",
        verifiableBy: "runtime"
      }
    ]
  },
  facts: {}
}

const page: Pattern = {
  id: "pattern:page.data-management",
  name: "Data management page",
  category: "page",
  description: "A page to find, review and act on a collection of records.",
  intent: "Let a person search a collection and act on what they find.",
  components: [
    "component:data-table",
    "component:empty-state",
    "component:page-header",
    "component:pagination"
  ],
  guidelines: [],
  composition: {
    parts: [
      { name: "header", ref: "component:page-header", role: "required", region: "header" },
      { name: "toolbar", ref: "pattern:composition.table-toolbar", role: "required", region: "results" },
      { name: "table", ref: "component:data-table", role: "required", region: "results" },
      { name: "pagination", ref: "component:pagination", role: "optional", region: "results" },
      { name: "empty", ref: "component:empty-state", role: "required", region: "results" }
    ]
  },
  layout: {
    regions: [
      { name: "header", required: true },
      {
        name: "results",
        required: true,
        responsive: [{ breakpoint: "token:breakpoint.md", behavior: "stack" }]
      }
    ]
  },
  behavior: {
    initial: "loading",
    states: [
      { name: "loading", feedback: "Show a loading indicator.", verifiableBy: "runtime" },
      { name: "ready" },
      { name: "empty", feedback: "Explain that nothing matches." },
      { name: "error", feedback: "Explain the failure and offer a retry." }
    ],
    transitions: [
      { id: "found", from: "loading", to: "ready" },
      { id: "none", from: "loading", to: "empty" },
      { id: "broke", from: "loading", to: "error" },
      { id: "search", from: "ready", to: "loading", trigger: "search or page change" },
      { id: "retry", from: "error", to: "loading", trigger: "user chooses Retry" }
    ]
  },
  relationships: [
    { id: "frame", type: "composes", target: "pattern:layout.application-shell" },
    { id: "tools", type: "composes", target: "pattern:composition.table-toolbar" },
    { id: "delete", type: "uses", target: "pattern:interaction.destructive-confirmation" },
    { id: "actions", type: "uses", target: "component:button" }
  ],
  constraints: [
    "constraint:data-management.results-required",
    "constraint:data-management.single-table",
    "constraint:data-management.toolbar-before-table"
  ],
  facts: {
    intent: documented(patternEvidence.standard),
    "layout.regions.results.required": documented(patternEvidence.standard),
    "relationships.delete": {
      status: "inferred",
      evidenceIds: ids(patternEvidence.confirm),
      confidence: 0.6,
      derivation: {
        rule: "co-usage",
        reasoning: "A confirmation dialog follows the delete action in 1 of 1 observed pages.",
        inputs: ids(patternEvidence.confirm)
      }
    },
    "relationships.tools": {
      status: "discovered",
      evidenceIds: ids(patternEvidence.toolbarUsage)
    }
  }
}

const approvedRequired = resolveFactPath(page, "layout.regions.results.required")
if (!approvedRequired.found) throw new Error("fixture bug: layout.regions.results.required must resolve")
page.facts["layout.regions.results.required"] = {
  status: "approved",
  evidenceIds: ids(patternEvidence.standard),
  approval: {
    approvedBy: "design-system-owners",
    approvedAt: "2026-11-03T10:00:00.000Z",
    role: "owner",
    reference: "DS-201",
    priorStatus: "documented",
    fingerprint: computeFactFingerprint({
      entityId: page.id,
      path: "layout.regions.results.required",
      value: approvedRequired.value
    })
  }
}

export function patternsDraft(): ContractDraft {
  const draft = acmeDraft()
  const sortById = <T extends { id: string }>(items: T[]): T[] =>
    [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  draft.contractVersion = "1.1.0"
  draft.components = sortById([
    ...draft.components,
    component("component:confirm-dialog", "ConfirmDialog"),
    component("component:data-table", "DataTable"),
    component("component:empty-state", "EmptyState"),
    component("component:page-header", "PageHeader"),
    component("component:pagination", "Pagination"),
    component("component:search-field", "SearchField")
  ])
  draft.tokens = sortById([
    ...draft.tokens,
    {
      id: "token:breakpoint.md",
      name: "breakpoint.md",
      category: "breakpoint",
      value: { value: "768px" },
      facts: {}
    }
  ])
  draft.patterns = sortById([...draft.patterns, ...structuredClone([shell, toolbar, confirmation, page])])
  draft.constraints = sortById([
    ...draft.constraints,
    {
      id: "constraint:data-management.results-required",
      name: "Results region is required",
      kind: "required-region",
      description: "A data management page must have a results region.",
      subjects: ["pattern:page.data-management"],
      details: { region: "region:results" },
      facts: { description: documented(patternEvidence.standard) }
    },
    {
      id: "constraint:data-management.single-table",
      name: "One table per page",
      kind: "cardinality",
      description: "A data management page shows exactly one table.",
      subjects: ["pattern:page.data-management", "component:data-table"],
      details: { target: "component:data-table", min: 1, max: 1, within: "region:results" },
      facts: {}
    },
    {
      id: "constraint:data-management.toolbar-before-table",
      name: "Toolbar comes before the table",
      kind: "ordering",
      description: "The table toolbar precedes the table in the results region.",
      subjects: ["pattern:page.data-management"],
      details: {
        before: "pattern:composition.table-toolbar",
        after: "component:data-table",
        within: "region:results"
      },
      facts: { description: documented(patternEvidence.standard) }
    }
  ])
  return draft
}

export function patternsEvidence(): Evidence[] {
  return [...Object.values(acmeEvidence), ...Object.values(patternEvidence)]
}

export function buildPatterns(): { contract: Contract; evidence: EvidenceFile } {
  const contract = finalizeContract(patternsDraft())
  return { contract, evidence: createEvidenceFile(contract.integrity.contentHash, patternsEvidence()) }
}
