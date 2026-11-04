import ts from "typescript"

/*
 * Facts about React code that interaction checks rest on, read from the syntax of one file. Nothing is run and
 * nothing is imported. These are observations (a state variable exists, a handler sets it, JSX reads it); what
 * they mean for a workflow is decided in `interaction-workflows.ts`.
 */

export type ArgKind = "true" | "false" | "null" | "empty" | "other"

export interface SetterCall {
  setter: string
  arg: ArgKind
  /** Source position, for ordering against the first await. */
  pos: number
  line: number
  inCatch: boolean
  inFinally: boolean
}

export interface CallFact {
  /** The last name in the callee: `push` for `router.push(...)`, `confirm` for `window.confirm(...)`. */
  name: string
  /** The whole callee as written: `router.push`. */
  full: string
  pos: number
  line: number
  inCatch: boolean
}

export interface FunctionInfo {
  name?: string
  line: number
  /** Where the first await, `.then` or `.catch` is. Undefined for a function that does nothing asynchronous. */
  awaitPos?: number
  setters: SetterCall[]
  calls: CallFact[]
  /** Identifiers tested by an early `if (x) return`. */
  guards: string[]
  hasCatch: boolean
}

export interface StateVar {
  name: string
  setter: string
  init: ArgKind | "array" | "string" | "number"
  line: number
}

export interface Scope {
  fn: ts.Node
  parent: Scope | undefined
  params: Set<string>
  states: Map<string, StateVar>
  /** Names bound from any hook other than useState, with the hook's name. */
  hookNames: Map<string, string>
  /** Names bound to the whole result of a hook (`const m = useMutation()`). */
  hookObjects: Map<string, string>
  /** Custom hooks called here, whose results Invariant cannot see inside. */
  unknownHooks: string[]
  handlers: Map<string, FunctionInfo>
  /** Bodies of `useEffect` calls. */
  effects: FunctionInfo[]
  /** Identifiers (and `obj.prop` pairs) read inside the JSX of this function. */
  consumed: Set<string>
}

const KNOWN_HOOKS = new Set([
  "useState",
  "useReducer",
  "useEffect",
  "useLayoutEffect",
  "useRef",
  "useMemo",
  "useCallback",
  "useContext",
  "useId",
  "useTransition",
  "useDeferredValue",
  "useFormStatus",
  "useActionState",
  "useFormState",
  "useImperativeHandle",
  "useQuery",
  "useMutation",
  "useSWR",
  "useForm",
  "useNavigate",
  "useRouter"
])

export const lineOf = (sf: ts.SourceFile, node: ts.Node): number =>
  sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1

export const unwrap = (node: ts.Node): ts.Node => {
  let n = node
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isSatisfiesExpression(n)
  )
    n = n.expression
  return n
}

export function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  return name.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : bindingNames(el.name)))
}

const isFunction = (n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration =>
  ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)

export function argKind(node: ts.Expression | undefined): ArgKind {
  if (!node) return "other"
  const e = unwrap(node)
  if (e.kind === ts.SyntaxKind.TrueKeyword) return "true"
  if (e.kind === ts.SyntaxKind.FalseKeyword) return "false"
  if (e.kind === ts.SyntaxKind.NullKeyword) return "null"
  if (ts.isStringLiteralLike(e) && e.text === "") return "empty"
  return "other"
}

function calleeNames(e: ts.Expression): { name: string; full: string } | undefined {
  const c = unwrap(e)
  if (ts.isIdentifier(c)) return { name: c.text, full: c.text }
  if (ts.isPropertyAccessExpression(c)) {
    const inner = calleeNames(c.expression)
    return { name: c.name.text, full: `${inner?.full ?? "?"}.${c.name.text}` }
  }
  return undefined
}

/** What a function does, in the order it is written. Nested functions are read only as promise callbacks. */
export function analyzeFunction(sf: ts.SourceFile, fn: ts.Node, name?: string): FunctionInfo {
  const info: FunctionInfo = {
    ...(name ? { name } : {}),
    line: lineOf(sf, fn),
    setters: [],
    calls: [],
    guards: [],
    hasCatch: false
  }
  const body = (fn as ts.FunctionLikeDeclaration).body
  if (!body) return info
  const catchRanges: Array<[number, number]> = []
  const finallyRanges: Array<[number, number]> = []
  const within = (ranges: Array<[number, number]>, pos: number): boolean =>
    ranges.some(([a, b]) => pos >= a && pos < b)
  const markAwait = (pos: number): void => {
    if (info.awaitPos === undefined || pos < info.awaitPos) info.awaitPos = pos
  }

  // First pass: where the awaits, catches and finallys are, so the second pass can classify every call.
  const scan = (n: ts.Node, top: boolean): void => {
    if (!top && isFunction(n) && !isPromiseCallback(n)) return
    if (ts.isAwaitExpression(n)) markAwait(n.getStart(sf))
    if (ts.isTryStatement(n)) {
      if (n.catchClause) {
        info.hasCatch = true
        catchRanges.push([n.catchClause.getStart(sf), n.catchClause.getEnd()])
      }
      if (n.finallyBlock) finallyRanges.push([n.finallyBlock.getStart(sf), n.finallyBlock.getEnd()])
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const m = n.expression.name.text
      if (m === "then" || m === "catch" || m === "finally") {
        markAwait(n.expression.name.getStart(sf))
        if (m === "catch") {
          info.hasCatch = true
          for (const a of n.arguments) catchRanges.push([a.getStart(sf), a.getEnd()])
        }
        if (m === "finally") for (const a of n.arguments) finallyRanges.push([a.getStart(sf), a.getEnd()])
      }
    }
    ts.forEachChild(n, (c) => scan(c, false))
  }
  scan(body, true)

  const walk = (n: ts.Node, top: boolean): void => {
    if (!top && isFunction(n) && !isPromiseCallback(n)) return
    if (ts.isCallExpression(n)) {
      const callee = calleeNames(n.expression)
      if (callee) {
        const pos = n.getStart(sf)
        const inCatch = within(catchRanges, pos)
        if (/^set[A-Z0-9_]/.test(callee.name) && callee.name === callee.full)
          info.setters.push({
            setter: callee.name,
            arg: argKind(n.arguments[0]),
            pos,
            line: lineOf(sf, n),
            inCatch,
            inFinally: within(finallyRanges, pos)
          })
        else info.calls.push({ name: callee.name, full: callee.full, pos, line: lineOf(sf, n), inCatch })
      }
    }
    if (top && ts.isBlock(n))
      for (const stmt of n.statements) {
        // `if (x) return` near the top: a guard against running twice.
        if (ts.isIfStatement(stmt) && (isReturn(stmt.thenStatement) || returnsInBlock(stmt.thenStatement)))
          collectIdentifiers(stmt.expression, info.guards)
      }
    ts.forEachChild(n, (c) => walk(c, false))
  }
  walk(body, true)
  return info
}

function isReturn(n: ts.Statement): boolean {
  return ts.isReturnStatement(n)
}
function returnsInBlock(n: ts.Statement): boolean {
  return (
    ts.isBlock(n) &&
    n.statements.length > 0 &&
    n.statements.every((s) => ts.isReturnStatement(s) || ts.isExpressionStatement(s)) &&
    n.statements.some((s) => ts.isReturnStatement(s))
  )
}

function collectIdentifiers(n: ts.Node, into: string[]): void {
  if (ts.isIdentifier(n)) into.push(n.text)
  ts.forEachChild(n, (c) => collectIdentifiers(c, into))
}

/** An arrow or function passed to `.then`, `.catch` or `.finally` is part of the same flow as its caller. */
function isPromiseCallback(n: ts.Node): boolean {
  const p = n.parent
  return (
    p !== undefined &&
    ts.isCallExpression(p) &&
    ts.isPropertyAccessExpression(p.expression) &&
    ["then", "catch", "finally"].includes(p.expression.name.text)
  )
}

/** Identifiers, and `obj.prop` pairs, read in the JSX of a subtree. */
export function consumedIn(root: ts.Node): Set<string> {
  const out = new Set<string>()
  const collect = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) out.add(n.text)
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression))
      out.add(`${n.expression.text}.${n.name.text}`)
    ts.forEachChild(n, collect)
  }
  const visit = (n: ts.Node): void => {
    if (ts.isJsxExpression(n) || ts.isJsxAttribute(n) || ts.isJsxSpreadAttribute(n)) collect(n)
    else ts.forEachChild(n, visit)
  }
  visit(root)
  return out
}

export function enclosingFunctions(node: ts.Node): ts.Node[] {
  const out: ts.Node[] = []
  for (let p = node.parent; p; p = p.parent) if (isFunction(p) || ts.isMethodDeclaration(p)) out.push(p)
  return out
}

/** Reads the declarations of one function: state, hook results, handlers, effects and parameters. */
export function buildScope(sf: ts.SourceFile, fn: ts.Node, parent: Scope | undefined): Scope {
  const scope: Scope = {
    fn,
    parent,
    params: new Set(),
    states: new Map(),
    hookNames: new Map(),
    hookObjects: new Map(),
    unknownHooks: [],
    handlers: new Map(),
    effects: [],
    consumed: consumedIn(fn)
  }
  const f = fn as ts.FunctionLikeDeclaration
  for (const p of f.parameters ?? []) for (const n of bindingNames(p.name)) scope.params.add(n)
  const body = f.body
  if (!body || !ts.isBlock(body)) return scope
  for (const stmt of body.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name)
      scope.handlers.set(stmt.name.text, analyzeFunction(sf, stmt, stmt.name.text))
    if (ts.isExpressionStatement(stmt) && ts.isCallExpression(unwrap(stmt.expression))) {
      const call = unwrap(stmt.expression) as ts.CallExpression
      if (
        ts.isIdentifier(call.expression) &&
        (call.expression.text === "useEffect" || call.expression.text === "useLayoutEffect")
      ) {
        const cb = call.arguments[0]
        if (cb && isFunction(cb)) {
          scope.effects.push(analyzeFunction(sf, cb))
          // An effect usually declares the async function it then calls; read those too.
          const inner = cb.body
          if (inner && ts.isBlock(inner))
            for (const s of inner.statements) {
              if (ts.isFunctionDeclaration(s)) scope.effects.push(analyzeFunction(sf, s, s.name?.text))
              if (ts.isVariableStatement(s))
                for (const d of s.declarationList.declarations) {
                  const init = d.initializer && unwrap(d.initializer)
                  if (init && isFunction(init)) scope.effects.push(analyzeFunction(sf, init))
                }
            }
        }
      }
    }
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      const init = decl.initializer ? unwrap(decl.initializer) : undefined
      if (!init) continue
      if (isFunction(init) && ts.isIdentifier(decl.name)) {
        scope.handlers.set(decl.name.text, analyzeFunction(sf, init, decl.name.text))
        continue
      }
      if (!ts.isCallExpression(init) || !ts.isIdentifier(init.expression)) continue
      const hook = init.expression.text
      if (hook === "useCallback" && ts.isIdentifier(decl.name)) {
        const cb = init.arguments[0] && unwrap(init.arguments[0])
        if (cb && isFunction(cb)) scope.handlers.set(decl.name.text, analyzeFunction(sf, cb, decl.name.text))
        continue
      }
      if (hook === "useState" && ts.isArrayBindingPattern(decl.name)) {
        const [a, b] = decl.name.elements
        if (
          a &&
          b &&
          !ts.isOmittedExpression(a) &&
          !ts.isOmittedExpression(b) &&
          ts.isIdentifier(a.name) &&
          ts.isIdentifier(b.name)
        ) {
          const arg = init.arguments[0] && unwrap(init.arguments[0])
          const kind = argKind(init.arguments[0])
          scope.states.set(a.name.text, {
            name: a.name.text,
            setter: b.name.text,
            init:
              kind !== "other"
                ? kind
                : arg && ts.isArrayLiteralExpression(arg)
                  ? "array"
                  : arg && ts.isStringLiteralLike(arg)
                    ? "string"
                    : arg && ts.isNumericLiteral(arg)
                      ? "number"
                      : "other",
            line: lineOf(sf, decl)
          })
        }
        continue
      }
      if (/^use[A-Z]/.test(hook)) {
        for (const n of bindingNames(decl.name)) {
          scope.hookNames.set(n, hook)
          if (ts.isIdentifier(decl.name)) scope.hookObjects.set(n, hook)
        }
        if (!KNOWN_HOOKS.has(hook)) scope.unknownHooks.push(hook)
      }
    }
  }
  return scope
}

export interface Chain {
  scopes: Scope[]
}

export const chainStates = (c: Chain): StateVar[] => c.scopes.flatMap((s) => [...s.states.values()])
export const chainConsumed = (c: Chain): Set<string> => new Set(c.scopes.flatMap((s) => [...s.consumed]))
export const chainHandler = (c: Chain, name: string): FunctionInfo | undefined => {
  for (const s of c.scopes) {
    const h = s.handlers.get(name)
    if (h) return h
  }
  return undefined
}
export const chainUnknownHooks = (c: Chain): string[] => c.scopes.flatMap((s) => s.unknownHooks)

export interface Candidate {
  /** The name as read in JSX: `isSubmitting`, or `m.isPending` for a property of a hook's result. */
  name: string
  source: "state" | "hook" | "prop"
  /** The state setter, when the candidate is `useState` state this file can see being set. */
  setter?: string
  hook?: string
}

/**
 * Names in scope that look like a given kind of flag, by name: state, values a hook returns, props, and
 * properties read off a hook's result. This is a naming heuristic, and the evidence says so.
 */
export function candidates(c: Chain, test: RegExp): Candidate[] {
  const out: Candidate[] = []
  for (const s of c.scopes) {
    for (const st of s.states.values())
      if (test.test(st.name)) out.push({ name: st.name, source: "state", setter: st.setter })
    for (const [n, hook] of s.hookNames) if (test.test(n)) out.push({ name: n, source: "hook", hook })
    for (const p of s.params) if (test.test(p)) out.push({ name: p, source: "prop" })
    for (const [obj, hook] of s.hookObjects)
      for (const used of s.consumed) {
        const m = new RegExp(`^${obj}\\.(.+)$`).exec(used)
        if (m && test.test(m[1] as string)) out.push({ name: used, source: "hook", hook })
      }
  }
  return [...new Map(out.map((x) => [x.name, x])).values()]
}

/** True when a name is read in the JSX of this component, directly or as a property of a hook's result. */
export const shown = (c: Chain, name: string): boolean => chainConsumed(c).has(name)

export const isDeleteLike = (name: string): boolean =>
  /(?:^|[^a-z])(delete|remove|destroy|discard|erase|purge)|(?:Delete|Remove|Destroy|Discard|Erase|Purge)/.test(
    name
  )
