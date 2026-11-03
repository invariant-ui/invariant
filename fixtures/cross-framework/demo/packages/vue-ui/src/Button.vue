<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: "primary" | "secondary" | "ghost"
    size?: "sm" | "md" | "lg"
    disabled?: boolean
    label: string
  }>(),
  { variant: "primary", size: "md", disabled: false }
)
const emit = defineEmits<{ (e: "press", event: MouseEvent): void }>()
defineSlots<{ default(): unknown; icon(): unknown }>()
</script>

<template>
  <button role="button" :disabled="disabled" :aria-label="label" @click="emit('press', $event)">
    <slot name="icon" />
    <slot />
  </button>
</template>

<style scoped>
.root { color: var(--color-action); }
</style>
