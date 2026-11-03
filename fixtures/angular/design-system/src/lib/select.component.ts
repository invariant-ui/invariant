import { Component, Input } from "@angular/core"
import { ExternalBase } from "some-lib"

@Component({ selector: "acme-select", standalone: true, template: "<ng-content />" })
export class AcmeSelect<T> extends ExternalBase {
  @Input() options: T[] = []
  @Input({ transform: (v: string) => v.trim() }) placeholder = ""
}
