// Keyword extraction and scoring: no semantic search, just stemmed terms
// weighted by where they appear in a note and how rare they are overall.

const STOPWORDS = new Set(
  `a about above after again against all almost also although always am among an and another any anybody
  anyone anything anyway anywhere are aren't around as at be became because become been before being below
  between both but by can can't cannot could couldn't did didn't do does doesn't doing don't done down during
  each either else enough etc even ever every everything few for from further get gets getting give go goes
  going gone got had hadn't has hasn't have haven't having he her here hers herself him himself his how
  however i i'd i'll i'm i've if in into is isn't it it's its itself just know let let's like likely made make
  makes many may maybe me might mine more most much must my myself need needs neither never no nor not nothing
  now of off often oh ok okay on once one only or other others otherwise our ours ourselves out over own per
  please put quite rather really said same say says see seem seems shall she should shouldn't since so some
  somebody someone something sometimes somewhere still such sure take tell than thank thanks that that's the
  their theirs them themselves then there there's these they they're thing things think this those though
  through thus to too try trying under until up upon us use used using very via want wanted wants was wasn't
  way we we're well were weren't what what's whatever when where whether which while who whom whose why will
  with within without won't would wouldn't yeah yes yet you you'd you'll you're you've your yours yourself
  yourselves
  able actually add already anything anyways back can could currently does done etc find first fine good great
  help hey hi hello last lets look looking lot lots new next right show sure today want work yeah`
    .split(/\s+/)
    .filter(Boolean),
)

export const isStopword = (word: string, extra?: ReadonlySet<string>) =>
  STOPWORDS.has(word) || (extra !== undefined && extra.has(word))

/** A deliberately light stemmer, applied to both the prompt and the notes. */
export const stem = (word: string): string => {
  if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y'
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3)
  if (word.length > 4 && word.endsWith('ed') && !word.endsWith('eed')) return word.slice(0, -2)
  if (word.endsWith('sses')) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith('s') && !/(ss|us|is)$/.test(word)) return word.slice(0, -1)
  return word
}

/** Every word of `text`, lowercased and stemmed, stopwords and noise dropped; repeats kept. */
export const terms = (text: string, extra?: ReadonlySet<string>): string[] => {
  const words = text.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu) ?? []
  const out: string[] = []
  for (const word of words) {
    if (word.length < 2 || isStopword(word, extra)) continue
    if (/^\p{N}+$/u.test(word) && word.length < 3) continue
    out.push(stem(word.replace(/'.*$/, '')))
  }
  return out
}

/** The distinct terms of `text`, in first-seen order. */
export const keywords = (text: string, extra?: ReadonlySet<string>): string[] => [...new Set(terms(text, extra))]

export const parseStopwords = (list: string): ReadonlySet<string> =>
  new Set(
    list
      .split(/[\s,]+/)
      .map(word => word.trim().toLowerCase())
      .filter(Boolean),
  )

/** What the scorer needs from a note. */
export type Indexed = {
  titleTerms: ReadonlySet<string>
  tagTerms: ReadonlySet<string>
  pathTerms: ReadonlySet<string>
  /** Each body term with how often it occurs. */
  bodyTerms: ReadonlyMap<string, number>
}

export type Scored<T> = {
  item: T
  score: number
  /** Distinct query terms the note matched. */
  matched: number
  /** Whether a term hit the title, tags or path, not only the body. */
  isStrong: boolean
}

export const has = (note: Indexed, term: string) =>
  note.titleTerms.has(term) || note.tagTerms.has(term) || note.pathTerms.has(term) || note.bodyTerms.has(term)

/**
 * Scores every note against `query` (already reduced to keywords) with
 * field weights times inverse document frequency; unmatched notes are left out.
 */
export const score = <T extends Indexed>(notes: readonly T[], query: readonly string[]): Scored<T>[] => {
  const total = notes.length
  if (total === 0 || query.length === 0) return []

  const idf = new Map<string, number>()
  for (const term of query) {
    let df = 0
    for (const note of notes) if (has(note, term)) df += 1
    if (df > 0) idf.set(term, Math.log(1 + total / df))
  }

  const out: Scored<T>[] = []
  for (const note of notes) {
    let sum = 0
    let matched = 0
    let isStrong = false
    for (const [term, weight] of idf) {
      let s = 0
      if (note.titleTerms.has(term)) s += 3
      if (note.tagTerms.has(term)) s += 2.5
      if (note.pathTerms.has(term)) s += 1.5
      if (s > 0) isStrong = true
      const count = note.bodyTerms.get(term) ?? 0
      if (count > 0) s += Math.min(1 + Math.log(count), 3)
      if (s > 0) {
        matched += 1
        sum += s * weight
      }
    }
    if (matched > 0) out.push({ item: note, score: sum, matched, isStrong })
  }

  return out.sort((a, b) => b.score - a.score)
}

/**
 * The notes worth hinting for a prompt: a title, tag or path hit, or at
 * least two distinct terms in the body, and a score above the floor.
 */
export const relevant = <T extends Indexed>(
  notes: readonly T[],
  query: readonly string[],
  minScore: number,
): Scored<T>[] =>
  score(notes, query).filter(
    one => one.score >= minScore && (one.isStrong || one.matched >= Math.min(2, query.length)),
  )
