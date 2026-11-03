import { Component, ViewEncapsulation } from "@angular/core"

@Component({
  selector: "acme-card",
  standalone: false,
  encapsulation: ViewEncapsulation.None,
  inputs: ["elevated", "tone: cardTone"],
  outputs: ["closed"],
  template: `
    <header><ng-content select="acme-card-header" /></header>
    <ng-content />
    <footer><ng-content select=".footer" /></footer>
  `,
  styles: [".card { box-shadow: var(--shadow-card); }"]
})
export class AcmeCard {}
