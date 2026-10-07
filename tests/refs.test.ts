import { expect, test } from 'claude-code/testing'

import {
  displayWidth,
  fileHref,
  fitWidth,
  githubCommitUrl,
  isRelative,
  linkify,
  mergeLayers,
  parseConfig,
  parentDir,
  parseFileHref,
  pushRoot,
  resolvePath,
  scanBlock,
  splitBlocks,
} from '../hooks/refs'
import type { Match } from '../hooks/refs'

const config = parseConfig(
  JSON.stringify({
    trackers: [{ kind: 'plane', baseUrl: 'http://plane:8090/', workspace: 'work', prefixes: ['CK', 'PLCB', 'PLC'] }],
    terms: [
      { name: '車籍表', aliases: ['vehicle registry'], target: 'docs/v.md', summary: 's' },
      { name: '車籍', target: 'docs/short.md', summary: 's' },
      { name: 'seqlock', target: 'https://x/seqlock', summary: 's' },
    ],
  }),
  '/repo',
)

const keyOf = (m: Match) =>
  m.kind === 'ticket' ? m.id : m.kind === 'term' ? m.term.name : m.kind === 'commit' ? m.hash : m.path
const show = (block: string, seen = new Set<string>()) =>
  linkify(
    block,
    scanBlock(block, config).map(m => ({ start: m.start, end: m.end, href: 'H', key: keyOf(m) })),
    seen,
  )
const kinds = (block: string) => scanBlock(block, config).map(m => `${m.kind}:${block.slice(m.start, m.end)}`)

test('only the first mention of a key in a reply is linked', async () => {
  const seen = new Set<string>()
  expect(show('CK-1 and CK-1', seen)).toBe('[CK-1](H) and CK-1')
  expect(show('again CK-1', seen)).toBe('again CK-1')
})

test('the longest ticket prefix wins and unknown prefixes are not tickets', async () => {
  expect(kinds('PLCB-3 not PLC-3B, UTF-8, CDS-3')).toEqual(['ticket:PLCB-3'])
})

test('CJK terms match inside running text, longest first', async () => {
  expect(kinds('改寫車籍表的那張工單，車籍也要改')).toEqual(['term:車籍表', 'term:車籍'])
})

test('ASCII terms need word edges', async () => {
  expect(kinds('a seqlock here, not seqlocks or myseqlock')).toEqual(['term:seqlock'])
  expect(kinds('the vehicle registry table')).toEqual(['term:vehicle registry'])
})

test('paths in prose and whole inline-code paths are file candidates', async () => {
  expect(kinds('see hooks/register.tsx:42 and `src/a.ts` too')).toEqual([
    'file:hooks/register.tsx:42',
    'file:`src/a.ts`',
  ])
  const [file] = scanBlock('see hooks/register.tsx:42', config)
  expect(file).toMatchObject({ kind: 'file', path: 'hooks/register.tsx', line: 42 })
})

test('version numbers, code with more than a path, links and URLs are left alone', async () => {
  const text = [
    'v2.1.291 here',
    '`CK-2 車籍表` inline',
    '[CK-3](http://x) here',
    'http://plane/work/browse/CK-4/a.ts here',
    'branch ck-5-foo and path a/CK-6 and CK-7-suffix',
  ].join('\n')
  expect(kinds(text)).toEqual([])
  expect(show(text)).toBe(text)
})

test('a fenced block stays whole and unlinked', async () => {
  const text = 'before CK-8\n\n```\nCK-9\n\nCK-10\n```\n\nafter'
  const blocks = splitBlocks(text)
  expect(blocks).toEqual(['before CK-8', '```\nCK-9\n\nCK-10\n```', 'after'])
  expect(kinds(blocks[1] ?? '')).toEqual([])
})

test('earlier layers win over later ones that share any spelling', async () => {
  const layer = (base: string, terms: object[]) => parseConfig(JSON.stringify({ terms }), base)
  const repoA = layer('/a', [{ name: 'x', aliases: ['車籍'], target: 'c', summary: 'a' }])
  const repoB = layer('/b', [{ name: 'x', target: 'd', summary: 'b' }, { name: 'y', target: 'e', summary: 'b' }])
  const user = layer('/home', [{ name: '車籍', target: 'a', summary: 'user' }, { name: 'other', target: 'b', summary: 'user' }])
  const merged = mergeLayers([repoA, repoB, user]).terms
  expect(merged.map(t => `${t.name}@${t.base}`)).toEqual(['x@/a', 'y@/b', 'other@/home'])
})

test('commit hashes in prose and inline code are candidates; numbers and words are not', async () => {
  expect(kinds('fixed in 46ce847 and `099543a`, see e4141ba0c1')).toEqual([
    'commit:46ce847',
    'commit:`099543a`',
    'commit:e4141ba0c1',
  ])
  expect(kinds('order 1234567, word defaced, short ab12cd, upper 46CE847, url http://x/46ce847')).toEqual([])
})

test('GitHub remotes give commit URLs, others none', async () => {
  const url = 'https://github.com/yaotek/ck_cutter/commit/abc1234'
  expect(githubCommitUrl('git@github.com:yaotek/ck_cutter.git', 'abc1234')).toBe(url)
  expect(githubCommitUrl('https://github.com/yaotek/ck_cutter', 'abc1234')).toBe(url)
  expect(githubCommitUrl('ssh://git@github.com/yaotek/ck_cutter.git\n', 'abc1234')).toBe(url)
  expect(githubCommitUrl('http://gitea.local/me/repo.git', 'abc1234')).toBeUndefined()
})

test('file hrefs round-trip with the line number', async () => {
  const href = fileHref('C:\\Users\\me\\a (1).ts', 42)
  expect(href).toBe('file:///C:/Users/me/a%20%281%29.ts#L42')
  expect(parseFileHref(href)).toEqual({ path: 'C:/Users/me/a (1).ts', line: 42 })
  expect(parseFileHref(fileHref('/home/me/b.ts'))).toEqual({ path: '/home/me/b.ts' })
})

test('relative, home and absolute paths resolve', async () => {
  expect(resolvePath('./src/a.ts', 'C:/repo/', 'C:/Users/me')).toBe('C:/repo/src/a.ts')
  expect(resolvePath('~/x.md', '/r', 'C:/Users/me')).toBe('C:/Users/me/x.md')
  expect(resolvePath('D:\\a\\b.ts', '/r', '/h')).toBe('D:/a/b.ts')
})

test('relative paths, parents and the recent-roots list', async () => {
  expect(['hooks/a.ts', './a.ts', 'C:\\a.ts', '/a.ts', '~/a.ts'].map(isRelative)).toEqual([true, true, false, false, false])
  expect(parentDir('C:/repo/hooks/a.ts')).toBe('C:/repo/hooks')
  expect(parentDir('C:/repo')).toBe('C:')
  expect(parentDir('C:')).toBeUndefined()
  expect(parentDir('/a')).toBe('/')
  expect(pushRoot(['C:/b', 'C:/A'], 'c:/a', 2)).toEqual(['c:/a', 'C:/b'])
})

test('a malformed config names the field', async () => {
  expect(() => parseConfig('{"trackers":[{"kind":"plane","baseUrl":"x","workspace":"w","prefixes":["ck"]}]}', '/')).toThrow(
    /prefixes/,
  )
  expect(() => parseConfig('{"terms":[{"name":"a","target":"b"}]}', '/')).toThrow(/summary/)
})

test('card lines are padded to exactly the width, CJK counted as two cells', async () => {
  expect(fitWidth('ab', 5)).toBe('ab   ')
  expect(displayWidth(fitWidth('工單', 7))).toBe(7)
  expect(fitWidth('abcdef', 4)).toBe('abc…')
  const cut = fitWidth('工單標題很長', 6)
  expect(cut).toBe('工單… ')
  expect(displayWidth(cut)).toBe(6)
})
