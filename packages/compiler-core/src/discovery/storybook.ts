import ts from "typescript"
import { globToRegExp, matchesAny } from "../glob.js"
import { isRecord, type RawPackage } from "./packages.js"
import type { StorybookConfig } from "./schema.js"
import { cmp, type DiscoveryEnv, hashText, owningPackage, posix, readBounded } from "./support.js"

const CONFIG_NAME = /^main\.[cm]?[jt]s$/

/** Storybook configs found under any `.storybook` directory, parsed statically (the config is never executed). */
export async function discoverStorybooks(
  env: DiscoveryEnv,
  packages: readonly RawPackage[]
): Promise<StorybookConfig[]> {
  const configs = env.files.filter(
    (f) => posix.basename(posix.dirname(f)) === ".storybook" && CONFIG_NAME.test(posix.basename(f))
  )
  const out: StorybookConfig[] = []
  for (const configPath of configs) {
    const text = await readBounded(env, configPath)
    if (text === undefined) continue
    const configDir = posix.dirname(configPath)
    const directory = posix.dirname(configDir)
    const evaluated = evaluateConfig(configPath, text)
    if (!evaluated) {
      env.diagnostics.warning(
        "discovery.storybook-unparsed",
        `No static config object found in ${configPath}`,
        { location: { path: configPath } }
      )
    }
    const config = evaluated ?? { values: {}, dynamic: ["<config>"] }
    for (const property of config.dynamic) {
      env.diagnostics.warning(
        "discovery.storybook-dynamic-config",
        `Storybook '${property}' in ${configPath} is not statically determinable`,
        {
          location: { path: configPath }
        }
      )
    }
    const stories = toStories(config.values.stories)
    const pkg = owningPackage(
      packages.map((p) => ({ dir: p.info.dir, raw: p })),
      configPath
    )?.raw
    const { files, total } = expandStories(env, configDir, stories)
    out.push({
      id: `storybook:${directory}`,
      configPath,
      configHash: hashText(text),
      directory,
      ...(pkg ? { package: pkg.info.id } : {}),
      ...frameworkOf(config.values.framework),
      addons: toStrings(config.values.addons).sort(),
      stories,
      staticDirs: toStrings(config.values.staticDirs).sort(),
      dynamicProperties: [...config.dynamic].sort(),
      ...(pkg ? await storybookVersion(env, pkg) : {}),
      ...(await builtOutput(env, directory)),
      storyFiles: files.slice(0, env.limits.maxStoryFiles),
      storyFileCount: total,
      storyFilesTruncated: total > env.limits.maxStoryFiles
    })
  }
  return out.sort((a, b) => cmp(a.configPath, b.configPath))
}

type Value = string | number | boolean | null | Value[] | { [key: string]: Value } | undefined
interface Evaluated {
  values: Record<string, Value>
  dynamic: string[]
}

function evaluateConfig(file: string, text: string): Evaluated | undefined {
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.ES2022,
    true,
    /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  )
  const bindings = new Map<string, ts.Expression>()
  let exported: ts.Expression | undefined
  for (const statement of sf.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const d of statement.declarationList.declarations)
        if (ts.isIdentifier(d.name) && d.initializer) bindings.set(d.name.text, d.initializer)
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) exported = statement.expression
    else if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      statement.expression.left.getText(sf) === "module.exports"
    ) {
      exported = statement.expression.right
    }
  }
  const object = unwrap(exported ?? bindings.get("config"), bindings)
  if (!object || !ts.isObjectLiteralExpression(object)) return undefined
  const values: Record<string, Value> = {}
  const dynamic: string[] = []
  for (const property of object.properties) {
    if (
      !ts.isPropertyAssignment(property) ||
      !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    ) {
      dynamic.push(property.name?.getText(sf) ?? "<spread>")
      continue
    }
    const name = property.name.text
    const result = evaluate(property.initializer, bindings)
    values[name] = result.value
    if (result.dynamic) dynamic.push(name)
  }
  return { values, dynamic }
}

function unwrap(
  node: ts.Expression | undefined,
  bindings: Map<string, ts.Expression>,
  depth = 0
): ts.Expression | undefined {
  if (!node || depth > 8) return undefined
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))
    return unwrap(node.expression, bindings, depth + 1)
  if (ts.isIdentifier(node)) return unwrap(bindings.get(node.text), bindings, depth + 1)
  // defineMain({...}) and similar single-argument wrappers
  if (ts.isCallExpression(node) && node.arguments.length === 1)
    return unwrap(node.arguments[0], bindings, depth + 1)
  return node
}

function evaluate(
  node: ts.Expression,
  bindings: Map<string, ts.Expression>,
  depth = 0
): { value: Value; dynamic: boolean } {
  if (depth > 8) return { value: undefined, dynamic: true }
  if (ts.isStringLiteralLike(node)) return { value: node.text, dynamic: false }
  if (ts.isNumericLiteral(node)) return { value: Number(node.text), dynamic: false }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { value: true, dynamic: false }
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { value: false, dynamic: false }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))
    return evaluate(node.expression, bindings, depth + 1)
  if (ts.isIdentifier(node) && bindings.has(node.text))
    return evaluate(bindings.get(node.text) as ts.Expression, bindings, depth + 1)
  // getAbsolutePath("@storybook/addon-docs") is the documented monorepo idiom; its argument is the package name.
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "getAbsolutePath"
  ) {
    const arg = node.arguments[0]
    if (arg && ts.isStringLiteralLike(arg)) return { value: arg.text, dynamic: false }
  }
  if (ts.isArrayLiteralExpression(node)) {
    let dynamic = false
    const value = node.elements.map((element) => {
      const inner = evaluate(element, bindings, depth + 1)
      dynamic ||= inner.dynamic
      return inner.value
    })
    return { value: value.filter((v) => v !== undefined), dynamic }
  }
  if (ts.isObjectLiteralExpression(node)) {
    let dynamic = false
    const value: Record<string, Value> = {}
    for (const property of node.properties) {
      if (
        ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      ) {
        const inner = evaluate(property.initializer, bindings, depth + 1)
        dynamic ||= inner.dynamic
        if (inner.value !== undefined) value[property.name.text] = inner.value
      } else dynamic = true
    }
    return { value, dynamic }
  }
  return { value: undefined, dynamic: true }
}

function toStrings(value: Value): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) =>
    typeof item === "string" ? [item] : isRecord(item) && typeof item.name === "string" ? [item.name] : []
  )
}

function toStories(value: Value): StorybookConfig["stories"] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): StorybookConfig["stories"] => {
    if (typeof item === "string") return [{ pattern: item }]
    if (isRecord(item)) {
      return [
        {
          ...(typeof item.directory === "string" ? { directory: item.directory } : {}),
          ...(typeof item.files === "string" ? { files: item.files } : {}),
          ...(typeof item.titlePrefix === "string" ? { titlePrefix: item.titlePrefix } : {})
        }
      ]
    }
    return []
  })
}

function frameworkOf(value: Value): { framework?: string } {
  if (typeof value === "string") return { framework: value }
  if (isRecord(value) && typeof value.name === "string") return { framework: value.name }
  return {}
}

function expandStories(
  env: DiscoveryEnv,
  configDir: string,
  stories: StorybookConfig["stories"]
): { files: string[]; total: number } {
  const matchers: RegExp[] = []
  for (const story of stories) {
    const pattern =
      story.pattern ??
      (story.directory
        ? `${story.directory.replace(/\/$/, "")}/${story.files ?? "**/*.stories.@(js|jsx|mjs|ts|tsx)"}`
        : undefined)
    if (!pattern) continue
    const resolved = posix.normalize(posix.join(configDir, pattern))
    if (resolved.startsWith("..")) continue
    matchers.push(globToRegExp(resolved))
  }
  const files = env.files.filter((f) => matchesAny(f, matchers))
  return { files, total: files.length }
}

async function storybookVersion(
  env: DiscoveryEnv,
  pkg: RawPackage
): Promise<Pick<StorybookConfig, "version">> {
  const dep =
    pkg.info.dependencies.find((d) => d.name === "storybook") ??
    pkg.info.dependencies.find((d) =>
      /^@storybook\/(react|vue3|angular|nextjs|web-components)(-|$)/.test(d.name)
    )
  if (!dep) return {}
  let installed: string | undefined
  for (let dir = pkg.info.dir; ; dir = posix.dirname(dir)) {
    const candidate = posix.join(dir, "node_modules", dep.name, "package.json")
    if (await env.fs.exists(candidate)) {
      try {
        const version = (JSON.parse(await env.fs.readFile(candidate)) as { version?: unknown }).version
        if (typeof version === "string") installed = version
      } catch {
        // Unreadable installed manifest: leave installedVersion unknown.
      }
      break
    }
    if (dir === ".") break
  }
  return {
    version: {
      package: dep.name,
      declaredRange: dep.range,
      ...(installed ? { installedVersion: installed } : {})
    }
  }
}

async function builtOutput(
  env: DiscoveryEnv,
  directory: string
): Promise<Pick<StorybookConfig, "builtOutput">> {
  const dir = posix.join(directory, "storybook-static")
  if (!(await env.fs.exists(dir))) return {}
  return { builtOutput: { path: dir, hasIndexJson: await env.fs.exists(posix.join(dir, "index.json")) } }
}
