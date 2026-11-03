<script setup lang="ts" generic="T extends { id: string }">
defineProps<{ items: T[]; selected?: T }>()
defineSlots<{ item(props: { item: T }): unknown }>()
</script>

<template>
  <ul><li v-for="item in items" :key="item.id"><slot name="item" :item="item" /></li></ul>
</template>
