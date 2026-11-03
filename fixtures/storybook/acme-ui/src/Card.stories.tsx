import type { Meta, StoryObj } from "@storybook/react"
import { Card } from "./Card"

const meta: Meta<typeof Card> = {
  title: "Components/Card",
  component: Card,
  args: { elevated: true, shadow: true },
  argTypes: { shadow: { control: "boolean" }, elevated: { control: "boolean" } }
}
export default meta

export const Basic: StoryObj<typeof Card> = {
  render: (args) => (
    <Card {...args}>
      <Card.Header title="Hello" />
      <Card.Body>Body</Card.Body>
    </Card>
  )
}

export const Plain: StoryObj<typeof Card> = { args: { elevated: false, shadow: true } }
