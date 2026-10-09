# simple-memory

A Claude Code mod that gives Claude a local, plain-markdown knowledge base, a lightweight take on
[basic-memory](https://github.com/basicmachines-co/basic-memory) without the cloud sync and without
semantic search. Everything runs inside Claude Code as function hooks: there's no server, no
database and no embeddings.

## Install

The repository is its own plugin marketplace. In Claude Code:

```
/plugin marketplace add EnyMan/simple-memory
/plugin install simple-memory@simple-memory
```

or from a shell:

```sh
claude plugin marketplace add EnyMan/simple-memory
claude plugin install simple-memory@simple-memory
```

Then run `/memory-init` to set up the knowledge base. Options use their defaults until you change
them with `/plugin configure simple-memory@simple-memory` (or `/config`). Update later with
`claude plugin marketplace update simple-memory` and `claude plugin update simple-memory@simple-memory`.

Coming from basic-memory with an existing vault? See
[Migrating from basic-memory](docs/migrating-from-basic-memory.md).

## What it does

| Piece | Behaviour |
| --- | --- |
| **Keyword hints** | On every prompt, the prompt is reduced to keywords (common words like *is*, *a*, *and*, *the* and filler like *please*/*help* are removed, and words are lightly stemmed). The keywords are scored against each note's frontmatter (keywords, title, tags, summary) and folder path, not its body, weighted by how rare each word is. Up to 5 matching notes are attached to the prompt as a hidden `<simple-memory-hint>`, each with its summary. A note is suggested at most once per conversation, and notes already read are never suggested. |
| **Tools** | `mcp__simple-memory__search_notes` (frontmatter and full text), `read_note`, `write_note` (requires a summary and keywords), `edit_note` (append / prepend / find_replace / replace_section / replace_body, plus title, summary, keywords and tags), `move_note` (to a folder, or a new id; `[[links]]` in other notes are rewritten), `delete_note` (reports notes still linking to it) and `init_memory`. |
| **Band** | A row above the prompt lists this conversation's notes: read notes first (`●`), then suggested ones not read yet (`○`). Clicking a note inserts `[[note-id]]` into the prompt. |
| **Session start** | The conversation's opening context gets the usage rules, the structure guide (`MEMORY.md`) and the most recently updated notes. |
| **Memory nudge** | Edits made with Edit, Write, MultiEdit and NotebookEdit are tracked as a set of distinct files. When a main-session turn ends with a normal answer and 3+ files have been edited since the last note, the plugin starts one follow-up turn asking Claude whether there is a non-obvious learning or a finished chunk worth recording, and to reply "No note needed." otherwise. Never in headless (`-p`/SDK) runs, after subagent turns, or after interrupted or failed turns. Writing, editing or moving a note (or editing a note file directly) resets the count. The count survives plugin reloads and resets on `/clear`. Bash, research and reading don't count. |
| **`/memory-init`** | A guided interview: Claude asks what the knowledge base is for (a general shared team KB, a personal second brain, project docs, research…), proposes a folder tree and conventions, revises it with you, then writes `MEMORY.md` and creates the folders. Run it again later to restructure. You can pass a head start: `/memory-init shared wiki for the platform team`. |

Opening a note with the built-in Read tool also marks it as read. Deleting uses `rm` (`del` on
Windows), since the plugin API has no file delete, and checks that the file is gone afterwards.

Meant for macOS, Linux and Windows (the Windows handling is covered by tests that use Windows
paths, run on Linux). The plugin builds paths with forward slashes, which Windows
accepts, and compares paths it gets from other tools (`C:\Users\…`) without regard to separator,
or to case on Windows. Notes keep their own line endings (`\r\n` or `\n`) when edited. The
`directory` option takes either kind of path (`~\notes`, `C:\kb`, `\\server\share\kb`).

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
summary: Why we chose Postgres over MySQL for the main store.
keywords: [postgres, database, mysql, jsonb, storage]
tags: [decision, backend]
created: 2026-10-05T12:00:00Z
updated: 2026-10-05T12:00:00Z
---

We chose Postgres over MySQL for JSONB support. See [[how-to/deploy-backend]].
```

Every note has a `title`, a one-line `summary` and 3 to 12 `keywords`; `write_note` refuses a note
without them, and `edit_note` can update them. The per-prompt hints match only on this frontmatter
(plus the folder path), which keeps the index small; `search_notes` also searches the full text.
Notes from before the schema still work: their headings stand in for keywords and their first
paragraph for the summary, and `search_notes` flags them so Claude can fill the fields in.

A note's id is its path under the root without `.md`. The tools accept an id, a path, a `[[link]]`
or the exact title. Files and folders whose names start with `.` are ignored. Because notes are
plain files, the folder can be a git repository that a team shares.

## Performance

Measured with `bun bench/run.ts` on synthetic knowledge bases laid out like a real one (60 folders,
3 deep). These are medians through Claude Code's plugin engine; full results, the method and a
worst-case layout are in [bench/README.md](bench/README.md):

| | 100 notes | 1,000 notes | 5,000 notes |
| --- | ---: | ---: | ---: |
| First prompt of a session (the index builds in the background) | 5 ms | 2 ms | 2 ms |
| Background index build, until complete | 100 ms | 470 ms | 1.6 s |
| Later prompts | 31 ms | 27 ms | 66 ms |
| `search_notes` (frontmatter + full text) | 26 ms | 38 ms | 130 ms |

Until the background build completes, hints cover only the notes read so far. Each prompt lists
every folder once, so folders count as much as notes: 5,000 notes in 60 folders cost about what
1,000 notes in 345 folders do (66 vs 72 ms).

## Options

Set these in `/config` or under `pluginConfigs["simple-memory"].options` in settings:

| Option | Default | Meaning |
| --- | --- | --- |
| `directory` | `~/simple-memory` | Where the notes live. Absolute, `~/…`, or relative to the project (e.g. `docs/memory` for a per-repo KB). |
| `maxHints` | `5` | The most notes hinted for one prompt (`0` turns hints off). |
| `nudgeAfterFiles` | `3` | Distinct edited files before the memory nudge (`0` turns it off). |
| `recentNotes` | `10` | Recently updated notes listed at session start. |
| `extraStopwords` | `""` | More words to ignore, comma- or space-separated (handy for prompts in another language). |

## Develop

```sh
claude plugin marketplace add /path/to/simple-memory   # a folder marketplace: edits apply on /reload-plugins
claude --plugin-dir /path/to/simple-memory             # or load it for one session, hot-reloading on save
claude plugin validate /path/to/simple-memory          # check manifest and hooks
claude plugin test /path/to/simple-memory              # run tests/*.test.ts
bun bench/run.ts                                       # benchmark: see bench/README.md
```

Layout: `hooks/register.tsx` (hooks, tools, band, command, nudge), `hooks/keywords.ts` (stopwords,
stemming, scoring), `hooks/notes.ts` (frontmatter and note edits), `hooks/indexer.ts` (the
cached note index), `bench/` (benchmark), `types/index.d.ts` (session state
contract), `.claude-plugin/marketplace.json` (the marketplace listing this repo as one plugin).
