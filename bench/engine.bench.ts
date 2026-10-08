// The end-to-end benchmark: simple-memory's prompt.submit hook through the
// engine's own dispatch, over an in-memory file system beneath the plugin.
// Not a *.test.ts so `claude plugin test .` skips it: bench/run.ts copies it
// into a scratch copy of the plugin as tests/engine.test.ts, replacing
// __SIZES__ and __LAYOUT__, and reads the BENCH lines it prints.

import { mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { corpus, PROMPTS } from '../bench/corpus'
import type { Layout } from '../bench/corpus'

const ROOT = '/mem'
const SIZES: number[] = __SIZES__
const LAYOUT: Layout = __LAYOUT__
const WARM_RUNS = 15

const TYPED = { wait: false, origin: { kind: 'composer' } } as const

/** The notes as files, with the dispatch of every $.fs call counted. */
const memoryFs = (on: On, files: Map<string, string>, mtimes: Map<string, number>) => {
  const calls = { list: 0, read: 0, exists: 0 }
  const children = new Map<string, Map<string, 'file' | 'dir'>>()
  for (const path of files.keys()) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/') || '/'
      const name = parts[i]!
      if (!children.has(dir)) children.set(dir, new Map())
      children.get(dir)!.set(name, i === parts.length - 1 ? 'file' : 'dir')
    }
  }
  on('fs.exists', ($, e) => {
    calls.exists++
    return { value: files.has(e.path) || children.has(e.path) }
  })
  on('fs.read', ($, e) => {
    calls.read++
    const text = files.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.list', ($, e) => {
    calls.list++
    const names = children.get(e.path)
    if (!names) return { deny: `ENOENT: ${e.path}` }
    return {
      value: [...names].map(([name, kind]) => ({
        name,
        kind,
        size: 0,
        mtimeMs: kind === 'file' ? (mtimes.get(`${e.path}/${name}`) ?? 1) : 0,
        isLink: false,
      })),
    }
  })
  return calls
}

const stats = (ms: number[]) => {
  const sorted = [...ms].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
  return { median: at(0.5), p95: at(0.95), runs: ms.length }
}

const report = (n: number, name: string, ms: number[], extra: Record<string, number> = {}) =>
  console.log(`BENCH ${JSON.stringify({ n, name, ...stats(ms), ...extra })}`)

for (const n of SIZES) {
  test(`engine prompt.submit, ${n} notes`, { options: { directory: ROOT }, timeoutMs: 600_000 }, async ($, on) => {
    const files = new Map<string, string>()
    const mtimes = new Map<string, number>()
    for (const note of corpus(n, { layout: LAYOUT })) {
      files.set(`${ROOT}/${note.rel}`, note.text)
      mtimes.set(`${ROOT}/${note.rel}`, 1)
    }
    const calls = memoryFs(on, files, mtimes)
    mock.clock(on)
    on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))

    const time = async (text: string) => {
      const start = performance.now()
      await $.prompt.submit({ text, ...TYPED })
      return performance.now() - start
    }

    // Floor: a prompt with no keywords returns before touching the index.
    const floor: number[] = []
    for (let i = 0; i < WARM_RUNS; i++) floor.push(await time('ok thanks'))
    report(n, 'engine: no-keyword prompt (dispatch floor)', floor)

    // The first prompt starts the first walk and returns without waiting for it;
    // a tool call then joins that walk, so its end marks the walk's completion.
    const before = { ...calls }
    const walkStart = performance.now()
    const cold = [await time(PROMPTS[0]!)]
    report(n, 'engine: first prompt (walk runs in background)', cold)
    await $.tool.call({ tool: 'mcp__simple-memory__search_notes', query: '' })
    report(n, 'engine: first walk, until complete (background)', [performance.now() - walkStart], {
      list: calls.list - before.list,
      read: calls.read - before.read,
    })

    const warm: number[] = []
    const warmBefore = { ...calls }
    for (let i = 0; i < WARM_RUNS; i++) warm.push(await time(PROMPTS[i % 4]!))
    report(n, 'engine: later prompt (warm index)', warm, {
      list: Math.round((calls.list - warmBefore.list) / WARM_RUNS),
      read: Math.round((calls.read - warmBefore.read) / WARM_RUNS),
    })

    const changed: number[] = []
    const paths = [...files.keys()]
    for (let i = 0; i < WARM_RUNS; i++) {
      const path = paths[(i * 7919) % paths.length]!
      mtimes.set(path, (mtimes.get(path) ?? 1) + 1)
      changed.push(await time(PROMPTS[i % 4]!))
    }
    report(n, 'engine: prompt after one note changed', changed)

    const searching: number[] = []
    for (let i = 0; i < WARM_RUNS; i++) {
      const start = performance.now()
      await $.tool.call({ tool: 'mcp__simple-memory__search_notes', query: PROMPTS[i % 4]! })
      searching.push(performance.now() - start)
    }
    report(n, 'engine: search_notes (warm index)', searching)
  })
}
