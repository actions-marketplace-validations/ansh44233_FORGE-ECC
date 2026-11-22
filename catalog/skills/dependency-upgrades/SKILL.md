---
description: Upgrade dependencies safely with changelog review and staged verification
profile: standard
tags: dependencies
---

# Dependency Upgrades
- Upgrade one package (or one coordinated group) at a time.
- Read the changelog/migration guide between current and target versions; list breaking changes.
- Update code, run typecheck and tests, then run the app's critical paths.
- Commit lockfile changes with the manifest change; note the upgrade reason in the commit message.
