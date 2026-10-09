# Migrating from basic-memory

simple-memory reads a basic-memory vault as it is: both are folders of markdown notes with
frontmatter, and basic-memory's database lives outside the vault, so there is nothing to convert.
Migrating is mostly pointing the plugin at the vault, plus a little cleanup so the hints work well
and the two systems don't run side by side.

## 1. Back up the vault

Commit it to git (or copy it) before the first session. simple-memory edits notes in place. The
first time it edits a note, it rewrites that note's frontmatter in its own order and format: lists
written inline, `title`, `summary`, `keywords` and `tags` first. That shows up as a one-off diff.

## 2. Point the plugin at the vault

Install the plugin (see the [README](../README.md#install)), then set its `directory` option to the
vault, with `/plugin configure simple-memory@simple-memory` or `/config`:

```
directory: ~/basic-memory          # or C:\Users\you\basic-memory on Windows
```

What carries over as it is:

- **Notes and folders**, at any depth. Folders and files whose names start with `.` (`.obsidian`,
  `.git`) are skipped.
- **Frontmatter**: `title` and `tags` are used; `type`, `permalink` and any other keys are kept
  untouched.
- **File names**: existing names, spaces and capitals included, keep their ids (`decisions/My Note`).
  Only notes written by simple-memory get slugified names (`decisions/my-note.md`).
- **Links**: `read_note` resolves `[[Title]]` and `[[folder/id]]` links alike.
- **Observations and relations** (`- [fact] …`, `- relates_to [[…]]`) are plain text to
  simple-memory: `search_notes` finds them, and the per-prompt hints don't look at them.

## 3. Tell the plugin the vault is set up

Without a `MEMORY.md` at the vault's root, the plugin's session-start context says the knowledge
base isn't initialized and suggests `/memory-init`. Pick one:

- **Keep your own guidelines** (your global `CLAUDE.md`, a guide note in each folder). Add a short
  `MEMORY.md` that points at them, for example:

  ```markdown
  # Memory structure

  Each folder has a guide note saying what belongs there; read it before writing to that folder.
  The general rules are in the global CLAUDE.md.
  ```

- **Or run `/memory-init`**. It sees the existing notes and folders, proposes a structure based on
  them, and writes `MEMORY.md` once you approve. It only adds a `.gitkeep` to folders that are
  empty, and doesn't move or change notes.

Whatever `MEMORY.md` says is injected into every session, next to the plugin's own short rules.
Per-folder guide notes are indexed like any other note, so they sometimes come up as hints.

## 4. Update your instructions

If your global `~/.claude/CLAUDE.md` (or a project's) mentions basic-memory or its tools, point it
at simple-memory's:

| | simple-memory |
| --- | --- |
| search | `mcp__simple-memory__search_notes` (frontmatter and full text; an empty query lists recent notes) |
| read | `mcp__simple-memory__read_note` (by id, path, `[[link]]` or title) |
| write | `mcp__simple-memory__write_note` (requires `summary` and 3 to 12 `keywords`) |
| edit | `mcp__simple-memory__edit_note` (append, prepend, find_replace, replace_section, replace_body; summary, keywords, tags) |
| move, delete | `mcp__simple-memory__move_note`, `mcp__simple-memory__delete_note` |

There's no equivalent of basic-memory's other tools (such as `build_context`, `recent_activity` or
canvases), so drop any guideline that depends on them.

## 5. Turn off the old setup

Two memory systems in one session confuse Claude, and two nudges are noise:

- Remove the basic-memory MCP server: `claude mcp remove <its name>` (`claude mcp list` shows it), or
  delete it from wherever you configured it.
- Remove any Stop hook or mod that reminded Claude to write basic-memory notes. simple-memory has
  its own nudge (`nudgeAfterFiles`, 3 edited files by default; `0` turns it off).

## 6. Backfill `summary` and `keywords` (recommended)

The per-prompt hints match only on frontmatter: keywords, title, tags, summary and the folder path.
basic-memory notes have no `summary` or `keywords`, so until they do, the hints fall back to each
note's headings and first paragraph and find less. `search_notes` labels such notes
"(no summary and keywords)", and Claude fills the fields in as it touches notes, so the vault
improves on its own over time.

To do it up front, ask Claude in a session, a folder at a time for a large vault:

```
List the notes in my simple-memory vault that have no "keywords:" line in their frontmatter
(for example with grep -rL '^keywords:' --include='*.md' <vault>/decisions).
For each one, read it with read_note and add a one-line summary and 3-12 keywords with
edit_note, changing only the frontmatter. Don't change the note bodies.
```

## Known differences

- **Moving a note rewrites `[[folder/id]]` links to it, but not `[[Title]]` links.** basic-memory
  links by title, so a move that also changes the title (or the file name a title link relies on)
  leaves those links pointing at the old name. `read_note` still finds a note by its title as long
  as the title is unchanged.
- **`permalink` isn't updated** when a note moves; simple-memory doesn't use it.
- **No semantic search and no cloud sync**, by design: matching is by keyword, and the vault is a
  plain folder you can sync or share with git.
