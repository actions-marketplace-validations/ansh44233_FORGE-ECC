---
description: Build SwiftUI apps: state ownership, concurrency with actors, previews, accessibility and tests
profile: standard
languages: swift
tags: swift, ios, mobile
---

# SwiftUI apps

Use in Swift packages or Xcode projects.

## State
- One owner per piece of state. Use `@State` for view-local values; for shared models, use `@Observable` classes (iOS 17+) or `ObservableObject` with `@StateObject` at the owner and `@ObservedObject` below.
- Do not create an `ObservableObject` with `@ObservedObject` in the view that owns it; it will be recreated on redraw.
- Keep views small and derive values instead of storing duplicates.

## Concurrency
- UI updates on the main actor: mark view models `@MainActor`.
- Use `.task {}` for work tied to a view's lifetime; it is cancelled automatically.
- Protect shared mutable state with actors. Fix Swift 6 strict-concurrency warnings instead of suppressing them.

## Quality
- Accessibility: labels for icon-only buttons, Dynamic Type support, enough contrast, and VoiceOver order checked.
- Secrets never in the bundle; tokens in the Keychain.
- Previews with sample data for each important state (empty, loading, error).

## Verify
`swift build` and `swift test` for packages, or `xcodebuild test -scheme <Scheme> -destination 'platform=iOS Simulator,name=<device>'`. SwiftLint if configured.
