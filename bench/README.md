# Benchmark

How long simple-memory's hooks take as the knowledge base grows: mainly the keyword hint that runs
on every prompt, plus the index walk that `search_notes`, `read_note` and the opening context share.

## Running it

From the repository root, with [Bun](https://bun.sh) and `claude` on the PATH:

```sh
bun bench/run.ts                          # 100, 1,000 and 5,000 notes; disk + engine; prints a markdown table
bun bench/run.ts --sizes 100,2000         # other sizes
bun bench/run.ts --skip-engine --json     # disk part only, raw rows as JSON
```

A full run takes about 2 minutes. Everything is written to a temp directory and removed afterwards.

## What it measures

- **Corpus** (`bench/corpus.ts`): deterministic synthetic notes with frontmatter (title, a one-line
  summary, 3 to 12 keywords, 1 to 3 tags), spread over 8 top-level folders, 40% of them one level
  deeper (1,164 folders at 5,000 notes, far more than a real knowledge base; see [#5](https://github.com/EnyMan/simple-memory/issues/5)). Bodies are 1 to 20 KB
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

Median / p95 in ms. Intel Xeon @ 2.80 GHz (4 threads), 16 GB, Linux 6.18, Bun 1.3.14,
Claude Code 2.1.289. One run of each cold measurement through the engine. The dispatch floor's
p95 is its first call warming up; the median is the steady state.

### Current: frontmatter-only index ([#3](https://github.com/EnyMan/simple-memory/issues/3))

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

## Next

- [#4](https://github.com/EnyMan/simple-memory/issues/4): build the index in the background, so the first prompt never waits for it.
- [#5](https://github.com/EnyMan/simple-memory/issues/5): make the corpus's folder layout realistic, re-measure, and decide whether a persisted,
  mtime-checked index cache is worth adding.
