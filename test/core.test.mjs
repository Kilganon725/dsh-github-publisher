// dsh-github-publisher 纯逻辑单测（不触碰真实 git/gh/npm 推送）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  parseVersion, bumpVersion, resolveRepo, ensureWorkflow, workflowExists,
  defaultReleaseNotes, normalizeConfig, DEFAULT_CONFIG, absPath,
} from '../lib/core.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

test('parseVersion 解析与非法版本', () => {
  assert.deepEqual(parseVersion('0.1.5'), { major: 0, minor: 1, patch: 5, core: '0.1.5' })
  assert.equal(parseVersion('1.2.3-rc.1').core, '1.2.3')
  assert.throws(() => parseVersion('abc'))
  assert.throws(() => parseVersion('1.2'))
})

test('bumpVersion 递增', () => {
  assert.equal(bumpVersion('0.1.5', 'patch'), '0.1.6')
  assert.equal(bumpVersion('0.1.5', 'minor'), '0.2.0')
  assert.equal(bumpVersion('0.1.5', 'major'), '1.0.0')
  assert.equal(bumpVersion('0.1.5', 'none'), '0.1.5')
  assert.equal(bumpVersion('2.9.9'), '2.9.10')
})

test('resolveRepo 校验 git 仓库 + package.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pub-test-'))
  mkdirSync(join(dir, '.git'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0' }))
  const r = resolveRepo(dir)
  assert.equal(r.pkg.name, 'x')
  assert.equal(r.pkg.version, '0.1.0')

  const dir2 = mkdtempSync(join(tmpdir(), 'dsh-pub-test2-'))
  assert.throws(() => resolveRepo(dir2))
})

test('ensureWorkflow / workflowExists 幂等写入', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pub-wf-'))
  assert.equal(workflowExists(dir), false)
  const r = ensureWorkflow(dir)
  assert.equal(r.created, true)
  assert.equal(workflowExists(dir), true)
  const r2 = ensureWorkflow(dir)
  assert.equal(r2.created, false)
})

test('defaultReleaseNotes 包含包名与描述', () => {
  const n = defaultReleaseNotes('', { name: 'dsh-x', version: '0.1.0', description: '测试' })
  assert.ok(n.includes('dsh-x'))
  assert.ok(n.includes('测试'))
})

test('normalizeConfig 默认值', () => {
  const c = normalizeConfig({})
  assert.equal(c.npmMode, 'workflow')
  assert.equal(c.defaultBump, 'patch')
  assert.equal(normalizeConfig({ npmMode: 'direct' }).npmMode, 'direct')
  assert.equal(normalizeConfig({ timeoutMs: 5 }).timeoutMs, 5)
  assert.equal(DEFAULT_CONFIG.npmMode, 'workflow')
})

test('absPath 解析', () => {
  assert.equal(absPath('./x'), resolve(process.cwd(), 'x'))
})

test('README/docs 存在（打包会带上）', () => {
  for (const f of ['README.md', 'LICENSE', 'cordis.patch.yml']) {
    assert.ok(existsSync(join(root, f)), f + ' 存在')
  }
})
