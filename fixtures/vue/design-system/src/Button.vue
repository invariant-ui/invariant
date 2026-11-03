<script setup lang="ts">
import Spinner from "./Spinner.vue"

withDefaults(
  defineProps<{
    /** Visual weight of the button. */
    variant?: "primary" | "secondary" | "ghost"
    size?: "sm" | "md" | "lg"
    disabled?: boolean
    loading?: boolean
    /** @deprecated Use `variant="ghost"` instead. */
    plain?: boolean
  }>(),
  { variant: "primary", size: "md", disabled: false }
)

const emit = defineEmits<{
  (e: "press", event: MouseEvent): void
  (e: "focus-change", focused: boolean): void
}>()

defineSlots<{
  default(): unknown
  icon(props: { size: string }): unknown
}>()
</script>

<template>
  <button :class="['btn', variant]" role="button" :aria-busy="loading" :disabled="disabled" @click="emit('press', $event)">
    <Spinner v-if="loading" />
    <slot name="icon" :size="size" />
    <slot />
  </button>
</template>

<style scoped>
.btn {
  color: var(--color-action);
  padding: var(--space-md) var(--space-lg, 24px);
  background: v-bind(variant);
}
</style>
