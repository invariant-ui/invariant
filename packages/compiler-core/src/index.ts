export type { Evidence } from "@invariant/contract"
export type {
  DiscoveredSource,
  DiscoveryContext,
  DiscoveryResult,
  ExtractionContext,
  ExtractionResult,
  SourceAdapter,
  SourceVersion,
  ValidationContext
} from "./adapter.js"
export {
  INVENTORY_ADAPTERS,
  markdownDocsAdapter,
  npmPackageAdapter,
  storybookConfigAdapter,
  tokenFilesAdapter
} from "./adapters/inventory.js"
export {
  type CompiledSource,
  type CompileOptions,
  type CompileResult,
  compile,
  toArtifactEntries
} from "./compile.js"
export {
  ComponentFacts,
  cssVariableReferences,
  type EventSpec,
  type PropSpec,
  type SlotSpec,
  type VariantSpec,
  variantsFromProps
} from "./component-facts.js"
export {
  type CssVariable,
  DISCOVERY_VERSION,
  type DiscoverOptions,
  type DiscoveryLimits,
  type DocFile,
  discoverProject,
  type EntryPoint,
  type ExportInfo,
  type FrameworkUse,
  type PackageInfo,
  type ProjectDiscovery,
  parseCssCustomProperties,
  parsePnpmWorkspacePackages,
  projectDiscoverySchema,
  type StorybookConfig,
  scanCssCustomProperties,
  type TokenFile
} from "./discovery/index.js"
export { cmp, fileExists, hashText, owningPackage, posix } from "./discovery/support.js"
export { type DirEntry, type DirEntryKind, memoryFs, nodeFs, type ReadonlyFs } from "./fs.js"
export { globToRegExp, matchesAny } from "./glob.js"
export { IrBuilder } from "./ir-builder.js"
export { discoveryJsonSchemas } from "./json-schema.js"
export {
  collapse,
  componentNameFromFile,
  declarationOf,
  excerpt,
  hasModifier,
  isProjectNode,
  jsxTargetDeclaration,
  lineOf,
  literalValue,
  relativeFileOf,
  resolveSymbol,
  subTarget,
  topLevelAssignments,
  typeReferenceInfo,
  unwrap,
  walkSameFunction
} from "./ts/ast.js"
export {
  allowedValuesOf,
  classifyKind,
  declarationParentName,
  describeMember,
  externalBases,
  literalDomain,
  type MemberInfo,
  type MemberKind,
  ownProperties
} from "./ts/members.js"
export { type Analysis, createAnalysis } from "./ts/program.js"
export { type Evaluated, evaluate } from "./ts/static-eval.js"
export { TSCONFIG_FILE, tsconfigPaths } from "./ts/tsconfig-paths.js"
export { DEFAULT_IGNORED_DIRS, walk } from "./walk.js"
