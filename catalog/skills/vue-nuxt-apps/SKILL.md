---
description: Build and change Vue 3 and Nuxt apps: Composition API, reactivity pitfalls, data fetching, SSR and testing
profile: standard
languages: vue
tags: frontend, vue, nuxt, typescript
---

# Vue and Nuxt apps

Use when changing Vue 3 or Nuxt code.

## Components
- `<script setup lang="ts">` with typed `defineProps` and `defineEmits`. Props flow down and events flow up. Never mutate a prop.
- Extract reusable logic into composables (`useX`) that return refs and functions.
- Keep templates simple. Move logic into `computed` values.

## Reactivity pitfalls
- Destructuring a reactive object loses reactivity: use `toRefs`, or keep refs.
- Use `computed` for derived state, not `watch` plus a copy.
- Replace or deep-watch nested objects deliberately. Large reactive objects are expensive, so use `shallowRef` for big immutable data.

## State and data
- Use Pinia for shared state, and local state everywhere else.
- In Nuxt, fetch with `useFetch` or `useAsyncData` with a stable key, so SSR data hydrates without double-fetching. Handle `pending` and `error`.
- Keep secrets in `runtimeConfig` (server-only keys); only `public` keys reach the client.

## SSR
No `window` or `document` access during setup on the server. Use `onMounted` or `<ClientOnly>`. Avoid hydration mismatches from random values or dates rendered differently on the two sides.

## Verify
Vitest plus Vue Test Utils for components, type check with `vue-tsc`, and an end-to-end test for the main flow.
