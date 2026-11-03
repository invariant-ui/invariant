import type { DocFile, PackageInfo, ProjectDiscovery, StorybookConfig, TokenFile } from "./schema.js"
import { cmp, owningPackage } from "./support.js"

type Graph = ProjectDiscovery["graph"]

/** Source relationship graph: sorted nodes and edges, derived only from discovered facts. */
export function buildGraph(input: {
  packages: readonly PackageInfo[]
  storybooks: readonly StorybookConfig[]
  tokenFiles: readonly TokenFile[]
  docFiles: readonly DocFile[]
}): Graph {
  const nodes = new Map<string, Graph["nodes"][number]>()
  const edges = new Map<string, Graph["edges"][number]>()
  const node = (id: string, type: Graph["nodes"][number]["type"], label: string): void => {
    nodes.set(id, { id, type, label })
  }
  const edge = (from: string, to: string, type: Graph["edges"][number]["type"], weight?: number): void => {
    edges.set(`${from}\u0000${type}\u0000${to}`, { from, to, type, ...(weight ? { weight } : {}) })
  }

  const byName = new Map(input.packages.flatMap((p) => (p.name ? [[p.name, p] as const] : [])))
  for (const pkg of input.packages) {
    node(pkg.id, "package", pkg.name ?? pkg.dir)
    for (const dep of pkg.dependencies) {
      const target = byName.get(dep.name)
      if (target && target.id !== pkg.id) edge(pkg.id, target.id, "depends-on")
    }
    for (const fw of pkg.frameworks) {
      node(`framework:${fw.name}`, "framework", fw.name)
      edge(pkg.id, `framework:${fw.name}`, "uses-framework")
    }
    for (const tool of pkg.buildTools) {
      node(`tool:${tool.name}`, "build-tool", tool.name)
      edge(pkg.id, `tool:${tool.name}`, "built-with")
    }
  }
  for (const storybook of input.storybooks) {
    node(storybook.id, "storybook-config", storybook.configPath)
    if (storybook.package) edge(storybook.package, storybook.id, "configured-by")
    const counts = new Map<string, number>()
    for (const file of storybook.storyFiles) {
      const owner = owningPackage(input.packages, file)
      if (owner) counts.set(owner.id, (counts.get(owner.id) ?? 0) + 1)
    }
    for (const [pkgId, count] of counts) edge(storybook.id, pkgId, "documents", count)
  }
  for (const file of input.tokenFiles) {
    node(`tokens:${file.path}`, "token-file", file.path)
    const owner = owningPackage(input.packages, file.path)
    if (owner) edge(owner.id, `tokens:${file.path}`, "contains")
  }
  for (const file of input.docFiles) {
    node(`doc:${file.path}`, "doc-file", file.path)
    const owner = owningPackage(input.packages, file.path)
    if (owner) edge(owner.id, `doc:${file.path}`, "contains")
  }
  return {
    nodes: [...nodes.values()].sort((a, b) => cmp(a.id, b.id)),
    edges: [...edges.values()].sort((a, b) => cmp(a.from, b.from) || cmp(a.type, b.type) || cmp(a.to, b.to))
  }
}
