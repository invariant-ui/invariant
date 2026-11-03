import { componentNameFromFile } from "@invariant/compiler-core"
import { parse, type SFCBlock, type SFCDescriptor } from "@vue/compiler-sfc"

/**
 * The script of an SFC as a virtual TypeScript module, so the type checker can analyze it. When both
 * `<script>` and `<script setup>` exist they are joined into one module (as Vue combines them), and
 * `lineOf` maps a virtual line back to the line in the `.vue` file.
 */
export interface VirtualScript {
  /** Project-relative virtual module path (for example `src/Button.vue.ts`). */
  path: string
  text: string
  /** True when the virtual module may contain JSX. */
  tsx: boolean
  lineOf(virtualLine: number): number
}

export interface ParsedSfc {
  path: string
  descriptor: SFCDescriptor
  errors: string[]
  script?: VirtualScript
}

export function parseSfc(path: string, text: string): ParsedSfc {
  const { descriptor, errors } = parse(text, { filename: path, sourceMap: false })
  const script = buildScript(path, descriptor)
  return {
    path,
    descriptor,
    errors: errors.map((e) => ("message" in e ? e.message : String(e))),
    ...(script ? { script } : {})
  }
}

function buildScript(path: string, descriptor: SFCDescriptor): VirtualScript | undefined {
  const blocks: SFCBlock[] = [descriptor.script, descriptor.scriptSetup].filter(
    (b): b is NonNullable<typeof b> => b !== null
  )
  // Blocks that load their content from another file (`<script src>`) are not read here.
  const readable = blocks.filter((b) => !b.src)
  if (readable.length === 0) return undefined
  const segments: Array<{ virtualStart: number; sfcStart: number; lines: number }> = []
  let text = ""
  let line = 1
  for (const block of readable) {
    const lines = block.content.split("\n").length
    segments.push({ virtualStart: line, sfcStart: block.loc.start.line, lines })
    text += `${block.content}\n`
    line += lines
  }
  const lang = readable.map((b) => b.lang).find((l) => l === "tsx" || l === "jsx")
  const ext = lang ? ".tsx" : ".ts"
  return {
    path: `${path}${ext}`,
    text,
    tsx: lang !== undefined,
    lineOf(virtualLine) {
      const segment = [...segments].reverse().find((s) => virtualLine >= s.virtualStart) ?? segments[0]
      return segment ? segment.sfcStart + (virtualLine - segment.virtualStart) : virtualLine
    }
  }
}

/** Display and link name of an SFC component: the PascalCase file name (`button-group.vue` is `ButtonGroup`). */
export function sfcLocalName(path: string): string {
  return componentNameFromFile(path)
}
