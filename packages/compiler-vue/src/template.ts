import type { SFCDescriptor } from "@vue/compiler-sfc"

export interface TemplateInfo {
  slots: Array<{ name?: string; dynamic: boolean; line: number; props: string[] }>
  /** Tags that are not plain HTML elements (candidates for component usage), with the line of first use. */
  components: Array<{ tag: string; count: number; line: number }>
  accessibility: { roles: string[]; attributes: string[] }
  /** Set when the template could not be analyzed (non-HTML language, external file, or parse failure). */
  skipped?: string
}

// Numeric node and element kinds of the Vue template AST (stable constants of the compiler).
const ELEMENT = 1
const ATTRIBUTE = 6
const DIRECTIVE = 7
const TAG_ELEMENT = 0
const TAG_SLOT = 2

interface AstNode {
  type: number
  tag?: string
  tagType?: number
  loc: { start: { line: number } }
  props?: AstProp[]
  children?: AstNode[]
}

interface AstProp {
  type: number
  name: string
  value?: { content: string }
  arg?: { content: string; isStatic: boolean }
}

/** Reads slot outlets, component tags and static accessibility attributes from the parsed template. */
export function analyzeTemplate(descriptor: SFCDescriptor): TemplateInfo {
  const info: TemplateInfo = { slots: [], components: [], accessibility: { roles: [], attributes: [] } }
  const template = descriptor.template
  if (!template) return info
  if (template.src) return { ...info, skipped: "template loaded from an external file (src)" }
  if (template.lang && template.lang !== "html")
    return { ...info, skipped: `template language ${template.lang} is not analyzed` }
  const root = template.ast as unknown as AstNode | undefined
  if (!root) return { ...info, skipped: "template did not parse" }

  const components = new Map<string, { count: number; line: number }>()
  const roles = new Set<string>()
  const attributes = new Set<string>()
  const visit = (node: AstNode): void => {
    if (node.type === ELEMENT && node.tag !== undefined) {
      const props = node.props ?? []
      if (node.tagType === TAG_SLOT) {
        const named = props.find((p) => p.type === ATTRIBUTE && p.name === "name")
        const bound = props.find(
          (p) => p.type === DIRECTIVE && p.name === "bind" && p.arg?.content === "name"
        )
        const slotProps = props
          .flatMap((p) =>
            p.type === ATTRIBUTE
              ? [p.name]
              : p.type === DIRECTIVE && p.name === "bind" && p.arg?.isStatic
                ? [p.arg.content]
                : []
          )
          .filter((n) => n !== "name")
        info.slots.push({
          ...(named?.value ? { name: named.value.content } : bound ? {} : { name: "default" }),
          dynamic: bound !== undefined,
          line: node.loc.start.line,
          props: [...new Set(slotProps)].sort()
        })
      } else if (node.tagType === TAG_ELEMENT) {
        for (const p of props) {
          if (p.type === ATTRIBUTE && p.name === "role" && p.value) roles.add(p.value.content)
          const name =
            p.type === ATTRIBUTE
              ? p.name
              : p.type === DIRECTIVE && p.name === "bind" && p.arg?.isStatic
                ? p.arg.content
                : undefined
          if (name?.startsWith("aria-")) attributes.add(name)
        }
      } else if (node.tagType !== undefined && node.tagType !== 3) {
        const entry = components.get(node.tag) ?? { count: 0, line: node.loc.start.line }
        entry.count++
        components.set(node.tag, entry)
      }
    }
    for (const child of node.children ?? []) if (typeof child === "object" && child !== null) visit(child)
  }
  visit(root)
  info.components = [...components]
    .map(([tag, v]) => ({ tag, ...v }))
    .sort((a, b) => (a.tag < b.tag ? -1 : 1))
  info.accessibility = { roles: [...roles].sort(), attributes: [...attributes].sort() }
  return info
}
