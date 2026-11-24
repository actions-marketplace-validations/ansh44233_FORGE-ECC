---
description: Build and change Kotlin Android apps: Jetpack Compose, coroutines, lifecycle-aware state and testing
profile: full
languages: kotlin
tags: mobile, kotlin, android
---

# Kotlin Android apps

Use when changing Android code in Kotlin.

## UI
- Jetpack Compose with state hoisting: screens take state and callbacks, and ViewModels own the state.
- Use `remember` and `derivedStateOf` deliberately. Keep composables side-effect free, and use `LaunchedEffect` for effects.
- Collect flows with `collectAsStateWithLifecycle` so work stops in the background.

## Concurrency
- Use structured coroutines: `viewModelScope` and `lifecycleScope`, never `GlobalScope`.
- Do IO on `Dispatchers.IO`, and never block the main thread.
- Expose `StateFlow` from ViewModels, and handle cancellation correctly (do not swallow `CancellationException`).

## Data
Room for local data, with migrations tested. Repository classes sit in front of network and database. Use WorkManager for deferrable background work.

## Security
EncryptedSharedPreferences or the Keystore for tokens. Keep secrets out of the APK, and use network security config to block cleartext traffic.

## Verify
Unit tests with `kotlinx-coroutines-test`, Compose UI tests, lint (`./gradlew lint`), and a run on a device or emulator for the changed flow.
