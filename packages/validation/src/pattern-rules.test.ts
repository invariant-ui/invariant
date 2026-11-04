import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { type Contract, evidenceFileSchema, parseContract } from "@invariant/contract"
import { DesignSystem } from "@invariant/contract-query"
import { describe, expect, it } from "vitest"
import { type Evaluation, validateCode } from "./index.js"
import { scanJsx } from "./scan.js"

const file = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../contract/fixtures/patterns/${name}`, import.meta.url)), "utf8")

interface Spec {
  id: string
  kind: string
  details: Record<string, unknown>
  paths?: string[] | undefined
  frameworks?: string[]
  severity?: "error" | "warning" | "info"
  enforcement?: "block" | "warn" | "report-only"
  /** Leave the constraint out of the pattern's own list, as if no pattern owned it. */
  orphan?: boolean
}

/** The sample contract with only the constraints and policies a test asks for. */
function system(specs: Spec[]): DesignSystem {
  const parsed = parseContract(JSON.parse(file("invariant.contract.json")))
  if (!parsed.ok) throw new Error("fixture invalid")
  const c: Contract = structuredClone(parsed.value)
  const page = c.patterns.find((p) => p.id === "pattern:page.data-management")
  if (!page) throw new Error("fixture bug")
  c.constraints = c.constraints.filter((k) => !k.id.startsWith("constraint:data-management."))
  page.constraints = []
  for (const s of specs) {
    const id = `constraint:t.${s.id}`
    c.constraints.push({
      id,
      name: s.id,
      kind: s.kind,
      description: `Rule ${s.id}.`,
      subjects: [page.id],
      details: s.details,
      facts: {}
    } as never)
    if (!s.orphan) page.constraints.push(id as never)
    c.policies.push({
      id: `policy:t.${s.id}`,
      name: s.id,
      statement: `Rule ${s.id}.`,
      severity: s.severity ?? "error",
      enforcement: s.enforcement ?? "block",
      scope: {
        entities: [page.id],
        ...(s.paths ? { paths: s.paths } : {}),
        ...(s.frameworks ? { frameworks: s.frameworks } : {})
      },
      basedOn: [id],
      approval: { approvedBy: "owners", approvedAt: "2026-11-03T10:00:00.000Z" }
    } as never)
  }
  c.constraints.sort((a, b) => (a.id < b.id ? -1 : 1))
  c.policies.sort((a, b) => (a.id < b.id ? -1 : 1))
  if (page.constraints.length === 0) delete page.constraints
  return new DesignSystem(c, evidenceFileSchema.parse(JSON.parse(file("invariant.evidence.json"))))
}

const IMPORT =
  'import { Button, ConfirmDialog, DataTable, EmptyState, PageHeader, Pagination, SearchField } from "@acme/ui-react"\n'
const run = (specs: Spec[], body: string, filename = "app/pages/List.tsx", rules = {}) =>
  validateCode(system(specs), { code: `${IMPORT}${body}`, filename, framework: "react" }, { rules })
const statuses = (r: ReturnType<typeof run>): string[] => r.evaluations.map((e) => e.status)
const only = (r: ReturnType<typeof run>): Evaluation => {
  expect(r.evaluations).toHaveLength(1)
  return r.evaluations[0] as Evaluation
}
const requiredChild = {
  id: "rc",
  kind: "required-child",
  details: { parent: "component:confirm-dialog", child: "component:button" }
}

describe("scanJsx: what the pattern rules rely on", () => {
  const depth = (code: string) =>
    scanJsx(code, "x.tsx").uses.map((u) => `${u.tag}:${u.exprDepth}${u.opaque ? "!" : ""}`)

  it("counts the expressions around an element", () => {
    expect(depth("const A = () => <div><B/>{c && <C/>}{rows.map((r) => <D key={r}/>)}</div>")).toEqual([
      "div:0",
      "B:0",
      "C:1",
      "D:1"
    ])
  })

  it("does not call an element passed as a prop conditional", () => {
    expect(depth("const A = () => <Box icon={<Icon/>} render={() => <Row/>}/>")).toEqual([
      "Box:0",
      "Icon:0",
      "Row:1"
    ])
  })

  it("marks an element that is not returned, as one not placed in the tree", () => {
    expect(depth("const x = <Button/>\nconst A = () => <Card>{x}</Card>")).toEqual([
      "Button:1!".replace("!", ""),
      "Card:0!"
    ])
    expect(depth("render(<App/>)")).toEqual(["App:1"])
    expect(depth("function A(){ return cond ? <B/> : <C/> }")).toEqual(["B:0", "C:0"])
    expect(depth("const A = () => cond && <B/>")).toEqual(["B:0"])
  })

  it("marks children that something else supplies as opaque", () => {
    expect(depth("const A = () => <Card>{children}</Card>")).toEqual(["Card:0!"])
    expect(depth("const A = () => <Card>{renderRows()}</Card>")).toEqual(["Card:0!"])
    expect(depth("const A = () => <Card {...props}/>")).toEqual(["Card:0!"])
    expect(depth("const A = () => <Card children={x}/>")).toEqual(["Card:0!"])
    expect(depth('const A = () => <Card>{"text"}{1}</Card>')).toEqual(["Card:0"])
    expect(depth("const A = () => <Card>{ok && <B/>}</Card>")).toEqual(["Card:0", "B:1"])
  })

  it("counts the callbacks around an element, so a list is not mistaken for one element", () => {
    const loops = (code: string) => scanJsx(code, "x.tsx").uses.map((u) => `${u.tag}:${u.loopDepth}`)
    expect(loops("const A = () => <main>{rows.map((r) => <Row key={r}/>)}</main>")).toEqual([
      "main:0",
      "Row:1"
    ])
    expect(loops("const A = () => <main>{c && <B/>}</main>")).toEqual(["main:0", "B:0"])
    expect(loops("const A = () => <main render={function () { return <B/> }}/>")).toEqual(["main:0", "B:1"])
    expect(
      loops("const A = () => <main>{rows.map((r) => <Row>{r.items.map((i) => <Cell/>)}</Row>)}</main>")
    ).toEqual(["main:0", "Row:1", "Cell:2"])
  })
})

describe("what applies, and what is recorded", () => {
  it("evaluates nothing when no approved policy carries a pattern rule", () => {
    const r = run([], "export const A = () => <ConfirmDialog />")
    expect(r.evaluations).toEqual([])
    expect(r.summary.patternRules).toEqual({ pass: 0, fail: 0, warning: 0, notVerifiable: 0, skipped: 0 })
  })

  it("reads the rule, the pattern, the constraint and the policy into each result", () => {
    const e = only(run([requiredChild], "export const A = () => <ConfirmDialog><Button /></ConfirmDialog>"))
    expect(e).toMatchObject({
      rule: "pattern-required-child-missing",
      status: "pass",
      pattern: "pattern:page.data-management",
      constraint: "constraint:t.rc",
      policy: "policy:t.rc",
      file: "app/pages/List.tsx",
      line: 2
    })
  })

  it("applies a policy only to files that match its paths, and says nothing about the others", () => {
    const spec = { ...requiredChild, paths: ["app/pages/**"] }
    expect(
      run([spec], "export const A = () => <ConfirmDialog />", "app/pages/List.tsx").evaluations
    ).toHaveLength(1)
    expect(run([spec], "export const A = () => <ConfirmDialog />", "app/other/List.tsx").evaluations).toEqual(
      []
    )
    expect(
      run([spec], "export const A = () => <ConfirmDialog />", "./app/pages/List.tsx").evaluations
    ).toHaveLength(1)
  })

  it("skips, and says so, when a path-scoped policy is checked without a file name", () => {
    const r = validateCode(system([{ ...requiredChild, paths: ["app/**"] }]), {
      code: `${IMPORT}export const A = () => <ConfirmDialog />`,
      framework: "react"
    })
    expect(only(r as never)).toMatchObject({ status: "skipped" })
    expect(r.evaluations[0]?.reason).toMatch(/no file name/)
    expect(r.findings.filter((f) => f.code.startsWith("pattern-"))).toEqual([])
  })

  it("honors a policy's frameworks, and skips templates it cannot analyze", () => {
    expect(
      run([{ ...requiredChild, frameworks: ["vue"] }], "export const A = () => <ConfirmDialog />").evaluations
    ).toEqual([])
    const vue = validateCode(system([requiredChild]), {
      code: "<template><ConfirmDialog /></template>",
      filename: "src/List.vue",
      framework: "vue"
    })
    expect(vue.evaluations).toHaveLength(1)
    expect(vue.evaluations[0]).toMatchObject({ status: "skipped" })
    expect(vue.evaluations[0]?.reason).toMatch(/React JSX only/)
  })

  it("does not enforce what no approved policy is based on, nor a constraint it cannot read", () => {
    const unapproved = system([requiredChild])
    unapproved.contract.policies.length = 0
    expect(
      validateCode(unapproved, {
        code: `${IMPORT}export const A = () => <ConfirmDialog />`,
        framework: "react"
      }).evaluations
    ).toEqual([])
    const broken = run(
      [{ id: "x", kind: "cardinality", details: { target: "component:button" } }],
      "export const A = () => <Button />"
    )
    expect(broken.evaluations).toEqual([])
    expect(broken.limitations.join(" ")).toMatch(
      /Not enforced: policy policy:t\.x: constraint:t\.x has details that do not fit its kind/
    )
  })

  it("lets the rule overrides turn a rule off or change its severity", () => {
    const body = "export const A = () => <ConfirmDialog />"
    expect(
      run([requiredChild], body, "a.tsx", { "pattern-required-child-missing": "off" }).evaluations
    ).toEqual([])
    const warn = run([requiredChild], body, "a.tsx", { "pattern-required-child-missing": "warning" })
    expect(warn.findings.find((f) => f.code === "pattern-required-child-missing")?.severity).toBe("warning")
  })

  it("takes finding severity from the policy, lowered by enforcement", () => {
    const body = "export const A = () => <ConfirmDialog />"
    const sev = (s: Partial<Spec>) =>
      run([{ ...requiredChild, ...s }], body).findings.find((f) => f.code.startsWith("pattern-"))?.severity
    expect(sev({})).toBe("error")
    expect(sev({ enforcement: "warn" })).toBe("warning")
    expect(sev({ enforcement: "report-only" })).toBe("info")
    expect(sev({ severity: "warning" })).toBe("warning")
  })

  it("puts the policy, the evidence of the constraint and the approved basis on a finding", () => {
    const f = run([requiredChild], "export const A = () => <ConfirmDialog />").findings.find((x) =>
      x.code.startsWith("pattern-")
    )
    expect(f).toMatchObject({
      code: "pattern-required-child-missing",
      basis: "approved",
      policy: "policy:t.rc",
      subject: "pattern:page.data-management",
      line: 2
    })
    expect(f?.suggestion).toMatch(/Add Button inside ConfirmDialog/)
  })
})

describe("required-child", () => {
  it("passes when the child is there, fails when a closed element lacks it", () => {
    expect(
      statuses(run([requiredChild], "export const A = () => <ConfirmDialog><Button /></ConfirmDialog>"))
    ).toEqual(["pass"])
    const fail = run([requiredChild], "export const A = () => <ConfirmDialog><span>hi</span></ConfirmDialog>")
    expect(only(fail)).toMatchObject({ status: "fail", line: 2 })
    expect(fail.valid).toBe(false)
  })

  it("finds the child at any depth, not only directly inside", () => {
    expect(
      statuses(
        run([requiredChild], "export const A = () => <ConfirmDialog><div><Button /></div></ConfirmDialog>")
      )
    ).toEqual(["pass"])
  })

  it("evaluates every instance on its own", () => {
    const r = run(
      [requiredChild],
      "export const A = () => <><ConfirmDialog><Button /></ConfirmDialog><ConfirmDialog /></>"
    )
    expect(statuses(r)).toEqual(["pass", "fail"])
    expect(r.findings.filter((f) => f.code === "pattern-required-child-missing")).toHaveLength(1)
  })

  it("will not call a missing child when children come from elsewhere", () => {
    for (const body of [
      "export const A = ({ children }) => <ConfirmDialog>{children}</ConfirmDialog>",
      "export const A = (p) => <ConfirmDialog {...p} />",
      "export const A = () => <ConfirmDialog><LocalActions /></ConfirmDialog>"
    ]) {
      const r = run([requiredChild], body)
      expect(only(r).status, body).toBe("not-verifiable")
      expect(r.findings.filter((f) => f.code.startsWith("pattern-"))).toEqual([])
      expect(r.valid).toBe(true)
    }
  })

  it("warns when the child is only conditionally rendered", () => {
    const r = run(
      [requiredChild],
      "export const A = ({ ok }) => <ConfirmDialog>{ok && <Button />}</ConfirmDialog>"
    )
    expect(only(r)).toMatchObject({ status: "warning" })
    expect(r.findings.find((f) => f.code === "pattern-required-child-missing")?.severity).toBe(
      "error".replace("error", "warning")
    )
  })

  it("honors min", () => {
    const spec = { ...requiredChild, details: { ...requiredChild.details, min: 2 } }
    expect(
      statuses(run([spec], "export const A = () => <ConfirmDialog><Button /><Button /></ConfirmDialog>"))
    ).toEqual(["pass"])
    expect(statuses(run([spec], "export const A = () => <ConfirmDialog><Button /></ConfirmDialog>"))).toEqual(
      ["fail"]
    )
  })

  it("does nothing for a file with no such parent", () => {
    expect(run([requiredChild], "export const A = () => <Button />").evaluations).toEqual([])
  })
})

describe("forbidden-child", () => {
  const spec = {
    id: "fc",
    kind: "forbidden-child",
    details: { parent: "component:confirm-dialog", child: "component:data-table" }
  }

  it("fails on the offending element, passes when a closed parent avoids it", () => {
    const r = run([spec], "export const A = () => <ConfirmDialog><div><DataTable /></div></ConfirmDialog>")
    expect(only(r)).toMatchObject({ status: "fail", line: 2 })
    expect(only(r).reason).toMatch(/DataTable at line 2/)
    expect(statuses(run([spec], "export const A = () => <ConfirmDialog><Button /></ConfirmDialog>"))).toEqual(
      ["pass"]
    )
  })

  it("fails even for a conditional match, and never passes an open parent", () => {
    expect(
      statuses(run([spec], "export const A = ({ x }) => <ConfirmDialog>{x && <DataTable />}</ConfirmDialog>"))
    ).toEqual(["fail"])
    expect(
      statuses(run([spec], "export const A = ({ children }) => <ConfirmDialog>{children}</ConfirmDialog>"))
    ).toEqual(["not-verifiable"])
  })
})

describe("requires-parent", () => {
  const spec = {
    id: "rp",
    kind: "requires-parent",
    details: { child: "component:pagination", parents: ["component:data-table"] }
  }

  it("passes inside the parent at any distance", () => {
    expect(
      statuses(run([spec], "export const A = () => <DataTable><div><Pagination /></div></DataTable>"))
    ).toEqual(["pass"])
  })

  it("fails inside a different design-system element", () => {
    const r = run([spec], "export const A = () => <PageHeader><Pagination /></PageHeader>")
    expect(only(r)).toMatchObject({ status: "fail", line: 2 })
    expect(only(r).reason).toMatch(/sits inside PageHeader instead/)
  })

  it("cannot tell when nothing in the file encloses it, because the parent may be in another file", () => {
    for (const body of [
      "export const A = () => <Pagination />",
      "export const A = () => <div><Pagination /></div>"
    ])
      expect(only(run([spec], body)).status, body).toBe("not-verifiable")
  })
})

describe("required-region", () => {
  const spec = {
    id: "rr",
    kind: "required-region",
    details: { region: "region:results" },
    paths: ["app/pages/**"]
  }

  it("passes when a component that makes up the region is present", () => {
    expect(statuses(run([spec], "export const A = () => <main><DataTable /></main>"))).toEqual(["pass"])
  })

  it("fails in a closed file that has none of them", () => {
    const r = run([spec], "export const A = () => <PageHeader />")
    expect(only(r)).toMatchObject({ status: "fail", line: 1 })
    expect(only(r).reason).toMatch(/region results is missing/)
  })

  it("cannot tell when the file may get the region from somewhere else", () => {
    expect(statuses(run([spec], "export const A = () => <PageHeader><LocalResults /></PageHeader>"))).toEqual(
      ["not-verifiable"]
    )
    expect(statuses(run([spec], "export const A = ({ children }) => <main>{children}</main>"))).toEqual([
      "not-verifiable"
    ])
  })

  it("warns when the region is only conditionally rendered", () => {
    expect(statuses(run([spec], "export const A = ({ x }) => <main>{x && <DataTable />}</main>"))).toEqual([
      "warning"
    ])
  })

  it("is skipped, with the reason, when the policy names no paths", () => {
    const r = run([{ ...spec, paths: undefined } as unknown as Spec], "export const A = () => <PageHeader />")
    expect(only(r).status).toBe("skipped")
    expect(only(r).reason).toMatch(/names no paths/)
  })

  it("cannot be checked for a region with no component to recognize it by, or one no pattern owns", () => {
    const ds = system([spec])
    const page = ds.contract.patterns.find((p) => p.id === "pattern:page.data-management")
    if (!page?.composition) throw new Error("fixture bug")
    page.composition.parts = page.composition.parts.filter((p) => p.region !== "results")
    const noParts = validateCode(ds, {
      code: `${IMPORT}export const A = () => <DataTable />`,
      filename: "app/pages/L.tsx",
      framework: "react"
    })
    expect(noParts.evaluations).toHaveLength(1)
    expect(noParts.evaluations[0]).toMatchObject({ status: "not-verifiable" })
    expect(noParts.evaluations[0]?.reason).toMatch(/no component parts to recognize it by/)
    const orphan = run([{ ...spec, orphan: true }], "export const A = () => <DataTable />")
    expect(orphan.evaluations).toEqual([])
  })
})

describe("ordering", () => {
  const spec = {
    id: "or",
    kind: "ordering",
    details: {
      before: "component:search-field",
      after: "component:data-table",
      within: "component:page-header"
    }
  }
  const wrap = (inner: string) => `export const A = () => <PageHeader>${inner}</PageHeader>`

  it("passes in order and fails out of order, naming both lines", () => {
    expect(statuses(run([spec], wrap("<SearchField /><DataTable />")))).toEqual(["pass"])
    const r = run([spec], wrap("\n<DataTable />\n<SearchField />\n"))
    expect(only(r)).toMatchObject({ status: "fail" })
    expect(only(r).reason).toMatch(/DataTable \(line 3\) comes before SearchField \(line 4\)/)
  })

  it("is skipped when there is nothing to order", () => {
    const r = run([spec], wrap("<DataTable />"))
    expect(only(r).status).toBe("skipped")
    expect(only(r).reason).toMatch(/no SearchField to order/)
  })

  it("still fails an order it can see, but will not pass one in an open scope", () => {
    expect(statuses(run([spec], wrap("<DataTable />{children}<SearchField />")))).toEqual(["fail"])
    expect(statuses(run([spec], wrap("<SearchField /><DataTable />{children}")))).toEqual(["not-verifiable"])
  })

  it("works on the whole file when the policy names paths, and is skipped otherwise", () => {
    const file = {
      ...spec,
      details: { before: spec.details.before, after: spec.details.after },
      paths: ["app/**"]
    }
    expect(
      statuses(
        run([file], "export const A = () => <main><SearchField /><DataTable /></main>", "app/List.tsx")
      )
    ).toEqual(["pass"])
    expect(
      statuses(
        run(
          [{ ...file, paths: undefined } as unknown as Spec],
          "export const A = () => <main><SearchField /><DataTable /></main>"
        )
      )
    ).toEqual(["skipped"])
  })

  it("does not order an element against its own ancestor", () => {
    expect(statuses(run([spec], wrap("<DataTable><SearchField /></DataTable>")))).toEqual(["pass"])
  })
})

describe("cardinality", () => {
  const spec = (details: Record<string, unknown>, extra: Partial<Spec> = {}): Spec => ({
    id: "cd",
    kind: "cardinality",
    details,
    paths: ["app/**"],
    ...extra
  })
  const file = (body: string, specs: Spec[]) => run(specs, body, "app/List.tsx")

  it("fails when a limit is exceeded by elements that certainly render", () => {
    const r = file("export const A = () => <main><DataTable /><DataTable /></main>", [
      spec({ target: "component:data-table", max: 1 })
    ])
    expect(only(r)).toMatchObject({ status: "fail", line: 2 })
    expect(only(r).reason).toMatch(/has 2 DataTable, but at most 1 are allowed/)
  })

  it("treats max 0 as a prohibition", () => {
    const s = spec({ target: "component:data-table", max: 0 })
    expect(statuses(file("export const A = () => <main><DataTable /></main>", [s]))).toEqual(["fail"])
    expect(statuses(file("export const A = () => <main><PageHeader /></main>", [s]))).toEqual(["pass"])
  })

  it("passes a count in range in a closed file, and says not verifiable in an open one", () => {
    const s = spec({ target: "component:data-table", min: 1, max: 1 })
    expect(statuses(file("export const A = () => <main><DataTable /></main>", [s]))).toEqual(["pass"])
    expect(
      statuses(file("export const A = ({ children }) => <main><DataTable />{children}</main>", [s]))
    ).toEqual(["not-verifiable"])
  })

  it("fails a missing minimum only when the file is closed", () => {
    const s = spec({ target: "component:data-table", min: 1 })
    expect(statuses(file("export const A = () => <main><PageHeader /></main>", [s]))).toEqual(["fail"])
    expect(statuses(file("export const A = () => <main><LocalTable /></main>", [s]))).toEqual([
      "not-verifiable"
    ])
  })

  it("warns when conditional elements decide whether a bound holds", () => {
    expect(
      statuses(
        file("export const A = ({ x }) => <main>{x && <DataTable />}</main>", [
          spec({ target: "component:data-table", min: 1 })
        ])
      )
    ).toEqual(["warning"])
    expect(
      statuses(
        file("export const A = ({ x, y }) => <main>{x && <DataTable />}{y && <DataTable />}</main>", [
          spec({ target: "component:data-table", max: 1 })
        ])
      )
    ).toEqual(["warning"])
  })

  it("counts elements in a list as possible, never as certain", () => {
    const s = spec({ target: "component:button", max: 1 })
    expect(
      statuses(file("export const A = ({ rows }) => <main>{rows.map((r) => <Button key={r} />)}</main>", [s]))
    ).toEqual(["warning"])
  })

  it("counts per container when the constraint is `within` a component, with no paths needed", () => {
    const s = spec(
      { target: "component:button", max: 1, within: "component:confirm-dialog" },
      { paths: undefined }
    )
    const r = run(
      [s],
      "export const A = () => <><ConfirmDialog><Button /></ConfirmDialog><ConfirmDialog><Button /><Button /></ConfirmDialog></>"
    )
    expect(statuses(r)).toEqual(["pass", "fail"])
  })

  it("reports the worst of min and max together", () => {
    const s = spec({ target: "component:data-table", min: 2, max: 3 })
    const r = file("export const A = () => <main><DataTable /></main>", [s])
    expect(only(r)).toMatchObject({ status: "fail" })
    expect(only(r).reason).toMatch(/needs at least 2/)
  })
})

describe("what cannot be established is never a pass", () => {
  it("does not detect occurrences of a pattern, or count within a region", () => {
    const pattern = run(
      [
        {
          id: "p",
          kind: "ordering",
          details: { before: "pattern:composition.table-toolbar", after: "component:data-table" },
          paths: ["app/**"]
        }
      ],
      "export const A = () => <main><DataTable /></main>",
      "app/List.tsx"
    )
    expect(only(pattern).status).toBe("not-verifiable")
    expect(only(pattern).reason).toMatch(/occurrences of a pattern are not detected statically yet/)
    const region = run(
      [
        {
          id: "r",
          kind: "cardinality",
          details: { target: "component:data-table", max: 1, within: "region:results" },
          paths: ["app/**"]
        }
      ],
      "export const A = () => <main><DataTable /></main>",
      "app/List.tsx"
    )
    expect(only(region).status).toBe("not-verifiable")
    expect(only(region).reason).toMatch(/not evaluated yet/)
  })

  it("never proves an absence, an order or an upper bound in a scope with opaque children", () => {
    const specs: Spec[] = [
      {
        id: "fc",
        kind: "forbidden-child",
        details: { parent: "component:confirm-dialog", child: "component:data-table" }
      },
      {
        id: "or",
        kind: "ordering",
        details: {
          before: "component:button",
          after: "component:search-field",
          within: "component:confirm-dialog"
        }
      },
      {
        id: "cd",
        kind: "cardinality",
        details: { target: "component:button", max: 2, within: "component:confirm-dialog" }
      }
    ]
    const r = run(
      specs,
      "export const A = ({ children }) => <ConfirmDialog><Button /><SearchField />{children}</ConfirmDialog>"
    )
    expect(r.evaluations).toHaveLength(3)
    expect(r.evaluations.filter((e) => e.status === "pass")).toEqual([])
    expect(r.evaluations.map((e) => e.status)).toEqual(["not-verifiable", "not-verifiable", "not-verifiable"])
  })

  it("does accept presence as proof, even when other children are opaque", () => {
    const r = run(
      [requiredChild],
      "export const A = ({ children }) => <ConfirmDialog><Button />{children}</ConfirmDialog>"
    )
    expect(statuses(r)).toEqual(["pass"])
  })

  it("summarizes the outcomes", () => {
    const r = run(
      [requiredChild],
      "export const A = () => <><ConfirmDialog><Button /></ConfirmDialog><ConfirmDialog /></>"
    )
    expect(r.summary.patternRules).toEqual({ pass: 1, fail: 1, warning: 0, notVerifiable: 0, skipped: 0 })
    expect(r.limitations.join(" ")).toMatch(/never as a pass/)
  })
})

describe("required-state: interaction checks and how much they establish", () => {
  const state = (workflow: string, name: string, extra: Partial<Spec> & { minimum?: string } = {}): Spec => {
    const { minimum, ...rest } = extra
    return {
      id: `${workflow}-${name}`,
      kind: "required-state",
      details: { workflow, state: name, ...(minimum ? { minimum } : {}) },
      ...rest
    }
  }
  const FORM = (body = "") => `export function F() {
  const [submitting, setSubmitting] = useState(false)
  const submit = async () => { setSubmitting(true); await save(); setSubmitting(false) }
  return <form onSubmit={submit}>${body}<button disabled={submitting}>Go</button></form>
}`
  const check = (specs: Spec[], body: string) => run(specs, body, "app/forms/F.tsx")

  it("passes with the level it established, and what it saw", () => {
    const r = check([state("form-submission", "submitting")], FORM())
    const e = only(r)
    expect(e).toMatchObject({ rule: "pattern-state-missing", status: "pass", level: "static-inferred" })
    expect(e.reason).toMatch(/form <form> at line \d+: submitting is represented \(static-inferred\)/)
    expect(e.evidence?.join(" ")).toMatch(/sets submitting to true before its await/)
    expect(r.findings.filter((f) => f.code === "pattern-state-missing")).toEqual([])
  })

  it("warns when the rule asks for more than the code shows", () => {
    const code = `export function F() {
  const [loading, setLoading] = useState(false)
  const submit = async () => { await save() }
  return <form onSubmit={submit}><button disabled={loading}>Go</button></form>
}`
    const loose = check([state("form-submission", "submitting")], code)
    expect(only(loose)).toMatchObject({ status: "pass", level: "structural" })
    const strict = check([state("form-submission", "submitting", { minimum: "static-inferred" })], code)
    expect(only(strict)).toMatchObject({ status: "warning", level: "structural" })
    expect(only(strict).reason).toMatch(
      /represented only structurally; the rule asks for evidence that the code makes it happen/
    )
    expect(strict.findings.find((f) => f.code === "pattern-state-missing")?.severity).toBe("warning")
    expect(strict.valid).toBe(true)
  })

  it("fails when nothing shows the state and nothing hides it", () => {
    const r = check(
      [state("form-submission", "error")],
      "export function F() { const submit = async () => { await save() }; return <form onSubmit={submit}><button>Go</button></form> }"
    )
    expect(only(r)).toMatchObject({ status: "fail" })
    expect(only(r).level).toBeUndefined()
    const finding = r.findings.find((f) => f.code === "pattern-state-missing")
    expect(finding).toMatchObject({
      severity: "error",
      basis: "approved",
      policy: "policy:t.form-submission-error"
    })
    expect(finding?.suggestion).toMatch(/Show an error message/)
    expect(r.valid).toBe(false)
  })

  it("is not verifiable when the code hides the answer, and never a pass or a failure", () => {
    const r = check(
      [state("form-submission", "submitting")],
      "export function F(props) { return <form onSubmit={props.onSubmit}><button>Go</button></form> }"
    )
    expect(only(r).status).toBe("not-verifiable")
    expect(only(r).reason).toMatch(
      /cannot tell whether submitting is represented; the submit handler cannot be read/
    )
    expect(r.findings.filter((f) => f.code === "pattern-state-missing")).toEqual([])
    expect(r.valid).toBe(true)
  })

  it("evaluates each place the interaction occurs", () => {
    const r = check(
      [state("form-submission", "guarded")],
      `${FORM()}\nexport function G() { const s = async () => { await save() }; return <form onSubmit={s}><button>Go</button></form> }`
    )
    expect(statuses(r)).toEqual(["pass", "fail"])
  })

  it("says nothing about a file without the interaction", () => {
    expect(
      check([state("form-submission", "submitting")], "export const A = () => <div />").evaluations
    ).toEqual([])
    expect(check([state("search-results", "empty")], FORM()).evaluations).toEqual([])
  })

  it("covers the three workflows", () => {
    const confirm = check(
      [state("destructive-confirmation", "confirming")],
      "export function R() { const rm = async () => { await deleteItem() }; return <button onClick={rm}>Delete</button> }"
    )
    expect(only(confirm)).toMatchObject({ status: "fail" })
    expect(only(confirm).reason).toMatch(/calls deleteItem \(line \d+\) directly, with no confirmation step/)
    const search = check(
      [state("search-results", "clearable")],
      'export function S() { const [q, setQ] = useState(""); return <input type="search" value={q} onChange={(e) => setQ(e.target.value)} /> }'
    )
    expect(only(search)).toMatchObject({ status: "pass", level: "structural" })
  })

  it("applies the policy's paths, frameworks, severity and overrides like any other pattern rule", () => {
    const code =
      "export function F() { const submit = async () => { await save() }; return <form onSubmit={submit}><button>Go</button></form> }"
    expect(
      run([state("form-submission", "error", { paths: ["app/forms/**"] })], code, "app/other/F.tsx")
        .evaluations
    ).toEqual([])
    expect(
      run([state("form-submission", "error", { enforcement: "warn" })], code).findings.find(
        (f) => f.code === "pattern-state-missing"
      )?.severity
    ).toBe("warning")
    expect(
      run([state("form-submission", "error")], code, "app/forms/F.tsx", { "pattern-state-missing": "off" })
        .evaluations
    ).toEqual([])
    const vue = validateCode(system([state("form-submission", "error")]), {
      code: "<template><form @submit='go'><button>Go</button></form></template>",
      filename: "src/F.vue",
      framework: "vue"
    })
    expect(vue.evaluations[0]).toMatchObject({ status: "skipped" })
  })

  it("treats a design-system button inside the form as something it can see through", () => {
    const code = `export function F() { const submit = async () => { await save() }; return <form onSubmit={submit}><Button>Go</Button></form> }`
    expect(only(check([state("form-submission", "error")], code)).status).toBe("fail")
  })

  it("never reports a runtime-verified level", () => {
    const r = check(
      [
        state("form-submission", "submitting"),
        state("form-submission", "error"),
        state("form-submission", "guarded")
      ],
      FORM()
    )
    expect(r.evaluations.length).toBeGreaterThan(0)
    for (const e of r.evaluations) expect(["structural", "static-inferred", undefined]).toContain(e.level)
  })
})
