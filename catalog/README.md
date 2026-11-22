# FORGE harness catalog

FORGE-authored agents, skills, commands and rules that `forge install` renders into
Claude Code, Cursor, Codex, OpenCode and Gemini project files.

| Folder | Format |
|---|---|
| `agents/<id>.md` | frontmatter `description`, `profile`, optional `tools`, `tags` |
| `skills/<id>/SKILL.md` | frontmatter `description`, `profile`, optional `tags` |
| `commands/<id>.md` | frontmatter `description`, `profile`, optional `argument-hint`; `$ARGUMENTS` placeholder |
| `rules/<language>/<id>.md` | frontmatter `description`, `profile`, optional `globs` |

`profile` is the smallest install profile that includes the item: `minimal`, `standard` or `full`.
Ids use lowercase letters, digits and dashes. `npm test` validates every item.
