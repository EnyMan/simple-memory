// A synthetic knowledge base: deterministic notes with frontmatter, nested
// folders, Zipf-distributed vocabulary and bodies of 1 to 20 KB. Pure (no
// file system), so the disk benchmark and the engine benchmark share it.

export type CorpusNote = { rel: string; text: string }

/** mulberry32: small, fast, deterministic. */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const COMMON = `the of and to in is for that on with as it be by this are from at or an we was
not have which can will but if all more when use our their has one they its about been there also
would other into should then than only some what these may most could first two after new each
time way over such them make like system data service user team code release change issue build
deploy config cache database query index api client server request error test review design plan
decision reason because migration schema backend frontend auth token session queue worker job
pipeline metric alert incident rollback feature flag customer support contract budget meeting`
  .split(/\s+/)
  .filter(Boolean)

const SYLLABLES = 'ka lo mi re su ta vo ne pi ra do fe gu li mo sa te zu ba ki'.split(' ')
const TAGS = `backend frontend ops infra security billing auth data ml mobile design process
people onboarding incident decision howto reference glossary meeting project research customer
release testing performance docs api database cache queue search analytics compliance hiring
roadmap budget vendor tooling`
  .split(/\s+/)
  .filter(Boolean)
const FOLDERS = ['decisions', 'how-to', 'concepts', 'projects', 'people', 'references', 'meetings', 'inbox']

/** A vocabulary of real-looking common words plus invented rarer ones. */
const vocabulary = (random: () => number, size: number) => {
  const words = new Set(COMMON)
  while (words.size < size) {
    const length = 2 + Math.floor(random() * 3)
    let word = ''
    for (let i = 0; i < length; i++) word += SYLLABLES[Math.floor(random() * SYLLABLES.length)]
    words.add(word)
  }
  return [...words]
}

/** Draws word indices with a Zipf-like (1/rank) distribution. */
const zipf = (random: () => number, size: number) => {
  const cumulative: number[] = []
  let sum = 0
  for (let rank = 1; rank <= size; rank++) cumulative.push((sum += 1 / rank))
  return () => {
    const target = random() * sum
    let lo = 0
    let hi = size - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((cumulative[mid] ?? 0) < target) lo = mid + 1
      else hi = mid
    }
    return lo
  }
}

export type CorpusOptions = { seed?: number; minBytes?: number; maxBytes?: number; vocabulary?: number }

export const corpus = (count: number, options: CorpusOptions = {}): CorpusNote[] => {
  const random = rng(options.seed ?? 42)
  const words = vocabulary(random, options.vocabulary ?? 8000)
  const pick = zipf(random, words.length)
  const word = () => words[pick()] ?? 'note'
  const minBytes = options.minBytes ?? 1024
  const maxBytes = options.maxBytes ?? 20 * 1024
  const notes: CorpusNote[] = []
  const used = new Set<string>()

  for (let n = 0; n < count; n++) {
    const titleWords = Array.from({ length: 3 + Math.floor(random() * 4) }, word)
    const title = titleWords.map(w => w[0]!.toUpperCase() + w.slice(1)).join(' ') + ` ${n}`
    const tags = [...new Set(Array.from({ length: 1 + Math.floor(random() * 3) }, () => TAGS[Math.floor(random() * TAGS.length)]!))]
    const folder = FOLDERS[Math.floor(random() * FOLDERS.length)]!
    const sub = random() < 0.4 ? `/${words[Math.floor(random() * 200)]}` : ''
    let rel = `${folder}${sub}/${titleWords.join('-')}-${n}.md`
    while (used.has(rel)) rel = rel.replace(/\.md$/, '-x.md')
    used.add(rel)

    // Log-uniform size between minBytes and maxBytes.
    const target = Math.round(minBytes * Math.pow(maxBytes / minBytes, random()))
    const lines: string[] = [`# ${title}`, '']
    let size = 0
    while (size < target) {
      if (random() < 0.08) lines.push('', `## ${word()} ${word()}`, '')
      const sentence = Array.from({ length: 8 + Math.floor(random() * 14) }, word).join(' ') + '.'
      lines.push(random() < 0.2 ? `- ${sentence}` : sentence)
      size += sentence.length + 1
    }
    const text = `---\ntitle: ${title}\ntags: [${tags.join(', ')}]\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-01T00:00:00Z\n---\n\n${lines.join('\n')}\n`
    notes.push({ rel, text })
  }
  return notes
}

/** Prompts of the kind the hint runs on: short, chatty, a few content words. */
export const PROMPTS = [
  'Can you help me fix the cache invalidation bug in the auth service?',
  'Why did we decide to move the billing queue to a new worker pool last quarter?',
  'Write a migration for the user sessions table and update the API docs.',
  'What is the deploy rollback process when an incident alert fires?',
  'ok thanks',
]
