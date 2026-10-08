# Benchmark

How long simple-memory's hooks take as the knowledge base grows: mainly the keyword hint that runs
on every prompt, plus the index walk that `search_notes`, `read_note` and the opening context share.

## Running it

From the repository root, with [Bun](https://bun.sh) and `claude` on the PATH:

```sh
bun bench/run.ts                          # 100, 1,000 and 5,000 notes; disk + engine; prints a markdown table
bun bench/run.ts --sizes 100,2000         # other sizes
bun bench/run.ts --skip-engine --json     # disk part only, raw rows as JSON
bun bench/run.ts --layout wide            # the walk's worst case: 1,162 folders at 5,000 notes
```

A full run takes about 2 minutes. Everything is written to a temp directory and removed afterwards.

## What it measures

- **Corpus** (`bench/corpus.ts`): deterministic synthetic notes with frontmatter (title, a one-line
  summary, 3 to 12 keywords, 1 to 3 tags) in one of two folder layouts:
  - `realistic` (the default), modelled on a real basic-memory knowledge base: 13 top-level
    folders plus `projects/` with 23 projects, each with a `progress/` folder. That's 60 folders,
    3 deep. Half the notes go under `projects/`, half of those into `progress/`.
  - `wide`: 8 top-level folders with 40% of notes one level deeper, under one of 200 random names
    each. That's 1,162 folders at 5,000 notes, and the layout of the runs before
    [#5](https://github.com/EnyMan/simple-memory/issues/5).

  Bodies are 1 to 20 KB
  (log-uniform, about 6.6 KB on average) of Zipf-distributed words drawn from an 8,000-word
  vocabulary. 5,000 notes come to about 33 MB.
- **disk** rows: the plugin's own `hooks/indexer.ts` and `hooks/keywords.ts`, run in Bun against
  files on disk, with `node:fs` standing in for `$.fs`. A list call stats each file, as `$.fs.list`
  does.
  - *cold*: a fresh index that parses every note.
  - *warm*: nothing changed, so a walk plus mtime checks only.
  - *one note changed*: one file's mtime moved before each run.
  - *scoring*: `keywords()` + `relevant()` over the whole index (frontmatter only), for the prompts
    in `bench/corpus.ts`.
  - *search*: `search()` over the whole index: frontmatter plus a full-text scan of every body.
  - *whole hint path*: keywords, warm index and scoring together.
- **engine** rows: the real `prompt.submit` hook, run by `claude plugin test` (`bench/engine.bench.ts`,
  copied into a scratch copy of the plugin) over an in-memory file system. Every `$.fs` call goes
  through the engine's dispatch, as in a session, but there is no disk I/O.
  - *dispatch floor*: a prompt with no keywords, which returns before touching the index.
  - *search_notes*: the tool called through the engine, on a warm index.

## Results

Median / p95 in ms, Bun 1.3.14, Claude Code 2.1.289, Linux 6.18. One run of each cold measurement
through the engine. The dispatch floor's p95 is its first call warming up; the median is the steady
state. Each table names its machine; compare rows within a table rather than across tables.

### Current: realistic folder layout ([#5](https://github.com/EnyMan/simple-memory/issues/5))

Same code as [#4](https://github.com/EnyMan/simple-memory/issues/4), measured on both layouts on
one machine (Intel Xeon @ 2.10 GHz, 4 threads, 16 GB).

**`realistic` layout (60 folders):**

| measurement | 100 notes | 1,000 notes | 5,000 notes |
| --- | ---: | ---: | ---: |
| disk: index, cold (parse every note) | 12.7 / 23.3 | 51.0 / 89.7 | 310 / 335 |
| disk: index, warm (walk + stat only) | 6.23 / 9.15 | 9.71 / 10.7 | 28.8 / 56.8 |
| disk: index, one note changed | 6.10 / 8.14 | 8.93 / 10.5 | 24.1 / 29.7 |
| scoring: keywords + relevant() (frontmatter) | 0.06 / 0.18 | 1.26 / 2.22 | 8.52 / 14.7 |
| search: frontmatter + full text over all notes | 3.53 / 6.02 | 33.8 / 61.0 | 179 / 324 |
| disk: whole hint path, warm | 5.75 / 8.22 | 12.3 / 21.8 | 50.8 / 70.8 |
| engine: no-keyword prompt (dispatch floor) | 0.53 / 246 | 0.47 / 91.5 | 0.51 / 99.3 |
| engine: first prompt (walk runs in background) | 5.15 | 2.27 | 1.79 |
| engine: first walk, until complete (background) | 100 | 470 | 1588 |
| engine: later prompt (warm index) | 31.2 / 41.5 | 27.1 / 34.9 | 65.7 / 118 |
| engine: prompt after one note changed | 22.3 / 25.9 | 30.1 / 42.4 | 57.1 / 71.7 |
| engine: search_notes (warm index) | 25.7 / 42.1 | 37.7 / 52.2 | 130 / 214 |

**`wide` layout (1,162 folders at 5,000 notes), same machine:**

| measurement | 100 notes | 1,000 notes | 5,000 notes |
| --- | ---: | ---: | ---: |
| disk: index, cold (parse every note) | 14.9 / 19.8 | 103 / 119 | 426 / 448 |
| disk: index, warm (walk + stat only) | 5.16 / 10.1 | 41.4 / 102 | 161 / 239 |
| disk: index, one note changed | 4.96 / 6.32 | 41.7 / 44.1 | 146 / 202 |
| scoring: keywords + relevant() (frontmatter) | 0.06 / 0.16 | 1.24 / 1.99 | 8.62 / 12.7 |
| search: frontmatter + full text over all notes | 3.77 / 5.74 | 38.5 / 61.8 | 190 / 296 |
| disk: whole hint path, warm | 5.76 / 7.78 | 47.6 / 72.5 | 186 / 238 |
| engine: no-keyword prompt (dispatch floor) | 0.54 / 129 | 0.70 / 135 | 0.41 / 90.1 |
| engine: first prompt (walk runs in background) | 4.41 | 2.23 | 1.68 |
| engine: first walk, until complete (background) | 79.4 | 724 | 1309 |
| engine: later prompt (warm index) | 26.0 / 49.3 | 71.8 / 93.2 | 172 / 190 |
| engine: prompt after one note changed | 20.9 / 27.4 | 55.7 / 117 | 158 / 212 |
| engine: search_notes (warm index) | 21.2 / 39.8 | 66.0 / 120 | 250 / 378 |

- **The folder count drove warm-prompt cost.** With the realistic layout a later prompt costs 66 ms
  at 5,000 notes instead of 172 ms (27 ms instead of 72 ms at 1,000), because the walk makes one
  `$.fs.list` per folder: 60 instead of about 1,160. What remains is the per-file mtime check and
  scoring (9 ms).
- **The first walk is unchanged by the layout**: 0.5 s at 1,000 notes and 1.3 to 1.6 s at 5,000,
  dominated by reading every file once. Since [#4](https://github.com/EnyMan/simple-memory/issues/4)
  it runs in the background and no prompt waits for it.

### Decision: no persisted index (for now)

[#5](https://github.com/EnyMan/simple-memory/issues/5) asked whether the index should also live on
disk, as an mtime-checked cache (path → mtime, title, summary, keywords, tags) that a new session
loads instead of reading every note. The threshold set there was a cold walk over 1 s at 5,000
notes. It is 1.6 s, but that threshold was set while the first walk blocked the first prompt. Since
[#4](https://github.com/EnyMan/simple-memory/issues/4) it doesn't, so what a cache would buy is a
shorter window (about 1.5 s at 5,000 notes, 0.4 s at 1,000) in which hints cover only part of the
knowledge base. Against that:

- It's a second copy of the frontmatter that must stay right: written whole after each walk,
  validated by mtime on load, and discarded when it can't be parsed.
- Several sessions write it. Correctness doesn't need a lock (each session still walks the folders
  and trusts an entry only while the file's mtime matches), but the sessions overwrite each
  other's cache file and re-read what the other changed.
- It doesn't help warm prompts, which are already about 30 to 70 ms in a realistic layout.

So it's not added. Revisit if knowledge bases reach several thousand notes and the partial-hint
window at session start becomes noticeable: the design above still applies.

### First walk in the background ([#4](https://github.com/EnyMan/simple-memory/issues/4))

The first walk starts at `session.start` and nothing waits for it: until it completes, the
per-prompt hint scores whatever it has read so far, and the opening context lists recent notes
from the directory listings alone. Tools that need the full index join the walk in progress. Walks
are shared by concurrent callers, and a walk reads changed notes 16 at a time.

`wide` layout. Intel Xeon @ 2.10 GHz (4 threads).

| measurement | 100 notes | 1,000 notes | 5,000 notes |
| --- | ---: | ---: | ---: |
| disk: index, cold (parse every note) | 10.8 / 28.2 | 91.9 / 101 | 426 / 444 |
| disk: index, warm (walk + stat only) | 4.99 / 6.56 | 41.1 / 49.9 | 155 / 183 |
| disk: index, one note changed | 5.35 / 7.29 | 42.5 / 49.3 | 162 / 173 |
| scoring: keywords + relevant() (frontmatter) | 0.07 / 0.19 | 2.07 / 2.75 | 9.20 / 18.9 |
| search: frontmatter + full text over all notes | 3.90 / 6.28 | 42.0 / 68.5 | 187 / 306 |
| disk: whole hint path, warm | 5.78 / 7.23 | 42.8 / 63.2 | 170 / 235 |
| engine: no-keyword prompt (dispatch floor) | 0.93 / 185 | 0.41 / 91.4 | 0.42 / 85.7 |
| engine: first prompt (walk runs in background) | 6.34 | 1.74 | 1.34 |
| engine: first walk, until complete (background) | 133 | 659 | 1400 |
| engine: later prompt (warm index) | 20.3 / 43.0 | 82.5 / 129 | 171 / 249 |
| engine: prompt after one note changed | 16.5 / 22.9 | 60.3 / 93.8 | 169 / 239 |
| engine: search_notes (warm index) | 19.2 / 26.9 | 98.4 / 119 | 259 / 365 |

- **The first prompt no longer waits: 1.8 s → about 1 ms at 5,000 notes.** Its hint covers only
  the notes read by then (none, if it arrives right after the session starts); later prompts get
  full hints once the walk completes.
- **The background walk completes in 1.4 s at 5,000 notes** (659 ms at 1,000). Reading 16 notes at
  a time roughly halved the cold disk index (956 → 426 ms at 5,000), though the machines differ.
- Warm prompts are still bound by the folder walk, inflated here by the `wide` layout; see the realistic layout above.

### Frontmatter-only index ([#3](https://github.com/EnyMan/simple-memory/issues/3))

`wide` layout. Intel Xeon @ 2.80 GHz (4 threads).

The hint indexes only each note's frontmatter (title, summary, keywords, tags) and its path.
Bodies are kept as text and scanned by `search_notes` when it is called.

| measurement | 100 notes | 1,000 notes | 5,000 notes |
| --- | ---: | ---: | ---: |
| disk: index, cold (parse every note) | 24.7 / 38.5 | 266 / 286 | 956 / 957 |
| disk: index, warm (walk + stat only) | 8.85 / 11.6 | 66.1 / 79.1 | 185 / 219 |
| disk: index, one note changed | 9.09 / 10.1 | 57.3 / 65.8 | 199 / 216 |
| scoring: keywords + relevant() (frontmatter) | 0.10 / 0.38 | 1.00 / 1.74 | 10.6 / 19.5 |
| search: frontmatter + full text over all notes | 3.86 / 5.97 | 35.3 / 58.4 | 185 / 290 |
| disk: whole hint path, warm | 8.07 / 10.6 | 54.9 / 62.2 | 226 / 276 |
| engine: no-keyword prompt (dispatch floor) | 0.55 / 181 | 0.45 / 126 | 0.40 / 106 |
| engine: first prompt (cold index) | 84.9 | 648 | 1808 |
| engine: later prompt (warm index) | 23.7 / 47.0 | 76.2 / 93.3 | 216 / 273 |
| engine: prompt after one note changed | 21.4 / 24.2 | 66.7 / 86.4 | 215 / 251 |
| engine: search_notes (warm index) | 22.0 / 27.5 | 82.8 / 136 | 308 / 352 |

- **The first prompt is 4.6× faster at 5,000 notes: 8.4 s → 1.8 s** (1,514 → 648 ms at 1,000).
  What remains is reading each file once through the engine and parsing its frontmatter. [#4](https://github.com/EnyMan/simple-memory/issues/4)
  moves it off the first prompt, and [#5](https://github.com/EnyMan/simple-memory/issues/5) decides whether a persisted index is worth it.
- **Scoring is about 3× cheaper** (30 → 11 ms at 5,000 notes): fewer terms per note.
- **Warm prompts are unchanged** (about 220 ms at 5,000 notes): they are bound by the folder walk,
  which this benchmark inflates with 1,164 folders. [#5](https://github.com/EnyMan/simple-memory/issues/5) makes the corpus realistic.
- **`search_notes` costs about 300 ms at 5,000 notes** through the engine, for the walk plus a
  full-text scan of every body. The scan matches each term with a plain case-insensitive pattern
  and checks word starts by hand. A lookbehind pattern scanned the same text 15 to 100 times
  slower on JavaScriptCore (Bun) than on V8.

### Baseline: full-text index ([#2](https://github.com/EnyMan/simple-memory/pull/2))

`wide` layout. Intel Xeon @ 2.80 GHz (4 threads).

Before [#3](https://github.com/EnyMan/simple-memory/issues/3), the hint tokenized every note's body (up to 50,000 characters).

| measurement | 100 notes | 1,000 notes | 5,000 notes |
| --- | ---: | ---: | ---: |
| disk: index, cold (parse every note) | 69.3 / 74.8 | 704 / 939 | 5069 / 7126 |
| disk: index, warm (walk + stat only) | 6.84 / 10.0 | 67.2 / 129 | 213 / 249 |
| disk: index, one note changed | 7.88 / 11.0 | 70.2 / 80.2 | 197 / 207 |
| scoring: keywords + relevant() over all notes | 0.14 / 0.39 | 3.90 / 6.55 | 30.1 / 44.8 |
| disk: whole hint path, warm | 7.94 / 11.5 | 65.1 / 79.6 | 229 / 285 |
| engine: no-keyword prompt (dispatch floor) | 0.53 / 151 | 0.65 / 81.3 | 0.36 / 86.9 |
| engine: first prompt (cold index) | 180 | 1514 | 8357 |
| engine: later prompt (warm index) | 20.2 / 32.1 | 84.3 / 161 | 219 / 344 |
| engine: prompt after one note changed | 20.2 / 25.3 | 69.4 / 116 | 220 / 268 |

What it showed:

1. **The first index was the problem.** It grew linearly, at about 1.5 to 1.7 ms per note through
   the engine, so 5,000 notes took **8.4 s**, close to a hook's 10 s budget. About 85% of it was
   `terms()` running over every body word; parsing frontmatter alone was 14 ms per 1,000 notes.
   Addressed by [#3](https://github.com/EnyMan/simple-memory/issues/3).
2. **Later prompts were bound by the walk** (one `$.fs.list` per folder and an mtime check per
   file), not by scoring. Still true; see [#5](https://github.com/EnyMan/simple-memory/issues/5).
