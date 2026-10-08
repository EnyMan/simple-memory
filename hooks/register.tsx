import { atom, read, update } from 'claude-code'
import type { FsEntry, Register } from 'claude-code'

import type { NoteRef } from '../types'
import { bodyMatcher, keywords, parseStopwords, relevant, score, search } from './keywords'
import { createIndexer, GUIDE, listNotes } from './indexer'
import { isAbsolute, normalize, pathKey, relativeTo, removeFile } from './paths'
import type { Note } from './indexer'
import {
  checkKeywords,
  checkSummary,
  findReplace,
  idOf,
  KEYWORDS_MAX,
  KEYWORDS_MIN,
  linksTo,
  parse,
  relink,
  replaceSection,
  safeRelative,
  serialize,
  slugify,
  snippet,
  tidyTags,
} from './notes'
import type { Parsed } from './notes'

const PLUGIN = 'simple-memory'
const TOOL = (name: string) => `mcp__${PLUGIN}__${name}`
const MIN_HINT_SCORE = 1.5

const suggested = atom({ plugin: 'simple-memory', key: 'suggested' } as const, [])
const readNotes = atom({ plugin: 'simple-memory', key: 'read' } as const, [])
const edited = atom({ plugin: 'simple-memory', key: 'edited' } as const, [])

/** Built-in tools whose calls count as editing a file, and where each names it. */
const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/
/** simple-memory tools that count as writing a note. */
const NOTE_TOOLS = new Set(['write_note', 'edit_note', 'move_note', 'init_memory'].map(name => `mcp__simple-memory__${name}`))


type Args = Record<string, unknown>

/**
 * What the helpers need from the engine. `$` itself may not be passed
 * around, so each hook builds one of these from its own `$` (see IO).
 */
type Io = {
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  list: (path: string) => Promise<readonly FsEntry[]>
  exists: (path: string) => Promise<boolean>
  now: () => Promise<number>
  home: () => Promise<string | undefined>
  cwd: () => Promise<string>
  markRead: (refs: readonly NoteRef[]) => Promise<void>
  invalidateContext: () => void
  /** Deletes a file. */
  remove: (path: string) => Promise<void>
  /** Drops a note from this conversation's suggested and read lists. */
  forget: (id: string) => Promise<void>
  /** Renames a note in this conversation's suggested and read lists. */
  rename: (from: string, to: NoteRef) => Promise<void>
}

const renameIn = (list: readonly NoteRef[], from: string, to: NoteRef) =>
  list.map(one => (one.id === from ? to : one))

const merge = (list: readonly NoteRef[], refs: readonly NoteRef[]) => [
  ...list.filter(one => !refs.some(ref => ref.id === one.id)),
  ...refs,
]

const str = (value: unknown) => (typeof value === 'string' ? value : '')
const strs = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((one): one is string => typeof one === 'string')
    : typeof value === 'string' && value !== ''
      ? [value]
      : []

const answer = (text: string) => ({ result: text })
const refuse = (text: string) => ({ result: `Error: ${text}`, isError: true as const })

const refOf = (note: Note): NoteRef => ({ id: note.id, title: note.title })
const clip = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text)
const line = (note: Note) =>
  `- ${note.id} — "${note.title}"${note.tags.length > 0 ? ` [${note.tags.join(', ')}]` : ''}${
    note.summary ? `: ${clip(note.summary, 140)}` : ''
  }`
/** Says what a note from before the schema is missing. */
const missing = (note: Note) =>
  [!note.hasSummary && 'summary', !note.hasKeywords && 'keywords'].filter(Boolean).join(' and ')

/** The note format, as the rules and MEMORY.md state it. */
const SCHEMA = `Every note has frontmatter with a title, a one-line summary and ${KEYWORDS_MIN}-${KEYWORDS_MAX} keywords (the words someone would use when the note is relevant, synonyms included); tags are optional. The per-prompt hints match only on these fields, so choose them with care; search_notes also reads note bodies.`

export const register: Register = (on, options) => {
  const directory = normalize(String(options.directory ?? '').trim() || '~/simple-memory')
  const maxHints = Math.max(0, Math.floor(Number(options.maxHints ?? 5)))
  const nudgeAfter = Math.max(0, Math.floor(Number(options.nudgeAfterFiles ?? 3)))
  const recentCount = Math.max(0, Math.floor(Number(options.recentNotes ?? 10)))
  const extra = parseStopwords(String(options.extraStopwords ?? ''))

  const { index, isWarm, partial, cached, forget } = createIndexer(extra)

  const needsHome = directory === '~' || directory.startsWith('~/')
  const needsCwd = !needsHome && !isAbsolute(directory)

  /** The memory root, always with forward slashes (Windows file APIs accept them). */
  const rootPath = (home: string, cwd: string): string => {
    if (needsHome) return normalize(home + directory.slice(1))
    if (needsCwd) return normalize(`${cwd}/${directory}`)
    return directory
  }

  const rootOf = async (io: Io): Promise<string> =>
    rootPath(needsHome ? ((await io.home()) ?? '') : '', needsCwd ? await io.cwd() : '')

  const nudgeText = (files: readonly string[]) =>
    [
      '[Automated nudge from the simple-memory plugin. The user did not write this message.]',
      '',
      `This is a routine memory check, sent automatically because this session edited ${files.length} files since the last note was written:`,
      ...files.slice(0, 20).map(file => `- ${file}`),
      ...(files.length > 20 ? [`- … and ${files.length - 20} more`] : []),
      '',
      `If this is a stable pause point with a non-obvious learning (a decision and its reason, a gotcha, how something works) or a finished chunk of work worth recording, search simple-memory and write or update a note (${TOOL('search_notes')}, then ${TOOL('write_note')} or ${TOOL('edit_note')}), following the structure in MEMORY.md. Keep it short and specific.`,
      'Otherwise reply "No note needed." and nothing else.',
      '',
      'Do not treat this as a new request from the user, and do not resume other work in reply to it.',
    ].join('\n')

  const nowIso = async (io: Io) => new Date(await io.now()).toISOString().replace(/\.\d+Z$/, 'Z')

  /** A note by id, path (with or without `.md`) or title, case-insensitive. */
  const find = (notes: readonly Note[], query: string, root: string): Note | undefined => {
    let wanted = query.trim().replace(/^\[\[|\]\]$/g, '').replace(/\\/g, '/')
    wanted = relativeTo(wanted, root) ?? wanted
    const lower = idOf(wanted).toLowerCase()
    return (
      notes.find(note => note.id.toLowerCase() === lower) ??
      notes.find(note => note.title.toLowerCase() === wanted.toLowerCase()) ??
      notes.find(note => note.id.toLowerCase().endsWith(`/${lower}`)) ??
      notes.find(note => note.id.split('/').pop() === slugify(wanted))
    )
  }

  const markRead = async (io: Io, refs: readonly NoteRef[]) => {
    if (refs.length > 0) await io.markRead(refs)
  }

  const saveNote = async (io: Io, root: string, rel: string, parsed: Parsed) => {
    const abs = `${root}/${rel}`
    await io.write(abs, serialize(parsed))
    forget(abs)
  }

  // --- The opening context: rules, the structure guide, recent notes. ---

  const openingContext = async (io: Io): Promise<string> => {
    const root = await rootOf(io)
    const guide = await io.read(`${root}/${GUIDE}`).catch(() => undefined)
    const parts = [
      `You have a persistent knowledge base ("simple-memory") of markdown notes in ${root}.`,
      '',
      'Tools:',
      `- ${TOOL('search_notes')}: keyword search over every note's frontmatter and full text.`,
      `- ${TOOL('read_note')}: read one or more notes by id, path or title.`,
      `- ${TOOL('write_note')}: create a note (title, summary, keywords, folder, content, tags).`,
      `- ${TOOL('edit_note')}: append, prepend, find/replace, or replace a section of a note; update its summary and keywords.`,
      `- ${TOOL('move_note')}: move or rename a note; links to it are updated.`,
      `- ${TOOL('delete_note')}: delete a note (only when the user asks or agrees).`,
      '',
      'Rules:',
      '- On each prompt a keyword match may add a <simple-memory-hint> listing notes not yet suggested. Read the ones that plausibly matter before answering; ignore the rest silently.',
      '- Search before writing: extend or correct an existing note rather than creating a near-duplicate.',
      '- Save durable knowledge: decisions and their reasons, facts, how-tos, people and project context, preferences the user states. Not transient chatter. When unsure whether something belongs in memory, ask.',
      '- Keep one topic per note with a specific title; link related notes as [[note-id]].',
      `- ${SCHEMA} When you edit a note so that its summary or keywords no longer fit, update them in the same edit_note call. When a tool result says a note is missing them, add them.`,
      '- Change notes only through these tools (not Write/Edit/Bash), so metadata stays consistent.',
      '- Follow the structure and conventions below. If a note fits no folder, ask before inventing a new top-level folder.',
    ]

    if (typeof guide === 'string') {
      parts.push('', `Structure and conventions (${GUIDE}):`, guide.trim())
    } else {
      parts.push(
        '',
        'The knowledge base is not initialized yet. If the user wants to store knowledge, suggest running /memory-init to design its folder structure first.',
      )
    }

    if (recentCount > 0) {
      // Never wait for the first walk: until it completes, list files by mtime
      // from the directory listings and name the ones not read yet by id.
      const files = isWarm(root) ? await index(io, root) : await listNotes(io, root)
      const recent = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, recentCount)
      if (recent.length > 0) {
        parts.push(
          '',
          `Recently updated notes (${files.length} in total):`,
          ...recent.map(file => {
            const note = cached(file.abs)
            return note ? line(note) : `- ${idOf(file.rel)}`
          }),
        )
      }
    }

    return parts.join('\n')
  }

  // --- /memory-init: a guided interview that ends in init_memory. ---

  const initPrompt = (root: string, existing: string | undefined, notes: number, args: string) =>
    [
      `Let's set up my simple-memory knowledge base in ${root}.`,
      args.trim() !== '' ? `\nWhat I have in mind: ${args.trim()}\n` : '',
      existing
        ? `It already has a structure (${notes} notes); treat this as a review and propose changes. Current ${GUIDE}:\n\n${existing.trim()}\n`
        : notes > 0
          ? `The folder already holds ${notes} notes but no ${GUIDE}; take their folders into account.\n`
          : '',
      'Guide me to the best structure, as a short interview:',
      '1. Ask what the knowledge base is for (use AskUserQuestion with concrete options, e.g. a general shared team knowledge base, a personal second brain, one project\'s documentation and decisions, research notes, customer/support knowledge, or something else). One or two questions at a time.',
      '2. Then ask what matters for that use case: who reads and writes it (just me, a team via git), the main kinds of knowledge (decisions, how-tos, people, projects, glossary, meetings, references...), and how granular notes should be.',
      '3. Propose a folder tree, at most two levels deep and about 4-10 top-level folders, each with a one-line purpose; plus conventions: note title style, when to create vs. edit a note, tag vocabulary, keyword habits (every note has a one-line summary and ${KEYWORDS_MIN}-${KEYWORDS_MAX} keywords; the plugin enforces this), linking with [[note-id]], and what not to store (secrets, transient chatter). For a general shared knowledge base, a good starting point is something like: decisions/, how-to/, concepts/, projects/, people/, references/, and inbox/ for unsorted notes.',
      '4. Revise until I approve, then call mcp__simple-memory__init_memory with the result. Offer to write one or two seed notes after that.',
      'Keep each message short.',
    ]
      .filter(Boolean)
      .join('\n')

  // --- Tools ---

  const tools = [
    {
      name: 'search_notes',
      description:
        'Keyword search over every note of the simple-memory knowledge base: frontmatter (keywords, title, tags, summary, folder path) and full text. No semantic search, so try synonyms if nothing matches. Frontmatter matches rank first. An empty query lists the most recently updated notes. Returns note ids with their summary and a matching line; read them with read_note.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords to look for.' },
          folder: { type: 'string', description: 'Only notes under this folder (relative to the memory root).' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Only notes carrying all of these tags.' },
          limit: { type: 'number', description: 'Most results to return (default 10).' },
        },
      },
    },
    {
      name: 'read_note',
      description:
        'Read one or more notes from the simple-memory knowledge base, by id (path under the memory root without .md, e.g. "decisions/use-postgres"), path, [[link]] or exact title.',
      inputSchema: {
        type: 'object',
        properties: {
          notes: { type: 'array', items: { type: 'string' }, description: 'The notes to read.' },
        },
        required: ['notes'],
      },
    },
    {
      name: 'write_note',
      description:
        `Create a note in the simple-memory knowledge base. The file is <folder>/<slug of title>.md with title, summary, keywords, tags and timestamps in its frontmatter. summary and keywords are required: the per-prompt hints match only on the frontmatter. Search first; to change an existing note use edit_note (or overwrite: true to replace it whole).`,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A specific, descriptive title.' },
          summary: { type: 'string', description: 'One line (at most 200 characters) saying what the note holds.' },
          keywords: {
            type: 'array',
            items: { type: 'string' },
            description: `${KEYWORDS_MIN}-${KEYWORDS_MAX} terms someone would use when this note is relevant, including synonyms and names not in the title.`,
          },
          folder: { type: 'string', description: 'Folder under the memory root, following its structure ("" for the root).' },
          content: { type: 'string', description: 'The markdown body (no frontmatter).' },
          tags: { type: 'array', items: { type: 'string' } },
          overwrite: { type: 'boolean', description: 'Replace the note if it exists (default false).' },
        },
        required: ['title', 'summary', 'keywords', 'folder', 'content'],
      },
    },
    {
      name: 'edit_note',
      description:
        'Edit a note of the simple-memory knowledge base. operation: "append" or "prepend" content to the body; "find_replace" replaces the exact text `find` (must be unique unless replace_all); "replace_section" replaces the body under heading `section` (added if missing); "replace_body" replaces the whole body. title, summary, keywords and tags, when given, update the frontmatter (the file keeps its path); give only those to change the frontmatter alone. Keep summary and keywords true to the body.',
      inputSchema: {
        type: 'object',
        properties: {
          note: { type: 'string', description: 'The note: id, path or title.' },
          operation: {
            type: 'string',
            enum: ['append', 'prepend', 'find_replace', 'replace_section', 'replace_body'],
            description: 'Left out to change only the frontmatter.',
          },
          content: { type: 'string', description: 'The new text.' },
          find: { type: 'string', description: 'For find_replace: the exact text to replace.' },
          replace_all: { type: 'boolean', description: 'For find_replace: replace every occurrence.' },
          section: { type: 'string', description: 'For replace_section: the heading text.' },
          title: { type: 'string', description: 'A new title.' },
          summary: { type: 'string', description: 'A new one-line summary.' },
          keywords: { type: 'array', items: { type: 'string' }, description: `The new full keyword list (${KEYWORDS_MIN}-${KEYWORDS_MAX}).` },
          tags: { type: 'array', items: { type: 'string' }, description: 'The new full tag list.' },
        },
        required: ['note'],
      },
    },
    {
      name: 'move_note',
      description:
        'Move or rename a note of the simple-memory knowledge base. destination is a folder ("archive/", keeps the file name) or a new note id ("projects/new-name"). [[links]] to the note in other notes are updated. title, when given, also retitles it.',
      inputSchema: {
        type: 'object',
        properties: {
          note: { type: 'string', description: 'The note: id, path or title.' },
          destination: { type: 'string', description: 'A folder ending in "/", or the new id.' },
          title: { type: 'string', description: 'A new title.' },
        },
        required: ['note', 'destination'],
      },
    },
    {
      name: 'delete_note',
      description:
        'Delete a note from the simple-memory knowledge base, permanently. Only when the user asked for it or confirmed it. Reports notes that still link to it.',
      inputSchema: {
        type: 'object',
        properties: {
          note: { type: 'string', description: 'The note: id, path or title.' },
        },
        required: ['note'],
      },
    },
    {
      name: 'init_memory',
      description:
        'Create or restructure the simple-memory knowledge base: writes MEMORY.md (overview, folders, conventions) at the memory root and creates the folders. Call it only at the end of /memory-init, or when the user asks to change the structure, after they approved it.',
      inputSchema: {
        type: 'object',
        properties: {
          overview: { type: 'string', description: 'What the knowledge base is for and who uses it.' },
          folders: {
            type: 'array',
            items: {
              type: 'object',
              properties: { path: { type: 'string' }, purpose: { type: 'string' } },
              required: ['path', 'purpose'],
            },
          },
          conventions: { type: 'string', description: 'Markdown: titles, when to create vs. edit, linking, what not to store.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'The suggested tag vocabulary.' },
        },
        required: ['overview', 'folders', 'conventions'],
      },
    },
  ]

  const searchNotes = async (io: Io, args: Args) => {
    const root = await rootOf(io)
    let notes = await index(io, root)
    const folder = safeRelative(str(args.folder))
    if (str(args.folder) !== '' && folder === undefined) return refuse('folder must be relative to the memory root.')
    if (folder) notes = notes.filter(note => note.id.startsWith(`${folder}/`))
    const tags = tidyTags(strs(args.tags))
    if (tags.length > 0) notes = notes.filter(note => tags.every(tag => note.tags.map(t => t.toLowerCase()).includes(tag)))
    const limit = Math.max(1, Math.min(50, Math.floor(Number(args.limit ?? 10)) || 10))
    const query = keywords(str(args.query), extra)

    if (query.length === 0) {
      const recent = [...notes].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit)
      if (recent.length === 0) return answer(`No notes in ${root}${folder ? `/${folder}` : ''}.`)
      return answer([`${notes.length} notes; most recently updated:`, ...recent.map(line)].join('\n'))
    }

    const hits = search(notes, query).slice(0, limit)
    if (hits.length === 0) return answer(`No notes match ${query.join(', ')}. Try other words or synonyms.`)
    const matchers = query.map(bodyMatcher)
    const isHit = (text: string) => matchers.some(matcher => matcher.test(text))
    return answer(
      hits
        .map(({ item, inBody }) => {
          const quote = inBody > 0 ? snippet(item.body, isHit) : ''
          const gap = missing(item)
          return `${line(item)}${gap ? ` (no ${gap})` : ''}${quote ? `\n    ${quote}` : ''}`
        })
        .join('\n'),
    )
  }

  const readNote = async (io: Io, args: Args) => {
    const root = await rootOf(io)
    const wanted = strs(args.notes ?? args.note)
    if (wanted.length === 0) return refuse('name at least one note.')
    const notes = await index(io, root)
    const found: Note[] = []
    const out: string[] = []
    for (const one of wanted.slice(0, 20)) {
      const note = find(notes, one, root)
      if (!note) {
        const close = score(notes, keywords(one, extra)).slice(0, 3).map(hit => hit.item.id)
        out.push(`# ${one}\n(not found${close.length > 0 ? `; did you mean ${close.join(', ')}?` : ''})`)
        continue
      }
      found.push(note)
      const text = await io.read(note.abs).catch(() => '')
      out.push(`# ${note.id}  (${note.rel})\n${typeof text === 'string' ? text.trim() : ''}`)
    }
    await markRead(io, found.map(refOf))
    return found.length === 0 ? refuse(out.join('\n\n')) : answer(out.join('\n\n---\n\n'))
  }

  const writeNote = async (io: Io, args: Args) => {
    const title = str(args.title).trim()
    if (title === '') return refuse('title is required.')
    const summary = checkSummary(str(args.summary))
    if (typeof summary !== 'string') return refuse(summary.error)
    const keywordList = checkKeywords(strs(args.keywords))
    if (!Array.isArray(keywordList)) return refuse(keywordList.error)
    const folder = safeRelative(str(args.folder))
    if (folder === undefined) return refuse('folder must be a relative path inside the memory root.')
    const root = await rootOf(io)
    const rel = `${folder ? `${folder}/` : ''}${slugify(title)}.md`
    const abs = `${root}/${rel}`
    const exists = await io.exists(abs)
    if (exists && args.overwrite !== true) {
      return refuse(`${idOf(rel)} already exists. Read it and use edit_note, or pass overwrite: true.`)
    }
    const now = await nowIso(io)
    const before = exists ? parse(String(await io.read(abs).catch(() => '')), title) : undefined
    const previous = before?.meta
    await saveNote(io, root, rel, {
      meta: {
        title,
        summary,
        keywords: keywordList,
        tags: tidyTags(strs(args.tags)),
        created: previous?.created ?? now,
        updated: now,
        rest: previous?.rest ?? [],
      },
      body: str(args.content),
      eol: before?.eol,
    })
    await markRead(io, [{ id: idOf(rel), title }])
    return answer(`${exists ? 'Replaced' : 'Created'} ${idOf(rel)} (${abs}).`)
  }

  const editNote = async (io: Io, args: Args) => {
    const root = await rootOf(io)
    const note = find(await index(io, root), str(args.note), root)
    if (!note) return refuse(`no note "${str(args.note)}". Search for it first.`)
    const text = await io.read(note.abs).catch(() => undefined)
    if (typeof text !== 'string') return refuse(`cannot read ${note.rel}.`)
    const parsed = parse(text, note.title)
    const content = str(args.content)
    let body = parsed.body

    switch (str(args.operation)) {
      case 'append':
        body = `${body.replace(/\n+$/, '')}\n\n${content.replace(/^\n+/, '')}`
        break
      case 'prepend': {
        // Keep a leading H1 on top.
        const heading = /^(#\s.*\n+)/.exec(body.replace(/^\n+/, ''))
        const rest = heading ? body.replace(/^\n+/, '').slice(heading[0].length) : body.replace(/^\n+/, '')
        body = `${heading ? (heading[1] ?? '').replace(/\n+$/, '\n\n') : ''}${content.replace(/\n+$/, '')}\n\n${rest}`
        break
      }
      case 'find_replace': {
        const next = findReplace(body, str(args.find), content, args.replace_all === true)
        if (typeof next !== 'string') return refuse(next.error)
        body = next
        break
      }
      case 'replace_section':
        if (str(args.section).trim() === '') return refuse('section is required for replace_section.')
        body = replaceSection(body, str(args.section), content)
        break
      case 'replace_body':
        body = content
        break
      case '':
        if ([args.title, args.summary, args.keywords, args.tags].every(one => one === undefined)) {
          return refuse('give an operation, or title, summary, keywords or tags to change the frontmatter.')
        }
        break
      default:
        return refuse('operation must be append, prepend, find_replace, replace_section or replace_body.')
    }

    let summary = parsed.meta.summary
    if (args.summary !== undefined) {
      const checked = checkSummary(str(args.summary))
      if (typeof checked !== 'string') return refuse(checked.error)
      summary = checked
    }
    let keywordList = parsed.meta.keywords
    if (args.keywords !== undefined) {
      const checked = checkKeywords(strs(args.keywords))
      if (!Array.isArray(checked)) return refuse(checked.error)
      keywordList = checked
    }
    const title = str(args.title).trim() || parsed.meta.title
    const tags = args.tags === undefined ? parsed.meta.tags : tidyTags(strs(args.tags))
    await saveNote(io, root, note.rel, {
      meta: { ...parsed.meta, title, summary, keywords: keywordList, tags, updated: await nowIso(io) },
      body,
      eol: parsed.eol,
    })
    await markRead(io, [{ id: note.id, title }])

    const notes: string[] = [`Updated ${note.id}.`]
    const gap = [!summary && 'summary', keywordList.length === 0 && 'keywords'].filter(Boolean).join(' and ')
    if (gap) {
      notes.push(`This note has no ${gap}: add ${gap === 'summary' ? 'it' : 'them'} with edit_note, so hints can find it.`)
    } else if (/^(replace_body|replace_section)$/.test(str(args.operation)) && args.summary === undefined && args.keywords === undefined) {
      notes.push(`Check that the summary and keywords still fit the new text: summary "${summary}"; keywords ${keywordList.join(', ')}.`)
    }
    return answer(notes.join(' '))
  }

  const moveNote = async (io: Io, args: Args) => {
    const root = await rootOf(io)
    const notes = await index(io, root)
    const note = find(notes, str(args.note), root)
    if (!note) return refuse(`no note "${str(args.note)}". Search for it first.`)

    const raw = str(args.destination).trim().replace(/\\/g, '/')
    const isFolder =
      raw === '' || raw.endsWith('/') || (!/\.md$/i.test(raw) && (await io.exists(`${root}/${raw}`)))
    const target = safeRelative(raw.replace(/\.md$/i, ''))
    if (target === undefined) return refuse('destination must be a relative path inside the memory root.')
    const fileName = note.rel.split('/').pop() ?? `${slugify(note.title)}.md`
    const rel = isFolder ? `${target ? `${target}/` : ''}${fileName}` : `${target}.md`
    if (rel === note.rel && str(args.title).trim() === '') return refuse('the note is already there.')
    if (rel !== note.rel && (await io.exists(`${root}/${rel}`))) return refuse(`${idOf(rel)} already exists.`)

    const parsed = parse(await io.read(note.abs), note.title)
    const title = str(args.title).trim() || parsed.meta.title
    const id = idOf(rel)
    await saveNote(io, root, rel, {
      meta: { ...parsed.meta, title, updated: await nowIso(io) },
      body: parsed.body,
      eol: parsed.eol,
    })
    if (rel !== note.rel) {
      await io.remove(note.abs)
      forget(note.abs)
    }

    const relinked: string[] = []
    if (id !== note.id) {
      for (const other of notes) {
        if (other.abs === note.abs || !linksTo(other.body, note.id)) continue
        const text = await io.read(other.abs).catch(() => undefined)
        if (text === undefined) continue
        await io.write(other.abs, relink(text, note.id, id))
        forget(other.abs)
        relinked.push(other.id)
      }
    }
    await io.rename(note.id, { id, title })
    return answer(
      `Moved ${note.id} to ${id}.${relinked.length > 0 ? ` Updated links in: ${relinked.join(', ')}.` : ''}`,
    )
  }

  const deleteNote = async (io: Io, args: Args) => {
    const root = await rootOf(io)
    const notes = await index(io, root)
    const note = find(notes, str(args.note), root)
    if (!note) return refuse(`no note "${str(args.note)}". Search for it first.`)
    await io.remove(note.abs)
    forget(note.abs)
    await io.forget(note.id)
    const linking = notes.filter(other => other.abs !== note.abs && linksTo(other.body, note.id)).map(other => other.id)
    return answer(
      `Deleted ${note.id}.${linking.length > 0 ? ` These notes still link to it: ${linking.join(', ')}.` : ''}`,
    )
  }

  const initMemory = async (io: Io, args: Args) => {
    const root = await rootOf(io)
    const folders = (Array.isArray(args.folders) ? args.folders : [])
      .map(one => (typeof one === 'object' && one !== null ? (one as Args) : {}))
      .map(one => ({ path: safeRelative(str(one.path)), purpose: str(one.purpose).trim() }))
    if (folders.length === 0) return refuse('give at least one folder.')
    const bad = folders.find(one => !one.path)
    if (bad) return refuse('every folder path must be relative to the memory root, without "..".')

    const tags = tidyTags(strs(args.tags))
    const guide = [
      '# Memory structure',
      '',
      str(args.overview).trim(),
      '',
      '## Folders',
      '',
      ...folders.map(one => `- \`${one.path}/\` — ${one.purpose}`),
      '',
      '## Note format',
      '',
      SCHEMA,
      '',
      '## Conventions',
      '',
      str(args.conventions).trim(),
      ...(tags.length > 0 ? ['', '## Tags', '', tags.map(tag => `\`${tag}\``).join(', ')] : []),
      '',
    ].join('\n')

    const existed = await io.exists(`${root}/${GUIDE}`)
    await io.write(`${root}/${GUIDE}`, guide)
    for (const one of folders) {
      const dir = `${root}/${one.path}`
      const entries = await io.list(dir).catch(() => [])
      if (entries.length === 0) await io.write(`${dir}/.gitkeep`, '')
    }
    // The opening context now has a structure to show.
    io.invalidateContext()
    return answer(
      `${existed ? 'Restructured' : 'Initialized'} ${root}: ${GUIDE} written, folders ${folders.map(one => `${one.path}/`).join(', ')}.`,
    )
  }

  const serve: Record<string, (io: Io, args: Args) => Promise<{ result: string; isError?: true }>> = {
    [TOOL('search_notes')]: searchNotes,
    [TOOL('read_note')]: readNote,
    [TOOL('write_note')]: writeNote,
    [TOOL('edit_note')]: editNote,
    [TOOL('move_note')]: moveNote,
    [TOOL('delete_note')]: deleteNote,
    [TOOL('init_memory')]: initMemory,
  }

  // --- Hooks ---

  on('session.start', async ($, e, next) => {
    for (const tool of tools) await $.tool.register(tool)
    await $.command.register({
      name: 'memory-init',
      description: 'Set up (or restructure) the simple-memory knowledge base with a short guided interview',
      argumentHint: '[what the knowledge base is for]',
    })
    // Start the first walk now, in the background: nothing waits on it, and the
    // first prompt hints from whatever it has read by then.
    try {
      const home = needsHome ? ((await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '') : ''
      const root = rootPath(home, needsCwd ? await $.session.cwd() : '')
      void index(
        {
          exists: path => $.fs.exists(path),
          list: path => $.fs.list(path),
          read: async path => String(await $.fs.read(path)),
        },
        root,
      ).catch(() => undefined)
    } catch {
      // The first prompt starts the walk instead.
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, suggested, () => [])
      await update($, readNotes, () => [])
      await update($, edited, () => [])
    }
    return next(e)
  })

  on('tool.call', { tool: /^mcp__simple-memory__/ }, async ($, e, next) => {
    const handler = serve[e.tool]
    if (handler === undefined) return next(e)
    const io: Io = {
      read: async path => String(await $.fs.read(path)),
      write: (path, text) => $.fs.write(path, text),
      list: path => $.fs.list(path),
      exists: path => $.fs.exists(path),
      now: () => $.clock.now(),
      home: async () => (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')),
      cwd: () => $.session.cwd(),
      markRead: async refs => void (await update($, readNotes, list => merge(list, refs))),
      invalidateContext: () => void $.ui.invalidate('prompt.context'),
      remove: path => removeFile(argv => $.process.run(argv), file => $.fs.exists(file), path),
      forget: async id => {
        await update($, suggested, list => list.filter(one => one.id !== id))
        await update($, readNotes, list => list.filter(one => one.id !== id))
      },
      rename: async (from, to) => {
        await update($, suggested, list => renameIn(list, from, to))
        await update($, readNotes, list => renameIn(list, from, to))
      },
    }
    try {
      const done = await handler(io, e as unknown as Args)
      if (!done.isError && NOTE_TOOLS.has(e.tool)) await update($, edited, () => [])
      return done
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error))
    }
  }).catch(() => refuse('simple-memory failed to run this tool.'))

  // A note opened with the plain Read tool counts as read too.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const ran = await next(e)
    const io: Io = {
      read: async path => String(await $.fs.read(path)),
      write: (path, text) => $.fs.write(path, text),
      list: path => $.fs.list(path),
      exists: path => $.fs.exists(path),
      now: () => $.clock.now(),
      home: async () => (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')),
      cwd: () => $.session.cwd(),
      markRead: async refs => void (await update($, readNotes, list => merge(list, refs))),
      invalidateContext: () => void $.ui.invalidate('prompt.context'),
      remove: path => removeFile(argv => $.process.run(argv), file => $.fs.exists(file), path),
      forget: async id => {
        await update($, suggested, list => list.filter(one => one.id !== id))
        await update($, readNotes, list => list.filter(one => one.id !== id))
      },
      rename: async (from, to) => {
        await update($, suggested, list => renameIn(list, from, to))
        await update($, readNotes, list => renameIn(list, from, to))
      },
    }
    const root = await rootOf(io)
    const rel = relativeTo(e.file_path, root)
    if (ran.deny === undefined && !ran.isError && rel !== undefined && /\.md$/i.test(rel)) {
      const note = find(await index(io, root), rel, root)
      if (note) await markRead(io, [refOf(note)])
    }
    return ran
  }).catch(($, e, next) => next(e)) // fail open: a bookkeeping error never blocks the call

  on('command.run', { command: 'memory-init' }, async ($, e) => {
    const io: Io = {
      read: async path => String(await $.fs.read(path)),
      write: (path, text) => $.fs.write(path, text),
      list: path => $.fs.list(path),
      exists: path => $.fs.exists(path),
      now: () => $.clock.now(),
      home: async () => (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')),
      cwd: () => $.session.cwd(),
      markRead: async refs => void (await update($, readNotes, list => merge(list, refs))),
      invalidateContext: () => void $.ui.invalidate('prompt.context'),
      remove: path => removeFile(argv => $.process.run(argv), file => $.fs.exists(file), path),
      forget: async id => {
        await update($, suggested, list => list.filter(one => one.id !== id))
        await update($, readNotes, list => list.filter(one => one.id !== id))
      },
      rename: async (from, to) => {
        await update($, suggested, list => renameIn(list, from, to))
        await update($, readNotes, list => renameIn(list, from, to))
      },
    }
    const root = await rootOf(io)
    const existing = await io.read(`${root}/${GUIDE}`).catch(() => undefined)
    const notes = await index(io, root)
    const text = initPrompt(root, existing, notes.length, e.args)
    // A command may not start a turn itself; submit once it has returned.
    $.clock.after(0, () => void $.prompt.submit({ text }).catch(() => undefined))
    return { text: `Starting the simple-memory setup for ${root}…` }
  })

  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    const io: Io = {
      read: async path => String(await $.fs.read(path)),
      write: (path, text) => $.fs.write(path, text),
      list: path => $.fs.list(path),
      exists: path => $.fs.exists(path),
      now: () => $.clock.now(),
      home: async () => (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')),
      cwd: () => $.session.cwd(),
      markRead: async refs => void (await update($, readNotes, list => merge(list, refs))),
      invalidateContext: () => void $.ui.invalidate('prompt.context'),
      remove: path => removeFile(argv => $.process.run(argv), file => $.fs.exists(file), path),
      forget: async id => {
        await update($, suggested, list => list.filter(one => one.id !== id))
        await update($, readNotes, list => list.filter(one => one.id !== id))
      },
      rename: async (from, to) => {
        await update($, suggested, list => renameIn(list, from, to))
        await update($, readNotes, list => renameIn(list, from, to))
      },
    }
    const text = await openingContext(io).catch(() => undefined)
    if (text === undefined) return result
    return { ...result, blocks: [...result.blocks.filter(block => block.name !== 'simpleMemory'), { name: 'simpleMemory', text }] }
  })

  on('prompt.submit', async ($, e, next) => {
    const isOwn = e.origin?.kind === 'plugin' && e.origin.name === PLUGIN
    if (maxHints === 0 || isOwn || e.text.trimStart().startsWith('/')) return next(e)

    const query = keywords(e.text, extra)
    if (query.length === 0) return next(e)

    const io: Io = {
      read: async path => String(await $.fs.read(path)),
      write: (path, text) => $.fs.write(path, text),
      list: path => $.fs.list(path),
      exists: path => $.fs.exists(path),
      now: () => $.clock.now(),
      home: async () => (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')),
      cwd: () => $.session.cwd(),
      markRead: async refs => void (await update($, readNotes, list => merge(list, refs))),
      invalidateContext: () => void $.ui.invalidate('prompt.context'),
      remove: path => removeFile(argv => $.process.run(argv), file => $.fs.exists(file), path),
      forget: async id => {
        await update($, suggested, list => list.filter(one => one.id !== id))
        await update($, readNotes, list => list.filter(one => one.id !== id))
      },
      rename: async (from, to) => {
        await update($, suggested, list => renameIn(list, from, to))
        await update($, readNotes, list => renameIn(list, from, to))
      },
    }
    const root = await rootOf(io)
    // Until the first walk completes, hint from what it has read so far.
    let notes: Note[]
    if (isWarm(root)) notes = await index(io, root).catch(() => [])
    else {
      void index(io, root).catch(() => undefined)
      notes = partial(root)
    }
    if (notes.length === 0) return next(e)

    const known = new Set([...(await read($, suggested)), ...(await read($, readNotes))].map(one => one.id))
    const hits = relevant(notes, query, MIN_HINT_SCORE)
      .filter(hit => !known.has(hit.item.id))
      .slice(0, maxHints)
      .map(hit => hit.item)
    if (hits.length === 0) return next(e)

    await update($, suggested, list => [...list, ...hits.map(refOf)])
    const hint = [
      '<simple-memory-hint>',
      'Notes in memory that may relate to this prompt (keyword match, not read yet):',
      ...hits.map(line),
      `Read the ones that look relevant with ${TOOL('read_note')} before answering; ignore the rest.`,
      '</simple-memory-hint>',
    ].join('\n')
    return next({ ...e, context: [...(e.context ?? []), hint] })
  }).catch(($, e, next) => next(e)) // fail open: a bookkeeping error never blocks the call

  // --- The nudge: after enough code edits, ask whether a note is due. ---

  on('tool.call', { tool: EDIT_TOOLS }, async ($, e, next) => {
    const ran = await next(e)
    if (nudgeAfter === 0 || ran.deny !== undefined || ran.isError) return ran
    const input = e as unknown as Args
    const path = str(input.file_path) || str(input.notebook_path)
    if (path === '') return ran
    const home = needsHome ? ((await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '') : ''
    const root = rootPath(home, needsCwd ? await $.session.cwd() : '')
    // A note file written by hand is a note, not work waiting for one.
    const rel = relativeTo(path, root)
    if (rel !== undefined && /\.md$/i.test(rel)) await update($, edited, () => [])
    else {
      // One file, however a tool spelled its path, counts once.
      const file = normalize(path)
      await update($, edited, list => (list.some(one => pathKey(one) === pathKey(file)) ? list : [...list, file]))
    }
    return ran
  }).catch(($, e, next) => next(e)) // fail open: a bookkeeping error never blocks the call

  on('turn.complete', async ($, e, next) => {
    const ended = await next(e)
    if (nudgeAfter === 0 || e.agentId !== undefined || e.reason !== 'answer' || e.isAborted) return ended
    const files = await read($, edited)
    if (files.length < nudgeAfter) return ended
    // Headless runs (-p, SDK) draw nowhere: never buy them an extra turn.
    if ((await $.session.surfaces()).length === 0) return ended
    await update($, edited, () => [])
    void $.prompt.submit({ text: nudgeText(files) }).catch(() => undefined)
    return ended
  })

  // --- The band: read notes first, then suggestions not read yet. ---

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.view.agentId !== undefined) return next(e)
    const done = await read($, readNotes)
    const doneIds = new Set(done.map(one => one.id))
    const pending = (await read($, suggested)).filter(one => !doneIds.has(one.id))
    if (done.length === 0 && pending.length === 0) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const insert = (id: string) => () => void $.prompt.fill({ text: `[[${id}]] `, mode: 'insert' })
    const width = Math.max(10, Math.min(40, Math.floor(e.props.bodyColumns / 3)))
    const label = (title: string) => (title.length > width ? `${title.slice(0, width - 1)}…` : title)

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2} width={e.props.bodyColumns}>
        <Text bold>memory</Text>
        {[...done].reverse().map(one => (
          <Box key={`r:${one.id}`} flexDirection="row">
            <Text color="green">● </Text>
            <Button key={`read:${one.id}`} label={label(one.title)} plain onPress={insert(one.id)} />
          </Box>
        ))}
        {[...pending].reverse().map(one => (
          <Box key={`s:${one.id}`} flexDirection="row">
            <Text dimColor>○ </Text>
            <Button key={`sug:${one.id}`} label={label(one.title)} plain dimColor onPress={insert(one.id)} />
          </Box>
        ))}
      </Box>
    )
  })
}
