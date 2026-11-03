import { EventEmitter, Input, Output } from "@angular/core"

export abstract class BaseField {
  /** Field label. */
  @Input() label = ""
  @Output() blurred = new EventEmitter<void>()
}
