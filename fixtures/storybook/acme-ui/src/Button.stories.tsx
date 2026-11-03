import type { Meta, StoryObj } from "@storybook/react"
import { expect, fn, userEvent, within } from "@storybook/test"
import { Button } from "./Button"
import { Icon } from "./Icon"

const sizes = ["sm", "md", "lg"] as const

const meta = {
  title: "Components/Button",
  component: Button,
  tags: ["autodocs"],
  args: { children: "Click me", onPress: fn() },
  argTypes: {
    variant: {
      control: "select",
      options: ["primary", "secondary", "ghost", "danger"],
      description: "Visual weight",
      table: { defaultValue: { summary: "secondary" } }
    },
    size: { control: { type: "radio" }, options: sizes },
    icon: { control: "select", options: ["none", "gear"], mapping: { none: undefined, gear: <Icon name="gear" /> } },
    plain: { control: "boolean" },
    tone: { control: "color" },
    loading: { table: { defaultValue: { summary: "false" } } }
  },
  excludeStories: /^Hidden/,
  parameters: {
    layout: "centered",
    a11y: { config: { rules: [{ id: "color-contrast", enabled: false }] } },
    docs: { description: { component: "Triggers an action." } }
  }
} satisfies Meta<typeof Button>

export default meta
type Story = StoryObj<typeof meta>

/** The default call to action. */
export const Primary: Story = { args: { variant: "primary", size: "lg" } }

export const Danger: Story = { args: { ...Primary.args, variant: "danger" } }

export const Deprecated: Story = { args: { plain: true, bogus: "x" } }

export const WithIcon: Story = {
  name: "With an icon",
  args: { icon: "gear" },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement)
    await step("press the button", async () => {
      await userEvent.click(canvas.getByRole("button"))
    })
    await expect(canvas.getByRole("button")).toBeEnabled()
  }
}

export const HiddenHelper = () => null
