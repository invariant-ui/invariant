import { Button, Card, IconButton, Modal, Stack } from "@acme/ui"

export const Good = () => (
  <Stack>
    <Card>
      <Card.Header title="Settings" />
      <Card.Body>
        <IconButton aria-label="Help" />
      </Card.Body>
    </Card>
    <Modal open title="Delete?">
      <Button>Delete</Button>
    </Modal>
  </Stack>
)
