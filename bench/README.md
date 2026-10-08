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

- **Corpus** (`bench/corpus.ts`): deterministic synthetic notes with frontmatter (title, 1 to 3 tags),
  spread over 8 top-level folders, 40% of them one level deeper. Bodies are 1 to 20 KB
  (log-uniform, about 6.6 KB on average) of Zipf-distributed words drawn from an 8,000-word
  vocabulary. 5,000 notes come to about 33 MB.
- **disk** rows: the plugin's own `hooks/indexer.ts` and `hooks/keywords.ts`, run in Bun against
  files on disk, with `node:fs` standing in for `$.fs`. A list call stats each file, as `$.fs.list`
  does.
  - *cold*: a fresh index that parses every note.
  - *warm*: nothing changed, so a walk plus mtime checks only.
  - *one note changed*: one file's mtime moved before each run.
  - *scoring*: `keywords()` + `relevant()` over the whole index, for the prompts in `bench/corpus.ts`.
  - *whole hint path*: keywords, warm index and scoring together.
- **engine** rows: the real `prompt.submit` hook, run by `claude plugin test` (`bench/engine.bench.ts`,
  copied into a scratch copy of the plugin) over an in-memory file system. Every `$.fs` call goes
  through the engine's dispatch, as in a session, but there is no disk I/O.
  - *dispatch floor*: a prompt with no keywords, which returns before touching the index.

## Results

Median / p95 in ms. Intel Xeon @ 2.80 GHz (4 threads), 16 GB, Linux 6.18, Bun 1.3.14,
Claude Code 2.1.289. One run of each cold measurement through the engine.

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

The dispatch floor's p95 is its first call warming up; the median is the steady state.

## What it shows

1. **The first index is the problem.** It grows linearly, at about 1 ms per note on disk and
   1.5 to 1.7 ms through the engine, so 5,000 notes take **8.4 s**. That cost lands on whatever
   first touches the index: the opening context (`prompt.context`, for the recent-notes list) or
   the first prompt's hint. It sits close to a hook's 10 s budget (which counts the hook's own
   time, not its `$` calls). Past the budget the engine drops the hook (`prompt.submit` fails open, so the
   prompt goes through without a hint); this benchmark doesn't cover what happens to a walk cut off there.
   Of that time, about 85% is `terms()` (stopword filtering and stemming over every body word;
   280 ms per 1,000 notes, the regex alone 92 ms). Parsing frontmatter is 14 ms per 1,000 notes.
2. **Later prompts cost about 20 ms (100 notes), 85 ms (1,000) and 220 ms (5,000).** That is the
   walk (one `$.fs.list` per folder and an mtime check per file), not the scoring: brute-force
   scoring is 30 ms even at 5,000 notes, so an inverted index isn't worth it yet.
3. **A changed note costs one re-parse**, which disappears in the walk's cost.

## Proposed fixes (not in this change)

In order of payoff:

1. **Build the index in the background.** Start `index()` from `session.start` without awaiting
   it, and let `prompt.context` and `prompt.submit` use whatever is indexed so far (or skip the
   hint until the first walk finishes) instead of blocking. This removes the multi-second first
   prompt entirely.
2. **Index less text per note.** Bodies are indexed up to 50,000 characters. Indexing the first
   8 to 10 KB (titles, tags and paths stay fully indexed) cuts cold time roughly in proportion for
   long notes, and keywords near the top of a note carry most of the signal.
3. **Skip the walk when nothing could have changed.** Remember when the last walk finished and
   reuse it for prompts within a few seconds of each other, forgetting it whenever a simple-memory
   tool or an Edit/Write under the memory root runs. That brings warm prompts close to the 30 ms
   scoring cost at 5,000 notes.
4. **Cheaper `terms()`.** Cache stems per distinct word (a Map lookup instead of the suffix
   regexes), and test for numbers with a character check instead of a regex.

Re-run `bun bench/run.ts` after any of these to compare.
