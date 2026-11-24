---
description: Report token usage and estimated spend for recent agent sessions
argument-hint: "[days]"
profile: standard
---

# /cost
1. Run `forge cost --json` (add `--days $ARGUMENTS` when a number is given).
2. Summarise sessions, tokens by model and the most expensive sessions.
3. Point out the largest saving available (for example, heavy cache writes, long sessions without compaction, or a large model used for small tasks), and label dollar figures as estimates.
