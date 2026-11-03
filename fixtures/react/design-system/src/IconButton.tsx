import { memo } from "react"
import { Button, type ButtonProps } from "./Button"
import { Icon } from "./Icon"

export type IconButtonProps = Omit<ButtonProps, "children" | "icon"> & { name: string; label: string }

export const IconButton = memo(function IconButton({ name, label, ...rest }: IconButtonProps) {
  return (
    <Button {...rest} aria-label={label} variant="ghost">
      <Icon name={name} />
    </Button>
  )
})
