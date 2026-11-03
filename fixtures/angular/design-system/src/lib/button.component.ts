import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  HostBinding,
  HostListener,
  Input,
  Output,
  booleanAttribute,
  input,
  output
} from "@angular/core"

@Component({
  selector: "acme-button, button[acme-button]",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./button.component.html",
  styleUrls: ["./button.component.scss"],
  host: { "[class.is-loading]": "loading()", "(keydown.enter)": "onEnter()", role: "button" }
})
export class AcmeButton {
  /** Visual weight of the button. */
  variant = input<"primary" | "secondary" | "ghost">("primary")
  size = input<"sm" | "md" | "lg">("md", { alias: "buttonSize" })
  disabled = input(false, { transform: booleanAttribute })
  loading = input<boolean>(false)
  label = input.required<string>()

  /** @deprecated Use variant="ghost". */
  @Input() plain = false
  @Input({ required: true, alias: "kind" }) kindValue!: string

  pressed = output<MouseEvent>()
  @Output("focusChange") focusChanged = new EventEmitter<boolean>()

  @HostBinding("attr.aria-busy") get busy() {
    return this.loading()
  }

  @HostListener("click", ["$event"]) onClick(_event: MouseEvent) {}
  onEnter() {}
}
