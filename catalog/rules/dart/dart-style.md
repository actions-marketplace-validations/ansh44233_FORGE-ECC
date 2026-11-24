---
description: Dart and Flutter conventions
profile: standard
globs: **/*.dart
---

# Dart
- Sound null safety: avoid `!`; handle null explicitly.
- `const` constructors for widgets where possible; keep `build()` pure and cheap.
- Check `context.mounted` after `await` before using a `BuildContext`.
- Dispose controllers, streams and subscriptions.
