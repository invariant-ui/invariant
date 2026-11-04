import { Button, Card, IconButton, Modal, Stack } from "@acme/ui"

export const Invoices = () => (
  <Stack>
    <Card>
      <Card.Header title="Invoices" />
      <Card.Body>
        <Button>Open</Button>
      </Card.Body>
    </Card>
    <Modal open title="Delete?">
      <Button>Delete</Button>
    </Modal>
  </Stack>
)
