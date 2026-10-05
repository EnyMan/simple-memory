# simple-memory

A Claude Code mod that gives Claude a local, plain-markdown knowledge base, a lightweight take on
[basic-memory](https://github.com/basicmachines-co/basic-memory) without the cloud sync and without
semantic search. Everything runs inside Claude Code as function hooks: there's no server, no
database and no embeddings.

## What it does

| Piece | Behaviour |
| --- | --- |
| **Keyword hints** | On every prompt, the prompt is reduced to keywords (common words like *is*, *a*, *and*, *the* and filler like *please*/*help* are removed, and words are lightly stemmed). The keywords are scored against each note's title, tags, folder path and body, weighted by how rare each word is. Up to 5 matching notes are attached to the prompt as a hidden `<simple-memory-hint>`. A note is suggested at most once per conversation, and notes already read are never suggested. |
| **Tools** | `mcp__simple-memory__search_notes`, `read_note`, `write_note`, `edit_note` (append / prepend / find_replace / replace_section / replace_body, plus title and tags) and `init_memory`. |
| **Band** | A row above the prompt lists this conversation's notes: read notes first (`●`), then suggested ones not read yet (`○`). Clicking a note inserts `[[note-id]]` into the prompt. |
| **Session start** | The conversation's opening context gets the usage rules, the structure guide (`MEMORY.md`) and the most recently updated notes. |
| **`/memory-init`** | A guided interview: Claude asks what the knowledge base is for (a general shared team KB, a personal second brain, project docs, research…), proposes a folder tree and conventions, revises it with you, then writes `MEMORY.md` and creates the folders. Run it again later to restructure. You can pass a head start: `/memory-init shared wiki for the platform team`. |

Opening a note with the built-in Read tool also marks it as read.

## Notes on disk

```
~/simple-memory/
├── MEMORY.md                  # structure + conventions, written by /memory-init
├── decisions/
│   └── use-postgres.md
└── how-to/
    └── deploy-backend.md
```

```markdown
---
title: Use Postgres
tags: [database, backend]
created: 2026-10-05T12:00:00Z
updated: 2026-10-05T12:00:00Z
---

We chose Postgres over MySQL for JSONB support. See [[how-to/deploy-backend]].
```

A note's id is its path under the root without `.md`. The tools accept an id, a path, a `[[link]]`
or the exact title. Files and folders whose names start with `.` are ignored. Because notes are
plain files, the folder can be a git repository that a team shares.

## Options

Set these in `/config` or under `pluginConfigs["simple-memory"].options` in settings:

| Option | Default | Meaning |
| --- | --- | --- |
| `directory` | `~/simple-memory` | Where the notes live. Absolute, `~/…`, or relative to the project (e.g. `docs/memory` for a per-repo KB). |
| `maxHints` | `5` | The most notes hinted for one prompt (`0` turns hints off). |
| `recentNotes` | `10` | Recently updated notes listed at session start. |
| `extraStopwords` | `""` | More words to ignore, comma- or space-separated (handy for prompts in another language). |

## Install / develop

```sh
claude --plugin-dir /path/to/simple-memory         # load it for one session
claude plugin validate /path/to/simple-memory      # check manifest and hooks
claude plugin test /path/to/simple-memory          # run tests/*.test.ts
```

Layout: `hooks/register.tsx` (hooks, tools, band, command), `hooks/keywords.ts` (stopwords, stemming,
scoring), `hooks/notes.ts` (frontmatter and note edits), `types/index.d.ts` (session state contract).
