<script setup lang="ts">
withDefaults(defineProps<{ size?: "sm" | "md" | "lg" }>(), { size: "md" })
defineEmits<{ press: [event: MouseEvent] }>()
</script>
<template><button :data-size="size" @click="$emit('press', $event)"><slot /></button></template>
