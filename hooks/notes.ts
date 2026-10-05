// Note files: markdown with a small frontmatter block, and the pure edits
// the tools make to them.

export type Meta = {
  title: string
  tags: string[]
  created?: string
  updated?: string
  /** Frontmatter keys this module does not manage, kept as written. */
  rest: [string, string][]
}

export type Parsed = { meta: Meta; body: string }

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, '$2')

const parseList = (value: string) =>
  value
    .trim()
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map(unquote)
    .map(tag => tag.replace(/^#/, ''))
    .filter(Boolean)

/** Splits a note into frontmatter and body; a missing title falls back to the first heading or `fallback`. */
export const parse = (text: string, fallback: string): Parsed => {
  const meta: Meta = { title: '', tags: [], rest: [] }
  let body = text
  const front = FRONT.exec(text)

  if (front) {
    body = text.slice(front[0].length)
    const lines = (front[1] ?? '').split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i] ?? '')
      if (!match) continue
      const key = match[1] ?? ''
      const value = match[2] ?? ''
      if (key === 'title') meta.title = unquote(value)
      else if (key === 'created') meta.created = unquote(value)
      else if (key === 'updated') meta.updated = unquote(value)
      else if (key === 'tags') {
        if (value.trim() !== '') meta.tags = parseList(value)
        else {
          for (let item = lines[i + 1]; item !== undefined && /^\s*-\s+/.test(item); item = lines[i + 1]) {
            meta.tags.push(unquote(item.replace(/^\s*-\s+/, '')).replace(/^#/, ''))
            i += 1
          }
        }
      } else meta.rest.push([key, value])
    }
  }

  if (meta.title === '') {
    meta.title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? fallback
  }

  return { meta, body }
}

const quote = (value: string) => (/^[\w][\w .,()/&+-]*$/.test(value) && !/:\s/.test(value) ? value : JSON.stringify(value))

export const serialize = ({ meta, body }: Parsed): string => {
  const lines = [`title: ${quote(meta.title)}`]
  if (meta.tags.length > 0) lines.push(`tags: [${meta.tags.map(quote).join(', ')}]`)
  if (meta.created) lines.push(`created: ${meta.created}`)
  if (meta.updated) lines.push(`updated: ${meta.updated}`)
  for (const [key, value] of meta.rest) lines.push(`${key}: ${value}`)
  const text = body.replace(/^\n+/, '')
  return `---\n${lines.join('\n')}\n---\n\n${text.endsWith('\n') ? text : text + '\n'}`
}

export const slugify = (title: string): string =>
  title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '') || 'note'

/**
 * A folder or note path relative to the memory root, normalized; undefined
 * when it would leave the root (absolute, `..`, a drive letter).
 */
export const safeRelative = (path: string): string | undefined => {
  const clean = path.trim().replace(/\\/g, '/')
  if (clean.startsWith('/') || /^[A-Za-z]:/.test(clean) || clean.startsWith('~')) return undefined
  const parts = clean.split('/').filter(part => part !== '' && part !== '.')
  if (parts.some(part => part === '..' || part.startsWith('.'))) return undefined
  return parts.join('/')
}

/** A note's id: its path under the root without `.md`. */
export const idOf = (relPath: string) => relPath.replace(/\.md$/i, '')

export const tidyTags = (tags: readonly string[]) =>
  [...new Set(tags.map(tag => tag.trim().replace(/^#/, '').toLowerCase()).filter(Boolean))]

/** Replaces exactly one occurrence of `find`, or all with `all`; an error string when that is impossible. */
export const findReplace = (body: string, find: string, replace: string, all: boolean): string | { error: string } => {
  if (find === '') return { error: 'find must not be empty.' }
  const count = body.split(find).length - 1
  if (count === 0) return { error: 'find text not found in the note.' }
  if (count > 1 && !all) {
    return { error: `find text occurs ${count} times; give more context or set replace_all.` }
  }
  return body.split(find).join(replace)
}

/**
 * Replaces the body under the heading `section` (up to the next heading of
 * the same or a higher level); appends a new `## section` when absent.
 */
export const replaceSection = (body: string, section: string, content: string): string => {
  const wanted = section.replace(/^#+\s*/, '').trim().toLowerCase()
  const lines = body.split('\n')
  const start = lines.findIndex(line => {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    return match !== null && (match[2] ?? '').trim().toLowerCase() === wanted
  })
  const block = content.replace(/\n+$/, '')

  if (start < 0) {
    return `${body.replace(/\n+$/, '')}\n\n## ${section.replace(/^#+\s*/, '').trim()}\n\n${block}\n`
  }

  const level = /^(#+)/.exec(lines[start] ?? '')?.[1]?.length ?? 1
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const match = /^(#{1,6})\s/.exec(lines[i] ?? '')
    if (match && (match[1] ?? '').length <= level) {
      end = i
      break
    }
  }

  const after = lines.slice(end)
  return [...lines.slice(0, start + 1), '', block, ...(after.length > 0 ? ['', ...after] : [''])].join('\n')
}

/** The first line of `body` holding any of `terms` (stemmed words), trimmed, for a search snippet. */
export const snippet = (body: string, match: (line: string) => boolean, width = 160): string => {
  const lines = body.split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('---'))
  const line = lines.find(match) ?? lines.find(one => !one.startsWith('#')) ?? ''
  return line.length > width ? line.slice(0, width - 1) + '…' : line
}
