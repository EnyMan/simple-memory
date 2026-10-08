// The note index: every markdown file under the memory root, its
// frontmatter reduced to terms, re-read only when a file's mtime moves.
// Bodies are kept as text for search and links, never tokenized here.

import { terms } from './keywords'
import type { Indexed } from './keywords'
import { firstParagraph, headings, idOf, parse } from './notes'

/** The structure guide at the root; never indexed as a note. */
export const GUIDE = 'MEMORY.md'
/** The most notes one walk indexes. */
export const MAX_FILES = 5000

export type Note = Indexed & {
  id: string
  rel: string
  abs: string
  title: string
  /** The frontmatter's summary, or the first paragraph when it has none. */
  summary: string
  keywords: string[]
  tags: string[]
  updated: string
  mtimeMs: number
  body: string
  /** Whether the frontmatter has its own keywords and summary (not derived). */
  hasKeywords: boolean
  hasSummary: boolean
}

/** One directory entry, as `$.fs.list` answers it. */
export type IndexEntry = { name: string; kind: 'file' | 'dir' | 'other'; mtimeMs: number }

/** What a walk needs from the file system. */
export type IndexIo = {
  exists: (path: string) => Promise<boolean>
  list: (path: string) => Promise<readonly IndexEntry[]>
  read: (path: string) => Promise<string>
}

export const buildNote = (
  abs: string,
  rel: string,
  mtimeMs: number,
  text: string,
  extra?: ReadonlySet<string>,
): Note => {
  const id = idOf(rel)
  const { meta, body } = parse(text, id.split('/').pop() ?? id)
  const hasKeywords = meta.keywords.length > 0
  const hasSummary = (meta.summary ?? '').trim() !== ''
  const summary = hasSummary ? meta.summary!.trim() : firstParagraph(body)
  // A note from before the schema: its headings stand in for keywords.
  const keywordText = hasKeywords ? meta.keywords.join(' ') : headings(body).join(' ')
  const words = (text: string) => new Set(terms(text.replace(/[-_/]/g, ' '), extra))
  return {
    id,
    rel,
    abs,
    title: meta.title,
    summary,
    keywords: meta.keywords,
    tags: meta.tags,
    updated: meta.updated ?? meta.created ?? '',
    mtimeMs,
    body,
    hasKeywords,
    hasSummary,
    keywordTerms: words(keywordText),
    titleTerms: words(meta.title),
    tagTerms: words(meta.tags.join(' ')),
    summaryTerms: words(summary),
    pathTerms: words(id),
  }
}

/** A markdown note file found by a walk, before it is read. */
export type NoteFile = { abs: string; rel: string; mtimeMs: number }

/** Reads in flight at once during a walk: each read is a round trip through the engine. */
const READ_BATCH = 16

/**
 * Every note file under the root, from directory listings alone (no reads):
 * dot-entries, node_modules and MEMORY.md skipped, at most MAX_FILES.
 */
export const listNotes = async (io: IndexIo, root: string): Promise<NoteFile[]> => {
  if (!(await io.exists(root))) return []
  const files: NoteFile[] = []
  const queue = ['']
  while (queue.length > 0 && files.length < MAX_FILES) {
    const dir = queue.shift()!
    const entries = await io.list(dir === '' ? root : `${root}/${dir}`).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (entry.kind === 'dir') queue.push(rel)
      else if (entry.kind === 'file' && /\.md$/i.test(entry.name) && rel !== GUIDE && files.length < MAX_FILES) {
        files.push({ abs: `${root}/${rel}`, rel, mtimeMs: entry.mtimeMs })
      }
    }
  }
  return files
}

/**
 * An index with its own cache of parsed notes by absolute path.
 *
 * Walks are single-flight: callers asking while one runs share it, unless a
 * note was written or forgotten after it started, in which case they get a
 * fresh walk once it ends. The first complete walk makes the index warm;
 * until then `partial` answers what has been read so far, so a prompt never
 * has to wait for it.
 */
export const createIndexer = (extra?: ReadonlySet<string>) => {
  const cache = new Map<string, Note>()
  let running: { root: string; generation: number; walk: Promise<Note[]> } | undefined
  let generation = 0
  let warmRoot: string | undefined

  const walk = async (io: IndexIo, root: string): Promise<Note[]> => {
    const files = await listNotes(io, root)
    const seen = new Set(files.map(file => file.abs))
    const notes: (Note | undefined)[] = files.map(file => {
      const cached = cache.get(file.abs)
      return cached && cached.mtimeMs === file.mtimeMs ? cached : undefined
    })
    const stale = files.map((file, at) => ({ file, at })).filter(({ at }) => notes[at] === undefined)
    for (let start = 0; start < stale.length; start += READ_BATCH) {
      await Promise.all(
        stale.slice(start, start + READ_BATCH).map(async ({ file, at }) => {
          const text = await io.read(file.abs).catch(() => undefined)
          if (typeof text !== 'string') return
          const note = buildNote(file.abs, file.rel, file.mtimeMs, text, extra)
          cache.set(file.abs, note)
          notes[at] = note
        }),
      )
    }
    for (const key of [...cache.keys()]) if (key.startsWith(`${root}/`) && !seen.has(key)) cache.delete(key)
    return notes.filter((note): note is Note => note !== undefined)
  }

  /** Every note under the root, from the cache where the file has not changed. */
  const index = (io: IndexIo, root: string): Promise<Note[]> => {
    if (running && running.root === root) {
      if (running.generation === generation) return running.walk
      // Something changed since this walk began: walk again after it.
      return running.walk.then(
        () => index(io, root),
        () => index(io, root),
      )
    }
    const mine = { root, generation, walk: walk(io, root) }
    running = mine
    void mine.walk.then(
      () => {
        if (mine.generation === generation) warmRoot = root
      },
      () => undefined,
    )
    void mine.walk.finally(() => {
      if (running === mine) running = undefined
    }).catch(() => undefined)
    return mine.walk
  }

  /** Whether a walk of `root` has completed: from then on a walk only re-reads changed notes. */
  const isWarm = (root: string) => warmRoot === root

  /** The notes of `root` read so far, complete or not; for callers that must not wait. */
  const partial = (root: string): Note[] => [...cache.values()].filter(note => note.abs.startsWith(`${root}/`))

  /** The note cached for a path, if any. */
  const cached = (abs: string) => cache.get(abs)

  /** Drops a file from the cache, so the next walk reads it again. */
  const forget = (abs: string) => {
    cache.delete(abs)
    generation += 1
  }

  return { index, isWarm, partial, cached, forget }
}
