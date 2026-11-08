import {
  declarationOf,
  resolveSymbol,
  topLevelAssignments,
  unwrap,
  walkSameFunction
} from "@invariant/compiler-core"
import ts from "typescript"

export type ComponentKind = "function" | "class" | "forwardRef" | "memo" | "lazy" | "styled"

export interface Candidate {
  /** Identity: the declaration node (function, class or variable declaration). */
  decl: ts.Node
  /** Local declaration name (`default` for an anonymous default export). */
  name: string
  kind: ComponentKind
  /** Outermost first, for example `["memo", "forwardRef"]`. */
  wrappers: string[]
  impl?: ts.FunctionLikeDeclaration | ts.ClassLikeDeclaration
  propsTypeNode?: ts.TypeNode
  refTypeText?: string
  styled?: { library: "styled-components" | "emotion" }
  /** Props cannot be determined from syntax (lazy, untyped, unknown wrapper). */
  propsUnknown: boolean
  /**
   * The component accepts more than its declared props (a polymorphic `component` prop, system props like `sx`, the root
   * element's attributes), so a prop it does not declare is not an error.
   */
  openProps?: boolean
  /** `Object.assign(Root, { Item })` and `Root.Item = Item` children. */
  subcomponents: Array<{ key: string; target: ts.Node }>
  /** Catalog name override, set for compound children (`Card.Header`). */
  displayName?: string
  /** Value of an explicit `X.displayName = "…"` assignment (a React DevTools label, not the catalog name). */
  reactDisplayName?: string
}

export interface HocFinding {
  hoc: true
  name: string
  node: ts.Node
}

/** Component types of other packages that declare components by wrapping a type map: see `declaredComponent`. */
const POLYMORPHIC_WRAPPERS = new Set(["OverridableComponent", "ExtendButtonBase"])
const PASCAL = /^[A-Z]/
const COMPONENT_BASES = new Set(["Component", "React.Component", "PureComponent", "React.PureComponent"])
const FC_TYPES = new Set([
  "FC",
  "React.FC",
  "FunctionComponent",
  "React.FunctionComponent",
  "VFC",
  "React.VFC"
])
/** Types a declaration file gives a component constant, and whether the first type argument is its props. */
const DECLARED_COMPONENT_TYPES: Record<string, { kind: "function" | "forwardRef" }> = {
  ForwardRefExoticComponent: { kind: "forwardRef" },
  ExoticComponent: { kind: "function" },
  NamedExoticComponent: { kind: "function" },
  ComponentType: { kind: "function" },
  ComponentClass: { kind: "function" },
  FC: { kind: "function" },
  FunctionComponent: { kind: "function" },
  VFC: { kind: "function" }
}
const REACT_PREFIX = String.raw`(?:React\.|import\(["']react["']\)\.)?`
const JSX_RETURN = new RegExp(
  `^(?:${REACT_PREFIX}JSX\\.Element|${REACT_PREFIX}ReactElement(?:<[\\s\\S]*>)?|${REACT_PREFIX}ReactNode)$`
)
const STYLED_MODULES: Record<string, "styled-components" | "emotion"> = {
  "styled-components": "styled-components",
  "@emotion/styled": "emotion"
}

/**
 * Decides whether a declaration is a React component using syntax only: a Pascal-case function (or
 * class extending Component/PureComponent) that returns JSX, optionally wrapped in forwardRef, memo or
 * lazy, a styled-components/emotion tagged template, or `Object.assign(Root, { Child })`. Anything
 * that returns a component (a higher-order component) is reported, not analyzed.
 */
export function classifyDeclaration(
  checker: ts.TypeChecker,
  decl: ts.Node,
  displayHint: string,
  depth = 0
): Candidate | HocFinding | undefined {
  if (depth > 6) return undefined
  if (ts.isFunctionDeclaration(decl)) {
    const name = decl.name?.text ?? displayHint
    if (isComponentFunction(decl, name))
      return finish(
        { decl, name, kind: "function", wrappers: [], impl: decl, propsUnknown: false, subcomponents: [] },
        decl
      )
    // `export declare function Card(props: P): JSX.Element`: a declaration file has no body to read JSX from.
    if (isDeclaredComponentFunction(decl, name))
      return finish(
        { decl, name, kind: "function", wrappers: [], impl: decl, propsUnknown: false, subcomponents: [] },
        decl
      )
    return returnsComponentFunction(decl) ? { hoc: true, name, node: decl } : undefined
  }
  if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
    const name = decl.name.text
    let fromInit = decl.initializer
      ? classifyExpression(checker, decl.initializer, { name, decl, depth })
      : undefined
    // A Pascal-case function declared as `React.FC<P>` is a component even when its return value is not literal JSX.
    const init = decl.initializer ? unwrap(decl.initializer) : undefined
    if (
      !fromInit &&
      PASCAL.test(name) &&
      fcTypeArgument(decl.type) &&
      init &&
      (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
    ) {
      fromInit = {
        decl,
        name,
        kind: "function",
        wrappers: [],
        impl: init,
        propsUnknown: false,
        subcomponents: []
      }
    }
    if (fromInit && "hoc" in fromInit) return fromInit
    if (fromInit) {
      const fcProps = fcTypeArgument(decl.type)
      if (fcProps && !fromInit.propsTypeNode) fromInit.propsTypeNode = fcProps
      return finish(fromInit, decl)
    }
    // `export declare const Button: ForwardRefExoticComponent<P & RefAttributes<T>>`
    const declared =
      !decl.initializer && decl.type ? declaredComponent(checker, decl.type, name, decl) : undefined
    return declared ? finish(declared, decl) : undefined
  }
  // A member of a declared compound object: `Item: (props: P) => JSX.Element`.
  if (ts.isPropertySignature(decl) && decl.type) {
    if (ts.isTypeQueryNode(decl.type)) {
      const query = decl.type.exprName
      const symbol = checker.getSymbolAtLocation(ts.isQualifiedName(query) ? query.right : query)
      const target = declarationOf(resolveSymbol(checker, symbol))
      return target && target !== decl
        ? classifyDeclaration(checker, target, displayHint, depth + 1)
        : undefined
    }
    return declaredComponent(checker, decl.type, displayHint, decl)
  }
  if (ts.isClassDeclaration(decl)) {
    const base = componentBase(decl)
    if (!base) return undefined
    const name = decl.name?.text ?? displayHint
    return finish(
      {
        decl,
        name,
        kind: "class",
        wrappers: [],
        impl: decl,
        ...(base.typeArguments?.[0] ? { propsTypeNode: base.typeArguments[0] } : {}),
        propsUnknown: !base.typeArguments?.[0],
        subcomponents: []
      },
      decl
    )
  }
  if (ts.isExportAssignment(decl) && !decl.isExportEquals) {
    const expression = unwrap(decl.expression)
    if (ts.isIdentifier(expression)) {
      // `export default Link`: the component is whatever `Link` declares, under its own name.
      const target = declarationOf(resolveSymbol(checker, checker.getSymbolAtLocation(expression)))
      return target && target !== decl
        ? classifyDeclaration(checker, target, expression.text, depth + 1)
        : undefined
    }
    return classifyExpression(checker, expression, { name: displayHint, decl, depth })
  }
  return undefined
}

function classifyExpression(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  ctx: { name: string; decl: ts.Node; depth: number }
): Candidate | HocFinding | undefined {
  const node = unwrap(expression)
  const { name, decl, depth } = ctx
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    if (isComponentFunction(node, name))
      return {
        decl,
        name,
        kind: "function",
        wrappers: [],
        impl: node,
        propsUnknown: false,
        subcomponents: []
      }
    return returnsComponentFunction(node) ? { hoc: true, name, node } : undefined
  }
  if (ts.isIdentifier(node)) {
    const target = declarationOf(resolveSymbol(checker, checker.getSymbolAtLocation(node)))
    if (!target || target === decl) return undefined
    const inner = classifyDeclaration(checker, target, name, depth + 1)
    return inner && !("hoc" in inner) ? { ...inner, decl, name } : inner
  }
  if (ts.isTaggedTemplateExpression(node)) {
    const library = styledLibrary(node.tag)
    if (!library) return undefined
    return {
      decl,
      name,
      kind: "styled",
      wrappers: [],
      styled: { library },
      ...(node.typeArguments?.[0] ? { propsTypeNode: node.typeArguments[0] } : {}),
      propsUnknown: !node.typeArguments?.[0],
      subcomponents: []
    }
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression.getText()
    const arg = node.arguments[0]
    if ((callee === "forwardRef" || callee === "React.forwardRef") && arg) {
      const inner = classifyExpression(checker, arg, { name, decl, depth: depth + 1 })
      const impl = inner && !("hoc" in inner) ? inner.impl : undefined
      const refType = node.typeArguments?.[0]
      return {
        decl,
        name,
        kind: "forwardRef",
        wrappers: ["forwardRef"],
        ...(impl ? { impl } : {}),
        ...(node.typeArguments?.[1] ? { propsTypeNode: node.typeArguments[1] } : {}),
        ...(refType ? { refTypeText: refType.getText() } : {}),
        propsUnknown: false,
        subcomponents: []
      }
    }
    if ((callee === "memo" || callee === "React.memo") && arg) {
      const inner = classifyExpression(checker, arg, { name, decl, depth: depth + 1 })
      if (!inner || "hoc" in inner) return inner
      return { ...inner, decl, kind: "memo", wrappers: ["memo", ...inner.wrappers] }
    }
    if ((callee === "lazy" || callee === "React.lazy") && arg) {
      return { decl, name, kind: "lazy", wrappers: ["lazy"], propsUnknown: true, subcomponents: [] }
    }
    if (callee === "Object.assign" && node.arguments.length >= 2) {
      const root = classifyExpression(checker, node.arguments[0] as ts.Expression, {
        name,
        decl,
        depth: depth + 1
      })
      if (!root || "hoc" in root) return root
      const extras = unwrap(node.arguments[1] as ts.Expression)
      const subcomponents: Candidate["subcomponents"] = []
      if (ts.isObjectLiteralExpression(extras)) {
        for (const property of extras.properties) {
          const key =
            property.name && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))
              ? property.name.text
              : undefined
          if (key && (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)))
            subcomponents.push({ key, target: property })
        }
      }
      return { ...root, decl, subcomponents: [...root.subcomponents, ...subcomponents] }
    }
  }
  return undefined
}

/**
 * A declaration file's compound object, `declare const Dialog: { Root: typeof DialogRoot; Title: typeof DialogTitle }`.
 * It is a namespace, not a component, so only its members are returned (named `Dialog.Root` by the caller).
 */
export function classifyCompound(
  checker: ts.TypeChecker,
  decl: ts.Node,
  name: string
): Array<{ key: string; candidate: Candidate }> | undefined {
  if (!ts.isVariableDeclaration(decl) || decl.initializer || !decl.type || !ts.isTypeLiteralNode(decl.type))
    return undefined
  if (!PASCAL.test(name)) return undefined
  const out: Array<{ key: string; candidate: Candidate }> = []
  for (const member of decl.type.members) {
    if (!ts.isPropertySignature(member) || !member.type) continue
    if (!member.name || !(ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name))) continue
    const key = member.name.text
    if (!PASCAL.test(key)) continue
    let candidate: Candidate | HocFinding | undefined
    if (ts.isTypeQueryNode(member.type)) {
      const query = member.type.exprName
      const symbol = checker.getSymbolAtLocation(ts.isQualifiedName(query) ? query.right : query)
      const target = declarationOf(resolveSymbol(checker, symbol))
      candidate = target ? classifyDeclaration(checker, target, key) : undefined
    } else candidate = declaredComponent(checker, member.type, key, member)
    if (candidate && !("hoc" in candidate)) out.push({ key, candidate })
  }
  return out.length > 0 ? out : undefined
}

function unparen(type: ts.TypeNode): ts.TypeNode {
  return ts.isParenthesizedTypeNode(type) ? unparen(type.type) : type
}

/** The name and type arguments of `Foo<P>`, `React.Foo<P>` and `import('react').Foo<P>`. */
function refInfo(type: ts.TypeNode): { name: string; typeArguments?: ts.NodeArray<ts.TypeNode> } | undefined {
  if (ts.isTypeReferenceNode(type)) {
    const n = type.typeName
    return {
      name: ts.isQualifiedName(n) ? n.right.text : n.text,
      ...(type.typeArguments ? { typeArguments: type.typeArguments } : {})
    }
  }
  if (ts.isImportTypeNode(type) && type.qualifier) {
    const q = type.qualifier
    return {
      name: ts.isQualifiedName(q) ? q.right.text : q.text,
      ...(type.typeArguments ? { typeArguments: type.typeArguments } : {})
    }
  }
  return undefined
}

function returnsJsxType(type: ts.TypeNode | undefined): boolean {
  if (!type) return false
  return JSX_RETURN.test(type.getText().replace(/\s*\|\s*(?:null|undefined)/g, ""))
}

function isDeclaredComponentFunction(fn: ts.FunctionDeclaration, name: string): boolean {
  return PASCAL.test(name) && !fn.body && fn.parameters.length <= 1 && returnsJsxType(fn.type)
}

/**
 * A component declared by its type in a declaration file, where there is no body to read JSX from:
 * `React.ForwardRefExoticComponent<P & RefAttributes<T>>`, `React.FC<P>`, an arrow type `(props: P) => JSX.Element`,
 * a callable object `{ (props: P): JSX.Element; Item: … }` (its Pascal-case members are subcomponents), or an alias of those.
 */
export function declaredComponent(
  checker: ts.TypeChecker,
  type: ts.TypeNode,
  name: string,
  decl: ts.Node,
  depth = 0
): Candidate | undefined {
  if (depth > 4 || !PASCAL.test(name)) return undefined
  const t = unparen(type)
  const make = (extra: Partial<Candidate>): Candidate => ({
    decl,
    name,
    kind: "function",
    wrappers: [],
    propsUnknown: false,
    subcomponents: [],
    ...extra
  })
  if (ts.isFunctionTypeNode(t)) {
    if (t.parameters.length > 1 || !returnsJsxType(t.type)) return undefined
    const props = t.parameters[0]?.type
    return make(props ? { propsTypeNode: props } : {})
  }
  if (ts.isTypeLiteralNode(t)) {
    const call = t.members.find(ts.isCallSignatureDeclaration)
    if (!call || call.parameters.length > 1 || !returnsJsxType(call.type)) return undefined
    const props = call.parameters[0]?.type
    const subcomponents: Candidate["subcomponents"] = []
    for (const member of t.members) {
      if (!ts.isPropertySignature(member) || !member.type || !member.name) continue
      if (!(ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name))) continue
      const key = member.name.text
      if (PASCAL.test(key) && declaredComponent(checker, member.type, key, member, depth + 1))
        subcomponents.push({ key, target: member })
    }
    return make({ ...(props ? { propsTypeNode: props } : {}), subcomponents })
  }
  // `NamedExoticComponent<P> & ThemeExtend<…>`: the component type is one member, the rest are static properties.
  if (ts.isIntersectionTypeNode(t)) {
    for (const member of t.types) {
      const found = declaredComponent(checker, member, name, decl, depth + 1)
      if (found) return found
    }
  }
  const ref = refInfo(t)
  if (!ref) return callableComponent(checker, t, make)
  // Checked first: the wrapper's own declaration is an alias whose first call signature (`href` required) is a trap.
  const polymorphic = POLYMORPHIC_WRAPPERS.has(ref.name)
  if (polymorphic) {
    // `OverridableComponent<ButtonTypeMap>`: the component's own props are the type map's `props`. Its call signatures
    // are no help: `ExtendButtonBase` lists an `href`-required overload first, and the `OverridableComponent` parameter
    // names the generic `M`. The wrapper also adds a `component` prop and system props, so the list is never closed.
    // Without a readable type map (it comes from a package that is not installed) there are no props to report.
    const typeMapProps = propsOfTypeMap(checker, ref.typeArguments?.[0])
    return make({ openProps: true, ...(typeMapProps ? { propsTypeNode: typeMapProps } : { propsUnknown: true }) })
  }
  const known = DECLARED_COMPONENT_TYPES[ref.name]
  const fromKnown = known ? knownComponent(known, ref.typeArguments, make) : undefined
  if (fromKnown) return fromKnown
  if (!known && (ts.isTypeReferenceNode(t) || (ts.isImportTypeNode(t) && t.qualifier))) {
    const reference = ts.isTypeReferenceNode(t) ? t.typeName : (t.qualifier as ts.EntityName)
    const target = declarationOf(resolveSymbol(checker, checker.getSymbolAtLocation(reference)))
    // `type TableSelectComponent = { (props: P): JSX.Element; Option: … }`
    if (target && ts.isTypeAliasDeclaration(target)) {
      const aliased = declaredComponent(checker, target.type, name, decl, depth + 1)
      // Mantine's `MantineComponent<{ props: AlertProps; … }>`: the alias's own props are `Payload['props']`, so read the
      // concrete type from the payload object at the use site.
      const payload = t.typeArguments?.[0]
      const payloadProps =
        payload && ts.isTypeLiteralNode(payload)
          ? payload.members.find(
              (m): m is ts.PropertySignature => ts.isPropertySignature(m) && m.name.getText() === "props"
            )?.type
          : undefined
      if (aliased && payloadProps) aliased.propsTypeNode = payloadProps
      if (aliased) return aliased
    }
    // `interface X extends React.ForwardRefExoticComponent<P> { Item: typeof Item }`
    if (target && ts.isInterfaceDeclaration(target)) {
      for (const heritage of target.heritageClauses ?? []) {
        if (heritage.token !== ts.SyntaxKind.ExtendsKeyword) continue
        for (const base of heritage.types) {
          const baseKnown = DECLARED_COMPONENT_TYPES[base.expression.getText().split(".").pop() ?? ""]
          const candidate = baseKnown ? knownComponent(baseKnown, base.typeArguments, make) : undefined
          if (!candidate) continue
          for (const member of target.members) {
            if (!ts.isPropertySignature(member) || !member.type || !member.name) continue
            if (!(ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name))) continue
            const key = member.name.text
            if (!PASCAL.test(key)) continue
            if (
              ts.isTypeQueryNode(member.type) ||
              declaredComponent(checker, member.type, key, member, depth + 1)
            )
              candidate.subcomponents.push({ key, target: member })
          }
          return candidate
        }
      }
    }
  }
  return callableComponent(checker, t, make)
}

/** The `props` member of a type map declared in the analyzed package (`interface ButtonTypeMap { props: P; … }`). */
function propsOfTypeMap(checker: ts.TypeChecker, arg: ts.TypeNode | undefined): ts.TypeNode | undefined {
  if (!arg || !ts.isTypeReferenceNode(arg)) return undefined
  const target = declarationOf(resolveSymbol(checker, checker.getSymbolAtLocation(arg.typeName)))
  // `type AccordionTypeMap<…> = ExtendPaperTypeMap<{ props: …; defaultComponent: … }>`: the map is the wrapper's argument.
  const literal = (t: ts.TypeNode | undefined): ts.TypeLiteralNode | undefined => {
    if (!t) return undefined
    if (ts.isTypeLiteralNode(t)) return t
    const first = ts.isTypeReferenceNode(t) ? t.typeArguments?.[0] : undefined
    return first && ts.isTypeLiteralNode(first) ? first : undefined
  }
  const members = target
    ? ts.isInterfaceDeclaration(target)
      ? target.members
      : ts.isTypeAliasDeclaration(target)
        ? literal(target.type)?.members
        : undefined
    : undefined
  const prop = members?.find((m): m is ts.PropertySignature => ts.isPropertySignature(m) && m.name.getText() === "props")
  return prop?.type
}

/**
 * A component whose declared type is not one of the known React component types but is still callable with props and
 * returns JSX: MUI's `OverridableComponent<M>` and `ExtendButtonBase<M>`, Mantine's `((props: P) => JSX.Element) & ThemeExtend<…>`.
 * The type checker finds the call signatures, so library-specific wrapper names need no list.
 */
function callableComponent(
  checker: ts.TypeChecker,
  node: ts.TypeNode,
  make: (extra: Partial<Candidate>) => Candidate
): Candidate | undefined {
  const signatures = checker.getSignaturesOfType(checker.getTypeFromTypeNode(node), ts.SignatureKind.Call)
  const jsx = signatures.filter((s) => s.parameters.length <= 1 && signatureReturnsJsx(checker, s))
  // An overload without type parameters has concrete props; generic ones are `component`-polymorphic variants.
  const sig = jsx.find((s) => !s.typeParameters?.length) ?? jsx[0]
  if (!sig) return undefined
  const param = sig.parameters[0]?.valueDeclaration
  const props = param && ts.isParameter(param) ? param.type : undefined
  return make(props ? { propsTypeNode: props } : {})
}

function signatureReturnsJsx(checker: ts.TypeChecker, sig: ts.Signature): boolean {
  const declared = sig.declaration?.type
  if (declared && ts.isTypeNode(declared)) return returnsJsxType(declared)
  return JSX_RETURN.test(checker.typeToString(sig.getReturnType()).replace(/\s*\|\s*(?:null|undefined)/g, ""))
}

/** A component typed as one of the React component types, with its props from the first type argument. */
function knownComponent(
  known: { kind: "function" | "forwardRef" },
  typeArguments: ts.NodeArray<ts.TypeNode> | undefined,
  make: (extra: Partial<Candidate>) => Candidate
): Candidate | undefined {
  const props = typeArguments?.[0]
  if (!props) return undefined
  // `P & RefAttributes<T>` is how forwardRef components declare their ref: it is not part of the props.
  let propsTypeNode: ts.TypeNode = props
  let refTypeText: string | undefined
  if (ts.isIntersectionTypeNode(props)) {
    const isRef = (n: ts.TypeNode): boolean => refInfo(n)?.name === "RefAttributes"
    const refs = props.types.filter(isRef)
    const rest = props.types.filter((n) => !isRef(n))
    if (refs.length === 1 && rest.length === 1) {
      propsTypeNode = rest[0] as ts.TypeNode
      refTypeText = refInfo(refs[0] as ts.TypeNode)?.typeArguments?.[0]?.getText()
    }
  }
  return make({
    kind: known.kind,
    wrappers: known.kind === "forwardRef" ? ["forwardRef"] : [],
    propsTypeNode,
    ...(refTypeText ? { refTypeText } : {})
  })
}

/** Adds `Root.displayName = "…"` and `Root.Item = Item` information found next to the declaration. */
function finish(candidate: Candidate, decl: ts.Node): Candidate {
  const assignments = topLevelAssignments(decl.getSourceFile())
  const display = assignments.get(`${candidate.name}.displayName`)
  if (display && ts.isStringLiteralLike(unwrap(display)))
    candidate.reactDisplayName = (unwrap(display) as ts.StringLiteralLike).text
  for (const [key, value] of assignments) {
    if (!key.startsWith(`${candidate.name}.`)) continue
    const member = key.slice(candidate.name.length + 1)
    if (member === "displayName" || member === "defaultProps" || !PASCAL.test(member)) continue
    candidate.subcomponents.push({ key: member, target: value })
  }
  return candidate
}

function isComponentFunction(fn: ts.FunctionLikeDeclaration, name: string): boolean {
  return PASCAL.test(name) && returnsJsx(fn)
}

export function returnsJsx(fn: ts.FunctionLikeDeclaration): boolean {
  if (!fn.body) return false
  if (!ts.isBlock(fn.body)) return yieldsJsx(fn.body)
  let found = false
  walkSameFunction(fn, (n) => {
    if (!found && ts.isReturnStatement(n) && n.expression && yieldsJsx(n.expression)) found = true
  })
  return found
}

function yieldsJsx(expression: ts.Expression): boolean {
  const node = unwrap(expression)
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return true
  if (ts.isConditionalExpression(node)) return yieldsJsx(node.whenTrue) || yieldsJsx(node.whenFalse)
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind
    if (
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return yieldsJsx(node.left) || yieldsJsx(node.right)
    }
  }
  if (ts.isCallExpression(node))
    return /(?:^|\.)(?:_?jsxs?|createElement|cloneElement|createPortal)$/.test(node.expression.getText())
  return false
}

function returnsComponentFunction(fn: ts.FunctionLikeDeclaration): boolean {
  if (!fn.body) return false
  const isInner = (e: ts.Expression): boolean => {
    const inner = unwrap(e)
    return (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) && returnsJsx(inner)
  }
  if (!ts.isBlock(fn.body)) return isInner(fn.body)
  let found = false
  walkSameFunction(fn, (n) => {
    if (!found && ts.isReturnStatement(n) && n.expression && isInner(n.expression)) found = true
  })
  return found
}

function componentBase(cls: ts.ClassDeclaration): ts.ExpressionWithTypeArguments | undefined {
  const extendsClause = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)
  const base = extendsClause?.types[0]
  return base && COMPONENT_BASES.has(base.expression.getText()) ? base : undefined
}

function fcTypeArgument(type: ts.TypeNode | undefined): ts.TypeNode | undefined {
  if (type && ts.isTypeReferenceNode(type) && FC_TYPES.has(type.typeName.getText()))
    return type.typeArguments?.[0]
  return undefined
}

function styledLibrary(tag: ts.Expression): "styled-components" | "emotion" | undefined {
  let root: ts.Expression = tag
  while (ts.isPropertyAccessExpression(root) || ts.isCallExpression(root))
    root = ts.isCallExpression(root) ? root.expression : root.expression
  if (!ts.isIdentifier(root)) return undefined
  for (const statement of root.getSourceFile().statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const library = STYLED_MODULES[statement.moduleSpecifier.text]
    const clause = statement.importClause
    if (!library || !clause) continue
    if (clause.name?.text === root.text) return library
    if (
      clause.namedBindings &&
      ts.isNamedImports(clause.namedBindings) &&
      clause.namedBindings.elements.some((e) => e.name.text === root.text)
    )
      return library
  }
  return undefined
}
