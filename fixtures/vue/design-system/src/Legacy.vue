<script>
export default {
  props: ["a", "b"],
  emits: { change: (value) => value !== undefined }
}
</script>

<template><div><slot /></div></template>
