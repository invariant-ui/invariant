import { Button, Card, IconButton, Modal, Stack } from "@acme/ui"

export const Orders = () => (
  <Stack>
    <Card>
      <Card.Header title="Orders" />
      <Card.Body>
        <Button>Open</Button>
      </Card.Body>
    </Card>
    <Modal open title="Delete?">
      <Button>Delete</Button>
    </Modal>
  </Stack>
)
