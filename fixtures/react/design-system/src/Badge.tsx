import styled from "styled-components"

export const Badge = styled.span<{ tone?: "info" | "warn" }>`
  color: var(--color-brand);
  padding: var(--space-md);
`
