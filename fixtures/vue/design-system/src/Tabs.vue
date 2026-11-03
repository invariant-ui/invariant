<script lang="ts">
export default { inheritAttrs: false }
</script>

<script setup lang="ts">
defineOptions({ name: "Tabs" })
defineProps<{ active?: string }>()
</script>

<template>
  <div role="tablist"><slot /></div>
</template>
