import { Component, input, output } from "@angular/core"

@Component({
  selector: "demo-button",
  standalone: true,
  template: `
    <button role="button" [attr.aria-label]="label()">
      <ng-content select="[slot=icon]" />
      <ng-content />
    </button>
  `,
  styles: [".root { color: var(--color-action); }"]
})
export class DemoButton {
  variant = input<"primary" | "secondary" | "ghost">("primary")
  size = input<"sm" | "md" | "lg">("md")
  disabled = input<boolean>(false)
  label = input.required<string>()
  press = output<MouseEvent>()
}
