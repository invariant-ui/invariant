import { computeEvidenceId, type Evidence } from "@invariant/contract"
import { sha256Hex } from "@invariant/shared"
import { IR_VERSION, type IrDocument, type IrFact } from "../src/index.ts"

function evidence(input: Omit<Evidence, "id" | "verificationStatus" | "capturedAt">): Evidence {
  return {
    ...input,
    id: computeEvidenceId(input),
    verificationStatus: "unverified",
    capturedAt: "2026-10-30T12:00:00.000Z"
  }
}

function fact(subject: string, path: string, value: IrFact["value"], ev: Evidence): IrFact {
  return { subject, path, value, origin: "extracted", evidenceIds: [ev.id] }
}

const SIZE_TYPE = '"sm" | "md" | "lg"'

/** What a React adapter would emit for the Acme Button. Hand-written; real extraction arrives with the React adapter. */
export function reactButtonIr(): IrDocument {
  const subject = "react:packages/ui-react/src/Button.tsx#Button"
  const props = evidence({
    sourceId: "ui-react",
    sourceRef: "packages/ui-react/src/Button.tsx#Button",
    location: { type: "file", path: "packages/ui-react/src/Button.tsx", line: 12, column: 3 },
    method: "compiler-api",
    extractor: { name: "react-props", version: "0.1.0" },
    original: 'size?: "sm" | "md" | "lg"'
  })
  const decl = evidence({
    sourceId: "ui-react",
    sourceRef: "packages/ui-react/src/Button.tsx#Button",
    location: { type: "file", path: "packages/ui-react/src/Button.tsx", line: 20 },
    method: "ast",
    extractor: { name: "react-exports", version: "0.1.0" },
    original: "export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(props, ref) {"
  })
  return {
    irVersion: IR_VERSION,
    source: {
      id: "ui-react",
      type: "react",
      location: "./packages/ui-react",
      version: { kind: "git-commit", value: "9b95d2c" },
      inputHash: sha256Hex("ui-react inputs"),
      adapter: { name: "react-adapter", version: "0.1.0" }
    },
    capabilities: [
      "props.*.type",
      "props.*.required",
      "props.*.default",
      "props.*.allowedValues",
      "implementations.*"
    ],
    completeness: "complete",
    entities: [{ ref: subject, kind: "component", name: "Button" }],
    facts: [
      fact(subject, "props.size.type.text", SIZE_TYPE, props),
      fact(subject, "props.size.type.kind", "enum", props),
      fact(subject, "props.size.required", false, props),
      fact(subject, "props.size.default", "md", props),
      fact(subject, "props.size.allowedValues", ["sm", "md", "lg"], props),
      fact(subject, "implementations.react.framework", "react", decl),
      fact(subject, "implementations.react.exportName", "Button", decl),
      fact(subject, "implementations.react.extensions.react.forwardRef", true, decl)
    ],
    evidence: [props, decl],
    diagnostics: []
  }
}

/** The same conceptual component from an Angular adapter: identical neutral paths, framework detail under extensions. */
export function angularButtonIr(): IrDocument {
  const subject = "angular:packages/ui-angular/src/button.component.ts#AcmeButton"
  const input = evidence({
    sourceId: "ui-angular",
    sourceRef: "packages/ui-angular/src/button.component.ts#AcmeButton",
    location: { type: "file", path: "packages/ui-angular/src/button.component.ts", line: 20 },
    method: "compiler-api",
    extractor: { name: "angular-inputs", version: "0.1.0" },
    original: 'size = input<"sm" | "md" | "lg">("md")'
  })
  const decorator = evidence({
    sourceId: "ui-angular",
    sourceRef: "packages/ui-angular/src/button.component.ts#AcmeButton",
    location: { type: "file", path: "packages/ui-angular/src/button.component.ts", line: 8 },
    method: "ast",
    extractor: { name: "angular-component", version: "0.1.0" },
    original: "@Component({ selector: 'acme-button', standalone: true })"
  })
  return {
    irVersion: IR_VERSION,
    source: {
      id: "ui-angular",
      type: "angular",
      location: "./packages/ui-angular",
      version: { kind: "git-commit", value: "9b95d2c" },
      inputHash: sha256Hex("ui-angular inputs"),
      adapter: { name: "angular-adapter", version: "0.1.0" }
    },
    capabilities: [
      "props.*.type",
      "props.*.required",
      "props.*.default",
      "props.*.allowedValues",
      "props.*.extensions",
      "implementations.*"
    ],
    completeness: "partial",
    entities: [{ ref: subject, kind: "component", name: "AcmeButton" }],
    facts: [
      fact(subject, "props.size.type.text", SIZE_TYPE, input),
      fact(subject, "props.size.type.kind", "enum", input),
      fact(subject, "props.size.required", false, input),
      fact(subject, "props.size.default", "md", input),
      fact(subject, "props.size.allowedValues", ["sm", "md", "lg"], input),
      fact(subject, "props.size.extensions.angular.kind", "input", input),
      fact(subject, "implementations.angular.framework", "angular", decorator),
      fact(subject, "implementations.angular.exportName", "AcmeButton", decorator),
      fact(subject, "implementations.angular.extensions.angular.selector", "acme-button", decorator)
    ],
    evidence: [input, decorator],
    diagnostics: [
      {
        code: "extract.unsupported-syntax",
        severity: "warning",
        message: "Template-driven outputs were not analyzed",
        sourceId: "ui-angular"
      }
    ]
  }
}
