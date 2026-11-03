import { Button } from "./Button"
import { Card } from "./Card"
import { Icon } from "./Icon"
import { Select } from "./Select"
import { Text } from "./Text"

export function Dashboard() {
  return (
    <Card elevated>
      <Card.Header title="Overview" />
      <Card.Body>
        <Text tone="danger">Careful</Text>
        <Select options={["a", "b"]} getKey={(o) => o} />
        <Button variant="primary" size="lg">Save</Button>
        <Button variant="danger">Delete</Button>
        <Button variant={pick()}>Dynamic</Button>
        <Icon name="gear" />
      </Card.Body>
      <Card shadow />
    </Card>
  )
}

declare function pick(): "primary"
