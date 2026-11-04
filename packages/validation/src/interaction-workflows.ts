import type { EvidenceLevel, InteractionWorkflow } from "@invariant/contract"
import ts from "typescript"
import {
  analyzeFunction,
  bindingNames,
  buildScope,
  type Candidate,
  type Chain,
  candidates,
  chainHandler,
  chainStates,
  chainUnknownHooks,
  enclosingFunctions,
  type FunctionInfo,
  isDeleteLike,
  lineOf,
  type Scope,
  shown,
  unwrap
} from "./interaction-facts.js"

/*
 * Three interactions, looked for in the JSX and handlers of one file: a form submission, a destructive action
 * that should be confirmed, and a search with results. Each yields, per place it occurs, how each of its states
 * is represented in the code.
 *
 * What a state check can report:
 *   structural       the code has the piece and shows it in the interface (some of this rests on names)
 *   static-inferred  a handler's code shows it happening (for example a flag set before an await and cleared after)
 * Neither is runtime verification. When the code hides the answer (an imported handler, a custom hook, a
 * component from another file) the check is `open`: absence cannot be claimed.
 */

export interface StateCheck {
  /** The strongest evidence found. Absent when the state was not found. */
  level?: Exclude<EvidenceLevel, "runtime-verified">
  /** What was seen, with lines. */
  evidence: string[]
  /** Why absence cannot be claimed, when the state was not found but could be somewhere this file hides. */
  open?: string
  /** What is missing, when the state was not found and nothing hides it. */
  absent?: string
}

export interface InteractionSite {
  workflow: InteractionWorkflow
  line: number
  column: number
  label: string
  states: Record<string, StateCheck>
}

const PENDING = /^(?:is|has)?(?:submitting|saving|sending|loading|pending|busy|processing|posting|updating)$/i
const LOADING = /^(?:is)?(?:loading|fetching|searching|pending|busy)$/i
const ERROR = /error|fail/i
const SUCCESS = /success|succeeded|submitted|saved|sent|completed|done/i
const OPEN_ATTR = /^(?:open|isOpen|visible|show|opened)$/i
const CONFIRM_ATTR = /^on(?:Confirm|Ok|Accept|Submit|Delete|Remove|Yes)$/i
const CANCEL_ATTR = /^on(?:Cancel|Close|Dismiss|OpenChange)$/i
const DIALOG_TAG = /(?:modal|dialog|drawer|popup|popover|sheet|confirm)/i
const SEARCH_TAG = /^(?:search|searchbox|searchfield|searchinput|searchbar)$/i
const NAVIGATION_OR_FEEDBACK =
  /^(?:navigate|push|replace|redirect|toast|notify|showToast|success|enqueueSnackbar|onSuccess|onSubmitted|onDone|onSaved|onComplete|alert)$/i
const notCallback = (c: Candidate): boolean => !/^on[A-Z]/.test(c.name)

type Attr = ts.Expression | string | true

interface El {
  node: ts.JsxElement | ts.JsxSelfClosingElement
  tag: string
  attrs: Map<string, Attr>
  spread: boolean
  line: number
  column: number
}

function elementOf(sf: ts.SourceFile, node: ts.JsxElement | ts.JsxSelfClosingElement): El {
  const opening = ts.isJsxElement(node) ? node.openingElement : node
  const attrs = new Map<string, Attr>()
  let spread = false
  for (const a of opening.attributes.properties) {
    if (ts.isJsxSpreadAttribute(a)) {
      spread = true
      continue
    }
    const name = a.name.getText(sf)
    const init = a.initializer
    if (!init) attrs.set(name, true)
    else if (ts.isStringLiteral(init)) attrs.set(name, init.text)
    else if (ts.isJsxExpression(init) && init.expression) attrs.set(name, init.expression)
  }
  const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf))
  return {
    node,
    tag: opening.tagName.getText(sf),
    attrs,
    spread,
    line: pos.line + 1,
    column: pos.character + 1
  }
}

const identifiersIn = (n: ts.Node): string[] => {
  const out: string[] = []
  const walk = (c: ts.Node): void => {
    if (ts.isIdentifier(c)) out.push(c.text)
    ts.forEachChild(c, walk)
  }
  walk(n)
  return out
}

const attrIds = (el: El, name: string): string[] => {
  const v = el.attrs.get(name)
  return v !== undefined && typeof v === "object" ? identifiersIn(v) : []
}

const isFn = (n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression =>
  ts.isArrowFunction(n) || ts.isFunctionExpression(n)

/** Reads one file and finds every place an interaction occurs. */
export function analyzeInteractions(
  code: string,
  filename: string,
  /** Tags of this file that are design-system components: their content is known to the contract. */
  transparentTags: ReadonlySet<string>
): InteractionSite[] {
  const sf = ts.createSourceFile(
    filename,
    code,
    ts.ScriptTarget.Latest,
    true,
    /\.jsx?$/i.test(filename) ? ts.ScriptKind.JSX : ts.ScriptKind.TSX
  )
  const scopes = new Map<ts.Node, Scope>()
  const scopeFor = (fn: ts.Node): Scope => {
    const hit = scopes.get(fn)
    if (hit) return hit
    const outer = enclosingFunctions(fn)[0]
    const s = buildScope(sf, fn, outer ? scopeFor(outer) : undefined)
    scopes.set(fn, s)
    return s
  }
  const chainOf = (node: ts.Node): Chain => ({ scopes: enclosingFunctions(node).map(scopeFor) })

  const elements: El[] = []
  const collect = (n: ts.Node): void => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) elements.push(elementOf(sf, n))
    ts.forEachChild(n, collect)
  }
  collect(sf)

  const isNative = (tag: string): boolean => /^[a-z][a-z0-9]*$/.test(tag)
  const isForeign = (tag: string): boolean =>
    !isNative(tag) && tag !== "Fragment" && !transparentTags.has(tag) && !DIALOG_TAG.test(tag)
  const within = (outer: El, inner: El): boolean =>
    inner.node !== outer.node &&
    inner.node.getStart(sf) >= outer.node.getStart(sf) &&
    inner.node.getEnd() <= outer.node.getEnd()
  const below = (el: El): El[] => elements.filter((e) => within(el, e))
  const textOf = (el: El): string =>
    ts.isJsxElement(el.node)
      ? el.node.children
          .filter(ts.isJsxText)
          .map((t) => t.text.trim())
          .join(" ")
          .trim()
      : ""
  const labelOf = (el: El): string => `<${el.tag}> at line ${el.line}`

  /** Reasons the answer may be somewhere this file does not show: custom hooks, other-file components, spreads. */
  const hidden = (chain: Chain, subtree: El[]): string | undefined => {
    const hooks = chainUnknownHooks(chain)
    if (hooks.length > 0)
      return `${[...new Set(hooks)].join(", ")} may supply it, and Invariant cannot see inside`
    const foreign = subtree.find((e) => isForeign(e.tag))
    if (foreign) return `<${foreign.tag}> at line ${foreign.line} comes from another file and may supply it`
    return undefined
  }

  /** The function a handler expression means, when this file shows it. */
  const resolveHandler = (value: Attr | undefined, chain: Chain): { info?: FunctionInfo; open?: string } => {
    if (value === undefined || value === true || typeof value === "string")
      return { open: "no handler is attached here" }
    const e = unwrap(value)
    if (ts.isIdentifier(e)) {
      const info = chainHandler(chain, e.text)
      return info ? { info } : { open: `${e.text} is not defined in this file` }
    }
    if (isFn(e)) {
      const inline = analyzeFunction(sf, e)
      // `() => submit()`: the inline function only hands over to a handler this file defines.
      const delegate = inline.calls.map((c) => chainHandler(chain, c.name)).find((h) => h !== undefined)
      return { info: inline.setters.length === 0 && delegate ? delegate : inline }
    }
    if (ts.isCallExpression(e) && e.arguments[0])
      return resolveHandler(e.arguments[0] as ts.Expression, chain)
    return { open: `the handler comes from outside this file (${value.getText(sf).slice(0, 40)})` }
  }

  const setsAround = (info: FunctionInfo, state: { setter: string }): boolean => {
    if (info.awaitPos === undefined) return false
    const before = info.setters.some(
      (s) => s.setter === state.setter && s.arg === "true" && s.pos < (info.awaitPos as number)
    )
    const after = info.setters.some(
      (s) =>
        s.setter === state.setter && s.arg === "false" && (s.pos > (info.awaitPos as number) || s.inFinally)
    )
    return before && after
  }

  const sites: InteractionSite[] = []

  // ---------------------------------------------------------------- form submission
  for (const form of elements.filter((e) => e.attrs.has("onSubmit"))) {
    const chain = chainOf(form.node)
    const inside = below(form)
    const handler = resolveHandler(form.attrs.get("onSubmit"), chain)
    const info = handler.info
    const hiddenReason =
      hidden(chain, inside) ??
      (form.spread ? "props are spread onto the form and may carry more" : undefined) ??
      (form.attrs.has("action")
        ? "the form has an action, so a child may read its status with useFormStatus"
        : undefined)
    const states: Record<string, StateCheck> = {}

    const pend = candidates(chain, PENDING).filter(notCallback)
    const pendShown = pend.filter((c) => shown(chain, c.name))
    const flags = chainStates(chain).filter((st) => st.init === "false" || st.init === "other")
    const inferredFlag = info ? flags.find((st) => setsAround(info, st) && shown(chain, st.name)) : undefined

    {
      const check: StateCheck = { evidence: [] }
      if (pendShown[0]) {
        check.level = "structural"
        check.evidence.push(
          `${pendShown[0].name} (${pendShown[0].source === "hook" ? `from ${pendShown[0].hook}` : pendShown[0].source}) is read in the interface and is named like a pending flag`
        )
      }
      if (inferredFlag) {
        check.level = "static-inferred"
        check.evidence.push(
          `the submit handler (line ${info?.line}) sets ${inferredFlag.name} to true before its await and back to false after, and the interface reads it`
        )
      }
      if (!check.level) {
        const unused = pend.find((c) => c.source === "state")
        if (unused) check.absent = `${unused.name} exists but nothing in the interface reads it`
        else if (hiddenReason ?? handler.open)
          check.open = hiddenReason ?? `the submit handler cannot be read: ${handler.open}`
        else check.absent = "nothing shows that the form is submitting"
      }
      states.submitting = check
    }

    {
      const check: StateCheck = { evidence: [] }
      const errs = candidates(chain, ERROR).filter(notCallback)
      const errShown = errs.filter((c) => shown(chain, c.name))
      const alert = elements.find(
        (e) =>
          (e.attrs.get("role") === "alert" || e.attrs.has("aria-live")) &&
          enclosingFunctions(e.node)[0] === enclosingFunctions(form.node)[0]
      )
      if (errShown[0]) {
        check.level = "structural"
        check.evidence.push(`${errShown[0].name} is read in the interface and is named like an error`)
      } else if (alert) {
        check.level = "structural"
        check.evidence.push(
          `an element with ${alert.attrs.has("role") ? 'role="alert"' : "aria-live"} is on line ${alert.line}`
        )
      }
      const caught = info
        ? errs.find(
            (c) => c.setter !== undefined && info.setters.some((s) => s.setter === c.setter && s.inCatch)
          )
        : undefined
      if (caught && (errShown.length > 0 || alert)) {
        check.level = "static-inferred"
        check.evidence.push(
          `the submit handler sets ${caught.name} when it fails (catch, line ${info?.line})`
        )
      }
      if (!check.level) {
        if (hiddenReason ?? handler.open)
          check.open = hiddenReason ?? `the submit handler cannot be read: ${handler.open}`
        else
          check.absent =
            info && !info.hasCatch
              ? "the submit handler has no catch and nothing shows an error"
              : "nothing shows an error"
      }
      states.error = check
    }

    {
      const check: StateCheck = { evidence: [] }
      const succ = candidates(chain, SUCCESS).filter(notCallback)
      const succShown = succ.filter((c) => shown(chain, c.name))
      if (succShown[0]) {
        check.level = "structural"
        check.evidence.push(`${succShown[0].name} is read in the interface and is named like a success flag`)
      }
      const after = info?.awaitPos
      const feedback =
        info && after !== undefined
          ? info.calls.find((c) => c.pos > after && !c.inCatch && NAVIGATION_OR_FEEDBACK.test(c.name))
          : undefined
      const set =
        info && after !== undefined
          ? succShown.find(
              (c) =>
                c.setter !== undefined &&
                info.setters.some((s) => s.setter === c.setter && s.pos > after && !s.inCatch)
            )
          : undefined
      if (feedback) {
        check.level = "static-inferred"
        check.evidence.push(
          `the submit handler calls ${feedback.full} after its await (line ${feedback.line})`
        )
      } else if (set) {
        check.level = "static-inferred"
        check.evidence.push(`the submit handler sets ${set.name} after its await`)
      }
      if (!check.level) {
        if (hiddenReason ?? handler.open)
          check.open = hiddenReason ?? `the submit handler cannot be read: ${handler.open}`
        else check.absent = "nothing shows that the submission succeeded"
      }
      states.success = check
    }

    {
      const check: StateCheck = { evidence: [] }
      const names = new Set(pend.map((c) => c.name))
      const control = inside.find((e) =>
        ["disabled", "loading", "isLoading", "isDisabled"].some((a) =>
          attrIds(e, a).some((id) => names.has(id))
        )
      )
      if (control) {
        check.level = "structural"
        check.evidence.push(
          `${labelOf(control)} is disabled or loading while ${[...names].find((n) => attrIds(control, "disabled").concat(attrIds(control, "loading"), attrIds(control, "isLoading"), attrIds(control, "isDisabled")).includes(n))} is set`
        )
      }
      const guarded = info?.guards.find((g) => names.has(g))
      if (guarded) {
        check.level = "static-inferred"
        check.evidence.push(`the submit handler returns early when ${guarded} is set`)
      } else if (
        control &&
        inferredFlag &&
        attrIds(control, "disabled").concat(attrIds(control, "loading")).includes(inferredFlag.name)
      ) {
        check.level = "static-inferred"
        check.evidence.push(`${inferredFlag.name} is set by the handler around its await`)
      }
      if (!check.level) {
        if (hiddenReason ?? handler.open)
          check.open = hiddenReason ?? `the submit handler cannot be read: ${handler.open}`
        else check.absent = "nothing stops the form being submitted again while it is pending"
      }
      states.guarded = check
    }
    sites.push({
      workflow: "form-submission",
      line: form.line,
      column: form.column,
      label: `form ${labelOf(form)}`,
      states
    })
  }

  // ---------------------------------------------------------------- destructive confirmation
  const dialogs = elements.filter((e) => (isNative(e.tag) ? e.tag === "dialog" : DIALOG_TAG.test(e.tag)))
  const insideDialog = (el: El): boolean => dialogs.some((d) => within(d, el))
  for (const trigger of elements.filter(
    (e) => (e.attrs.has("onClick") || e.attrs.has("onPress")) && !insideDialog(e)
  )) {
    const chain = chainOf(trigger.node)
    const handler = resolveHandler(trigger.attrs.get("onClick") ?? trigger.attrs.get("onPress"), chain)
    const info = handler.info
    const deletes = info?.calls.filter((c) => isDeleteLike(c.name)) ?? []
    const labelled = /^(?:delete|remove|destroy|discard)\b/i.test(textOf(trigger))
    const named = info?.name !== undefined && isDeleteLike(info.name)
    if (!(deletes.length > 0 || named || labelled)) continue
    const states: Record<string, StateCheck> = {}
    let dialog: El | undefined
    let gate: { name: string; setter: string } | undefined
    const confirming: StateCheck = { evidence: [] }
    const cancellable: StateCheck = { evidence: [] }

    if (!info) {
      confirming.open = `the delete handler cannot be read (${handler.open}), so any confirmation may live in the caller`
      cancellable.open = confirming.open
    } else if (deletes.length > 0) {
      const first = deletes[0] as (typeof deletes)[number]
      const native = info.calls.find((c) => c.name === "confirm" && c.pos < first.pos)
      if (native) {
        confirming.level = "static-inferred"
        confirming.evidence.push(
          `the handler calls ${native.full} (line ${native.line}) before ${first.full}`
        )
        cancellable.level = "structural"
        cancellable.evidence.push(`${native.full} offers a cancel choice`)
      } else {
        confirming.absent = `the handler calls ${first.full} (line ${first.line}) directly, with no confirmation step`
        cancellable.absent = "there is no confirmation to cancel"
      }
    } else {
      const states_ = chainStates(chain)
      const opened = info.setters
        .filter((s) => s.arg === "true" || s.arg === "other")
        .map((s) => states_.find((st) => st.setter === s.setter))
        .filter((st): st is NonNullable<typeof st> => st !== undefined)
      for (const st of opened) {
        const found = dialogs.find(
          (d) =>
            [...d.attrs.keys()].some((k) => OPEN_ATTR.test(k) && attrIds(d, k).includes(st.name)) ||
            gatedBy(d, st.name)
        )
        if (found) {
          dialog = found
          gate = st
          break
        }
      }
      if (!dialog) {
        const reason = opened[0]
          ? `${opened[0].name} is set, but no dialog in this file reacts to it (it may be rendered elsewhere)`
          : "the handler neither deletes nor opens anything this file shows"
        confirming.open = reason
        cancellable.open = reason
      } else {
        const confirmEls = [dialog, ...below(dialog)]
        const confirmHandler = confirmEls
          .flatMap((e) =>
            [...e.attrs.entries()]
              .filter(([k]) => CONFIRM_ATTR.test(k) || k === "onClick")
              .map(([, v]) => resolveHandler(v, chainOf(e.node)).info)
          )
          .find((h) => h?.calls.some((c) => isDeleteLike(c.name)))
        confirming.level = confirmHandler ? "static-inferred" : "structural"
        confirming.evidence.push(
          `${labelOf(trigger)} opens ${labelOf(dialog)} through ${gate?.name}`,
          confirmHandler
            ? `the delete call (line ${confirmHandler.calls.find((c) => isDeleteLike(c.name))?.line}) is reached from the dialog's confirm action`
            : "the dialog's confirm action was not traced to the delete call"
        )
        const cancel = confirmEls.find(
          (e) => e.node !== dialog?.node && /^(?:cancel|no|keep|dismiss|close|back)\b/i.test(textOf(e))
        )
        const cancelAttr = [...dialog.attrs.entries()].find(([k]) => CANCEL_ATTR.test(k))
        if (cancel || cancelAttr) {
          cancellable.level = "structural"
          cancellable.evidence.push(
            cancel ? `${labelOf(cancel)} reads "${textOf(cancel)}"` : `the dialog has ${cancelAttr?.[0]}`
          )
          const closer = [cancel, dialog]
            .flatMap((e) =>
              e
                ? [...e.attrs.entries()]
                    .filter(([k]) => CANCEL_ATTR.test(k) || k === "onClick")
                    .map(([, v]) => resolveHandler(v, chainOf(e.node)).info)
                : []
            )
            .find((h) => h?.setters.some((s) => s.setter === gate?.setter && s.arg === "false"))
          if (closer) {
            cancellable.level = "static-inferred"
            cancellable.evidence.push(`cancelling sets ${gate?.name} back to false`)
          }
        } else cancellable.absent = "the dialog has no cancel button or close handler"
      }
    }
    states.confirming = confirming
    states.cancellable = cancellable
    sites.push({
      workflow: "destructive-confirmation",
      line: trigger.line,
      column: trigger.column,
      label: `destructive action ${labelOf(trigger)}`,
      states
    })
  }

  function gatedBy(dialog: El, name: string): boolean {
    for (let p: ts.Node | undefined = dialog.node.parent; p; p = p.parent) {
      if (ts.isJsxExpression(p) && p.expression && identifiersIn(p.expression).includes(name)) return true
      if (isFn(p) || ts.isFunctionDeclaration(p)) return false
    }
    return false
  }

  // ---------------------------------------------------------------- search and results
  for (const input of elements.filter(
    (e) =>
      (isNative(e.tag) && e.tag === "input" && e.attrs.get("type") === "search") ||
      SEARCH_TAG.test(e.tag) ||
      (isNative(e.tag) &&
        e.tag === "input" &&
        attrIds(e, "value").some((id) => /^(?:q|query|term|keyword|search\w*)$/i.test(id)))
  )) {
    const chain = chainOf(input.node)
    const top = enclosingFunctions(input.node)[enclosingFunctions(input.node).length - 1]
    const all = top
      ? elements.filter((e) => within({ ...input, node: top as never } as El, e) || e.node === input.node)
      : elements
    const stateList = chainStates(chain)
    const bound = attrIds(input, "value")
      .map((id) => stateList.find((s) => s.name === id))
      .find((s) => s !== undefined)
    const changeSetter = (() => {
      const c = input.attrs.get("onChange")
      if (!c || typeof c !== "object") return undefined
      const info = resolveHandler(c, chain).info
      return info?.setters[0]?.setter
    })()
    const query = bound ?? stateList.find((s) => s.setter === changeSetter)
    const states: Record<string, StateCheck> = {}
    const hiddenReason = hidden(chain, all)
    const effects = chain.scopes.flatMap((s) => [...s.effects, ...s.handlers.values()])

    {
      const check: StateCheck = { evidence: [] }
      if (query) {
        const feeding = referencesOutside(chain, query.name, input)
        const strong = feeding.find((r) => r.kind === "filter" || r.kind === "request")
        if (strong) {
          check.level = "static-inferred"
          check.evidence.push(
            `${query.name} feeds ${strong.kind === "filter" ? "a filter" : "a request"} (line ${strong.line})`
          )
        } else if (feeding[0]) {
          check.level = "structural"
          check.evidence.push(`${query.name} is also used at line ${feeding[0].line}`)
        }
      }
      if (!check.level) {
        if (!query) check.open = "the input is not tied to state this file can see"
        else if (hiddenReason) check.open = hiddenReason
        else check.absent = `${query.name} is set by the input but nothing else uses it`
      }
      states.connected = check
    }

    {
      const check: StateCheck = { evidence: [] }
      const loading = candidates(chain, LOADING).filter(notCallback)
      const loadShown = loading.filter((c) => shown(chain, c.name))
      if (loadShown[0]) {
        check.level = "structural"
        check.evidence.push(`${loadShown[0].name} is read in the interface and is named like a loading flag`)
      }
      const flag = stateList.find(
        (s) =>
          (s.init === "false" || s.init === "other") &&
          shown(chain, s.name) &&
          effects.some((f) => setsAround(f, s))
      )
      if (flag) {
        check.level = "static-inferred"
        check.evidence.push(
          `${flag.name} is set to true before an await and back to false after, and the interface reads it`
        )
      }
      if (!check.level) {
        if (hiddenReason) check.open = hiddenReason
        else check.absent = "nothing shows that results are loading"
      }
      states.loading = check
    }

    {
      const check: StateCheck = { evidence: [] }
      const derived = new Set<string>()
      if (query)
        for (const s of chain.scopes) {
          const body = (s.fn as ts.FunctionLikeDeclaration).body
          if (body && ts.isBlock(body))
            for (const stmt of body.statements)
              if (ts.isVariableStatement(stmt))
                for (const d of stmt.declarationList.declarations)
                  if (d.initializer && identifiersIn(d.initializer).includes(query.name))
                    for (const n of bindingNames(d.name)) derived.add(n)
        }
      const empties = emptinessChecks(top ?? sf)
      const text = jsxTextMatch(
        top ?? sf,
        /no (?:results|matches|items|data)|nothing (?:found|matches)|no .{0,20} found/i
      )
      const emptyEl = all.find((e) => /empty/i.test(e.tag))
      const fromQuery = empties.find((e) => derived.has(e.id))
      if (fromQuery) {
        check.level = "static-inferred"
        check.evidence.push(
          `${fromQuery.id}.length is checked in the interface, and ${fromQuery.id} is derived from ${query?.name} (line ${fromQuery.line})`
        )
      } else if (empties[0] || text || emptyEl) {
        check.level = "structural"
        check.evidence.push(
          empties[0]
            ? `${empties[0].id}.length is checked in the interface (line ${empties[0].line})`
            : text
              ? `the interface says "${text.text}" (line ${text.line})`
              : `${labelOf(emptyEl as El)} is rendered`
        )
      }
      if (!check.level) {
        if (hiddenReason) check.open = hiddenReason
        else check.absent = "nothing tells the user there are no results"
      }
      states.empty = check
    }

    {
      const check: StateCheck = { evidence: [] }
      const errs = candidates(chain, ERROR).filter(notCallback)
      const errShown = errs.filter((c) => shown(chain, c.name))
      if (errShown[0]) {
        check.level = "structural"
        check.evidence.push(`${errShown[0].name} is read in the interface and is named like an error`)
      }
      const caught = errShown.find(
        (c) =>
          c.setter !== undefined &&
          effects.some((f) => f.setters.some((s) => s.setter === c.setter && s.inCatch))
      )
      if (caught) {
        check.level = "static-inferred"
        check.evidence.push(`${caught.name} is set when the search fails (catch)`)
      }
      if (!check.level) {
        if (hiddenReason) check.open = hiddenReason
        else check.absent = "nothing shows that a search failed"
      }
      states.error = check
    }

    {
      const check: StateCheck = { evidence: [] }
      if (input.attrs.get("type") === "search") {
        check.level = "structural"
        check.evidence.push('the input has type="search", which browsers give a clear control')
      }
      if (input.attrs.has("onClear") || input.attrs.has("clearable")) {
        check.level = "structural"
        check.evidence.push(`${labelOf(input)} has ${input.attrs.has("onClear") ? "onClear" : "clearable"}`)
      }
      if (query) {
        const clears = (el: El): boolean =>
          ["onClick", "onPress", "onClear"].some((a) => {
            const h = el.attrs.get(a)
            return (
              h !== undefined &&
              resolveHandler(h, chainOf(el.node)).info?.setters.some(
                (s) => s.setter === query.setter && s.arg === "empty"
              ) === true
            )
          })
        const control = all.find(clears)
        if (control) {
          check.level = "static-inferred"
          check.evidence.push(`${labelOf(control)} sets ${query.name} to an empty string`)
        }
      }
      if (!check.level) {
        if (hiddenReason) check.open = hiddenReason
        else check.absent = "there is no way to clear the search"
      }
      states.clearable = check
    }
    sites.push({
      workflow: "search-results",
      line: input.line,
      column: input.column,
      label: `search ${labelOf(input)}`,
      states
    })
  }

  function referencesOutside(
    chain: Chain,
    name: string,
    site: El
  ): Array<{ kind: "filter" | "request" | "other"; line: number }> {
    const out: Array<{ kind: "filter" | "request" | "other"; line: number }> = []
    const start = site.node.getStart(sf)
    const end = site.node.getEnd()
    const root = chain.scopes[chain.scopes.length - 1]?.fn
    if (!root) return out
    const walk = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && n.text === name && !(n.getStart(sf) >= start && n.getEnd() <= end)) {
        const p = n.parent
        if (ts.isVariableDeclaration(p) || ts.isBindingElement(p) || ts.isArrayBindingPattern(p)) return
        out.push({ kind: classify(n), line: lineOf(sf, n) })
      }
      ts.forEachChild(n, walk)
    }
    walk(root)
    return out
  }

  function classify(id: ts.Identifier): "filter" | "request" | "other" {
    for (let p: ts.Node | undefined = id.parent; p; p = p.parent) {
      if (ts.isCallExpression(p)) {
        const callee = ts.isPropertyAccessExpression(p.expression)
          ? p.expression.name.text
          : ts.isIdentifier(p.expression)
            ? p.expression.text
            : ""
        if (/^(?:filter|find|some|every|includes|search)$/.test(callee)) return "filter"
        if (/^(?:fetch|get|post|search|query|load\w*|fetch\w*|request)$/i.test(callee)) return "request"
      }
      if (ts.isFunctionDeclaration(p)) break
    }
    return "other"
  }

  function emptinessChecks(root: ts.Node): Array<{ id: string; line: number }> {
    const out: Array<{ id: string; line: number }> = []
    const lengthOf = (e: ts.Node): string | undefined => {
      const x = unwrap(e)
      return ts.isPropertyAccessExpression(x) &&
        x.name.text === "length" &&
        ts.isIdentifier(unwrap(x.expression))
        ? (unwrap(x.expression) as ts.Identifier).text
        : undefined
    }
    const visit = (n: ts.Node, inJsx: boolean): void => {
      const now = inJsx || ts.isJsxExpression(n)
      if (now) {
        if (ts.isBinaryExpression(n)) {
          const l = lengthOf(n.left) ?? lengthOf(n.right)
          if (l) out.push({ id: l, line: lineOf(sf, n) })
        }
        if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken) {
          const l = lengthOf(n.operand)
          if (l) out.push({ id: l, line: lineOf(sf, n) })
        }
        if (ts.isConditionalExpression(n)) {
          const l = lengthOf(n.condition)
          if (l) out.push({ id: l, line: lineOf(sf, n) })
        }
      }
      ts.forEachChild(n, (c) => visit(c, now))
    }
    visit(root, false)
    return out
  }

  function jsxTextMatch(root: ts.Node, re: RegExp): { text: string; line: number } | undefined {
    let found: { text: string; line: number } | undefined
    const visit = (n: ts.Node): void => {
      if (found) return
      if (ts.isJsxText(n) && re.test(n.text)) found = { text: n.text.trim(), line: lineOf(sf, n) }
      if (ts.isStringLiteral(n) && ts.isJsxExpression(n.parent) && re.test(n.text))
        found = { text: n.text, line: lineOf(sf, n) }
      ts.forEachChild(n, visit)
    }
    visit(root)
    return found
  }

  return sites.sort((a, b) => a.line - b.line || a.column - b.column)
}
