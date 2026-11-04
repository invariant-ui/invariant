import { Button, Card, IconButton, Modal } from "@acme/ui"

export const Bad = () => (
  <Card>
    <Card.Body>
      <IconButton aria-label="Help" />
    </Card.Body>
    <Card.Header title="Late" />
    <Card>
      <Card.Body />
    </Card>
    <Modal open title="First">Just text</Modal>
    <Modal open title="Second">
      <Button>Ok</Button>
    </Modal>
  </Card>
)
