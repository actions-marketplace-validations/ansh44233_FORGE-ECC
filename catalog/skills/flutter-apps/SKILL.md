---
description: Build and change Flutter apps: widget structure, state management, async UI, platform channels and tests
profile: full
languages: dart
tags: mobile, flutter, dart
---

# Flutter apps

Use when changing Flutter and Dart code.

## Widgets
- Prefer small `StatelessWidget`s and `const` constructors so Flutter can skip rebuilds.
- Keep business logic out of `build()`. It runs often and must be cheap and side-effect free.
- Lists: `ListView.builder` for long or unbounded lists.

## State
Pick one approach per app (Riverpod, Bloc, Provider) and keep state close to where it is used. Dispose controllers, streams and subscriptions.

## Async
- Show loading, error and empty states for every `FutureBuilder` and `StreamBuilder`.
- Check `mounted` (or `context.mounted`) before using `BuildContext` after an `await`.

## Platform and security
Request permissions at the point of use, store tokens in secure storage (Keychain or Keystore), and never ship secrets in the app bundle.

## Verify
`flutter analyze`, unit and widget tests (`flutter test`), a golden test for key screens, and an integration test on a real device or emulator for the main flow.
