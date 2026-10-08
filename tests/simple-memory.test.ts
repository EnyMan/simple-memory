import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { keywords } from '../hooks/keywords'
import { parse, replaceSection, serialize, slugify } from '../hooks/notes'
import { normalize, pathKey, relativeTo, removeFile } from '../hooks/paths'

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

/**
 * A Windows path as the plugin asked for it. On Linux, where these tests run,
 * the engine resolves `C:/…` against the working directory before a hook sees
 * it (on Windows it is absolute already), so the drive is cut back out here.
 */
const drive = (path: string) => path.replace(/^.*?\/(?=[A-Za-z]:\/)/, '')

/** An in-memory file system beneath the plugin. */
const memoryFs = (on: On, files: Record<string, string> = {}, gate?: Promise<void>, reads = { count: 0 }) => {
  const store = new Map(Object.entries(files))
  let tick = 1
  const mtimes = new Map([...store.keys()].map(path => [path, tick++]))
  const isDir = (path: string) => [...store.keys()].some(file => file.startsWith(`${path}/`))

  on('fs.read', async ($, e) => {
    await gate
    reads.count += 1
    const text = store.get(drive(e.path))
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', ($, e) => {
    store.set(drive(e.path), e.text)
    mtimes.set(drive(e.path), tick++)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => {
    const path = drive(e.path)
    return { value: store.has(path) || isDir(path) }
  })
  on('fs.list', ($, e) => {
    const dir = drive(e.path)
    if (!isDir(dir)) return { deny: `ENOENT: ${dir}` }
    const names = new Map<string, 'file' | 'dir'>()
    for (const file of store.keys()) {
      if (!file.startsWith(`${dir}/`)) continue
      const [name, ...rest] = file.slice(dir.length + 1).split('/')
      if (name) names.set(name, rest.length > 0 ? 'dir' : 'file')
    }
    return {
      value: [...names].map(([name, kind]) => ({
        name,
        kind,
        size: 0,
        mtimeMs: kind === 'file' ? (mtimes.get(`${dir}/${name}`) ?? 0) : 0,
        isLink: false,
      })),
    }
  })
  on('process.run', ($, e) => {
    const [command] = e.argv
    let exitCode = 1
    if (command === 'rm') {
      const path = e.argv[3]
      exitCode = path !== undefined && store.delete(path) ? 0 : 1
    } else if (command === 'cmd') {
      // Like the real del: exit 0 whether or not anything was deleted.
      const path = e.argv[5]?.replace(/\\/g, '/')
      if (path !== undefined) store.delete(path)
      exitCode = 0
    }
    return {
      value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  return store
}

/** Waits for the plugin's first walk of the notes, as a tool call does. */
const warmUp = ($: Engine) => $.tool.call({ tool: 'mcp__simple-memory__search_notes', query: '' })

/** The fields write_note requires beside title, folder and content. */
const SCHEMA = { summary: 'What to check before a release.', keywords: ['release', 'checklist', 'ship'] }

const NOTES = {
  [`${ROOT}/MEMORY.md`]: '# Memory structure\n\nTeam knowledge.\n\n## Folders\n\n- `decisions/` — why we chose things\n',
  [`${ROOT}/decisions/use-postgres.md`]:
    '---\ntitle: Use Postgres for storage\ntags: [database, backend]\n---\n\nWe chose Postgres over MySQL for JSONB support.\n',
  [`${ROOT}/how-to/deploy-backend.md`]:
    '---\ntitle: Deploy the backend\nsummary: Run the deploy pipeline from main; roll back with the previous tag.\nkeywords: [deploy, release, rollback, pipeline]\ntags: [ops]\n---\n\nRun the deploy pipeline from main. The cluster is kubernetes.\n',
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
    const parsed = parse(
      '---\ntitle: "A: b"\nsummary: "One line: here"\nkeywords:\n  - alpha\n  - beta gamma\ntags:\n  - x\n  - y\nowner: me\n---\n\nBody\n',
      'f',
    )
    expect(parsed.meta.title).toBe('A: b')
    expect(parsed.meta.summary).toBe('One line: here')
    expect(parsed.meta.keywords).toEqual(['alpha', 'beta gamma'])
    expect(parsed.meta.tags).toEqual(['x', 'y'])
    const again = parse(serialize(parsed), 'f')
    expect(again.meta).toEqual(parsed.meta)
    expect(again.body.trim()).toBe('Body')
  })

  test('keeps Windows line endings', () => {
    const crlf = '---\r\ntitle: T\r\nkeywords: [a, b, c]\r\n---\r\n\r\n# T\r\n\r\n## A\r\n\r\nold\r\n'
    const parsed = parse(crlf, 'f')
    expect(parsed.eol).toBe('\r\n')
    expect(parsed.meta.keywords).toEqual(['a', 'b', 'c'])
    expect(parsed.body).not.toContain('\r')
    const edited = serialize({ ...parsed, body: replaceSection(parsed.body, 'A', 'new') })
    expect(edited).toContain('## A\r\n\r\nnew\r\n')
    expect(edited.replace(/\r\n/g, '')).not.toContain('\n')
    expect(serialize(parse('---\ntitle: T\n---\n\nx\n', 'f'))).not.toContain('\r')
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

describe('paths', () => {
  test('normalize', () => {
    expect(normalize('C:\\Users\\me\\memory\\')).toBe('C:/Users/me/memory')
    expect(normalize('c:/Users//me')).toBe('C:/Users/me')
    expect(normalize('\\\\server\\share\\notes')).toBe('//server/share/notes')
    expect(normalize('/home/me//memory/')).toBe('/home/me/memory')
    expect(normalize('~\\notes')).toBe('~/notes')
  })

  test('relativeTo: Windows ignores case and separators; Unix does not', () => {
    expect(relativeTo('c:\\users\\ME\\memory\\Decisions\\x.md', 'C:/Users/me/memory')).toBe('Decisions/x.md')
    expect(relativeTo('C:\\Users\\me\\memory-old\\x.md', 'C:/Users/me/memory')).toBeUndefined()
    expect(relativeTo('/home/me/memory/a/x.md', '/home/me/memory')).toBe('a/x.md')
    expect(relativeTo('/home/me/Memory/a/x.md', '/home/me/memory')).toBeUndefined()
    expect(pathKey('C:\\Src\\A.ts')).toBe(pathKey('c:/src/a.ts'))
    expect(pathKey('/src/A.ts')).not.toBe(pathKey('/src/a.ts'))
  })

  test('removeFile checks the file is gone, since del exits 0 regardless', async () => {
    const files = new Set(['C:/m/a.md', '/m/a.md'])
    const calls: string[] = []
    const run = (removes: boolean) => async (argv: readonly string[]) => {
      calls.push(argv.join(' '))
      if (removes) files.delete(argv[0] === 'cmd' ? argv[5]!.replace(/\\/g, '/') : argv[3]!)
      return { exitCode: 0, stderr: '' }
    }
    const exists = async (path: string) => files.has(path)

    await removeFile(run(true), exists, 'C:/m/a.md')
    expect(calls).toEqual(['cmd /c del /f /q C:\\m\\a.md'])
    await removeFile(run(true), exists, '/m/a.md')
    expect(calls.at(-1)).toBe('rm -f -- /m/a.md')

    files.add('C:/m/b.md')
    await expect(removeFile(run(false), exists, 'C:/m/b.md')).rejects.toThrow('could not delete C:/m/b.md')
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
    await warmUp($)

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
      ...SCHEMA,
    })
    expect(String(wrote.result)).toContain('Created how-to/release-checklist')
    expect(files.get(`${ROOT}/how-to/release-checklist.md`)).toContain(
      'summary: What to check before a release.\nkeywords: [release, checklist, ship]\ntags: [ops]\ncreated: 2026-10-05T00:00:00Z',
    )

    const found = await $.tool.call({ tool: 'mcp__simple-memory__search_notes', query: 'release steps' })
    expect(String(found.result)).toContain('how-to/release-checklist')

    const edited = await $.tool.call({
      tool: 'mcp__simple-memory__edit_note',
      note: 'Release checklist',
      operation: 'replace_section',
      section: 'Steps',
      content: '- tag\n- announce',
    })
    expect(files.get(`${ROOT}/how-to/release-checklist.md`)).toContain('- announce')
    expect(String(edited.result)).toContain('Check that the summary and keywords still fit')

    const read = await $.tool.call({ tool: 'mcp__simple-memory__read_note', notes: ['[[how-to/release-checklist]]'] })
    expect(String(read.result)).toContain('- announce')

    const twice = await $.tool.call({
      tool: 'mcp__simple-memory__write_note',
      title: 'Release checklist',
      folder: 'how-to',
      content: 'x',
      ...SCHEMA,
    })
    expect(String(twice.result)).toContain('already exists')

    const escape = await $.tool.call({
      tool: 'mcp__simple-memory__write_note',
      title: 'x',
      folder: '../etc',
      content: 'x',
      ...SCHEMA,
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

  test('nudges after enough edited files, only in drawn main-session answers', OPTIONS, async ($, on) => {
    memoryFs(on, NOTES)
    mock.clock(on, { now: Date.UTC(2026, 9, 5) })
    let surfaces: string[] = []
    on('session.surfaces', () => ({ value: surfaces as never }))
    on('tool.call', ($, e) => ({ result: `ran ${e.tool}` }))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    const prompts: string[] = []
    on('prompt.submit', ($, e) => {
      prompts.push(e.text)
      return { text: e.text }
    })
    const turn = { answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as const
    const edit = (file_path: string) =>
      $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b', replace_all: false })

    await edit('/src/a.ts')
    await edit('/src/a.ts')
    await edit('/src/b.ts')
    await $.turn.complete(turn)
    expect(prompts).toEqual([])

    await edit('/src/c.ts')
    await $.turn.complete(turn) // headless: nothing draws
    await $.turn.complete({ ...turn, agentId: 'sub' })
    await $.turn.complete({ ...turn, reason: 'aborted', isAborted: true })
    expect(prompts).toEqual([])

    surfaces = ['terminal']
    await $.turn.complete(turn)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Automated nudge from the simple-memory plugin')
    expect(prompts[0]).toContain('edited 3 files')
    expect(prompts[0]).toContain('- /src/c.ts')
    expect(prompts[0]).toContain('No note needed.')

    // The count starts over; writing a note clears it too.
    await edit('/src/d.ts')
    await edit('/src/e.ts')
    await $.tool.call({ tool: 'mcp__simple-memory__write_note', title: 'Gotcha', folder: 'how-to', content: 'x', ...SCHEMA })
    await edit('/src/f.ts')
    await $.turn.complete(turn)
    expect(prompts).toHaveLength(1)

    // Editing a note file by hand counts as writing a note.
    await edit('/src/g.ts')
    await edit(`${ROOT}/how-to/gotcha.md`)
    await edit('/src/h.ts')
    await $.turn.complete(turn)
    expect(prompts).toHaveLength(1)
  })

  test('write_note enforces the schema; edit_note can fix a legacy note', OPTIONS, async ($, on) => {
    const files = memoryFs(on, NOTES)
    mock.clock(on, { now: Date.UTC(2026, 9, 5) })
    const write = (extra: Record<string, unknown>) =>
      $.tool.call({ tool: 'mcp__simple-memory__write_note', title: 'Gotcha', folder: 'how-to', content: 'x', ...extra })

    expect(String((await write({ keywords: SCHEMA.keywords })).result)).toContain('summary is required')
    expect(String((await write({ summary: 'x', keywords: ['one', 'two'] })).result)).toContain('keywords needs 3-12')
    expect(String((await write({ summary: 'a\nb'.repeat(150), keywords: SCHEMA.keywords })).result)).toContain(
      'at most 200',
    )
    expect(files.has(`${ROOT}/how-to/gotcha.md`)).toBe(false)

    // A legacy note: flagged in search, fixed with a frontmatter-only edit.
    const found = await $.tool.call({ tool: 'mcp__simple-memory__search_notes', query: 'postgres' })
    expect(String(found.result)).toContain('decisions/use-postgres')
    expect(String(found.result)).toContain('(no summary and keywords)')

    const fixed = await $.tool.call({
      tool: 'mcp__simple-memory__edit_note',
      note: 'decisions/use-postgres',
      summary: 'Why we chose Postgres over MySQL.',
      keywords: ['Postgres', 'database', 'mysql', 'jsonb'],
    })
    expect(String(fixed.result)).toBe('Updated decisions/use-postgres.')
    expect(files.get(`${ROOT}/decisions/use-postgres.md`)).toContain('keywords: [postgres, database, mysql, jsonb]')
    expect(files.get(`${ROOT}/decisions/use-postgres.md`)).toContain('We chose Postgres over MySQL')

    const appended = await $.tool.call({
      tool: 'mcp__simple-memory__edit_note',
      note: 'people/jane',
      operation: 'append',
      content: 'Also on call.',
    })
    expect(String(appended.result)).toContain('no summary and keywords')
  })

  test('hints match frontmatter only; search also reads bodies', OPTIONS, async ($, on) => {
    memoryFs(on, NOTES)
    const contexts: (readonly string[] | undefined)[] = []
    on('prompt.submit', ($, e) => {
      contexts.push(e.context)
      return { text: e.text, context: e.context }
    })
    await warmUp($)

    // "kubernetes" is only in a body: no hint.
    await $.prompt.submit({ text: 'Is our kubernetes cluster healthy?', ...TYPED })
    expect(contexts[0]).toBeUndefined()

    // A keyword hit hints, with the note's summary.
    await $.prompt.submit({ text: 'How do I roll out a release?', ...TYPED })
    const hint = contexts[1]?.join('\n') ?? ''
    expect(hint).toContain('how-to/deploy-backend — "Deploy the backend" [ops]: Run the deploy pipeline from main')

    const body = await $.tool.call({ tool: 'mcp__simple-memory__search_notes', query: 'kubernetes' })
    expect(String(body.result)).toContain('how-to/deploy-backend')
    expect(String(body.result)).toContain('The cluster is kubernetes.')

    // Frontmatter matches rank above body-only ones.
    const ranked = String((await $.tool.call({ tool: 'mcp__simple-memory__search_notes', query: 'postgres' })).result)
    expect(ranked.indexOf('decisions/use-postgres')).toBeLessThan(ranked.indexOf('people/jane'))
  })

  test('a prompt never waits for the first walk, which finishes in the background', OPTIONS, async ($, on) => {
    let release = () => {}
    const gate = new Promise<void>(resolve => (release = resolve))
    const reads = { count: 0 }
    memoryFs(on, NOTES, gate, reads)
    const contexts: (readonly string[] | undefined)[] = []
    on('prompt.submit', ($, e) => {
      contexts.push(e.context)
      return { text: e.text, context: e.context }
    })

    // Every read is held: the prompt still goes through, without a hint.
    await $.prompt.submit({ text: 'Which database do we use for storage?', ...TYPED })
    expect(contexts).toEqual([undefined])

    // Once reads flow, the walk the prompt started completes on its own.
    release()
    await warmUp($)
    await $.prompt.submit({ text: 'Which database do we use for storage?', ...TYPED })
    expect(contexts[1]?.join('\n') ?? '').toContain('decisions/use-postgres')
    // The 3 notes were read once, by that first walk: nothing read them again.
    expect(reads.count).toBe(3)
  })

  test('a Windows memory folder: backslash paths from tools, del, CRLF notes', { options: { directory: 'C:\\Users\\me\\memory', nudgeAfterFiles: 2 } }, async ($, on) => {
    const WIN = 'C:/Users/me/memory'
    const files = memoryFs(on, {
      [`${WIN}/decisions/use-postgres.md`]:
        '---\r\ntitle: Use Postgres for storage\r\nsummary: Why Postgres.\r\nkeywords: [postgres, database, storage]\r\n---\r\n\r\n## Why\r\n\r\nJSONB.\r\n',
      [`${WIN}/how-to/deploy.md`]: '---\ntitle: Deploy\nsummary: How to deploy.\nkeywords: [deploy, release, ship]\n---\n\nSteps.\n',
    })
    mock.clock(on, { now: Date.UTC(2026, 9, 5) })
    let surfaces: string[] = ['terminal']
    on('session.surfaces', () => ({ value: surfaces as never }))
    on('tool.call', ($, e) => ({ result: `ran ${e.tool}` }))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    const prompts: string[] = []
    on('prompt.submit', ($, e) => {
      prompts.push(e.text)
      return { text: e.text }
    })
    const turn = { answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as const
    const edit = (file_path: string) =>
      $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b', replace_all: false })

    // A full Windows path, in any case, finds the note.
    const read = await $.tool.call({
      tool: 'mcp__simple-memory__read_note',
      notes: ['c:\\users\\me\\memory\\decisions\\use-postgres.md'],
    })
    expect(String(read.result)).toContain('# decisions/use-postgres')

    // The Read tool's backslash path marks the note read.
    await $.tool.call({ tool: 'Read', file_path: 'C:\\Users\\me\\memory\\how-to\\deploy.md' })
    const ui = await $.ui.mount({ plugin: 'simple-memory', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ key: 'read:how-to/deploy' })).toBeDefined()
    await ui.unmount()

    // One file in two spellings counts once; a note edited by hand resets the count.
    await edit('C:\\src\\a.ts')
    await edit('c:/SRC/A.ts')
    await $.turn.complete(turn)
    expect(prompts).toHaveLength(0)
    await edit('C:\\Users\\me\\memory\\how-to\\deploy.md')
    await edit('C:\\src\\b.ts')
    await $.turn.complete(turn)
    expect(prompts).toHaveLength(0)
    await edit('C:\\src\\c.ts')
    await $.turn.complete(turn)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('- C:/src/b.ts')

    // Editing a CRLF note keeps CRLF.
    await $.tool.call({
      tool: 'mcp__simple-memory__edit_note',
      note: 'decisions/use-postgres',
      operation: 'replace_section',
      section: 'Why',
      content: 'JSONB and ops familiarity.',
    })
    const after = files.get(`${WIN}/decisions/use-postgres.md`) ?? ''
    expect(after).toContain('## Why\r\n\r\nJSONB and ops familiarity.\r\n')
    expect(after.replace(/\r\n/g, '')).not.toContain('\n')

    // Deleting goes through del, and is checked.
    const deleted = await $.tool.call({ tool: 'mcp__simple-memory__delete_note', note: 'how-to/deploy' })
    expect(String(deleted.result)).toContain('Deleted how-to/deploy')
    expect(files.has(`${WIN}/how-to/deploy.md`)).toBe(false)
    surfaces = []
  })
})
