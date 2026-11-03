export interface StackProps {
  gap?: "sm" | "md" | "lg"
  children?: React.ReactNode
}

export const Stack: React.FC<StackProps> = ({ gap = "md", children }) => (
  <div className="flex flex-col gap-4" data-gap={gap}>
    {children}
  </div>
)
