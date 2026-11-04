import {
  type Contract,
  type ContractDraft,
  computeFactFingerprint,
  createEvidenceFile,
  type Evidence,
  type EvidenceFile,
  type FactRecord,
  finalizeContract,
  type Pattern,
  resolveFactPath
} from "../src/index.ts"
import { patternEvidence, patternsDraft, patternsEvidence } from "./patterns.ts"

/**
 * The pattern sample with three more page archetypes' worth of material: a detail page and an edit form that
 * compose shared patterns, an interaction pattern they use, and variations. The detail page is fully approved
 * while the patterns it composes are not, which is the situation a consumer must be told about.
 */

const ids = (...ev: Evidence[]): string[] => ev.map((e) => e.id).sort()
const documented = (): FactRecord => ({ status: "documented", evidenceIds: ids(patternEvidence.standard) })

function approveAll(p: Pattern): void {
  for (const path of Object.keys(p.facts)) delete p.facts[path]
  const paths = [
    "description",
    "intent",
    "composition",
    "layout",
    "behavior",
    ...(p.relationships ?? []).map((r) => `relationships.${r.id}`),
    ...(p.variations ?? []).map((v) => `variations.${v.name}`)
  ]
  for (const path of paths) {
    const value = resolveFactPath(p, path)
    if (!value.found) continue
    p.facts[path] = {
      status: "approved",
      evidenceIds: ids(patternEvidence.standard),
      approval: {
        approvedBy: "design-system-owners",
        approvedAt: "2026-11-03T11:00:00.000Z",
        reference: "DS-300",
        priorStatus: "documented",
        fingerprint: computeFactFingerprint({ entityId: p.id, path, value: value.value })
      }
    }
  }
}

const detail: Pattern = {
  id: "pattern:page.detail",
  name: "Detail page",
  category: "page",
  description: "A page that shows one record and the actions that apply to it.",
  intent: "Let a person understand one record and act on it.",
  components: ["component:button", "component:data-table", "component:empty-state", "component:page-header"],
  guidelines: [],
  layout: {
    regions: [
      { name: "header", required: true },
      { name: "summary", required: true },
      {
        name: "related",
        required: false,
        responsive: [{ breakpoint: "token:breakpoint.md", behavior: "stack" }]
      }
    ]
  },
  composition: {
    parts: [
      { name: "header", ref: "component:page-header", role: "required", region: "header" },
      { name: "actions", ref: "component:button", role: "optional", region: "header" },
      { name: "summary", ref: "component:empty-state", role: "required", region: "summary" },
      { name: "related", ref: "component:data-table", role: "optional", region: "related" }
    ]
  },
  variations: [
    {
      name: "read-only",
      description: "Read only",
      when: "The person cannot change this record.",
      roles: [{ part: "actions", role: "prohibited" }]
    },
    {
      name: "with-history",
      description: "With history",
      when: "The record keeps an audit trail.",
      roles: [{ part: "related", role: "required" }],
      parts: [
        { name: "history", ref: "pattern:composition.table-toolbar", role: "optional", region: "related" }
      ]
    }
  ],
  relationships: [
    { id: "frame", type: "composes", target: "pattern:layout.application-shell" },
    { id: "delete", type: "uses", target: "pattern:interaction.destructive-confirmation" }
  ],
  constraints: ["constraint:detail.summary-required"],
  facts: {}
}

const edit: Pattern = {
  id: "pattern:page.edit-form",
  name: "Create or edit form",
  category: "page",
  description: "A page with one form that creates or changes a record.",
  intent: "Let a person create or change a record and know it was saved.",
  components: ["component:button", "component:page-header"],
  guidelines: [],
  layout: {
    regions: [
      { name: "header", required: true },
      { name: "form", required: true }
    ]
  },
  composition: {
    parts: [
      { name: "header", ref: "component:page-header", role: "required", region: "header" },
      { name: "fields", ref: "component:search-field", role: "required", region: "form" },
      { name: "submit", ref: "component:button", role: "required", region: "form" },
      { name: "remove", ref: "component:button", role: "optional", region: "form" }
    ]
  },
  variations: [
    {
      name: "create",
      description: "Create",
      when: "There is no record yet.",
      roles: [{ part: "remove", role: "prohibited" }]
    }
  ],
  relationships: [
    { id: "frame", type: "composes", target: "pattern:layout.application-shell" },
    { id: "workflow", type: "uses", target: "pattern:interaction.form-workflow" },
    { id: "delete", type: "uses", target: "pattern:interaction.destructive-confirmation" }
  ],
  facts: { description: documented(), intent: documented() }
}

const formWorkflow: Pattern = {
  id: "pattern:interaction.form-workflow",
  name: "Form workflow",
  category: "interaction",
  description: "How a form behaves while it submits and after.",
  intent: "Never leave a person unsure whether their form went through.",
  components: ["component:button"],
  guidelines: [],
  behavior: {
    initial: "idle",
    states: [
      { name: "idle" },
      { name: "submitting", feedback: "Show progress.", verifiableBy: "runtime" },
      { name: "success", terminal: true, feedback: "Confirm the result." },
      { name: "error", feedback: "Explain the failure." }
    ],
    transitions: [
      { id: "submit", from: "idle", to: "submitting" },
      { id: "ok", from: "submitting", to: "success" },
      { id: "fail", from: "submitting", to: "error" },
      { id: "retry", from: "error", to: "submitting" }
    ]
  },
  constraints: ["constraint:form.shows-error", "constraint:form.shows-submitting"],
  facts: { description: documented() }
}

export function archetypesDraft(): ContractDraft {
  const draft = patternsDraft()
  const byId = <T extends { id: string }>(items: T[]): T[] =>
    [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const page = draft.patterns.find((p) => p.id === "pattern:page.data-management")
  if (!page) throw new Error("fixture bug: data management page missing")
  page.variations = [
    {
      name: "bulk",
      description: "With bulk actions",
      when: "People select several rows and act on them.",
      parts: [{ name: "bulk", ref: "component:button", role: "optional", region: "results" }]
    }
  ]
  page.facts["variations.bulk"] = documented()
  const created = structuredClone([detail, edit, formWorkflow])
  for (const p of created) if (p.id === "pattern:page.detail") approveAll(p)
  draft.patterns = byId([...draft.patterns, ...created])
  draft.constraints = byId([
    ...draft.constraints,
    {
      id: "constraint:detail.summary-required",
      name: "Summary region is required",
      kind: "required-region",
      description: "A detail page has a summary region.",
      subjects: ["pattern:page.detail"],
      details: { region: "region:summary" },
      facts: {}
    },
    {
      id: "constraint:form.shows-error",
      name: "A form shows an error",
      kind: "required-state",
      description: "A form shows an error when submitting fails.",
      subjects: ["pattern:interaction.form-workflow"],
      details: { workflow: "form-submission", state: "error" },
      facts: {}
    },
    {
      id: "constraint:form.shows-submitting",
      name: "A form shows it is submitting",
      kind: "required-state",
      description: "A form shows that it is submitting.",
      subjects: ["pattern:interaction.form-workflow"],
      details: { workflow: "form-submission", state: "submitting", minimum: "static-inferred" },
      facts: {}
    }
  ])
  return draft
}

export function archetypesEvidence(): Evidence[] {
  return patternsEvidence()
}

export function buildArchetypes(): { contract: Contract; evidence: EvidenceFile } {
  const contract = finalizeContract(archetypesDraft())
  return { contract, evidence: createEvidenceFile(contract.integrity.contentHash, archetypesEvidence()) }
}
