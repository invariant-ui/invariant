# Invariant Engineering Instructions

## Project Mission

Invariant compiles existing design systems into accurate, portable, machine-readable contracts that AI agents can consume and validate.

## Core Principles

- The contract is the canonical source of truth.
- All source adapters compile into a shared intermediate representation.
- Never couple the canonical contract to a particular frontend framework.
- Never couple the contract to MCP.
- Prefer deterministic extraction over LLM-generated assumptions.
- Preserve evidence and provenance.
- Never silently discard conflicting source information.
- Never represent inferred information as discovered fact.
- Never automatically promote inferred rules into approved policies.
- Never fabricate component APIs, properties, tokens, or relationships.
- Preserve framework-specific semantics in appropriate extension metadata.

## Source Adapters

Every adapter must:
1. Discover available source information.
2. Extract structured facts.
3. Normalize findings into IR.
4. Attach source evidence.
5. Produce diagnostics for unsupported or incomplete extraction.

Adapters must not independently generate the canonical contract.

## Contract Changes

Before changing the contract:
1. Inspect the existing schema.
2. Identify affected packages.
3. Explain compatibility implications.
4. Update JSON Schema and runtime validation.
5. Add migration logic when necessary.
6. Update fixtures and tests.

All contract changes must be versioned.

## AI and Semantic Processing

LLMs may assist with:
- Semantic classification.
- Entity resolution.
- Documentation interpretation.
- Pattern identification.
- Relationship inference.
- Conflict explanations.

LLMs must not be the authoritative source for:
- TypeScript APIs.
- Angular inputs and outputs.
- Vue props and emits.
- Component exports.
- Default values that can be statically extracted.
- Actual token values.

All AI-derived information must retain evidence and confidence.

## Engineering Standards

- TypeScript strict mode.
- Explicit package boundaries.
- Small composable modules.
- Deterministic compilation.
- Structured diagnostics.
- Unit tests for extraction logic.
- Integration tests for source adapters.
- Golden fixtures for regression testing.
- No unnecessary dependencies.
- No arbitrary execution of customer source code during static analysis.

## Claude Code Workflow

For each milestone:
1. Read the relevant specification.
2. Inspect existing implementation.
3. Write a short implementation plan.
4. Identify files and packages affected.
5. Implement in small increments.
6. Run tests and type checks.
7. Update documentation.
8. Report completed work, limitations, and remaining tasks.

Do not skip tests to save time.

Do not implement future phases unless explicitly requested.

Do not make architectural changes silently. Document significant decisions in ADRs.
