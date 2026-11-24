---
description: Internationalize apps correctly: message catalogs, ICU plurals, locale formatting, RTL and pseudo-localization
profile: full
tags: frontend, ux, i18n
---

# Internationalization

Use when adding languages or making text user-facing.

## Strings
- No concatenated sentences. Use full messages with named placeholders: `"{count, plural, one {# file} other {# files}}"` (ICU MessageFormat).
- Give translators context with a description per message, and never reuse one key for two meanings.
- Keep catalogs per locale under version control, and fail CI on missing keys in the default locale.

## Formatting
Use the platform's locale APIs (`Intl.DateTimeFormat`, `Intl.NumberFormat`, `Intl.RelativeTimeFormat`) for dates, numbers, currencies and units. Store times in UTC and convert at the edge.

## Layout
- Support right-to-left: use logical CSS properties (`margin-inline-start`) and `dir="rtl"`.
- Expect text to grow by around 30–40%; avoid fixed-width buttons.

## Locale selection
Respect an explicit user choice first, then `Accept-Language`. Put the locale in the URL for public pages, so they can be indexed and shared.

## Verify
Run pseudo-localization (accented, lengthened strings) to find hardcoded text and truncation. Test one RTL locale and plural edge cases (0, 1, 2, many).
