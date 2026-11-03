import { Badge, Button, Buttn, Card, Icon, Modal } from "@acme/ui"

export const Screen = () => (
  <main style={{ color: "#123456", border: "1px solid #0057ff" }}>
    <Button variant="danger" plain>Save</Button>
    <Button icon={<Icon name="x" />} />
    <Badge tonne="info" />
    <Modal title="Hello">Body</Modal>
    <Buttn />
    <Icon name="star" />
    <Card>
      <Card.Header />
      <Button>Inside card</Button>
    </Card>
    <Modal open>
      <Card.Header />
    </Modal>
    <p className="a" style={{ color: "var(--color-old)", background: "var(--nope)" }}>text</p>
  </main>
)
