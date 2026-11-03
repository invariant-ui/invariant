import { Badge, Button, Card } from "@acme/ui"

export const Clean = () => (
  <Card>
    <Card.Header title="Hello" />
    <Card.Body>
      <Button variant="ghost" size="sm">Go</Button>
      <Badge tone="warn" />
      <Button aria-label="Close" icon={null}>x</Button>
      <p style={{ color: "var(--color-brand)" }}>ok</p>
    </Card.Body>
  </Card>
)
