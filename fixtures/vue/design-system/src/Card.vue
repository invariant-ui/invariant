<script setup lang="ts">
import { ref } from "vue"

const { elevated = false, as = "div" } = defineProps<{ elevated?: boolean; as?: "div" | "section" }>()
const open = ref(true)
const dynamicName = "extra"
function toggle() {
  open.value = !open.value
}
defineExpose({ toggle, open })
</script>

<template>
  <component :is="as" class="card" :data-elevated="elevated">
    <header><slot name="header" /></header>
    <slot />
    <slot :name="dynamicName" />
    <footer><slot name="footer" :open="open" /></footer>
  </component>
</template>

<style>
.card { box-shadow: var(--shadow-card); }
</style>
