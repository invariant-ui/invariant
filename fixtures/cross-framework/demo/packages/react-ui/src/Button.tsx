import styles from "./Button.module.css"

export interface ButtonProps {
  variant?: "primary" | "secondary" | "ghost"
  size?: "sm" | "md" | "lg"
  disabled?: boolean
  label: string
  onPress?: (event: MouseEvent) => void
  icon?: React.ReactNode
  children?: React.ReactNode
}

export function Button({ variant = "primary", size = "md", disabled = false, label, onPress, icon, children }: ButtonProps) {
  return (
    <button className={styles.root} role="button" disabled={disabled} data-variant={variant} data-size={size} aria-label={label} onClick={onPress}>
      {icon}
      {children}
    </button>
  )
}
