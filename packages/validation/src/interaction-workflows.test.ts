import { describe, expect, it } from "vitest"
import { analyzeInteractions, type InteractionSite, type StateCheck } from "./interaction-workflows.js"

const analyze = (code: string, transparent: string[] = []): InteractionSite[] =>
  analyzeInteractions(code, "f.tsx", new Set(transparent))
const one = (code: string, workflow: string, transparent: string[] = []): InteractionSite => {
  const sites = analyze(code, transparent).filter((s) => s.workflow === workflow)
  expect(sites, `sites of ${workflow}`).toHaveLength(1)
  return sites[0] as InteractionSite
}
const state = (site: InteractionSite, name: string): StateCheck => site.states[name] as StateCheck
const levels = (site: InteractionSite): Record<string, string> =>
  Object.fromEntries(
    Object.entries(site.states).map(([k, v]) => [k, v.level ?? (v.open ? "open" : "absent")])
  )

describe("form submission", () => {
  const GOOD = `
import { useState } from "react"
export function ContactForm() {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  async function handleSubmit(e) {
    e.preventDefault()
    if (submitting) return
    setSubmitting(true)
    try {
      await save()
      navigate("/thanks")
    } catch (err) {
      setError("Could not save")
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <form onSubmit={handleSubmit}>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={submitting}>{submitting ? "Saving" : "Save"}</button>
    </form>
  )
}`

  it("finds every state, at the level the code shows", () => {
    const site = one(GOOD, "form-submission")
    expect(levels(site)).toEqual({
      submitting: "static-inferred",
      error: "static-inferred",
      success: "static-inferred",
      guarded: "static-inferred"
    })
    expect(site.line).toBe(20)
    expect(site.label).toBe("form <form> at line 20")
  })

  it("says what it saw, with lines", () => {
    const site = one(GOOD, "form-submission")
    expect(state(site, "submitting").evidence.join(" ")).toMatch(
      /sets submitting to true before its await and back to false after/
    )
    expect(state(site, "error").evidence.join(" ")).toMatch(/sets error when it fails/)
    expect(state(site, "success").evidence.join(" ")).toMatch(/calls navigate after its await \(line 12\)/)
    expect(state(site, "guarded").evidence.join(" ")).toMatch(/returns early when submitting is set/)
  })

  it("is structural, not inferred, when the interface reads a flag the handler does not visibly set", () => {
    const site = one(
      `export function F() {
  const [loading, setLoading] = useState(false)
  const submit = async () => { await save() }
  return <form onSubmit={submit}><button disabled={loading}>Go</button></form>
}`,
      "form-submission"
    )
    expect(levels(site)).toMatchObject({ submitting: "structural", guarded: "structural" })
    expect(state(site, "submitting").evidence[0]).toMatch(/named like a pending flag/)
  })

  it("accepts a pending flag from a hook, structurally", () => {
    const site = one(
      `export function F() {
  const { pending } = useFormStatus()
  return <form onSubmit={go}><button disabled={pending}>Go</button></form>
}
function go() {}`,
      "form-submission"
    )
    expect(state(site, "submitting")).toMatchObject({ level: "structural" })
    expect(state(site, "submitting").evidence[0]).toMatch(/from useFormStatus/)
  })

  it("accepts a property of a hook's result", () => {
    const site = one(
      `export function F() {
  const m = useMutation()
  return <form onSubmit={() => m.mutate()}><button disabled={m.isPending}>Go</button></form>
}`,
      "form-submission"
    )
    expect(state(site, "submitting").level).toBe("structural")
  })

  it("infers a pending flag from what the handler does, whatever it is called", () => {
    const site = one(
      `export function F() {
  const [working, setWorking] = useState(false)
  const submit = async () => { setWorking(true); await save(); setWorking(false) }
  return <form onSubmit={submit}><button disabled={working}>Go</button></form>
}`,
      "form-submission"
    )
    expect(state(site, "submitting").level).toBe("static-inferred")
  })

  it("follows an inline handler that only calls a local one, and react-hook-form's handleSubmit", () => {
    const code = (attr: string) => `export function F() {
  const [saving, setSaving] = useState(false)
  const save = async () => { setSaving(true); await post(); setSaving(false) }
  return <form onSubmit={${attr}}><button disabled={saving}>Go</button></form>
}`
    expect(state(one(code("() => save()"), "form-submission"), "submitting").level).toBe("static-inferred")
    expect(state(one(code("handleSubmit(save)"), "form-submission"), "submitting").level).toBe(
      "static-inferred"
    )
  })

  it("reads promise chains as part of the handler", () => {
    const site = one(
      `export function F() {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(null)
  const submit = () => {
    setBusy(true)
    post().then(() => navigate("/ok")).catch(() => setFailed("x")).finally(() => setBusy(false))
  }
  return <form onSubmit={submit}>{failed}<button disabled={busy}>Go</button></form>
}`,
      "form-submission"
    )
    expect(levels(site)).toMatchObject({
      submitting: "static-inferred",
      error: "static-inferred",
      success: "static-inferred"
    })
  })

  it("says a state is absent when nothing hides it", () => {
    const site = one(
      `export function F() {
  const submit = async () => { await save() }
  return <form onSubmit={submit}><button>Go</button></form>
}`,
      "form-submission"
    )
    expect(levels(site)).toEqual({
      submitting: "absent",
      error: "absent",
      success: "absent",
      guarded: "absent"
    })
    expect(state(site, "error").absent).toMatch(/no catch and nothing shows an error/)
  })

  it("calls a flag that is set but never shown absent, and says why", () => {
    const site = one(
      `export function F() {
  const [submitting, setSubmitting] = useState(false)
  const submit = async () => { setSubmitting(true); await save(); setSubmitting(false) }
  return <form onSubmit={submit}><button>Go</button></form>
}`,
      "form-submission"
    )
    expect(state(site, "submitting")).toMatchObject({
      absent: expect.stringMatching(/submitting exists but nothing in the interface reads it/)
    })
    expect(state(site, "submitting").level).toBeUndefined()
  })

  it("does not claim absence when the handler comes from outside", () => {
    const site = one(
      `export function F(props) { return <form onSubmit={props.onSubmit}><button>Go</button></form> }`,
      "form-submission"
    )
    expect(levels(site)).toEqual({ submitting: "open", error: "open", success: "open", guarded: "open" })
    expect(state(site, "error").open).toMatch(/submit handler cannot be read/)
  })

  it("does not claim absence when a custom hook, a spread, an action or a component from another file may supply it", () => {
    const open = (code: string) => state(one(code, "form-submission"), "submitting").open
    expect(
      open(
        `export function F() { const f = useMyForm(); return <form onSubmit={f.submit}><button>Go</button></form> }`
      )
    ).toMatch(/useMyForm may supply it/)
    expect(
      open(
        `export function F(p) { const submit = async () => { await x() }; return <form {...p} onSubmit={submit}><button>Go</button></form> }`
      )
    ).toMatch(/spread onto the form/)
    expect(
      open(
        `export function F() { const submit = async () => { await x() }; return <form action={doIt} onSubmit={submit}><button>Go</button></form> }`
      )
    ).toMatch(/useFormStatus/)
    expect(
      open(
        `export function F() { const submit = async () => { await x() }; return <form onSubmit={submit}><Fancy /></form> }`
      )
    ).toMatch(/<Fancy> at line 1 comes from another file/)
  })

  it("treats a design-system component as transparent", () => {
    const code = `export function F() { const submit = async () => { await x() }; return <form onSubmit={submit}><Button>Go</Button></form> }`
    expect(state(one(code, "form-submission", ["Button"]), "submitting").absent).toBeDefined()
    expect(state(one(code, "form-submission"), "submitting").open).toMatch(/<Button> at line 1/)
  })

  it("does not read callbacks as flags", () => {
    const site = one(
      `export function F({ onError }) {
  const submit = async () => { await x() }
  return <form onSubmit={submit}>{onError}<button>Go</button></form>
}`,
      "form-submission"
    )
    expect(state(site, "error").level).toBeUndefined()
  })

  it("finds every form in a file, in order", () => {
    const sites = analyze(
      `export const A = () => <form onSubmit={go}><button>a</button></form>
export const B = () => <form onSubmit={go}><button>b</button></form>
function go() {}`
    )
    expect(sites.map((s) => s.line)).toEqual([1, 2])
  })

  it("finds no site where there is no form", () => {
    expect(analyze("export const A = () => <div><button>x</button></div>")).toEqual([])
  })
})

describe("destructive confirmation", () => {
  const GOOD = `
export function Row({ id }) {
  const [open, setOpen] = useState(false)
  const remove = async () => { await deleteItem(id); setOpen(false) }
  return (
    <div>
      <button onClick={() => setOpen(true)}>Delete</button>
      {open && (
        <Modal>
          <p>Delete this item?</p>
          <button onClick={remove}>Delete</button>
          <button onClick={() => setOpen(false)}>Cancel</button>
        </Modal>
      )}
    </div>
  )
}`

  it("finds a trigger that opens a dialog whose confirm reaches the delete, and a cancel that closes it", () => {
    const site = one(GOOD, "destructive-confirmation")
    expect(levels(site)).toEqual({ confirming: "static-inferred", cancellable: "static-inferred" })
    expect(site.label).toBe("destructive action <button> at line 7")
    expect(state(site, "confirming").evidence.join(" ")).toMatch(/opens <Modal> at line 9 through open/)
    expect(state(site, "confirming").evidence.join(" ")).toMatch(
      /delete call \(line 4\) is reached from the dialog's confirm action/
    )
    expect(state(site, "cancellable").evidence.join(" ")).toMatch(/cancelling sets open back to false/)
  })

  it("does not treat the confirm button inside the dialog as a second destructive action", () => {
    expect(analyze(GOOD).filter((s) => s.workflow === "destructive-confirmation")).toHaveLength(1)
  })

  it("fails a trigger that deletes directly", () => {
    const site = one(
      `export function Row({ id }) {
  const remove = async () => { await deleteItem(id) }
  return <button onClick={remove}>Delete</button>
}`,
      "destructive-confirmation"
    )
    expect(state(site, "confirming").absent).toMatch(
      /calls deleteItem \(line 2\) directly, with no confirmation step/
    )
    expect(state(site, "cancellable").absent).toMatch(/no confirmation to cancel/)
  })

  it("accepts window.confirm before the delete", () => {
    const site = one(
      `export function Row({ id }) {
  const remove = () => { if (window.confirm("Sure?")) { deleteItem(id) } }
  return <button onClick={remove}>Delete</button>
}`,
      "destructive-confirmation"
    )
    expect(state(site, "confirming")).toMatchObject({ level: "static-inferred" })
    expect(state(site, "cancellable")).toMatchObject({ level: "structural" })
  })

  it("is structural when a dialog reacts but its confirm action is not traced", () => {
    const site = one(
      `export function Row() {
  const [open, setOpen] = useState(false)
  return (<div><button onClick={() => setOpen(true)}>Delete</button><ConfirmDialog open={open} onClose={() => setOpen(false)} /></div>)
}`,
      "destructive-confirmation"
    )
    expect(state(site, "confirming").level).toBe("structural")
    expect(state(site, "cancellable").level).toBe("static-inferred")
  })

  it("reads an onConfirm prop as the confirm action", () => {
    const site = one(
      `export function Row({ id }) {
  const [open, setOpen] = useState(false)
  const remove = () => { deleteItem(id) }
  return (<div><button onClick={() => setOpen(true)}>Remove</button><ConfirmDialog open={open} onConfirm={remove} onCancel={() => setOpen(false)} /></div>)
}`,
      "destructive-confirmation"
    )
    expect(levels(site)).toEqual({ confirming: "static-inferred", cancellable: "static-inferred" })
  })

  it("finds a dialog with no cancel absent", () => {
    const site = one(
      `export function Row({ id }) {
  const [open, setOpen] = useState(false)
  const remove = () => deleteItem(id)
  return (<div><button onClick={() => setOpen(true)}>Delete</button>{open && <Modal><button onClick={remove}>OK</button></Modal>}</div>)
}`,
      "destructive-confirmation"
    )
    expect(state(site, "confirming").level).toBe("static-inferred")
    expect(state(site, "cancellable").absent).toMatch(/no cancel button or close handler/)
  })

  it("will not call a confirmation missing when the handler comes from outside", () => {
    const site = one(
      `export function Row(props) { return <button onClick={props.onDelete}>Delete</button> }`,
      "destructive-confirmation"
    )
    expect(levels(site)).toEqual({ confirming: "open", cancellable: "open" })
    expect(state(site, "confirming").open).toMatch(/confirmation may live in the caller/)
  })

  it("says so when a state is opened but no dialog here reacts to it", () => {
    const site = one(
      `export function Row() {
  const [open, setOpen] = useState(false)
  return <button onClick={() => setOpen(true)}>Delete</button>
}`,
      "destructive-confirmation"
    )
    expect(state(site, "confirming").open).toMatch(/open is set, but no dialog in this file reacts to it/)
  })

  it("recognizes a delete by the handler's calls or by the button's text, but not an ordinary click", () => {
    expect(analyze(`export const A = () => <button onClick={() => save()}>Save</button>`)).toEqual([])
    expect(analyze(`export const A = () => <button onClick={() => archiveItem()}>Archive</button>`)).toEqual(
      []
    )
    expect(analyze(`export const A = () => <button onClick={props.go}>Delete account</button>`)).toHaveLength(
      1
    )
    expect(analyze(`export const A = () => <button onClick={() => removeUser(1)}>Go</button>`)).toHaveLength(
      1
    )
  })
})

describe("search and results", () => {
  const GOOD = `
export function Search({ items }) {
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const results = items.filter((i) => i.name.includes(query))
  useEffect(() => {
    async function run() {
      setLoading(true)
      try { await fetchResults(query) } catch (e) { setError("x") } finally { setLoading(false) }
    }
    run()
  }, [query])
  return (
    <div>
      <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
      <button onClick={() => setQuery("")}>Clear</button>
      {loading && <p>Loading</p>}
      {error && <p>{error}</p>}
      {results.length === 0 ? <p>No results</p> : results.map((r) => <p key={r.id}>{r.name}</p>)}
    </div>
  )
}`

  it("finds every state, with the strongest evidence", () => {
    const site = one(GOOD, "search-results")
    expect(levels(site)).toMatchObject({
      connected: "static-inferred",
      empty: "static-inferred",
      clearable: "static-inferred"
    })
    expect(site.label).toBe("search <input> at line 16")
  })

  it("infers loading from a flag set around an await in an effect, and an error set in a catch", () => {
    const site = one(GOOD, "search-results")
    expect(state(site, "loading")).toMatchObject({ level: "static-inferred" })
    expect(state(site, "error").level).toBe("static-inferred")
  })

  it("ties emptiness to the query only when the results are derived from it", () => {
    const derived = state(one(GOOD, "search-results"), "empty")
    expect(derived.evidence.join(" ")).toMatch(/results is derived from query/)
    const loose = one(
      `export function S({ items }) {
  const [q, setQ] = useState("")
  return (<div><input type="search" value={q} onChange={(e) => setQ(e.target.value)} />{items.length === 0 && <p>Nothing</p>}</div>)
}`,
      "search-results"
    )
    expect(state(loose, "empty").level).toBe("structural")
  })

  it("accepts an empty message or an Empty component", () => {
    const text = one(
      `export function S() { const [q, setQ] = useState(""); return <div><input type="search" value={q} onChange={(e) => setQ(e.target.value)} />{rows.length ? rows : <p>No results found</p>}</div> }`,
      "search-results"
    )
    expect(state(text, "empty").level).toBe("structural")
    const el = one(
      `export function S() { const [q, setQ] = useState(""); return <div><input type="search" value={q} onChange={(e) => setQ(e.target.value)} /><EmptyState /></div> }`,
      "search-results",
      ["EmptyState"]
    )
    expect(state(el, "empty").level).toBe("structural")
  })

  it("accepts a native search input's clear control, and a clear control as structural or inferred", () => {
    const native = one(
      `export function S() { const [q, setQ] = useState(""); return <input type="search" value={q} onChange={(e) => setQ(e.target.value)} /> }`,
      "search-results"
    )
    expect(state(native, "clearable")).toMatchObject({ level: "structural" })
    const control = one(
      `export function S() { const [q, setQ] = useState(""); return <div><input value={q} onChange={(e) => setQ(e.target.value)} /><button onClick={() => setQ("")}>x</button></div> }`,
      "search-results"
    )
    expect(state(control, "clearable").level).toBe("static-inferred")
  })

  it("finds a search by a SearchField component, and by an input bound to a query", () => {
    expect(analyze(`export const A = () => <SearchField onChange={f} />`, ["SearchField"])).toHaveLength(1)
    expect(
      analyze(
        `export function S() { const [query, setQuery] = useState(""); return <input value={query} onChange={(e) => setQuery(e.target.value)} /> }`
      )
    ).toHaveLength(1)
    expect(analyze(`export const A = () => <input type="text" />`)).toEqual([])
  })

  it("says connected is absent when nothing else uses the query", () => {
    const site = one(
      `export function S() { const [q, setQ] = useState(""); return <input type="search" value={q} onChange={(e) => setQ(e.target.value)} /> }`,
      "search-results"
    )
    expect(state(site, "connected").absent).toMatch(/q is set by the input but nothing else uses it/)
  })

  it("does not claim a state absent when a custom hook or a component from another file may supply it", () => {
    const hook = one(
      `export function S() { const r = useResults(); const [q, setQ] = useState(""); return <input type="search" value={q} onChange={(e) => setQ(e.target.value)} /> }`,
      "search-results"
    )
    expect(levels(hook)).toMatchObject({ loading: "open", empty: "open", error: "open" })
    const foreign = one(
      `export function S() { const [q, setQ] = useState(""); return <div><input type="search" value={q} onChange={(e) => setQ(e.target.value)} /><Results q={q} /></div> }`,
      "search-results"
    )
    expect(state(foreign, "empty").open).toMatch(/<Results> at line 1 comes from another file/)
    expect(state(foreign, "connected").level).toBe("structural")
  })

  it("cannot tie an input to state it does not see", () => {
    const site = one(
      `export function S(props) { return <input type="search" value={props.q} onChange={props.set} /> }`,
      "search-results"
    )
    expect(state(site, "connected").open).toMatch(/not tied to state this file can see/)
  })
})

describe("what it never claims", () => {
  it("has no runtime-verified level anywhere", () => {
    const sites = analyze(`
export function F() {
  const [submitting, setSubmitting] = useState(false)
  const submit = async () => { setSubmitting(true); await save(); setSubmitting(false) }
  return <form onSubmit={submit}><button disabled={submitting}>Go</button></form>
}`)
    for (const s of sites)
      for (const c of Object.values(s.states))
        expect(["structural", "static-inferred", undefined]).toContain(c.level)
  })

  it("never has both a level and an absence or open reason for the same state", () => {
    const sites = analyze(`
export function F(props) {
  const [loading, setLoading] = useState(false)
  return <form onSubmit={props.go}><button disabled={loading}>Go</button></form>
}`)
    for (const s of sites)
      for (const c of Object.values(s.states)) {
        if (c.level) expect(c.open ?? c.absent).toBeUndefined()
        else expect([c.open, c.absent].filter(Boolean)).toHaveLength(1)
      }
  })
})
