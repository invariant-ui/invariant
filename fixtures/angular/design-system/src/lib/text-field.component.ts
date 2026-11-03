import { Component, input, model } from "@angular/core"
import { AcmeButton } from "./button.component"
import { BaseField } from "./base-field"
import { AcmeTooltip } from "./tooltip.directive"

@Component({
  selector: "acme-text-field",
  standalone: true,
  imports: [AcmeButton, AcmeTooltip],
  template: `<label><input aria-label="field" /></label>
    <button acme-button label="Clear" acmeTooltip="Clear the field"></button>`
})
export class AcmeTextField extends BaseField {
  value = model<string>("")
  focused = model.required<boolean>()
  type = input<"text" | "email">("text")
  maxLength = input<number | undefined>(undefined)
}
