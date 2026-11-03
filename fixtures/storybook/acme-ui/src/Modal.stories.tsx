import { Modal } from "./Modal"

export default {
  title: "Components/Modal",
  component: Modal,
  argTypes: {
    size: { control: "radio", options: ["sm", "lg", "xl"], table: { defaultValue: { summary: "lg" } } }
  }
}

export const Open = { args: { open: true, size: "xl", title: "Hi" } }
