import { forwardRef } from "react"

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  size?: "sm" | "md" | "lg"
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ size = "md", ...rest }, ref) {
  return <button ref={ref} data-size={size} {...rest} />
})
