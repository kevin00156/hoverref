import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CommitInfo, TicketInfo } from '../types'
import { parseWorkItem, workItemUrl } from './plane'
import {
  EMPTY,
  browseUrl,
  fileHref,
  fitWidth,
  githubCommitUrl,
  isRelative,
  linkify,
  mergeLayers,
  parentDir,
  parseConfig,
  parseFileHref,
  pushRoot,
  resolvePath,
  scanBlock,
  spellings,
  splitBlocks,
} from './refs'
import type { Config, Link, Match, PlaneTracker, Term } from './refs'

const tickets = atom({ plugin: 'glossary', key: 'tickets' } as const, {} as Record<string, TicketInfo>)
const commits = atom({ plugin: 'glossary', key: 'commits' } as const, {} as Record<string, CommitInfo | null>)

const FETCH_TIMEOUT_MS = 5000
const MAX_FILE_CHECKS = 60
const MAX_ROOTS = 12
const MAX_SEEDED_PATHS = 200
const ADD_TOOL = 'mcp__glossary__add'

const USAGE = `# Glossary links

When your replies are shown to the user, ticket IDs, commit hashes, file paths that exist and registered project terms are turned into links with a hover card explaining them. Write them as plain text; do not add your own markdown links for them.

When you introduce a project-specific term the user may not know (an internal name, a label coined for a component or process, a reference document) that is not a general technical term, register it once with the ${ADD_TOOL} tool: \`name\`, \`target\` (a file path or an http(s) URL that explains it, which you have seen exist), and a one-line \`summary\` in the user's language. It is stored in the glossary of the repo the target belongs to; pass \`scope: "global"\` only for a term that means the same thing across all of the user's projects. If the tool says the term is already registered or clashes with an entry, move on; never work around it.`

type Ref =
  | { kind: 'ticket'; key: string; href: string; id: string; tracker: PlaneTracker }
  | { kind: 'file'; key: string; href: string; label: string; path: string; line?: number }
  | { kind: 'term'; key: string; href?: string; term: Term }
  | { kind: 'commit'; key: string; href?: string; hash: string; info: CommitInfo }

type Located = { start: number; end: number; ref: Ref }

type Lookup = { files: number; commits: Record<string, CommitInfo | null> }

// Module variables start over on a hot reload; session.start fires again
// then, so they are refilled before the next draw needs them.
let config: Config = EMPTY
// False until session.start has read the config and replayed the touched
// repos: the transcript is drawn before that, and a commit looked up then
// would be searched for in the session root alone.
let ready = false
let home = ''
let root = ''
let userFile = ''
let userLayer: Config = EMPTY
// Each directory's own glossary, keyed by the lowercased directory.
const repoLayers = new Map<string, Config>()
// Directories of files this session read or wrote, most recent first: their
// repo root, or the file's own folder outside any repo. A relative path the
// session root does not hold is looked up in these, and their glossaries are
// loaded, since an agent works in repos below wherever the session started.
let roots: string[] = []
const gitRoots = new Map<string, string | null>()
const remotes = new Map<string, string | null>()
const tokens = new Map<PlaneTracker, string | null>()
const inflight = new Set<string>()
// null: the path is not a file. lines: null until a card first needs them.
const files = new Map<string, { lines: string[] | null } | null>()
const addedThisTurn: Array<{ name: string; file: string }> = []

const slashes = (p: string) => p.replace(/\\/g, '/')
const isUrl = (s: string) => /^https?:\/\//.test(s)
// The session root first, then the touched directories; one per directory.
const searchDirs = () => [...new Map([root, ...roots].map(d => [d.toLowerCase(), d])).values()]

function rebuildConfig(): void {
  const layers = searchDirs().flatMap(d => repoLayers.get(d.toLowerCase()) ?? [])
  config = mergeLayers([...layers, userLayer])
}

async function loadLayer($: EngineInterface, path: string, base: string): Promise<Config> {
  if (!(await $.fs.exists(path))) return EMPTY
  try {
    return parseConfig(await $.fs.read(path), base)
  } catch (err) {
    $.ui.toast(`glossary: ${path} 讀不懂：${err instanceof Error ? err.message : String(err)}`)
    return EMPTY
  }
}

// A session started in the home directory reaches the user's file through
// its root too; it stays the global layer only.
async function ensureLayer($: EngineInterface, dir: string): Promise<void> {
  const key = dir.toLowerCase()
  if (repoLayers.has(key)) return
  const file = `${dir}/.claude/glossary.json`
  repoLayers.set(key, file.toLowerCase() === userFile.toLowerCase() ? EMPTY : await loadLayer($, file, dir))
}

async function loadConfig($: EngineInterface): Promise<void> {
  ready = false
  home = slashes((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '')
  root = slashes(await $.session.root())
  userFile = `${home}/.claude/glossary.json`
  userLayer = await loadLayer($, userFile, home)
  repoLayers.clear()
  roots = []
  await ensureLayer($, root)
  await seedRoots($).catch(() => undefined)
  rebuildConfig()
  ready = true
  await forgetMissingCommits($)
}

// "Not a commit" only holds for the repos searched so far: a repo the session
// reaches later may hold it.
async function forgetMissingCommits($: EngineInterface): Promise<void> {
  await update($, commits, all => Object.fromEntries(Object.entries(all).filter(([, info]) => info !== null)))
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

async function originOf($: EngineInterface, dir: string): Promise<string | null> {
  const cached = remotes.get(dir)
  if (cached !== undefined) return cached
  const ran = await $.process.run(['git', '-C', dir, 'remote', 'get-url', 'origin']).catch(() => undefined)
  const remote = ran?.exitCode === 0 ? ran.stdout.trim() : null
  remotes.set(dir, remote)
  return remote
}

// The first directory, in search order, whose repo holds the commit wins.
async function lookupCommit($: EngineInterface, hash: string): Promise<void> {
  let info: CommitInfo | null = null
  for (const dir of searchDirs()) {
    const argv = ['git', '-C', dir, 'log', '-1', '--format=%H%x1f%ad%x1f%an%x1f%s', '--date=short', `${hash}^{commit}`, '--']
    const ran = await $.process.run(argv).catch(() => undefined)
    if (ran?.exitCode !== 0) continue
    const [full = hash, date = '', author = '', subject = ''] = ran.stdout.trim().split('\x1f')
    const remote = await originOf($, dir)
    const url = remote === null ? undefined : githubCommitUrl(remote, full)
    info = { full, date, author, subject, ...(url === undefined ? {} : { url }) }
    break
  }
  inflight.delete(`commit:${hash}`)
  await update($, commits, all => ({ ...all, [hash]: info }))
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

// The nearest directory above the file holding .git; undefined outside a repo.
async function gitRootOf($: EngineInterface, file: string): Promise<string | undefined> {
  const start = parentDir(file)
  if (start === undefined) return undefined
  const cached = gitRoots.get(start)
  if (cached !== undefined) return cached ?? undefined
  let found: string | null = null
  for (let dir: string | undefined = start, depth = 0; dir !== undefined && depth < 12; dir = parentDir(dir), depth++) {
    if (await $.fs.exists(`${dir}/.git`)) {
      found = dir
      break
    }
  }
  gitRoots.set(start, found)
  return found ?? undefined
}

async function noteDir($: EngineInterface, dir: string): Promise<void> {
  const moved = roots[0]?.toLowerCase() !== dir.toLowerCase()
  const isNew = !searchDirs().some(d => d.toLowerCase() === dir.toLowerCase())
  roots = pushRoot(roots, dir, MAX_ROOTS)
  await ensureLayer($, dir)
  rebuildConfig()
  if (isNew && ready) await forgetMissingCommits($)
  if (moved) $.ui.invalidate('ui.render')
}

async function noteFile($: EngineInterface, path: string): Promise<void> {
  const file = resolvePath(path, root, home)
  const dir = (await gitRootOf($, file)) ?? parentDir(file)
  if (dir !== undefined) await noteDir($, dir)
}

// Replayed oldest first, so the most recently touched directory ends up first.
async function seedRoots($: EngineInterface): Promise<void> {
  const rows = await $.session.messages()
  // Rows the engine typed as always carrying toolUses are not trusted to: one
  // missing would throw and leave every repo unknown.
  const paths = rows.flatMap(r => r.toolUses ?? []).map(u => u.input?.file_path)
  for (const path of paths.filter((p): p is string => typeof p === 'string').slice(-MAX_SEEDED_PATHS)) {
    await noteFile($, path)
  }
}

async function findFile($: EngineInterface, path: string): Promise<string | undefined> {
  const bases = isRelative(path) ? searchDirs() : [root]
  for (const base of bases) {
    const candidate = resolvePath(path, base, home)
    if (await isFile($, candidate)) return candidate
  }
  return undefined
}

async function resolveRef($: EngineInterface, m: Match, lookup: Lookup): Promise<Ref | undefined> {
  if (m.kind === 'ticket') return { kind: 'ticket', key: m.id, href: browseUrl(m.tracker, m.id), id: m.id, tracker: m.tracker }
  if (m.kind === 'commit') {
    if (!ready) return undefined
    const info = lookup.commits[m.hash]
    if (info === undefined && !inflight.has(`commit:${m.hash}`)) {
      inflight.add(`commit:${m.hash}`)
      const { hash } = m
      // A draw may not write state: the lookup's write redraws this message.
      $.clock.after(0, () => {
        void lookupCommit($, hash)
      })
    }
    if (info === undefined || info === null) return undefined
    return { kind: 'commit', key: `commit:${m.hash}`, hash: m.hash, info, ...(info.url === undefined ? {} : { href: info.url }) }
  }
  if (m.kind === 'file') {
    if (lookup.files-- <= 0) return undefined
    const path = await findFile($, m.path)
    if (path === undefined) return undefined
    const label = m.line === undefined ? m.path : `${m.path}:${m.line}`
    return { kind: 'file', key: `${path}#${m.line ?? ''}`, href: fileHref(path, m.line), label, path, ...(m.line === undefined ? {} : { line: m.line }) }
  }
  const { term } = m
  const key = `term:${term.name}`
  if (isUrl(term.target)) return { kind: 'term', key, href: term.target, term }
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

function display(file: string): string {
  if (file.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return file.slice(root.length + 1)
  return file.toLowerCase().startsWith(`${home.toLowerCase()}/`) ? `~${file.slice(home.length)}` : file
}

async function firstGitRepo($: EngineInterface): Promise<string | undefined> {
  for (const dir of searchDirs()) {
    if (await $.fs.exists(`${dir}/.git`)) return dir
  }
  return undefined
}

// Where a new term goes: the glossary of the repo its target lives in, or of
// the repo the session works in for a URL; the global file when asked, or
// when there is no repo to put it in.
async function placeTerm(
  $: EngineInterface,
  target: string,
  isGlobal: boolean,
): Promise<{ repo?: string; target: string } | { missing: true }> {
  if (isUrl(target)) {
    if (!(await urlExists($, target))) return { missing: true }
    const repo = isGlobal ? undefined : await firstGitRepo($)
    return repo === undefined ? { target } : { repo, target }
  }
  const path = await findFile($, target)
  if (path === undefined) return { missing: true }
  const repo = isGlobal ? undefined : await gitRootOf($, path)
  return repo === undefined ? { target: path } : { repo, target: path.slice(repo.length + 1) }
}

async function addTerm($: EngineInterface, input: Record<string, unknown>): Promise<{ result: string } | { deny: string }> {
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const name = text(input.name)
  const summary = text(input.summary)
  const aliases = Array.isArray(input.aliases) ? input.aliases.map(text).filter(a => a !== '') : []
  const isGlobal = input.scope === 'global'
  if (name === '' || text(input.target) === '' || summary === '') return { deny: 'name、target、summary 都必填。' }

  const placed = await placeTerm($, text(input.target), isGlobal)
  if ('missing' in placed) return { deny: `target 不存在：${text(input.target)}。只能登記確認存在的檔案或網址。` }
  const { repo, target } = placed

  const wanted = [name, ...aliases]
  const clash = config.terms.find(t => spellings(t).some(s => wanted.includes(s)))
  if (clash !== undefined) {
    if (clash.name === name && clash.target === target) return { result: `「${name}」已經登記過了，不用再登記。` }
    const existing = JSON.stringify({ name: clash.name, aliases: clash.aliases, target: clash.target, summary: clash.summary })
    return { deny: `「${name}」和既有條目衝突，沒有寫入。既有條目：${existing}。要改既有條目請交給使用者。` }
  }

  const file = repo === undefined ? userFile : `${repo}/.claude/glossary.json`
  let raw: { terms?: unknown } = {}
  if (await $.fs.exists(file)) {
    try {
      raw = JSON.parse(await $.fs.read(file)) as { terms?: unknown }
    } catch {
      return { deny: `${file} 不是合法的 JSON，沒有寫入。` }
    }
  }
  raw.terms = [...(Array.isArray(raw.terms) ? raw.terms : []), { name, ...(aliases.length > 0 ? { aliases } : {}), target, summary }]
  const written = `${JSON.stringify(raw, null, 2)}\n`
  await $.fs.write(file, written)

  if (repo === undefined) userLayer = parseConfig(written, home)
  else {
    repoLayers.set(repo.toLowerCase(), parseConfig(written, repo))
    roots = searchDirs().some(d => d.toLowerCase() === repo.toLowerCase()) ? roots : pushRoot(roots, repo, MAX_ROOTS)
  }
  rebuildConfig()
  addedThisTurn.push({ name, file })
  $.ui.invalidate('ui.render')
  const fellBack = !isGlobal && repo === undefined ? '（target 不在任何 git repo 裡，所以寫進全域名詞庫）' : ''
  return { result: `已登記「${name}」到 ${display(file)}${fellBack}，之後的回覆會自動加上連結和說明。` }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await loadConfig($)
    await $.tool.register({
      name: 'add',
      description:
        "Register a project-specific term so it is linked and explained wherever it appears in replies. The target must exist: a file path or an http(s) URL. Stored in the glossary of the target's repo unless scope is global.",
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The term as it appears in text' },
          aliases: { type: 'array', items: { type: 'string' }, description: 'Other spellings of the same thing' },
          target: { type: 'string', description: 'File path (relative to a repo the session works in, or absolute) or http(s) URL that explains the term' },
          summary: { type: 'string', description: "One line explaining the term, in the user's language" },
          scope: { type: 'string', enum: ['repo', 'global'], description: 'global only for a term that means the same across all projects' },
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

  // A tool that wrote a file makes its cached lines stale, and any file a
  // tool touched tells which repo the session is working in.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const path = (e as { file_path?: unknown }).file_path
    if (typeof path === 'string') {
      files.delete(resolvePath(path, root, home))
      await noteFile($, path)
    }
    return ran
  }).catch(($, e, next) => next(e))

  // The model is not asked to report what it registered: the plugin saw each
  // write, so it says so itself where the user reads the turn.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (addedThisTurn.length > 0) {
      const byFile = new Map<string, string[]>()
      for (const { name, file } of addedThisTurn.splice(0)) byFile.set(file, [...(byFile.get(file) ?? []), name])
      const parts = [...byFile].map(([file, names]) => `${names.join('、')}（${display(file)}）`)
      // The engine prefixes the plugin's name to the line.
      $.ui.log(`這輪新登記了 ${parts.join('；')}`)
    }
    return done
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary === true) return next(e)
    const blocks = splitBlocks(e.props.text)
    const scanned = blocks.map(b => scanBlock(b, config))
    if (!scanned.some(ms => ms.length > 0)) return next(e)

    // Read before resolving: a lookup that lands later redraws through these.
    const knownTickets = await read($, tickets)
    const lookup: Lookup = { files: MAX_FILE_CHECKS, commits: await read($, commits) }
    const located: Located[][] = []
    for (const matches of scanned) {
      const found: Located[] = []
      for (const m of matches) {
        const ref = await resolveRef($, m, lookup)
        if (ref !== undefined) found.push({ start: m.start, end: m.end, ref })
      }
      located.push(found)
    }
    if (!located.some(l => l.length > 0)) return next(e)

    // A draw may not write state, so the fetch runs from a timer and its
    // write redraws this message through the read above.
    for (const { ref } of located.flat()) {
      if (ref.kind !== 'ticket' || knownTickets[ref.id] !== undefined || inflight.has(ref.id)) continue
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
      if (ref.kind === 'commit') return `${ref.hash}  ${ref.info.date} ${ref.info.subject}`
      if (ref.kind === 'file') return ref.line === undefined ? ref.label : `${ref.label}  ${await lineOf($, ref.path, ref.line)}`
      const info = knownTickets[ref.id]
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
