// Pure text logic: no `$`, so the tests exercise it directly.

export type PlaneTracker = {
  kind: 'plane'
  baseUrl: string
  workspace: string
  prefixes: string[]
  tokenFile?: string
}

// `base` is the directory a relative `target` resolves against: the repo
// root for the repo's file, the home directory for the user's.
export type Term = { name: string; aliases: string[]; target: string; summary: string; base: string }

export type Config = { trackers: PlaneTracker[]; terms: Term[] }

export type Match =
  | { kind: 'ticket'; start: number; end: number; id: string; tracker: PlaneTracker }
  | { kind: 'term'; start: number; end: number; term: Term }
  | { kind: 'file'; start: number; end: number; path: string; line?: number }

export type Link = { start: number; end: number; href: string; key: string }

export const EMPTY: Config = { trackers: [], terms: [] }

export function parseConfig(text: string, base: string): Config {
  const raw = JSON.parse(text) as { trackers?: unknown; terms?: unknown }
  const trackers = raw.trackers ?? []
  const terms = raw.terms ?? []
  if (!Array.isArray(trackers)) throw new Error('"trackers" must be an array')
  if (!Array.isArray(terms)) throw new Error('"terms" must be an array')
  return { trackers: trackers.map(parseTracker), terms: terms.map((t, i) => parseTerm(t, i, base)) }
}

function parseTracker(raw: unknown, i: number): PlaneTracker {
  const t = raw as Partial<PlaneTracker>
  const where = `trackers[${i}]`
  if (t.kind !== 'plane') throw new Error(`${where}.kind must be "plane"`)
  if (typeof t.baseUrl !== 'string') throw new Error(`${where}.baseUrl must be a string`)
  if (typeof t.workspace !== 'string') throw new Error(`${where}.workspace must be a string`)
  const prefixes = t.prefixes
  if (!Array.isArray(prefixes) || !prefixes.every(p => /^[A-Z][A-Z0-9]*$/.test(p))) {
    throw new Error(`${where}.prefixes must be uppercase identifiers like "CK"`)
  }
  return {
    kind: 'plane',
    baseUrl: t.baseUrl.replace(/\/+$/, ''),
    workspace: t.workspace,
    prefixes,
    ...(typeof t.tokenFile === 'string' ? { tokenFile: t.tokenFile } : {}),
  }
}

export function parseTerm(raw: unknown, i: number, base: string): Term {
  const t = raw as Partial<Term>
  const where = `terms[${i}]`
  for (const field of ['name', 'target', 'summary'] as const) {
    const value = t[field]
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`${where}.${field} must be a non-empty string`)
  }
  const aliases = t.aliases ?? []
  if (!Array.isArray(aliases) || !aliases.every(a => typeof a === 'string' && a.trim() !== '')) {
    throw new Error(`${where}.aliases must be an array of non-empty strings`)
  }
  return { name: t.name as string, aliases, target: t.target as string, summary: t.summary as string, base }
}

// The repo's terms win: a user-level term is dropped when any of its spellings
// is taken by a repo term, so one word never points two ways.
export function mergeConfigs(user: Config, repo: Config): Config {
  const taken = new Set(repo.terms.flatMap(spellings))
  return {
    trackers: [...user.trackers, ...repo.trackers],
    terms: [...repo.terms, ...user.terms.filter(t => !spellings(t).some(s => taken.has(s)))],
  }
}

export function spellings(term: Term): string[] {
  return [term.name, ...term.aliases]
}

export function browseUrl(tracker: PlaneTracker, id: string): string {
  return `${tracker.baseUrl}/${tracker.workspace}/browse/${id}/`
}

// Blank lines outside a fence separate blocks; a fence stays whole even when
// it holds blank lines, so code never gets cut in half.
export function splitBlocks(markdown: string): string[] {
  const blocks: string[] = []
  let current: string[] = []
  let fence: string | undefined
  for (const line of markdown.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence === undefined && marker !== undefined) fence = marker[0]
    else if (fence !== undefined && marker?.[0] === fence) fence = undefined
    else if (fence === undefined && line.trim() === '') {
      if (current.length > 0) blocks.push(current.join('\n'))
      current = []
      continue
    }
    current.push(line)
  }
  if (current.length > 0) blocks.push(current.join('\n'))
  return blocks
}

const FENCE = /^\s*(`{3,}|~{3,})[\s\S]*/g
const INLINE_CODE = /(`+)([\s\S]*?)\1/g

// Spans a reference inside of is not prose: linking there would break the
// code, nest a link in a link, or cut a URL apart.
const PROTECTED = [
  FENCE,
  INLINE_CODE,
  /!?\[[^\]]*\]\([^)]*\)/g,
  /<[a-z][a-z0-9+.-]*:[^>\s]*>/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s)>\]]+/gi,
]

function protectedSpans(block: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  for (const re of PROTECTED) {
    for (const m of block.matchAll(re)) spans.push([m.index, m.index + m[0].length])
  }
  return spans
}

// The extension must start with a letter so version numbers like 2.1.291 are
// not candidates; every candidate still has to exist on disk to be linked.
const PATH = String.raw`(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\\/])?(?:[\w.@+-]+[\\/])*[\w@+-][\w.@+-]*\.[A-Za-z][A-Za-z0-9]{0,7}(?::(?<line>\d+)(?:[:-]\d+)?)?`
const PROSE_PATH = new RegExp(String.raw`(?<![\w./\\:-])${PATH}(?![\w/\\-])`, 'g')
const WHOLE_PATH = new RegExp(String.raw`^${PATH}$`)

function ticketPattern(config: Config): RegExp | undefined {
  const prefixes = config.trackers.flatMap(t => t.prefixes)
  if (prefixes.length === 0) return undefined
  // Longest first, so PLCB is not read as a shorter prefix that happens to match.
  const alternation = [...prefixes].sort((a, b) => b.length - a.length).join('|')
  return new RegExp(`(?<![A-Za-z0-9_/.-])(${alternation})-(\\d+)(?![A-Za-z0-9_-])`, 'g')
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Chinese has no spaces between words, so a CJK term matches anywhere; an
// ASCII edge must not touch another ASCII word character.
function termPattern(config: Config): RegExp | undefined {
  const words = config.terms.flatMap(spellings)
  if (words.length === 0) return undefined
  const alternation = [...new Set(words)]
    .sort((a, b) => b.length - a.length)
    .map(w => {
      const head = /^[A-Za-z0-9_]/.test(w) ? '(?<![A-Za-z0-9_])' : ''
      const tail = /[A-Za-z0-9_]$/.test(w) ? '(?![A-Za-z0-9_])' : ''
      return `${head}${escapeRegExp(w)}${tail}`
    })
    .join('|')
  return new RegExp(alternation, 'g')
}

function fileMatch(m: RegExpMatchArray, start: number, end: number): Match {
  const line = m.groups?.line
  const path = m[0].replace(/:\d+(?:[:-]\d+)?$/, '')
  return { kind: 'file', start, end, path, ...(line !== undefined ? { line: Number(line) } : {}) }
}

// Every reference candidate in the block, sorted and without overlaps; file
// candidates are unverified, the caller keeps only those that exist.
export function scanBlock(block: string, config: Config): Match[] {
  const spans = protectedSpans(block)
  const isProse = (start: number, end: number) => !spans.some(([s, e]) => start < e && end > s)
  const found: Match[] = []

  const tickets = ticketPattern(config)
  const trackerOf = new Map(config.trackers.flatMap(t => t.prefixes.map(p => [p, t] as const)))
  for (const m of tickets === undefined ? [] : block.matchAll(tickets)) {
    const tracker = trackerOf.get(m[1] ?? '')
    const end = m.index + m[0].length
    if (tracker !== undefined && isProse(m.index, end)) found.push({ kind: 'ticket', start: m.index, end, id: m[0], tracker })
  }

  const terms = termPattern(config)
  const termOf = new Map(config.terms.flatMap(t => spellings(t).map(s => [s, t] as const)))
  for (const m of terms === undefined ? [] : block.matchAll(terms)) {
    const term = termOf.get(m[0])
    const end = m.index + m[0].length
    if (term !== undefined && isProse(m.index, end)) found.push({ kind: 'term', start: m.index, end, term })
  }

  for (const m of block.matchAll(PROSE_PATH)) {
    const end = m.index + m[0].length
    if (isProse(m.index, end)) found.push(fileMatch(m, m.index, end))
  }
  // A path the agent wrote as inline code is linked as a whole, backticks
  // included, so the link keeps its code styling.
  for (const m of block.matchAll(INLINE_CODE)) {
    const inner = WHOLE_PATH.exec((m[2] ?? '').trim())
    if (inner !== null) found.push({ ...fileMatch(inner, m.index, m.index + m[0].length) })
  }

  found.sort((a, b) => a.start - b.start || b.end - a.end)
  const kept: Match[] = []
  for (const match of found) {
    const last = kept.at(-1)
    if (last === undefined || match.start >= last.end) kept.push(match)
  }
  return kept
}

// `seen` spans the whole reply: only the first mention of a key becomes a link.
export function linkify(block: string, links: readonly Link[], seen: Set<string>): string {
  let out = ''
  let last = 0
  for (const link of links) {
    if (seen.has(link.key)) continue
    seen.add(link.key)
    out += `${block.slice(last, link.start)}[${block.slice(link.start, link.end)}](${link.href})`
    last = link.end
  }
  return out + block.slice(last)
}

export function fileHref(absolute: string, line?: number): string {
  const path = absolute.replace(/\\/g, '/')
  const encoded = encodeURI(path).replace(/\(/g, '%28').replace(/\)/g, '%29')
  return `file://${path.startsWith('/') ? '' : '/'}${encoded}${line === undefined ? '' : `#L${line}`}`
}

export function parseFileHref(href: string): { path: string; line?: number } | undefined {
  const m = /^file:\/\/\/?(.*?)(?:#L(\d+))?$/.exec(href)
  if (m === null) return undefined
  const decoded = decodeURI(m[1] ?? '').replace(/%28/g, '(').replace(/%29/g, ')')
  const path = /^[A-Za-z]:/.test(decoded) ? decoded : `/${decoded}`
  return { path, ...(m[2] !== undefined ? { line: Number(m[2]) } : {}) }
}

export function isRelative(path: string): boolean {
  return !/^(?:[A-Za-z]:[\\/]|[\\/]|~[\\/])/.test(path)
}

export function parentDir(path: string): string | undefined {
  const p = path.replace(/[\\/]+$/, '')
  const cut = p.lastIndexOf('/')
  // A drive or filesystem root has no parent.
  if (cut < 0 || /^[A-Za-z]:$/.test(p) || p === '') return undefined
  return cut === 0 ? '/' : p.slice(0, cut)
}

// Most recent first, one entry per directory whatever its case, at most `max`.
export function pushRoot(roots: readonly string[], dir: string, max: number): string[] {
  return [dir, ...roots.filter(r => r.toLowerCase() !== dir.toLowerCase())].slice(0, max)
}

export function resolvePath(path: string, base: string, home: string): string {
  const p = path.replace(/\\/g, '/')
  if (/^[A-Za-z]:\//.test(p) || p.startsWith('/')) return p
  if (p.startsWith('~/')) return `${home}${p.slice(1)}`
  return `${base.replace(/\/+$/, '')}/${p.replace(/^\.\//, '')}`
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

export function displayWidth(text: string): number {
  let w = 0
  for (const ch of text) w += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1
  return w
}

// An absolutely placed card only paints the cells its text covers, so every
// line is padded to the full width or the transcript beneath shows through.
export function fitWidth(text: string, width: number): string {
  const full = displayWidth(text)
  if (full <= width) return text + ' '.repeat(width - full)
  let out = ''
  let used = 0
  for (const ch of text) {
    const w = isWide(ch.codePointAt(0) ?? 0) ? 2 : 1
    if (used + w > width - 1) break
    out += ch
    used += w
  }
  return out + '…' + ' '.repeat(width - used - 1)
}
