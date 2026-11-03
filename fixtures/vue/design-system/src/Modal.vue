<script lang="ts">
import { defineComponent, type PropType } from "vue"
import Button from "./Button.vue"

export default defineComponent({
  name: "AcmeModal",
  components: { Button },
  props: {
    open: { type: Boolean, required: true },
    size: { type: String as PropType<"sm" | "lg">, default: "sm" },
    title: String,
    tags: { type: Array as PropType<string[]>, default: () => [] }
  },
  emits: ["close", "update:open"]
})
</script>

<template>
  <div v-if="open" role="dialog" aria-modal="true">
    <h2>{{ title }}</h2>
    <slot />
    <slot name="actions"><Button variant="ghost" @press="$emit('close')">Close</Button></slot>
  </div>
</template>
