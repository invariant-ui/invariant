import { relativePathSchema } from "@invariant/contract"
import { diagnosticSchema } from "@invariant/diagnostics"
import { z } from "zod"

export const DISCOVERY_VERSION = "1.0.0"

const hash = z.string().regex(/^[0-9a-f]{64}$/)
const fileRef = z.strictObject({ path: relativePathSchema, contentHash: hash })
const dependencyKind = z.enum(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"])

export const exportInfoSchema = z.strictObject({
  name: z.string().min(1),
  kind: z.enum(["value", "type", "namespace", "default", "unknown"]),
  /** True when the export has no runtime value: `export type`, interfaces and type aliases. */
  typeOnly: z.boolean(),
  file: relativePathSchema,
  line: z.number().int().positive(),
  reexportOf: z.strictObject({ module: z.string().min(1), external: z.boolean() }).optional()
})
export type ExportInfo = z.infer<typeof exportInfoSchema>

export const entryPointSchema = z.strictObject({
  subpath: z.string().min(1),
  condition: z.string().min(1),
  target: z.string().min(1),
  resolution: z.enum(["declared", "mapped", "conventional", "unresolved"]),
  file: relativePathSchema.optional(),
  exports: z.array(exportInfoSchema),
  /** False when exports could not be fully enumerated (external `export *`, parse failure, or limits). */
  exportsComplete: z.boolean(),
  parsedFiles: z.array(fileRef)
})
export type EntryPoint = z.infer<typeof entryPointSchema>

export const frameworkUseSchema = z.strictObject({
  name: z.enum(["react", "angular", "vue"]),
  package: z.string().min(1),
  dependencyKind,
  declaredRange: z.string().min(1),
  installedVersion: z.string().min(1).optional(),
  line: z.number().int().positive().optional()
})
export type FrameworkUse = z.infer<typeof frameworkUseSchema>

export const buildToolSchema = z.strictObject({
  name: z.string().min(1),
  evidence: z.array(z.strictObject({ type: z.enum(["dependency", "config-file"]), ref: z.string().min(1) }))
})

export const packageSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  dir: relativePathSchema,
  private: z.boolean(),
  manifest: fileRef,
  dependencies: z.array(z.strictObject({ name: z.string().min(1), range: z.string(), kind: dependencyKind })),
  scripts: z.array(z.string()),
  frameworks: z.array(frameworkUseSchema),
  buildTools: z.array(buildToolSchema),
  entryPoints: z.array(entryPointSchema)
})
export type PackageInfo = z.infer<typeof packageSchema>

export const packageManagerSchema = z.strictObject({
  name: z.enum(["npm", "pnpm", "yarn", "bun", "unknown"]),
  version: z.string().min(1).optional(),
  evidence: z.array(z.string().min(1))
})

export type PackageManager = z.infer<typeof packageManagerSchema>

export const workspacesSchema = z.strictObject({
  kind: z.enum(["pnpm-workspace", "package-json", "none"]),
  patterns: z.array(z.string()),
  source: relativePathSchema.optional()
})

export const storybookSchema = z.strictObject({
  id: z.string().min(1),
  configPath: relativePathSchema,
  configHash: hash,
  directory: relativePathSchema,
  package: z.string().min(1).optional(),
  framework: z.string().min(1).optional(),
  addons: z.array(z.string()),
  stories: z.array(
    z.strictObject({
      pattern: z.string().optional(),
      directory: z.string().optional(),
      files: z.string().optional(),
      titlePrefix: z.string().optional()
    })
  ),
  staticDirs: z.array(z.string()),
  /** Config properties whose value could not be determined statically. */
  dynamicProperties: z.array(z.string()),
  version: z
    .strictObject({ package: z.string(), declaredRange: z.string(), installedVersion: z.string().optional() })
    .optional(),
  builtOutput: z.strictObject({ path: relativePathSchema, hasIndexJson: z.boolean() }).optional(),
  storyFiles: z.array(relativePathSchema),
  storyFileCount: z.number().int().nonnegative(),
  storyFilesTruncated: z.boolean()
})
export type StorybookConfig = z.infer<typeof storybookSchema>

export const cssVariableSchema = z.strictObject({
  name: z.string().min(1),
  scope: z.string(),
  line: z.number().int().positive(),
  value: z.string().max(200),
  aliasOf: z.string().optional()
})
export type CssVariable = z.infer<typeof cssVariableSchema>

export const tokenFileSchema = z.strictObject({
  path: relativePathSchema,
  kind: z.enum(["css-custom-properties", "json-tokens", "style-dictionary-config", "tailwind-config"]),
  /** Shape heuristic only: it says what the file looks like, not that it conforms to a spec. */
  format: z.enum(["dtcg-like", "style-dictionary-like", "unknown"]).optional(),
  contentHash: hash,
  package: z.string().min(1).optional(),
  cssVariables: z.array(cssVariableSchema).optional(),
  cssVariablesTruncated: z.boolean().optional(),
  tokenCount: z.number().int().nonnegative().optional()
})
export type TokenFile = z.infer<typeof tokenFileSchema>

export const docFileSchema = z.strictObject({
  path: relativePathSchema,
  kind: z.enum(["readme", "changelog", "mdx", "markdown"]),
  title: z.string().optional(),
  headings: z.array(
    z.strictObject({
      level: z.number().int().min(1).max(6),
      text: z.string(),
      line: z.number().int().positive()
    })
  ),
  lineCount: z.number().int().nonnegative(),
  contentHash: hash,
  package: z.string().min(1).optional()
})
export type DocFile = z.infer<typeof docFileSchema>

export const graphSchema = z.strictObject({
  nodes: z.array(
    z.strictObject({
      id: z.string().min(1),
      type: z.enum(["package", "framework", "build-tool", "storybook-config", "token-file", "doc-file"]),
      label: z.string().min(1)
    })
  ),
  edges: z.array(
    z.strictObject({
      from: z.string().min(1),
      to: z.string().min(1),
      type: z.enum(["depends-on", "uses-framework", "built-with", "contains", "configured-by", "documents"]),
      weight: z.number().int().positive().optional()
    })
  )
})

export const projectDiscoverySchema = z.strictObject({
  discoveryVersion: z.literal(DISCOVERY_VERSION),
  packageManager: packageManagerSchema,
  workspaces: workspacesSchema,
  packages: z.array(packageSchema),
  storybooks: z.array(storybookSchema),
  tokenFiles: z.array(tokenFileSchema),
  docFiles: z.array(docFileSchema),
  graph: graphSchema,
  stats: z.strictObject({ filesScanned: z.number().int().nonnegative(), truncated: z.boolean() }),
  diagnostics: z.array(diagnosticSchema)
})
export type ProjectDiscovery = z.infer<typeof projectDiscoverySchema>
