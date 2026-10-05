import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { keywords } from '../hooks/keywords'
import { parse, replaceSection, serialize, slugify } from '../hooks/notes'

const ROOT = '/mem'
const OPTIONS = { options: { directory: ROOT } }
const COMMAND = {
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
} as const
const TYPED = { wait: false, origin: { kind: 'composer' } } as const
const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 5, contentRows: 0 },
  view: {},
}

/** An in-memory file system beneath the plugin. */
const memoryFs = (on: On, files: Record<string, string> = {}) => {
  const store = new Map(Object.entries(files))
  let tick = 1
  const mtimes = new Map([...store.keys()].map(path => [path, tick++]))
  const isDir = (path: string) => [...store.keys()].some(file => file.startsWith(`${path}/`))

  on('fs.read', ($, e) => {
    const text = store.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', ($, e) => {
    store.set(e.path, e.text)
    mtimes.set(e.path, tick++)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: store.has(e.path) || isDir(e.path) }))
  on('fs.list', ($, e) => {
    if (!isDir(e.path)) return { deny: `ENOENT: ${e.path}` }
    const names = new Map<string, 'file' | 'dir'>()
    for (const file of store.keys()) {
      if (!file.startsWith(`${e.path}/`)) continue
      const [name, ...rest] = file.slice(e.path.length + 1).split('/')
      if (name) names.set(name, rest.length > 0 ? 'dir' : 'file')
    }
    return {
      value: [...names].map(([name, kind]) => ({
        name,
        kind,
        size: 0,
        mtimeMs: kind === 'file' ? (mtimes.get(`${e.path}/${name}`) ?? 0) : 0,
        isLink: false,
      })),
    }
  })
  on('process.run', ($, e) => {
    const [command, , , path] = e.argv
    const isRemoved = command === 'rm' && path !== undefined && store.delete(path)
    return {
      value: { exitCode: isRemoved ? 0 : 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  return store
}

const NOTES = {
  [`${ROOT}/MEMORY.md`]: '# Memory structure\n\nTeam knowledge.\n\n## Folders\n\n- `decisions/` — why we chose things\n',
  [`${ROOT}/decisions/use-postgres.md`]:
    '---\ntitle: Use Postgres for storage\ntags: [database, backend]\n---\n\nWe chose Postgres over MySQL for JSONB support.\n',
  [`${ROOT}/how-to/deploy-backend.md`]:
    '---\ntitle: Deploy the backend\ntags: [ops]\n---\n\nRun the deploy pipeline from main.\n',
  [`${ROOT}/people/jane.md`]:
    '---\ntitle: Jane Doe\n---\n\nOwns the billing service. Agreed on [[decisions/use-postgres|Postgres]].\n',
}

describe('keywords', () => {
  test('drops stopwords and stems', () => {
    expect(keywords('Is the database and the databases a good idea?')).toEqual(['database', 'idea'])
    expect(keywords('a an the is and or')).toEqual([])
  })

  test('extra stopwords', () => {
    expect(keywords('jak nasadit backend', new Set(['jak']))).toEqual(['nasadit', 'backend'])
  })
})

describe('notes', () => {
  test('frontmatter round trip', () => {
    const parsed = parse('---\ntitle: "A: b"\ntags:\n  - x\n  - y\nowner: me\n---\n\nBody\n', 'f')
    expect(parsed.meta.title).toBe('A: b')
    expect(parsed.meta.tags).toEqual(['x', 'y'])
    const again = parse(serialize(parsed), 'f')
    expect(again.meta).toEqual(parsed.meta)
    expect(again.body.trim()).toBe('Body')
  })

  test('title falls back to the first heading', () => {
    expect(parse('# Hello there\n\ntext', 'f').meta.title).toBe('Hello there')
  })

  test('replace section', () => {
    const body = '# T\n\n## A\n\nold\n\n## B\n\nkeep\n'
    expect(replaceSection(body, 'A', 'new')).toBe('# T\n\n## A\n\nnew\n\n## B\n\nkeep\n')
    expect(replaceSection(body, 'C', 'added')).toContain('## C\n\nadded')
  })

  test('slugify', () => {
    expect(slugify('Použít Postgres? Ano!')).toBe('pouzit-postgres-ano')
  })
})

describe('plugin', () => {
  test('hints relevant notes once, and the band lists them', OPTIONS, async ($, on) => {
    memoryFs(on, NOTES)
    const contexts: (readonly string[] | undefined)[] = []
    on('prompt.submit', ($, e) => {
      contexts.push(e.context)
      return { text: e.text, context: e.context }
    })

    await $.prompt.submit({ text: 'Which database do we use for storage?', ...TYPED })
    const first = contexts[0]?.join('\n') ?? ''
    expect(first).toContain('decisions/use-postgres')
    expect(first).not.toContain('people/jane')

    await $.prompt.submit({ text: 'And the database again?', ...TYPED })
    expect(contexts[1]).toBeUndefined()

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'simple-memory', surface, component: 'AbovePrompt', props: BAND_PROPS })
      expect(await ui.find({ key: 'sug:decisions/use-postgres' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('write, search, read and edit notes', OPTIONS, async ($, on) => {
    const files = memoryFs(on, NOTES)
    mock.clock(on, { now: Date.UTC(2026, 9, 5) })

    const wrote = await $.tool.call({
      tool: 'mcp__simple-memory__write_note',
      title: 'Release checklist',
      folder: 'how-to',
      content: '# Release checklist\n\n## Steps\n\n- tag\n',
      tags: ['Ops'],
    })
    expect(String(wrote.result)).toContain('Created how-to/release-checklist')
    expect(files.get(`${ROOT}/how-to/release-checklist.md`)).toContain('tags: [ops]\ncreated: 2026-10-05T00:00:00Z')

    const found = await $.tool.call({ tool: 'mcp__simple-memory__search_notes', query: 'release steps' })
    expect(String(found.result)).toContain('how-to/release-checklist')

    await $.tool.call({
      tool: 'mcp__simple-memory__edit_note',
      note: 'Release checklist',
      operation: 'replace_section',
      section: 'Steps',
      content: '- tag\n- announce',
    })
    expect(files.get(`${ROOT}/how-to/release-checklist.md`)).toContain('- announce')

    const read = await $.tool.call({ tool: 'mcp__simple-memory__read_note', notes: ['[[how-to/release-checklist]]'] })
    expect(String(read.result)).toContain('- announce')

    const twice = await $.tool.call({
      tool: 'mcp__simple-memory__write_note',
      title: 'Release checklist',
      folder: 'how-to',
      content: 'x',
    })
    expect(String(twice.result)).toContain('already exists')

    const escape = await $.tool.call({
      tool: 'mcp__simple-memory__write_note',
      title: 'x',
      folder: '../etc',
      content: 'x',
    })
    expect(String(escape.result)).toContain('inside the memory root')

    const ui = await $.ui.mount({ plugin: 'simple-memory', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ key: 'read:how-to/release-checklist' })).toBeDefined()
    await ui.unmount()
  })

  test('init writes the guide and folders', OPTIONS, async ($, on) => {
    const files = memoryFs(on)
    const done = await $.tool.call({
      tool: 'mcp__simple-memory__init_memory',
      overview: 'A shared team knowledge base.',
      folders: [
        { path: 'decisions', purpose: 'Why we chose things' },
        { path: 'how-to', purpose: 'Step-by-step guides' },
      ],
      conventions: '- One topic per note.',
    })
    expect(String(done.result)).toContain('Initialized /mem')
    expect(files.get(`${ROOT}/MEMORY.md`)).toContain('`decisions/` — Why we chose things')
    expect(files.has(`${ROOT}/how-to/.gitkeep`)).toBe(true)
  })

  test('/memory-init starts a guided setup turn', OPTIONS, async ($, on) => {
    memoryFs(on)
    const clock = mock.clock(on)
    const prompts: string[] = []
    on('prompt.submit', ($, e) => {
      prompts.push(e.text)
      return { text: e.text }
    })
    const ran = await $.command.run({ command: 'memory-init', args: 'a shared team wiki', ...COMMAND })
    expect(ran.text).toContain('/mem')
    await clock.advance(1)
    expect(prompts[0]).toContain('What I have in mind: a shared team wiki')
    expect(prompts[0]).toContain('mcp__simple-memory__init_memory')
  })

  test('move a note and relink, then delete it', OPTIONS, async ($, on) => {
    const files = memoryFs(on, NOTES)
    mock.clock(on, { now: Date.UTC(2026, 9, 5) })

    await $.tool.call({ tool: 'mcp__simple-memory__read_note', notes: ['decisions/use-postgres'] })
    const moved = await $.tool.call({
      tool: 'mcp__simple-memory__move_note',
      note: 'Use Postgres for storage',
      destination: 'archive/',
    })
    expect(String(moved.result)).toContain('Moved decisions/use-postgres to archive/use-postgres')
    expect(String(moved.result)).toContain('people/jane')
    expect(files.has(`${ROOT}/decisions/use-postgres.md`)).toBe(false)
    expect(files.get(`${ROOT}/archive/use-postgres.md`)).toContain('JSONB')
    expect(files.get(`${ROOT}/people/jane.md`)).toContain('[[archive/use-postgres|Postgres]]')

    const renamed = await $.tool.call({
      tool: 'mcp__simple-memory__move_note',
      note: 'archive/use-postgres',
      destination: 'archive/postgres',
      title: 'Postgres',
    })
    expect(String(renamed.result)).toContain('to archive/postgres')
    expect(files.get(`${ROOT}/archive/postgres.md`)).toContain('title: Postgres')

    const clash = await $.tool.call({
      tool: 'mcp__simple-memory__move_note',
      note: 'archive/postgres',
      destination: 'people/jane',
    })
    expect(String(clash.result)).toContain('already exists')

    const ui = await $.ui.mount({ plugin: 'simple-memory', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ key: 'read:archive/postgres' })).toBeDefined()
    await ui.unmount()

    const deleted = await $.tool.call({ tool: 'mcp__simple-memory__delete_note', note: 'archive/postgres' })
    expect(String(deleted.result)).toContain('Deleted archive/postgres')
    expect(String(deleted.result)).toContain('still link to it: people/jane')
    expect(files.has(`${ROOT}/archive/postgres.md`)).toBe(false)

    await $.tool.call({ tool: 'mcp__simple-memory__read_note', notes: ['people/jane'] })
    const after = await $.ui.mount({ plugin: 'simple-memory', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await after.find({ key: 'read:people/jane' })).toBeDefined()
    expect(await after.find({ key: 'read:archive/postgres' })).toBeUndefined()
    await after.unmount()
  })
})
