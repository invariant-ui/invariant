import { Component, input, output } from "@angular/core"

@Component({ selector: "acme-button", standalone: true, template: "<button><ng-content /></button>" })
export class AcmeButton {
  size = input<"sm" | "md" | "lg">("md")
  pressed = output<MouseEvent>()
}
