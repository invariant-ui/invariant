<script setup>
defineProps({
  tone: { type: String, default: "info", validator: (v) => ["info", "warn"].includes(v) },
  count: Number
})
defineEmits(["dismiss"])
</script>

<template>
  <span class="badge" :class="$style.root">{{ count }}</span>
</template>

<style module lang="scss">
.root { color: var(--color-brand); }
</style>
