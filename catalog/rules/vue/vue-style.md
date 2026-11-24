---
description: Vue conventions
profile: standard
globs: **/*.vue
---

# Vue
- `<script setup lang="ts">` with typed props and emits; never mutate props.
- `computed` for derived state; do not destructure reactive objects without `toRefs`.
- Reusable logic in composables; shared state in Pinia.
- No browser globals during SSR setup.
