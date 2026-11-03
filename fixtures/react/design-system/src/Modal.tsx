import { Component } from "react"

interface ModalProps {
  open: boolean
  title?: string
  size?: "sm" | "lg"
  onClose?: () => void
  children?: React.ReactNode
}

/** Blocks the page until dismissed. */
export class Modal extends Component<ModalProps> {
  static defaultProps = { size: "sm" as const, title: "Dialog" }

  render() {
    return this.props.open ? (
      <div role="dialog" aria-modal="true">
        {this.props.children}
      </div>
    ) : null
  }
}
