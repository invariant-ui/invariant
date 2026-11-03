<script setup lang="ts">
interface BaseFieldProps {
  label: string
  /** Hint text shown below the field. */
  hint?: string
}
interface Props extends BaseFieldProps {
  type?: "text" | "email" | "password"
  maxLength?: number
}
defineProps<Props & /* external */ Omit<ExternalInputAttrs, "type">>()
const value = defineModel<string>({ required: true })
const focused = defineModel<boolean>("focused", { default: false })
declare type ExternalInputAttrs = import("vue").InputHTMLAttributes
</script>

<template>
  <label>
    <input v-model="value" @focus="focused = true" aria-label="field" />
  </label>
</template>
