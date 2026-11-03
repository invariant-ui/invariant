export {
  IR_VERSION,
  type IrDocument,
  type IrEntity,
  type IrFact,
  irDocumentSchema,
  irEntitySchema,
  irFactSchema
} from "./ir.js"
export { irJsonSchemas } from "./json-schema.js"
export {
  canonicalizeIrDocument,
  computeIrContentHash,
  matchesCapability,
  type ParseResult,
  parseIrDocument,
  serializeIrDocument,
  verifyIrDocument
} from "./validate.js"
