import { existsSync, readFileSync } from "node:fs"
import { posix } from "node:path"
import ts from "typescript"

export interface Analysis {
  program: ts.Program
  checker: ts.TypeChecker
  /** Project-relative POSIX path for a project source file; undefined for lib or unresolved files. */
  relativePath(fileName: string): string | undefined
  sourceFile(relativePath: string): ts.SourceFile | undefined
  /** Whether a project file (of any kind, including non-code files such as `.vue`) was supplied. */
  hasFile(relativePath: string): boolean
}

/**
 * Builds a type-checking program over the supplied project files only. Nothing is read from
 * `node_modules` and no customer code runs: third-party types (including `@types/react`) are not
 * loaded, so references to them stay unresolved and are reported as such rather than guessed.
 * TypeScript's own `lib.es2022.d.ts` is read so built-in utility types like `Omit` resolve.
 */
export function createAnalysis(
  files: ReadonlyMap<string, string>,
  extra: {
    paths?: Record<string, string[]>
    /**
     * Relative imports that resolve to a virtual module: project path (for example `src/Button.vue`) to
     * the virtual TypeScript file standing in for it (`src/Button.vue.ts`).
     */
    moduleAliases?: Record<string, string>
  } = {}
): Analysis {
  const virtual = new Map([...files].map(([rel, text]) => [`/${rel}`, text]))
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    lib: ["lib.es2022.d.ts"],
    types: [],
    strict: true,
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    resolveJsonModule: true,
    allowArbitraryExtensions: true,
    // Workspace package names resolved to project-relative entry files (supplied by the caller).
    ...(extra.paths
      ? {
          baseUrl: "/",
          paths: Object.fromEntries(
            Object.entries(extra.paths).map(([name, targets]) => [name, targets.map((t) => `/${t}`)])
          )
        }
      : {})
  }
  const libDir = ts.getDefaultLibFilePath(options).replace(/[^/\\]+$/, "")
  const isLib = (file: string): boolean => file.startsWith(libDir)
  const read = (file: string): string | undefined => {
    const text = virtual.get(file)
    if (text !== undefined) return text
    return isLib(file) && existsSync(file) ? readFileSync(file, "utf8") : undefined
  }
  const host: ts.CompilerHost = {
    getSourceFile: (file, languageVersion) => {
      const text = read(file)
      return text === undefined ? undefined : ts.createSourceFile(file, text, languageVersion, true)
    },
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    fileExists: (file) => read(file) !== undefined,
    readFile: read,
    getCanonicalFileName: (file) => file,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    ...(extra.moduleAliases
      ? {
          resolveModuleNames: (
            names: string[],
            containingFile: string
          ): Array<ts.ResolvedModuleFull | undefined> =>
            names.map((name) => {
              const aliases = extra.moduleAliases as Record<string, string>
              if (name.startsWith(".")) {
                const target =
                  aliases[posix.normalize(posix.join(posix.dirname(containingFile.slice(1)), name))]
                if (target) return { resolvedFileName: `/${target}`, extension: ts.Extension.Ts }
              }
              return ts.resolveModuleName(name, containingFile, options, host).resolvedModule
            })
        }
      : {})
  }
  const roots = [...virtual.keys()].filter((f) => /\.(?:[cm]?[jt]sx?)$/.test(f))
  const program = ts.createProgram({ rootNames: roots, options, host })
  return {
    program,
    checker: program.getTypeChecker(),
    relativePath: (fileName) => (virtual.has(fileName) ? fileName.slice(1) : undefined),
    sourceFile: (rel) => program.getSourceFile(`/${rel}`),
    hasFile: (rel) => virtual.has(`/${rel}`)
  }
}
