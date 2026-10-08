// The note index: every markdown file under the memory root, parsed and
// reduced to terms, re-read only when a file's mtime moves.

import { terms } from './keywords'
import type { Indexed } from './keywords'
import { idOf, parse } from './notes'

/** The structure guide at the root; never indexed as a note. */
export const GUIDE = 'MEMORY.md'
/** The most notes one walk indexes. */
export const MAX_FILES = 5000

export type Note = Indexed & {
  id: string
  rel: string
  abs: string
  title: string
  tags: string[]
  updated: string
  mtimeMs: number
  body: string
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
  const bodyTerms = new Map<string, number>()
  for (const term of terms(body.slice(0, 50_000), extra)) bodyTerms.set(term, (bodyTerms.get(term) ?? 0) + 1)
  return {
    id,
    rel,
    abs,
    title: meta.title,
    tags: meta.tags,
    updated: meta.updated ?? meta.created ?? '',
    mtimeMs,
    body,
    titleTerms: new Set(terms(meta.title, extra)),
    tagTerms: new Set(meta.tags.flatMap(tag => terms(tag.replace(/[-_/]/g, ' '), extra))),
    pathTerms: new Set(terms(id.replace(/[-_/]/g, ' '), extra)),
    bodyTerms,
  }
}

/** An index with its own cache of parsed notes by absolute path. */
export const createIndexer = (extra?: ReadonlySet<string>) => {
  const cache = new Map<string, Note>()

  /** Every note under the root, from the cache where the file has not changed. */
  const index = async (io: IndexIo, root: string): Promise<Note[]> => {
    if (!(await io.exists(root))) return []
    const notes: Note[] = []
    const seen = new Set<string>()
    const queue = ['']
    while (queue.length > 0 && notes.length < MAX_FILES) {
      const dir = queue.shift()!
      const entries = await io.list(dir === '' ? root : `${root}/${dir}`).catch(() => [])
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        const rel = dir === '' ? entry.name : `${dir}/${entry.name}`
        if (entry.kind === 'dir') {
          queue.push(rel)
          continue
        }
        if (entry.kind !== 'file' || !/\.md$/i.test(entry.name) || rel === GUIDE) continue
        const abs = `${root}/${rel}`
        seen.add(abs)
        const cached = cache.get(abs)
        if (cached && cached.mtimeMs === entry.mtimeMs) {
          notes.push(cached)
          continue
        }
        const text = await io.read(abs).catch(() => undefined)
        if (typeof text !== 'string') continue
        const note = buildNote(abs, rel, entry.mtimeMs, text, extra)
        cache.set(abs, note)
        notes.push(note)
      }
    }
    for (const key of [...cache.keys()]) if (key.startsWith(`${root}/`) && !seen.has(key)) cache.delete(key)
    return notes
  }

  /** Drops a file from the cache, so the next walk reads it again. */
  const forget = (abs: string) => void cache.delete(abs)

  return { index, forget }
}
