# mentat: instructions for AI agents

This is a personal knowledge base. It gives any AI assistant (Claude, OpenCode, others) the context for the owner's ongoing work and life admin, so they don't have to explain things again.

## Start here

1. Read [[me]] for who the owner is and how they like to work.
2. Read `INDEX.md` for the list of notes. It is generated automatically.
3. Open only the notes relevant to the task. Follow `[[links]]` to find related context.
4. For anything dated, check the latest file in `logs/`.

## Layout

| Folder | What it holds |
| --- | --- |
| `me.md` | Profile, working style, writing preferences |
| `areas/` | Ongoing parts of life: job hunt, applications, home, side work |
| `projects/` | Software projects |
| `people/` | People you deal with, with role and context |
| `logs/` | Month-by-month log of what happened and what was decided |
| `raw/` | Chat exports. **Not in git** (see `.gitignore`) |
| `scripts/` | Import, index and safety-check tools |
| `assets/` | README banner and icon |
| `docs/` | Setup notes for Obsidian, CI and the hosted MCP server |
| `mcp/` | Cloudflare Worker that serves these notes as an MCP server |

## Note format

Every note has YAML frontmatter, then short sections:

```markdown
---
title: Acme Cloud
type: area
status: active        # active | waiting | done
updated: 2026-11-04
tags: [job-hunt]
---

## Status
## Key facts
## Next steps
## Related
- [[job-hunt]]
```

- One topic per note. File name is the slug: `areas/acme-cloud.md` is `[[acme-cloud]]`.
- Link generously with `[[slug]]`. Links are the graph.
- Put dates in ISO format (2026-11-04).
- Write facts the owner has stated or that come from documents. Mark guesses as guesses.

## Rules

- **Summaries only.** Never commit raw chat exports, bank details, ID numbers or passwords.
- **Keep sensitive records elsewhere.** Evidence for a dispute, medical detail or legal papers belong in a separate private repo. Here, keep a short summary.
- **Writing style:** follow [[me]].
- **Update as you go.** When something changes, update the note's `Status`, `Next steps` and `updated:` date, and add a line to the current month's log.
- Do not edit `INDEX.md` or `graph.json` by hand. CI regenerates them.
