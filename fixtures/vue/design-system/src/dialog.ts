import { defineComponent } from "vue"

export const Dialog = defineComponent({
  props: { open: Boolean, label: { type: String, default: "Dialog" } },
  emits: ["close"],
  setup() {
    return {}
  }
})
