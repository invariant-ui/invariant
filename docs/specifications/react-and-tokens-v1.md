# React compiler and token extraction (v1)

Status: implemented in `packages/compiler-react` and `packages/compiler-tokens` (plan Phase 3). Output is IR 1.1.0; no contract is generated yet.

## Safety and inputs

- Analysis reads project files through `ReadonlyFs` and never executes, imports, or builds customer code. A test confirms a file containing top-level `throw` and `process.exit` is analyzed without effect.
- The React adapter type-checks a program made only of the package's own files (virtual root, `moduleResolution: Bundler`, `lib.es2022` from TypeScript's own install so `Omit`, `Pick`, and `Partial` resolve). `node_modules`, including `@types/react`, is not loaded. References to third-party types therefore stay unresolved and are reported as inherited, never guessed.
- Tests, specs, and stories (`*.test.*`, `*.spec.*`, `*.stories.*`, `__tests__`, `__mocks__`) are excluded from analysis and from usage counts. Stories belong to the Storybook phase.
- One source per package that declares React (`dependencies`, `peerDependencies`, `devDependencies`, or `optionalDependencies`). A parent package does not include the files of nested workspace packages.

## What counts as a component

Only components exported from a package's entry points (the public API, resolved by discovery) are reported. Aliases, renames, `export *`, default exports, and barrels are followed with the type checker, so one component exported under several names is one entity listing all of them.

A declaration is a component when, using syntax only:

| Form | Rule |
|---|---|
| Function, arrow, function expression | Pascal-case name and returns JSX (through conditionals, `&&`/`\|\|`/`??`, parentheses, `createElement`, `jsx`, `cloneElement`, or `createPortal`) |
| Annotated function | Pascal-case function declared `React.FC<P>`, `FunctionComponent<P>`, or `VFC<P>`, even if its return is not literal JSX |
| Class | Extends `Component` or `PureComponent` (with or without `React.`) |
| Wrappers | `forwardRef(...)`, `memo(...)` (nesting allowed, outermost recorded as `kind`), `lazy(...)` (props unknown) |
| CSS-in-JS | A tagged template from `styled-components` or `@emotion/styled` (library confirmed from the file's imports) |
| Compound | `Object.assign(Root, { Child })` and `Root.Child = Child`; each child is its own component named `Root.Child` |

Not components: hooks, lowercase functions, functions without JSX, constants, classes that do not extend a React base. Reported but not analyzed: higher-order components (`react.higher-order-component`) and Pascal-case exports created by an unrecognized call such as `createSlot()` (`react.unclassified-export`). A recognized-but-unknowable component (`lazy`, untyped props) is emitted with `propsComplete: false`.

## Facts emitted per component

Fact paths follow the contract's grammar. Prose from JSDoc is `authored` (becomes `documented`); everything derived from syntax or types is `extracted` (becomes `discovered`).

| Path | Source | Notes |
|---|---|---|
| `name` | declaration name | Catalog name. An explicit `X.displayName` is a DevTools label and is kept separately. Compound children are `Root.Child`. |
| `description`, `lifecycle`, `deprecated`, `examples.example-N.{language,code}` | JSDoc (authored) | `@deprecated` on a component sets `lifecycle: deprecated`. |
| `implementations.react.{framework,packageName,exportName,importPath}` | manifest, entry point | `importPath` is the package name plus the subpath when the primary export is not from `.`. |
| `implementations.react.extensions.react.*` | syntax | `kind` (function, class, forwardRef, memo, lazy, styled), `wrappers`, `forwardRef`, `memo`, `refType`, `displayName`, `exports` (every subpath/name), `file`, `localName`, `generics`, `inheritedPropsFrom`, `propsComplete`, `styledLibrary`, `compoundParent`. `file` and `localName` are the neutral link key other sources use to find this component (Storybook links stories this way); display names are never used for linking. |
| `props.<name>.type.{text,kind}`, `.required`, `.default`, `.allowedValues` | type checker, declaration | `kind` is `string`, `number`, `boolean`, `enum`, `function`, `component` (renderable), `object`, `array`, `union`, or `unknown`. `allowedValues` keep declaration order, including through aliases. |
| `props.<name>.description`, `.deprecated` | JSDoc (authored) | |
| `props.<name>.extensions.react.{role,inheritedFrom,defaultExpression}` | syntax | `role`: prop, children, event-handler, slot, render-prop, ref. `inheritedFrom` is the local interface that declares the prop. A default that is not a plain literal is kept as source text, never as a value. |
| `variants.<name>.{values,default}` | props and `cva` | A prop that is a union of two or more string literals, plus `cva` configs (`variants` and `defaultVariants`) whose function the component calls. `extensions.react.source` says which. |
| `slots.<name>.{required}` | props | `children` is `default`; a renderable-typed prop is a named slot; a function prop returning renderable output is a render-prop slot. |
| `accessibility.{role,attributes}` | JSX | Static `role="…"` (only when exactly one) and every `aria-*` attribute on intrinsic (lowercase) elements in the component's own body. |
| `styling.cssModules`, `.cssVariables`, `.classNames`, `.tailwind`, `.libraries` | imports, source | CSS-module files the component actually uses, `var(--x)` references in those files and in the component source, literal `className` tokens (including through `cn`/`clsx`/`classNames`/`cx`/`twMerge`, conditionals, and templates), and CSS-in-JS libraries. `tailwind` is only asserted when the package depends on `tailwindcss` or has a Tailwind config, and only alongside class names. References are recorded as written, never resolved to tokens. |
| `composition.renders` | JSX | Which public components this one renders, with site counts. `composition.subcomponents` for compound roots. |
| `usage.sites`, `usage.props.<name>.{count,observedValues,dynamicCount,declared}`, `usage.undeclaredProps`, `usage.combinations` | JSX sites | Static counts across the package, never runtime frequency. Non-literal values (including arrays and objects) are `dynamicCount`, not guessed. Observed values are bounded (20). `usage.undeclaredProps` is only produced when the props set is closed and the site has no spread. `declared: false` is not claimed when the props set is open. |

Event handlers such as `onPress` stay props (`role: event-handler`). Mapping them to neutral `events` is a reconciliation concern for a later phase, because Vue emits and Angular outputs are not props.

### Completeness

`propsComplete` is false when the props type cannot be fully enumerated: a base type from outside the project (`React.ButtonHTMLAttributes<…>`, `VariantProps<typeof x>`), an unresolved type, `lazy`, an untyped parameter, or a prop name that cannot be addressed by a fact path (for example `$transient`, which gets `react.unsupported-prop-name`). The IR document is `partial` when any component is partial. Consumers must treat an absent prop as unknown unless `propsComplete` is true.

## Token extraction (`@invariant/compiler-tokens`)

Source type `tokens`, adapter id `design-tokens`, one source per package that has extractable token files. It lives in its own package because tokens are not React-specific.

- **CSS custom properties.** Each declaration yields name, raw value, and line. Scope is classified conservatively: `:root`/`html`/`:host`/`body` is the default; `[data-theme="x"]` (also `data-mode`, `data-color-scheme`, `data-color-mode`), `.dark`, `.light`, and `.theme-x` are theme modes; `@media (prefers-color-scheme: dark|light)` around a root selector is a theme mode. Anything else is component-private (`scopeKind: other`) and gets no value or mode fact. Default values are `value.value` (or `value.aliasOf` for a pure `var(--y)`), theme values are `modes.<mode>.value`/`.aliasOf`. Per-scope detail (`rawValue`, `valueKind`) lives under the scope it describes, so a root and a dark definition never contradict each other; two definitions in the same scope with different values surface as `ir.conflicting-facts`.
- **JSON.** W3C-Design-Tokens-shaped files (`$value`, group-inherited `$type`, `{path}` aliases, `$description`, `$deprecated`) and Style Dictionary-shaped files (`value`, `type`, `comment`). Composite values are kept as JSON. Evidence carries the line of each token's key (a small position-tracking JSON parser provides it).
- **Not decided here:** token category, semantic name, and the mapping between a CSS variable name and a JSON token name. `value.aliasOf` is the referenced token's source-local name; resolving it to an id is reconciliation. `extensions.css.valueKind` is a syntactic description (color, length, time, number, reference, expression, url, string, other), not design intent.

## Evidence

Every fact cites at least one evidence entry with a project-relative file and line, an extraction method (`compiler-api` for checker-derived facts, `ast` for syntax, `structured-parse` for CSS and JSON), and a bounded excerpt of the source line. Usage facts cite up to five sample sites.

## Validation on a real library

Run on Radix Primitives (70 packages, 155 Markdown files, 52 tokens): 227 components found in about 2.4 seconds, 108 with at least one own prop, 23 with variants, and 190 flagged `propsComplete: false` because they inherit `ComponentPropsWithoutRef<typeof Primitive.x>`. Diagnostics: 1 warning (a dynamic Storybook setting) and 29 informational (21 packages without components, 5 factory-made exports, 3 wildcard subpaths). This run is not part of the test suite (it needs a network clone); it found and fixed two false negatives (`React.FC` components returning `cloneElement`, and annotated components with non-JSX returns).

## Known limitations

- **Third-party types are not loaded.** Props inherited from library types (HTML attributes, other design systems, `VariantProps`) are listed as inherited, not enumerated. A future type-aware mode that reads installed `.d.ts` files read-only would make most real libraries' props complete; it needs its own decision because it reads `node_modules`.
- Components created by factory functions or computed at runtime (`createSlot`, `Primitive.div` maps) are reported, not extracted.
- Higher-order components are reported, not analyzed.
- `tsconfig` `paths`, `baseUrl`, and `extends` are not applied; cross-package imports resolve only if both packages' files are in the same analysis (they are not: one program per package), so usage and composition are intra-package.
- Variant detection treats any two-or-more string-literal union prop as a variant (including polymorphic `as` props); `extensions.react.source` marks the origin so consumers can filter. `cva` `compoundVariants` are ignored.
- Accessibility facts reflect only static attributes on intrinsic elements in the component's own body, not attributes forwarded to child components or computed values.
- JSX in non-component code and in unexported internal components is counted for usage only when it targets a public component; internal components are not entities.

## Contract gap (open decision U17)

Contract v1 has no domain for `styling.*`, `usage.*`, or `composition.renders`. The IR carries them under neutral paths because they apply to every framework. Before contract generation (plan Phase 7) the contract needs an additive 1.1 change (token and style references, observed usage, render relationships), or the compiler must store them under `extensions`. See the ADR.
