import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TicketInfo } from '../types'
import { parseWorkItem, workItemUrl } from './plane'
import {
  EMPTY,
  browseUrl,
  fileHref,
  fitWidth,
  linkify,
  mergeConfigs,
  parseConfig,
  parseFileHref,
  parseTerm,
  resolvePath,
  scanBlock,
  spellings,
  splitBlocks,
} from './refs'
import type { Config, Link, Match, PlaneTracker, Term } from './refs'

const tickets = atom({ plugin: 'glossary', key: 'tickets' } as const, {} as Record<string, TicketInfo>)

const FETCH_TIMEOUT_MS = 5000
const MAX_FILE_CHECKS = 60
const ADD_TOOL = 'mcp__glossary__add'

const USAGE = `# Glossary links

When your replies are shown to the user, ticket IDs, file paths that exist and registered project terms are turned into links with a hover card explaining them. Write them as plain text; do not add your own markdown links for them.

When you introduce a project-specific term the user may not know (an internal name, a label coined for a component or process, a reference document) that is not a general technical term, register it once with the ${ADD_TOOL} tool: \`name\`, \`target\` (a repo-relative path or an http(s) URL that explains it, which you have seen exist), and a one-line \`summary\` in the user's language. If the tool says the term is already registered or clashes with an entry, move on; never work around it.`

type Ref =
  | { kind: 'ticket'; key: string; href: string; id: string; tracker: PlaneTracker }
  | { kind: 'file'; key: string; href: string; label: string; path: string; line?: number }
  | { kind: 'term'; key: string; href?: string; term: Term }

type Located = { start: number; end: number; ref: Ref }

// Module variables start over on a hot reload; session.start fires again
// then, so they are refilled before the next draw needs them.
let config: Config = EMPTY
let home = ''
let root = ''
let repoFile = ''
const tokens = new Map<PlaneTracker, string | null>()
const inflight = new Set<string>()
// null: the path is not a file. lines: null until a card first needs them.
const files = new Map<string, { lines: string[] | null } | null>()
const addedThisTurn: string[] = []

const slashes = (p: string) => p.replace(/\\/g, '/')

async function loadLayer($: EngineInterface, path: string, base: string): Promise<Config> {
  if (!(await $.fs.exists(path))) return EMPTY
  try {
    return parseConfig(await $.fs.read(path), base)
  } catch (err) {
    $.ui.toast(`glossary: ${path} 讀不懂：${err instanceof Error ? err.message : String(err)}`)
    return EMPTY
  }
}

async function loadConfig($: EngineInterface): Promise<void> {
  home = slashes((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '')
  root = slashes(await $.session.root())
  const userFile = `${home}/.claude/glossary.json`
  repoFile = `${root}/.claude/glossary.json`
  const user = await loadLayer($, userFile, home)
  // A session started in the home directory has one file serving as both.
  config = repoFile.toLowerCase() === userFile.toLowerCase() ? user : mergeConfigs(user, await loadLayer($, repoFile, root))
}

async function readToken($: EngineInterface, tracker: PlaneTracker): Promise<string | null> {
  const cached = tokens.get(tracker)
  if (cached !== undefined) return cached
  const path = tracker.tokenFile === undefined ? undefined : resolvePath(tracker.tokenFile, home, home)
  const token = path === undefined ? null : await $.fs.read(path).then(t => t.trim(), () => null)
  tokens.set(tracker, token)
  return token
}

async function fetchTicket($: EngineInterface, id: string, tracker: PlaneTracker): Promise<void> {
  const token = await readToken($, tracker)
  const headers: Record<string, string> = token === null ? {} : { 'X-API-Key': token }
  const info = await Promise.race([
    $.http.fetch(workItemUrl(tracker, id), { headers }).then(r => parseWorkItem(r.status, r.text)),
    $.clock.sleep(FETCH_TIMEOUT_MS).then((): TicketInfo => ({ status: 'error', reason: '連不到 Plane' })),
  ]).catch((): TicketInfo => ({ status: 'error', reason: '連不到 Plane' }))
  inflight.delete(id)
  await update($, tickets, all => ({ ...all, [id]: info }))
}

async function isFile($: EngineInterface, path: string): Promise<boolean> {
  if (!files.has(path)) {
    const stat = await $.fs.stat(path).catch(() => undefined)
    files.set(path, stat?.kind === 'file' ? { lines: null } : null)
  }
  return files.get(path) !== null
}

async function lineOf($: EngineInterface, path: string, line: number): Promise<string> {
  const entry = files.get(path)
  if (entry === undefined || entry === null) return ''
  entry.lines ??= await $.fs.read(path).then(t => t.split(/\r?\n/), () => [])
  return (entry.lines[line - 1] ?? '').trim()
}

async function urlExists($: EngineInterface, url: string): Promise<boolean> {
  const status = await Promise.race([
    $.http.fetch(url).then(r => r.status),
    $.clock.sleep(FETCH_TIMEOUT_MS).then(() => 0),
  ]).catch(() => 0)
  // A page behind a login still exists; only "not there" and no answer fail.
  return status !== 0 && status !== 404 && status !== 410 && status < 500
}

async function targetExists($: EngineInterface, target: string, base: string): Promise<boolean> {
  if (/^https?:\/\//.test(target)) return urlExists($, target)
  return isFile($, resolvePath(target, base, home))
}

async function resolveRef($: EngineInterface, m: Match, budget: { files: number }): Promise<Ref | undefined> {
  if (m.kind === 'ticket') return { kind: 'ticket', key: m.id, href: browseUrl(m.tracker, m.id), id: m.id, tracker: m.tracker }
  if (m.kind === 'file') {
    if (budget.files-- <= 0) return undefined
    const path = resolvePath(m.path, root, home)
    if (!(await isFile($, path))) return undefined
    const label = m.line === undefined ? m.path : `${m.path}:${m.line}`
    return { kind: 'file', key: `${path}#${m.line ?? ''}`, href: fileHref(path, m.line), label, path, ...(m.line === undefined ? {} : { line: m.line }) }
  }
  const { term } = m
  const key = `term:${term.name}`
  if (/^https?:\/\//.test(term.target)) return { kind: 'term', key, href: term.target, term }
  const path = resolvePath(term.target, term.base, home)
  return (await isFile($, path)) ? { kind: 'term', key, href: fileHref(path), term } : { kind: 'term', key, term }
}

async function openInEditor($: EngineInterface, href: string): Promise<void> {
  const target = parseFileHref(href)
  if (target === undefined) return
  const where = target.line === undefined ? target.path : `${target.path}:${target.line}`
  // The press lands only after the double-click window, and the VS Code CLI
  // takes a second or two more: say at once that the click was taken, so it
  // is not clicked again, which would turn into a double-click and drop it.
  $.ui.toast(`glossary: 用 VS Code 打開 ${where}…`)
  // `code` is a .cmd shim on Windows, which only cmd can run.
  const argv = /^[A-Za-z]:/.test(home) ? ['cmd', '/c', 'code', '-g', where] : ['code', '-g', where]
  const ran = await $.process.run(argv).catch(() => undefined)
  if (ran === undefined || ran.exitCode !== 0) $.ui.toast(`glossary: 開不了 VS Code：${where}`)
}

async function addTerm($: EngineInterface, input: Record<string, unknown>): Promise<{ result: string } | { deny: string }> {
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const name = text(input.name)
  const target = text(input.target)
  const summary = text(input.summary)
  const aliases = Array.isArray(input.aliases) ? input.aliases.map(text).filter(a => a !== '') : []
  if (name === '' || target === '' || summary === '') return { deny: 'name、target、summary 都必填。' }

  const wanted = [name, ...aliases]
  const clash = config.terms.find(t => spellings(t).some(s => wanted.includes(s)))
  if (clash !== undefined) {
    if (clash.name === name && clash.target === target) return { result: `「${name}」已經登記過了，不用再登記。` }
    const existing = JSON.stringify({ name: clash.name, aliases: clash.aliases, target: clash.target, summary: clash.summary })
    return { deny: `「${name}」和既有條目衝突，沒有寫入。既有條目：${existing}。要改既有條目請交給使用者。` }
  }
  if (!(await targetExists($, target, root))) return { deny: `target 不存在：${target}。只能登記確認存在的檔案或網址。` }

  let raw: { terms?: unknown } = {}
  if (await $.fs.exists(repoFile)) {
    try {
      raw = JSON.parse(await $.fs.read(repoFile)) as { terms?: unknown }
    } catch {
      return { deny: `${repoFile} 不是合法的 JSON，沒有寫入。` }
    }
  }
  const entry = { name, ...(aliases.length > 0 ? { aliases } : {}), target, summary }
  raw.terms = [...(Array.isArray(raw.terms) ? raw.terms : []), entry]
  await $.fs.write(repoFile, `${JSON.stringify(raw, null, 2)}\n`)

  config = { ...config, terms: [parseTerm(entry, 0, root), ...config.terms] }
  addedThisTurn.push(name)
  $.ui.invalidate('ui.render')
  return { result: `已登記「${name}」，之後的回覆會自動加上連結和說明。` }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await loadConfig($)
    await $.tool.register({
      name: 'add',
      description:
        'Register a project-specific term so it is linked and explained wherever it appears in replies. The target must exist: a repo-relative file path or an http(s) URL.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The term as it appears in text' },
          aliases: { type: 'array', items: { type: 'string' }, description: 'Other spellings of the same thing' },
          target: { type: 'string', description: 'Repo-relative path or http(s) URL that explains the term' },
          summary: { type: 'string', description: "One line explaining the term, in the user's language" },
        },
        required: ['name', 'target', 'summary'],
      },
    })
    // On a hot reload the transcript redraws before this hook has read the
    // config, and those draws fell through to the engine's own rows.
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { sections: [...composed.sections, { id: 'glossary:usage', text: USAGE, scope: 'session' }] }
  })

  on('tool.call', { tool: ADD_TOOL }, ($, e) => addTerm($, e as unknown as Record<string, unknown>)).catch(() => ({
    deny: 'glossary: 登記時出錯，沒有寫入。',
  }))

  // A tool that wrote a file makes its cached lines stale.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const path = (e as { file_path?: unknown }).file_path
    if (typeof path === 'string') files.delete(resolvePath(path, root, home))
    return ran
  }).catch(($, e, next) => next(e))

  // The model is not asked to report what it registered: the plugin saw each
  // write, so it says so itself where the user reads the turn.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (addedThisTurn.length > 0) {
      // The engine prefixes the plugin's name to the line.
      const where = repoFile.startsWith(`${root}/`) ? repoFile.slice(root.length + 1) : repoFile
      $.ui.log(`這輪新登記了 ${addedThisTurn.splice(0).join('、')}（${where}）`)
    }
    return done
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary === true) return next(e)
    const blocks = splitBlocks(e.props.text)
    const scanned = blocks.map(b => scanBlock(b, config))
    if (!scanned.some(ms => ms.length > 0)) return next(e)

    const budget = { files: MAX_FILE_CHECKS }
    const located: Located[][] = []
    for (const matches of scanned) {
      const found: Located[] = []
      for (const m of matches) {
        const ref = await resolveRef($, m, budget)
        if (ref !== undefined) found.push({ start: m.start, end: m.end, ref })
      }
      located.push(found)
    }
    if (!located.some(l => l.length > 0)) return next(e)

    const known = await read($, tickets)
    // A draw may not write state, so the fetch runs from a timer and its
    // write redraws this message through the read above.
    for (const { ref } of located.flat()) {
      if (ref.kind !== 'ticket' || known[ref.id] !== undefined || inflight.has(ref.id)) continue
      inflight.add(ref.id)
      const { id, tracker } = ref
      $.clock.after(0, () => {
        void fetchTicket($, id, tracker)
      })
    }

    const columns = e.viewport?.columns ?? 80
    const cardWidth = Math.max(20, Math.min(columns - 4, 100))

    // State goes before the title: a long title is cut at the end, and the
    // state is the part worth keeping.
    const describe = async (ref: Ref): Promise<string> => {
      if (ref.kind === 'term') return `${ref.term.name}  ${ref.term.summary}`
      if (ref.kind === 'file') return ref.line === undefined ? ref.label : `${ref.label}  ${await lineOf($, ref.path, ref.line)}`
      const info = known[ref.id]
      if (info === undefined) return `${ref.id}  讀取中…`
      if (info.status === 'error') return `${ref.id}  （${info.reason}）`
      return `${ref.id}  [${info.state}] ${info.title}`
    }

    // Blocks without references are merged back into one Markdown so the
    // engine's own spacing and list numbering survive where nothing changes.
    type Segment = { text: string; refs: Ref[]; fileHrefs: string[] }
    const seen = new Set<string>()
    const segments: Segment[] = []
    for (const [i, block] of blocks.entries()) {
      const found = located[i] ?? []
      const links: Link[] = found.flatMap(({ start, end, ref }) => (ref.href === undefined ? [] : [{ start, end, href: ref.href, key: ref.key }]))
      const text = linkify(block, links, seen)
      const refs = [...new Map(found.map(l => [l.ref.key, l.ref])).values()]
      const fileHrefs = [...new Set(links.map(l => l.href).filter(h => h.startsWith('file:')))]
      const prev = segments.at(-1)
      if (refs.length === 0 && prev !== undefined && prev.refs.length === 0) prev.text += `\n\n${text}`
      else segments.push({ text, refs, fileHrefs })
    }

    const lines = new Map<string, string>()
    for (const ref of segments.flatMap(s => s.refs)) lines.set(ref.key, fitWidth(await describe(ref), cardWidth - 2))

    const { Box, Markdown, Text } = $.ui.resolve(e)

    const card = (refs: Ref[]) => (
      <Box
        position="absolute"
        top={-(refs.length + 2)}
        left={0}
        width={cardWidth}
        display="none"
        hover={{ display: 'flex' }}
        borderStyle="round"
        borderColor="suggestion"
        flexDirection="column"
      >
        {refs.map(ref => (
          <Text>{lines.get(ref.key) ?? ''}</Text>
        ))}
      </Box>
    )

    const body = (segment: Segment, i: number) =>
      segment.fileHrefs.length === 0 ? (
        <Markdown text={segment.text} />
      ) : (
        <Markdown
          key={`m${i}`}
          text={segment.text}
          pressableLinks={segment.fileHrefs}
          onLinkPress={link => void openInEditor($, link.href)}
        />
      )

    // Our own tree replaces the engine's row, bullet included, so the reply's
    // opening bullet and the indent under it are drawn here.
    return (
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text>{e.props.isFirstOfReply ? '●' : ' '}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {segments.map((segment, i) => (
            <Box key={`b${i}`} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
              {body(segment, i)}
              {segment.refs.length > 0 && card(segment.refs)}
            </Box>
          ))}
        </Box>
      </Box>
    )
  })
}
