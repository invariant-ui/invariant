import { forwardRef } from "react"
import styles from "./Button.module.css"

interface BaseProps {
  /** Hook for tests and analytics. */
  "data-testid"?: string
}

export interface ButtonProps extends BaseProps, React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual weight of the button. */
  variant?: "primary" | "secondary" | "ghost"
  size?: "sm" | "md" | "lg"
  /** @deprecated Use `variant="ghost"` instead. */
  plain?: boolean
  loading?: boolean
  onPress?: (event: React.MouseEvent<HTMLButtonElement>) => void
  children: React.ReactNode
  /** Leading icon. */
  icon?: React.ReactElement
}

/**
 * Triggers an action.
 *
 * @example
 * <Button variant="primary">Save</Button>
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading = false, icon, children, onPress, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      className={`${styles.root} ${styles[variant]}`}
      role="button"
      aria-busy={loading}
      data-size={size}
      onClick={onPress}
      {...rest}
    >
      {loading && <Spinner />}
      {icon}
      {children}
    </button>
  )
})

function Spinner() {
  return <span role="status" aria-label="Loading" />
}
