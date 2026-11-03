import { cva, type VariantProps } from "class-variance-authority"

const text = cva("text", {
  variants: {
    tone: { neutral: "text-neutral", danger: "text-danger" },
    weight: { regular: "w-4", bold: "w-7" }
  },
  defaultVariants: { tone: "neutral", weight: "regular" }
})

export interface TextProps extends VariantProps<typeof text> {
  as?: "p" | "span"
  children: React.ReactNode
}

export function Text({ as: Tag = "p", tone, weight, children }: TextProps) {
  return <Tag className={text({ tone, weight })}>{children}</Tag>
}
