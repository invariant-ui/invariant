import { Card, Modal } from "@acme/ui"
import { Actions } from "./Actions"

export const Open = ({ children }: { children: unknown }) => (
  <Card>
    <Actions />
    <Modal open title="Anything">
      {children}
    </Modal>
  </Card>
)
