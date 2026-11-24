---
description: Build and change React Native and Expo apps: navigation, lists, native modules, offline state and release
profile: full
languages: react
tags: mobile, react, typescript
---

# React Native apps

Use when changing React Native or Expo code.

## Performance
- Lists: `FlatList` or `FlashList` with stable `keyExtractor`s and memoized rows. Never map a long array inside a `ScrollView`.
- Avoid unnecessary re-renders: memoize callbacks passed to rows, and keep heavy work off the JS thread (Reanimated worklets for animation).
- Optimize images: use the right sizes and a caching image component.

## Navigation and state
Use typed routes (React Navigation or Expo Router). Persist only what the app needs offline, and handle offline and slow networks explicitly.

## Native and platform
- Test on both iOS and Android; behavior differs (keyboard, back button, permissions, safe areas).
- Prefer Expo modules or well-maintained libraries over custom native code, and upgrade the SDK on schedule.

## Security
Store tokens in secure storage (Keychain or Keystore via `expo-secure-store`), not AsyncStorage. Never ship API secrets in the bundle: it can be extracted.

## Release
Use EAS or Fastlane builds from CI, staged rollouts, and OTA updates only for JavaScript-compatible changes.

## Verify
Jest and React Native Testing Library for components, type check, and an end-to-end test (Detox or Maestro) for the main flow on both platforms.
