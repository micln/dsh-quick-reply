import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// client.js is a browser bundle: evaluate it with a stub loader and capture the factory.
const here = dirname(fileURLToPath(import.meta.url))
let captured = null
globalThis.window = { __ModuleLoader__: { load: def => { captured = def } } }
new Function(readFileSync(join(here, 'client.js'), 'utf8'))()
const stub = new Proxy(function () {}, { get: () => stub, apply: () => stub })
const { core } = captured.factory(name => (name === 'react' || name === 'react-dom' || name === '@deepseek-ai/dsh-client-ui-primitives' ? stub : undefined))

const memoryStorage = () => {
  const map = new Map()
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
  }
}

test('normalizeItems trims, drops blanks, caps length', () => {
  assert.deepEqual(core.normalizeItems(['  a ', '', '   ', 'b']), ['a', 'b'])
  assert.equal(core.normalizeItems('nope'), null)
  const many = Array.from({ length: 30 }, (_, i) => `m${i}`)
  assert.equal(core.normalizeItems(many).length, core.MAX_ITEMS)
  assert.equal(core.normalizeItems(['x'.repeat(5000)])[0].length, core.MAX_TEXT_LENGTH)
})

test('loadItems returns defaults when empty, corrupt, or missing', () => {
  const s = memoryStorage()
  assert.deepEqual(core.loadItems(s), ['按推荐执行', '我已做完，你继续', '端到端测试一下', '/handoff'])
  s.setItem(core.STORAGE_KEY, '{not json')
  assert.deepEqual(core.loadItems(s), ['按推荐执行', '我已做完，你继续', '端到端测试一下', '/handoff'])
  s.setItem(core.STORAGE_KEY, JSON.stringify(['只一条']))
  assert.deepEqual(core.loadItems(s), ['只一条'])
})

test('saveItems round-trips through loadItems', () => {
  const s = memoryStorage()
  core.saveItems(s, ['  先看看 ', '', '继续'])
  assert.deepEqual(core.loadItems(s), ['先看看', '继续'])
})

test('reorderItem moves an entry to the target index without mutating input', () => {
  const a = ['1', '2', '3']
  assert.deepEqual(core.reorderItem(a, 0, 2), ['2', '3', '1'])
  assert.deepEqual(core.reorderItem(a, 2, 0), ['3', '1', '2'])
  assert.deepEqual(core.reorderItem(a, 1, 0), ['2', '1', '3'])
  assert.equal(core.reorderItem(a, 1, 1), a)
  assert.equal(core.reorderItem(a, -1, 0), a)
  assert.equal(core.reorderItem(a, 0, 3), a)
  assert.deepEqual(a, ['1', '2', '3'])
})

test('skillTokens follows the host gesture grammar', () => {
  assert.deepEqual(core.skillTokens('/office'), ['office'])
  assert.deepEqual(core.skillTokens('先 /office 然后继续'), ['office'])
  assert.deepEqual(core.skillTokens('/a /b /a'), ['a', 'b'])
  // Not gestures: no leading boundary, no trailing boundary, bad shape.
  assert.deepEqual(core.skillTokens('/usr/bin'), [])
  assert.deepEqual(core.skillTokens('5/8'), [])
  assert.deepEqual(core.skillTokens('/Upper'), [])
  assert.deepEqual(core.skillTokens('/office.'), [])
  assert.deepEqual(core.skillTokens(''), [])
})

test('phraseSkill resolves only installed names', () => {
  assert.equal(core.phraseSkill('/office', ['office', 'tdd']), 'office')
  assert.equal(core.phraseSkill('先 /nope 再 /tdd', ['tdd']), 'tdd')
  assert.equal(core.phraseSkill('/nope', ['tdd']), undefined)
  assert.equal(core.phraseSkill('/office', []), undefined)
  assert.equal(core.phraseSkill('/office', undefined), undefined)
  assert.equal(core.phraseSkill('普通短语', ['office']), undefined)
})

test('skillQuery only matches a reference being typed at the end', () => {
  assert.equal(core.skillQuery('/'), '')
  assert.equal(core.skillQuery('/off'), 'off')
  assert.equal(core.skillQuery('先 /off'), 'off')
  assert.equal(core.skillQuery('/office 说点什么'), null)
  assert.equal(core.skillQuery('abc'), null)
  assert.equal(core.skillQuery(''), null)
})

test('withSkill/withSkillTrigger keep surrounding text and boundaries', () => {
  assert.equal(core.withSkillTrigger(''), '/')
  assert.equal(core.withSkillTrigger('/off'), '/')
  assert.equal(core.withSkillTrigger('先看'), '先看 /')
  assert.equal(core.withSkillTrigger('先看 '), '先看 /')
  assert.equal(core.withSkill('', 'tdd'), '/tdd ')
  assert.equal(core.withSkill('/of', 'office'), '/office ')
  assert.equal(core.withSkill('先 /of', 'office'), '先 /office ')
  assert.equal(core.withSkill('先看', 'tdd'), '先看 /tdd ')
  // The trailing space closes the reference, so the picker collapses.
  assert.equal(core.skillQuery(core.withSkill('/of', 'office')), null)
  assert.equal(core.phraseSkill(core.withSkill('/of', 'office'), ['office']), 'office')
  assert.equal(core.atBoundary(''), true)
  assert.equal(core.atBoundary('a '), true)
  assert.equal(core.atBoundary('a'), false)
})

test('rankSkills prefers prefix hits then shorter names, capped', () => {
  const skills = [
    { name: 'ponytail' }, { name: 'ponytail-review' }, { name: 'office' }, { name: 'tools-office' },
  ]
  assert.deepEqual(core.rankSkills(skills, 'off').map(s => s.name), ['office', 'tools-office'])
  // Ordered subsequence, not substring: 'ptr' fits 'ponytail-review' only.
  assert.deepEqual(core.rankSkills(skills, 'ptr').map(s => s.name), ['ponytail-review'])
  assert.deepEqual(core.rankSkills(skills, 'ptl').map(s => s.name), ['ponytail', 'ponytail-review'])
  assert.deepEqual(core.rankSkills(skills, '').length, 4)
  assert.deepEqual(core.rankSkills(skills, 'zzz'), [])
  assert.deepEqual(core.rankSkills(skills, 'OFF').map(s => s.name), ['office', 'tools-office'])
})

test('parseRun recognises only `! ` phrases with a command', () => {
  assert.equal(core.parseRun('! npm run dev'), 'npm run dev')
  assert.equal(core.parseRun('!   pnpm test  '), 'pnpm test')
  assert.equal(core.parseRun('! '), null)
  assert.equal(core.parseRun('!'), null)
  assert.equal(core.parseRun('npm run dev'), null)
  assert.equal(core.parseRun('/tdd'), null)
})
