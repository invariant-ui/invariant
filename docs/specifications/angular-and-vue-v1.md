# Angular and Vue compilers (v1)

Status: implemented in `packages/compiler-angular` and `packages/compiler-vue` (plan Phase 6). Output is IR 1.3.0; no contract is generated yet.

**Verification status.** Fixture-based and unit tests pass (323 tests across the workspace). The cross-framework fixture lives in `fixtures/cross-framework/demo`, apart from its golden artifacts. Both adapters were also run on real third-party libraries (read-only, static analysis only):

- **reka-ui (Vue):** 395 components. 19 are marked `propsComplete: false`, all generic components whose type parameters the adapter does not resolve. Before `.vue` module resolution and tsconfig `paths` support, 372 were incomplete.
- **ng-bootstrap (Angular):** 52 components and 20 NgModules, including ng-packagr secondary entry points. Many input types and defaults are `unknown`, mainly defaults set through `inject()`, because third-party types are not loaded (about 108 of 177 props).

These runs found real defects (type casts dropped from `PropType`, control-flow conditions swallowing template elements, undiscovered ng-packagr entries, unresolved cross-SFC types). Other libraries may still expose more.

## What was verified against official documentation

Checked on 2026-10-31.

**Angular (angular.dev).**

- Decorator inputs: `@Input({ required, alias, transform })`; the alias may be given as the first argument instead of the config object. Signal inputs: `input(defaultValue, { alias, transform })`, `input.required<T>()`. Without a default, `input<T>()` is `InputSignal<T | undefined>`.
- `model()` creates an input and an output named the input name plus `Change`. Model inputs can be required or aliased; they do not support transforms.
- Outputs: `output<T>()` (with `{ alias }`), `@Output('alias') x = new EventEmitter<T>()`, and an `outputs` array in `@Component`. `output()` is only valid in component and directive property initializers. `outputFromObservable` is not described on that page.
- The `@Component`/`@Directive` `inputs` array accepts `'name: alias'` entries.
- Content projection: `<ng-content select>` supports the same CSS selectors as component selectors; an `ng-content` without `select` is the catch-all; `ngProjectAs` takes static values only.
- `@Component` options include `selector`, `standalone`, `imports`, `template`, `templateUrl`, `styles`, `styleUrl`, `styleUrls`, `host`, `changeDetection`, `encapsulation`, `hostDirectives`, `exportAs`. **The documentation page does not state the default of `standalone`**, so the adapter records `standalone` only when it is written in the decorator.

**Vue (vuejs.org).**

- `<script setup>` macros: `defineProps` (runtime declaration or a type argument; mutually exclusive with each other), `withDefaults` for type-based defaults (3.4 and below), reactive props destructure with native defaults (3.5+), `defineEmits` (call-signature and, from 3.3, named-tuple type forms, or a runtime array or object), `defineSlots` (3.3+), `defineModel` (3.4+: the first string argument is the prop name, otherwise `modelValue`; emits `update:<name>`), `defineExpose`, `defineOptions` (3.3+).
- A `<slot>` without `name` is the slot named `default`; `name` may be dynamic; `name` is reserved and not part of slot props.
- An SFC has at most one `<script>` and one `<script setup>`; the SFC page does not say whether both may coexist, so both are read without asserting a rule. Blocks may load content with `src`, which is not read.
- `@vue/compiler-sfc` 3.5.44 (MIT, no install scripts) is the official SFC parser; its template AST carries file-relative line numbers.

## Decisions

- **Vue: the official SFC parser plus the TypeScript API, not `vue-component-meta`.** This deviates from the earlier note in ADR D6. `vue-component-meta` needs a real `tsconfig` and installed `vue` types, which contradicts the project-files-only, read-only analysis used everywhere else. Instead each SFC's script becomes a virtual TypeScript module (a normal `<script>` and a `<script setup>` are joined, as Vue combines them) and the macros are read from its syntax tree with type resolution through the checker. Line numbers map back to the `.vue` file.
- **Angular: static decorator metadata via the TypeScript API, and a small template scanner.** `@angular/compiler` is not used: it is heavy and is not a stable tooling surface. Decorator arguments are read the way the compiler reads them (statically). The scanner handles only what is needed: element start tags and attributes, `<ng-content>`, static `role` and `aria-*`, and selector matching. It skips comments, `{{ }}` interpolations and the conditions of `@if`/`@for`/`@switch`/`@case`/`@defer`, and does not build a DOM or evaluate expressions.
- **One neutral fact writer.** `ComponentFacts` in `compiler-core` writes `props.*`, `events.*`, `slots.*`, `variants.*`, `accessibility.*`, the link key and extensions, so the new adapters cannot drift from each other. (The React adapter keeps its own emitter; a cross-framework test enforces the same paths.)
- **IR 1.3.0** adds the entity kind `module` for Angular NgModules.
- **Discovery learns ng-packagr entries.** A library's source `package.json` usually declares no entry; the entry is `lib.entryFile` in `ng-package.json`, or by convention `src/public-api.ts` (also `public_api.ts`). Without one of these, no entry is guessed (a bare `src/index.ts` is not used).

## Module resolution

Each adapter reads the package's `tsconfig*.json` files (following `extends` and `references`, resolving `compilerOptions.paths` against `baseUrl` or the config directory) through `tsconfigPaths` in `compiler-core`, so `@/…` style imports resolve to project files. Package-name `extends` is not followed. Vue additionally maps `.vue` imports to virtual script modules so props types declared in another SFC resolve. Angular adds a self-entry path for ng-packagr secondary entry points. React and Storybook use the same `paths` support.

## Components

**Vue.** Public components are what the entry points export: `.vue` files re-exported by name or as default (including through barrels and `import X from "./X.vue"; export { X }`), and `defineComponent(...)` declarations in TypeScript. Internal SFCs are not entities. Link key: `implementations.vue.extensions.vue.{file, localName}` with `localName` the PascalCase file name (`button-group.vue` is `ButtonGroup`). Storybook links a story's `./X.vue` import with the same pair.

**Angular.** Public components and directives are the decorated classes the entry points export (`@Component`, `@Directive`, including aliased and namespace imports of `@angular/core`; look-alike decorators from other packages are ignored). Directives are entities with `extensions.angular.kind: directive`. Link key: `{file, localName}` with `localName` the class name. Every `@NgModule` in the package is an entity of kind `module`.

## Facts

Neutral paths are identical to React's. Framework detail is only under `implementations.<fw>.extensions.<fw>` or `<member>.extensions.<fw>`. Prose a person wrote (JSDoc, Vue prop JSDoc) is `authored`; everything else is `extracted`.

| Path | Vue source | Angular source |
|---|---|---|
| `props.<name>.type.{text,kind}`, `.required`, `.default`, `.allowedValues` | `defineProps<T>()` types; runtime objects (`type: String as PropType<…>`, `required`, `default`); array props; `defineModel`; Options API `props` | `@Input` (alias, `required`, `transform`, setters, inferred literal types); `input()`, `input.required()`, `model()`; `inputs` metadata entries |
| `events.<name>.payload.text` | `defineEmits` (call signature, named tuple, runtime array/object); `defineModel` (`update:<name>`) | `output()`, `@Output` with `EventEmitter<T>`, `model()` (`<name>Change`), `outputs` metadata |
| `slots.<name>.declared` | `defineSlots` merged with template `<slot>` outlets; scoped slot props in `extensions.vue.props` and `propNames` | `<ng-content>`: `default`, or a name from `select` (`[slot=icon]`, `[icon]`, `.icon` and `icon` all give `icon`; anything else is sanitized; the raw selector is `extensions.angular.select`) |
| `variants.<name>.{values,default}` | string-literal union props | string-literal union inputs |
| `accessibility.{role,attributes}` | static `role` and `aria-*` (including bound) on native template elements | the same, on native elements in the template (inline or file) |
| `styling.*` | `cssVariables` (with file lines), `scoped`, `cssModules`, `preprocessors` | `cssVariables` (with lines in the style file), `cssFiles`, `preprocessors` |
| `composition.renders` | template tags resolved through the script's imports to other public components (PascalCase and kebab-case) | template elements matched against other public components' selectors (element, attribute, and combined forms) |

Framework-specific extensions include, for Vue: `kind` (sfc or defineComponent), `scriptSetup`, `optionsApi`, `scriptLang`, `templateLang`, `generic`, `exposed`, `options.name`, `options.inheritAttrs`, `dynamicSlots`, per-prop `kind`/`source`, per-event `kind`/`source`/`emit`; for Angular: `kind`, `selector`, `standalone` (only when written), `imports` (as written, resolved to file and class when in the project), `exportAs`, `changeDetection`, `encapsulation`, `hostDirectives`, `host.bindings`, `host.listeners`, `queries`, `templateSource`, `declaredIn`, `exportedBy`, per-input `kind` (`input`, `signal-input`, `model`), `property`, `alias`, `transform`, `writeType`, `typeInferred`, `inheritedFrom`.

Angular members inherited from a base class declared in the project are included with `inheritedFrom`; a base class outside the project, `hostDirectives`, or an unresolved Vue prop type make `propsComplete` false. Events: Angular outputs and Vue emits are `events`; React callbacks are ordinary props (`extensions.react.role: event-handler`). That difference is deliberate and tested; mapping them together is a reconciliation decision.

## Declaration files (installed packages)

A source with `declarations: true` and a `path` into `node_modules` (see the CLI spec) is read from the package's `.d.ts` files, as for React. Nothing is executed and only that package is read.

- **Angular.** ng-packagr writes the compiled metadata into each class: `static ɵcmp: ɵɵComponentDeclaration<T, Selector, ExportAs, Inputs, Outputs, Queries, NgContentSelectors, Standalone, HostDirectives>`, with `ɵdir` for directives and `ɵmod` for NgModules. Selector, `exportAs`, standalone, public input and output names (aliases), required flags, signal flags, content projection slots, host directives and NgModule declarations, imports and exports come from that type. Input types come from the class members: the type argument of `InputSignal`, `InputSignalWithTransform` (second argument is `writeType`) and `ModelSignal`, a setter's parameter type, or `ngAcceptInputType_x`. `OutputEmitterRef` is a signal output. A `model()` yields its `<name>Change` event. Inputs of a base class in the package are merged with `inheritedFrom`; other bases are listed as inherited.
- **Vue.** vue-tsc and vite-plugin-dts write `declare const X: DefineComponent<Props, …, Emits, …>`. Props come from the first type argument (an interface, a type literal, vue-tsc's `__VLS_` wrappers, `ExtractPropTypes<{…}>` runtime options with `PropType`, or a name list). Events come from the eighth (call-signature, function-member, named-tuple and name-array forms). Slots come from `__VLS_WithTemplateSlots<T, S>` or `& { new (): { $slots: S } }`. A default export named `_default` takes the PascalCase file name (`Button.vue.d.ts` is `Button`).
- **Not available.** A declaration file has types, never values: Vue prop defaults are not reported (diagnostic `vue.declaration-defaults-unavailable`), and no template, style or accessibility facts exist. Angular `.d.ts` files carry no templates either.

## Cross-framework consistency

`fixtures/cross-framework/` implements one conceptual Button in all three frameworks. `scripts/phase6.e2e.test.ts` asserts that props (`variant`, `size`, `disabled`, `label`: kind, required, default, domain), variants, slots (`default`, `icon`), accessibility role and style variable references are identical across the three, that framework detail never appears outside `extensions` or `implementations.<fw>`, and that each publishes the same link key shape. It also checks that the neutral Storybook reconciliation links and checks stories for a Vue SFC and an Angular class exactly as for React.

## Known limitations

- Validation covers one Vue and one Angular library (see above). Treat other libraries as unvalidated.
- Angular defaults and types produced through `inject()` or other third-party types stay `unknown`; the adapter reports them rather than guessing.
- Vue generic components (`<script setup generic="…">`) are marked incomplete.
- No usage statistics (`usage.*`): React has them, Angular and Vue do not yet.
- Vue: components registered only through a plugin (`app.component(...)`) or exported under a different local name than the import (`export { Btn as Button }` with a local import) are not found; `<script src>` and `<template src>` blocks are not read (reported); non-HTML template languages such as pug are not analyzed (reported); `v-bind()` in CSS is not recorded.
- Angular: `@angular/compiler` template semantics are not modeled (structural directives, pipes, template references); `ngProjectAs` is not recorded; pipes are not extracted; `standalone` has no inferred default; selectors using class or `:not()` forms are not matched for composition; `@let` and unusual control-flow syntax rely on the scanner's skipping rules; inputs and outputs contributed by `hostDirectives` are not enumerated (the component is marked incomplete).
- As elsewhere, third-party types are not loaded, so props inherited from library types are reported as inherited rather than enumerated.
- Open contract decision U17 (fields for styling, usage and render relationships) is unchanged and now applies to three frameworks.
