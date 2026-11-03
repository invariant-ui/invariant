import { Directive, Input } from "@angular/core"

@Directive({ selector: "[acmeTooltip]", exportAs: "acmeTooltip", standalone: true })
export class AcmeTooltip {
  /** Tooltip text. */
  @Input("acmeTooltip") text = ""
  @Input() position: "top" | "bottom" = "top"
}
