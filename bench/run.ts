#!/usr/bin/env bun
// simple-memory benchmark. Run from the repository root:
//
//   bun bench/run.ts                 # 100, 1000 and 5000 notes, disk + engine
//   bun bench/run.ts --sizes 100,1000 --skip-engine
//   bun bench/run.ts --layout wide       # 1,164 folders at 5,000 notes: the walk's worst case
//
// Disk: the plugin's own indexer (hooks/indexer.ts) and scorer
// (hooks/keywords.ts) over a generated knowledge base written to a temp
// directory, with node:fs standing in for $.fs. Engine: the plugin's
// prompt.submit hook dispatched by `claude plugin test`, over an in-memory
// file system, so every $.fs call pays the engine's dispatch.

import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile, access, cp } from 'node:fs/promises'
import { cpus, platform, release, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'

import { createIndexer } from '../hooks/indexer'
import type { IndexIo } from '../hooks/indexer'
import { keywords, relevant, search } from '../hooks/keywords'
import { corpus, LAYOUTS, PROMPTS } from './corpus'
import type { Layout } from './corpus'

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const value = (name: string) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
const SIZES = (value('--sizes') ?? '100,1000,5000').split(',').map(Number).filter(n => n > 0)
const LAYOUT = (value('--layout') ?? 'realistic') as Layout
if (!LAYOUTS.includes(LAYOUT)) throw new Error(`--layout must be one of ${LAYOUTS.join(', ')}`)
const MIN_HINT_SCORE = 1.5

type Row = { n: number; name: string; median: number; p95: number; runs: number; [key: string]: unknown }
const rows: Row[] = []

const stats = (ms: number[]) => {
  const sorted = [...ms].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
  return { median: at(0.5), p95: at(0.95), runs: ms.length }
}

const record = (n: number, name: string, ms: number[], extra: Record<string, unknown> = {}) => {
  const row = { n, name, ...stats(ms), ...extra }
  rows.push(row)
  console.error(`  ${name.padEnd(48)} median ${row.median.toFixed(2).padStart(9)} ms   p95 ${row.p95.toFixed(2).padStart(9)} ms`)
}

const time = async (fn: () => unknown) => {
  const start = performance.now()
  await fn()
  return performance.now() - start
}

/** node:fs in the shape $.fs answers: one list call gives each file's mtime. */
const diskIo: IndexIo = {
  exists: path => access(path).then(() => true, () => false),
  read: path => readFile(path, 'utf8'),
  list: async path => {
    const entries = await readdir(path, { withFileTypes: true })
    return Promise.all(
      entries.map(async entry => ({
        name: entry.name,
        kind: entry.isDirectory() ? ('dir' as const) : entry.isFile() ? ('file' as const) : ('other' as const),
        mtimeMs: entry.isFile() ? (await stat(join(path, entry.name))).mtimeMs : 0,
      })),
    )
  },
}

const benchDisk = async (n: number, base: string) => {
  const root = join(base, `kb-${n}`)
  const notes = corpus(n, { layout: LAYOUT })
  for (const note of notes) {
    const path = join(root, note.rel)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, note.text)
  }
  const bytes = notes.reduce((sum, note) => sum + note.text.length, 0)
  console.error(`\n${n} notes, ${(bytes / 1024 / 1024).toFixed(1)} MB (disk)`)

  const coldRuns = n >= 5000 ? 3 : 5
  const cold: number[] = []
  for (let i = 0; i < coldRuns; i++) cold.push(await time(() => createIndexer().index(diskIo, root)))
  record(n, 'disk: index, cold (parse every note)', cold, { mb: bytes / 1024 / 1024 })

  const indexer = createIndexer()
  const indexed = await indexer.index(diskIo, root)
  const warm: number[] = []
  for (let i = 0; i < 20; i++) warm.push(await time(() => indexer.index(diskIo, root)))
  record(n, 'disk: index, warm (walk + stat only)', warm)

  const changed: number[] = []
  for (let i = 0; i < 10; i++) {
    const note = notes[(i * 7919) % notes.length]!
    const when = new Date(Date.now() + (i + 1) * 1000)
    await utimes(join(root, note.rel), when, when)
    changed.push(await time(() => indexer.index(diskIo, root)))
  }
  record(n, 'disk: index, one note changed', changed)

  const scoring: number[] = []
  for (let i = 0; i < 50; i++) {
    for (const prompt of PROMPTS) scoring.push(await time(() => relevant(indexed, keywords(prompt), MIN_HINT_SCORE)))
  }
  record(n, 'scoring: keywords + relevant() (frontmatter)', scoring)

  const searching: number[] = []
  for (let i = 0; i < 10; i++) {
    for (const prompt of PROMPTS.slice(0, 4)) searching.push(await time(() => search(indexed, keywords(prompt))))
  }
  record(n, 'search: frontmatter + full text over all notes', searching)

  const hint: number[] = []
  for (let i = 0; i < 20; i++) {
    const prompt = PROMPTS[i % 4]!
    hint.push(
      await time(async () => {
        const query = keywords(prompt)
        const all = await indexer.index(diskIo, root)
        relevant(all, query, MIN_HINT_SCORE).slice(0, 5)
      }),
    )
  }
  record(n, 'disk: whole hint path, warm', hint)
}

const benchEngine = async (sizes: number[], base: string) => {
  const plugin = join(base, 'plugin')
  for (const part of ['.claude-plugin', 'hooks', 'types']) await cp(part, join(plugin, part), { recursive: true })
  await mkdir(join(plugin, 'bench'), { recursive: true })
  await cp('bench/corpus.ts', join(plugin, 'bench/corpus.ts'))
  await mkdir(join(plugin, 'tests'), { recursive: true })
  const template = await readFile('bench/engine.bench.ts', 'utf8')
  await writeFile(join(plugin, 'tests/engine.test.ts'), template
      .replace('= __SIZES__', `= ${JSON.stringify(sizes)}`)
      .replace('= __LAYOUT__', `= ${JSON.stringify(LAYOUT)}`))

  console.error(`\nengine (claude plugin test, in-memory fs), sizes ${sizes.join(', ')}`)
  const child = Bun.spawn(['claude', 'plugin', 'test', plugin], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  await child.exited
  const lines = `${out}\n${err}`.split('\n').filter(line => line.includes('BENCH {'))
  for (const line of lines) {
    const row = JSON.parse(line.slice(line.indexOf('{'))) as Row
    rows.push(row)
    console.error(`  ${String(row.n).padStart(5)}  ${row.name.padEnd(44)} median ${row.median.toFixed(2).padStart(9)} ms   p95 ${row.p95.toFixed(2).padStart(9)} ms`)
  }
  if (child.exitCode !== 0 || lines.length === 0) {
    console.error(`claude plugin test exited ${child.exitCode}:\n${(out + err).slice(-2000)}`)
  }
}

const machine = () => {
  const cpu = cpus()[0]?.model ?? 'unknown CPU'
  return `${cpu} (${cpus().length} threads), ${(totalmem() / 1024 ** 3).toFixed(0)} GB, ${platform()} ${release()}, Bun ${Bun.version}`
}

const markdown = () => {
  const names = [...new Set(rows.map(row => row.name))]
  const sizes = [...new Set(rows.map(row => row.n))].sort((a, b) => a - b)
  const fmt = (ms: number) => (ms < 10 ? ms.toFixed(2) : ms < 100 ? ms.toFixed(1) : ms.toFixed(0))
  const head = `| measurement | ${sizes.map(n => `${n} notes`).join(' | ')} |`
  const rule = `| --- | ${sizes.map(() => '---:').join(' | ')} |`
  const body = names.map(name => {
    const cells = sizes.map(n => {
      const row = rows.find(one => one.n === n && one.name === name)
      return row ? `${fmt(row.median)} / ${fmt(row.p95)}` : ''
    })
    return `| ${name} | ${cells.join(' | ')} |`
  })
  return [`Median / p95 in ms, ${LAYOUT} layout. ${machine()}.`, '', head, rule, ...body].join('\n')
}

const base = await mkdtemp(join(tmpdir(), 'simple-memory-bench-'))
try {
  if (!flag('--skip-disk')) for (const n of SIZES) await benchDisk(n, base)
  if (!flag('--skip-engine')) await benchEngine(SIZES, base)
  console.log(flag('--json') ? JSON.stringify({ machine: machine(), rows }, null, 2) : `\n${markdown()}`)
} finally {
  await rm(base, { recursive: true, force: true })
}
