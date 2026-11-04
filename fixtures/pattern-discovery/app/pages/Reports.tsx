import { Button, Card, IconButton, Modal, Stack } from "@acme/ui"

export const Reports = () => (
  <Stack>
    <Card>
      <Card.Header title="Reports" />
      <Card.Body>
      <IconButton aria-label="Help" />
        <Button>Open</Button>
      </Card.Body>
    </Card>
    <Modal open title="Delete?">
      <Button>Delete</Button>
    </Modal>
  </Stack>
)
