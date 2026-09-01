// dsh-github-publisher 核心（纯 Node，无 DSH 依赖，可独立测试）：
// 把「一个 dsh 插件仓库」全自动发布到 GitHub（+ npm）拆成可复用的原子步骤：
//   1) 版本 bump（patch/minor/major/显式/none）
//   2) npm pack 生成 .tgz（校验可打包）
//   3) 确保 .github/workflows/publish.yml 存在（打 tag 自动 npm publish）
//   4) git commit + push
//   5) git tag vX.Y.Z + push
//   6) gh release create（附 .tgz / README / 安装说明）
//   7) npm publish（workflow 模式 = 交给 tag 触发的 Actions；direct 模式 = 本地直发）
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const DEFAULT_CONFIG = {
  npmMode: 'workflow',       // 'workflow' | 'direct' | 'none'
  defaultBump: 'patch',      // 'patch' | 'minor' | 'major' | 'none'
  packDest: null,            // null => 临时目录
  timeoutMs: 10 * 60 * 1000, // 单条命令超时（10 分钟）
}

export function normalizeConfig(input) {
  const cfg = { ...DEFAULT_CONFIG }
  if (!input || typeof input !== 'object') return cfg
  for (const k of ['npmMode', 'defaultBump', 'packDest']) {
    if (typeof input[k] === 'string' && input[k]) cfg[k] = input[k]
  }
  const t = Number(input.timeoutMs)
  if (Number.isFinite(t) && t > 0) cfg.timeoutMs = Math.round(t)
  return cfg
}

export function absPath(p) {
  return resolve(process.cwd(), String(p || '').trim())
}

/* ---------------- 进程执行 ---------------- */

/** 执行命令；成功 resolve {out, err, code}，失败 reject（含 tail 输出）。 */
export function run(cmd, args, opts = {}) {
  const { cwd, env, timeoutMs = DEFAULT_CONFIG.timeoutMs, signal } = opts
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...(env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    const kill = () => {
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, 2000)
    }
    let timer = null
    if (timeoutMs > 0) timer = setTimeout(kill, timeoutMs)
    const onAbort = () => kill()
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    child.on('error', (e) => { cleanup(); reject(new Error(cmd + ' 启动失败: ' + e.message)) })
    child.on('close', (code) => {
      cleanup()
      if (code === 0) resolve({ out, err, code })
      else {
        const tail = (err || out || '').toString().slice(-1200)
        reject(new Error(cmd + ' ' + args.join(' ') + ' 失败(exit ' + code + '):\n' + tail))
      }
    })
  })
}

/** 执行命令；失败不抛，返回 {code, out, err}（用于探测类调用）。 */
export function runAllowFail(cmd, args, opts = {}) {
  return new Promise((resolveAllow) => {
    run(cmd, args, opts)
      .then((r) => resolveAllow({ ...r, ok: true }))
      .catch((e) => resolveAllow({ code: -1, out: '', err: String(e && e.message || e), ok: false }))
  })
}

/* ---------------- 仓库 / 版本 ---------------- */

export function resolveRepo(p) {
  const abs = absPath(p)
  if (!existsSync(join(abs, '.git'))) throw new Error('不是 git 仓库（缺少 .git）：' + abs)
  const pkgPath = join(abs, 'package.json')
  if (!existsSync(pkgPath)) throw new Error('找不到 package.json：' + pkgPath)
  let pkg
  try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) } catch (e) { throw new Error('package.json 解析失败: ' + e.message) }
  if (!pkg.name || !pkg.version) throw new Error('package.json 缺少 name/version 字段')
  return { abs, pkgPath, pkg }
}

export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(v || '').trim())
  if (!m) throw new Error('非法版本号（需 X.Y.Z）：' + v)
  return { major: +m[1], minor: +m[2], patch: +m[3], core: m[1] + '.' + m[2] + '.' + m[3] }
}

export function bumpVersion(v, bump) {
  const p = parseVersion(v)
  if (bump === 'major') return (p.major + 1) + '.0.0'
  if (bump === 'minor') return p.major + '.' + (p.minor + 1) + '.0'
  if (bump === 'none') return p.core
  return p.major + '.' + p.minor + '.' + (p.patch + 1) // patch（默认）
}

/* ---------------- git ---------------- */

async function gitConfig(abs, key) {
  const r = await runAllowFail('git', ['config', '--get', key], { cwd: abs, timeoutMs: 10000 })
  return r.ok ? String(r.out).trim() : ''
}

/** 提交身份：优先 git 配置，缺失则用 gh 账号（noreply 邮箱），零持久化副作用。 */
export async function gitIdentity(abs) {
  const name = await gitConfig(abs, 'user.name')
  const email = await gitConfig(abs, 'user.email')
  if (name && email) return { name, email }
  const u = await ghUser()
  return { name: u.name || u.login, email: u.id + '+' + u.login + '@users.noreply.github.com' }
}

export async function currentBranch(abs) {
  const r = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: abs, timeoutMs: 10000 })
  return String(r.out).trim()
}

export async function isDirty(abs) {
  const r = await run('git', ['status', '--porcelain'], { cwd: abs, timeoutMs: 10000 })
  return String(r.out).trim().length > 0
}

export async function latestTag(abs) {
  const r = await runAllowFail('git', ['describe', '--tags', '--abbrev=0'], { cwd: abs, timeoutMs: 10000 })
  return r.ok ? String(r.out).trim() : ''
}

export async function commitsSinceTag(abs, tag) {
  const range = tag ? tag + '..HEAD' : 'HEAD'
  const r = await runAllowFail('git', ['log', '--oneline', '-n', '50', range], { cwd: abs, timeoutMs: 10000 })
  const lines = String(r.out || '').trim().split('\n').filter(Boolean)
  return { lines, count: lines.length, hasMore: lines.length >= 50 }
}

export async function remoteInfo(abs) {
  const r = await runAllowFail('git', ['config', '--get', 'remote.origin.url'], { cwd: abs, timeoutMs: 10000 })
  const url = String(r.out || '').trim()
  if (!url) throw new Error('未配置 git remote origin；请先 git remote add origin <repo-url>')
  // https://github.com/OWNER/REPO.git  |  git@github.com:OWNER/REPO.git  |  github:OWNER/REPO
  const m = /(?:github\.com[:/])([^/]+)\/([^/\s]+?)(?:\.git)?$/.exec(url.replace(/^https?:\/\//, ''))
  if (!m) throw new Error('无法从 remote 解析 GitHub 仓库：' + url)
  return { url, owner: m[1], repo: m[2].replace(/\.git$/, '') }
}

export async function headSha(abs) {
  const r = await run('git', ['rev-parse', 'HEAD'], { cwd: abs, timeoutMs: 10000 })
  return String(r.out).trim()
}

/* ---------------- gh ---------------- */

async function ghAvailable() {
  const r = await runAllowFail('gh', ['--version'], { timeoutMs: 10000 })
  return r.ok
}

export async function ghUser() {
  if (!(await ghAvailable())) throw new Error('未安装 gh CLI（GitHub CLI），请先 brew install gh 并 gh auth login')
  const r = await run('gh', ['api', 'user', '--jq', '{login:.login,id:.id,name:.name}'], { timeoutMs: 20000 })
  try {
    const u = JSON.parse(r.out)
    if (!u.login || u.id == null) throw new Error('gh 返回异常')
    return u
  } catch {
    throw new Error('gh 未登录或返回异常；请先执行 gh auth login')
  }
}

export async function ghAuthed() {
  const r = await runAllowFail('gh', ['auth', 'status'], { timeoutMs: 10000 })
  return r.ok
}

/* ---------------- npm ---------------- */

export async function npmWhoami() {
  const r = await runAllowFail('npm', ['whoami'], { timeoutMs: 20000 })
  return r.ok ? String(r.out).trim() : ''
}

/** npm pack 到指定目录，返回 tgz 绝对路径。 */
export async function packTgz(abs, version, { packDest = null, dryRun = false, signal } = {}) {
  const dest = packDest || mkdtempSync(join(tmpdir(), 'dsh-publisher-'))
  mkdirSync(dest, { recursive: true })
  const r = await run('npm', ['pack', '--json', '--pack-destination', dest], { cwd: abs, signal, timeoutMs: 10 * 60 * 1000 })
  let filename = null
  try {
    const arr = JSON.parse(String(r.out).trim())
    filename = arr && arr[0] && arr[0].filename
  } catch { /* fallthrough */ }
  if (!filename) {
    // 兜底：按 name-version.tgz 推断
    const pkg = JSON.parse(readFileSync(join(abs, 'package.json'), 'utf8'))
    filename = pkg.name + '-' + (version || pkg.version) + '.tgz'
  }
  const tgz = join(dest, filename)
  if (!existsSync(tgz)) throw new Error('npm pack 未产出 ' + tgz)
  return { tgz, dest }
}

/* ---------------- workflow 兜底 ---------------- */

const PUBLISH_WORKFLOW = `name: Publish to npm

on:
  push:
    tags:
      - 'v*'

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org/
      - run: npm install --no-audit --no-fund
      - run: npm run test --if-present
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}
`

export function workflowExists(abs) {
  return existsSync(join(abs, '.github', 'workflows', 'publish.yml'))
}

export function ensureWorkflow(abs) {
  const p = join(abs, '.github', 'workflows', 'publish.yml')
  if (existsSync(p)) return { created: false, path: p }
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, PUBLISH_WORKFLOW)
  return { created: true, path: p }
}

/* ---------------- 主流程 ---------------- */

export async function publish(opts) {
  const {
    path, bump, version, npmMode, commitMessage, releaseNotes,
    dryRun = false, onStep = () => {}, signal = null, cfg = DEFAULT_CONFIG,
  } = opts

  const steps = []
  const log = (msg) => { steps.push(msg); try { onStep(msg) } catch { /* ignore */ } }

  const repo = resolveRepo(path)
  const { abs, pkg } = repo
  const bumpKind = bump || cfg.defaultBump || 'patch'
  const target = version ? parseVersion(version).core : bumpVersion(pkg.version, bumpKind)
  const tag = 'v' + target
  const mode = npmMode || cfg.npmMode || 'workflow'

  log('📦 ' + pkg.name + ' @ ' + pkg.version + ' → ' + target + ' · ' + abs)

  // 0) 预检
  const dirty = await isDirty(abs)
  const branch = await currentBranch(abs)
  const remote = await remoteInfo(abs)
  const identity = await gitIdentity(abs)
  const lastTag = await latestTag(abs)
  if (lastTag === tag) throw new Error('tag ' + tag + ' 已存在（本地），版本号没有递增？')
  log('预检通过：分支=' + branch + ' · 远端=' + remote.owner + '/' + remote.repo + (dirty ? ' · 有未提交改动' : ' · 工作区干净'))

  // 1) 版本 bump
  if (target !== pkg.version) {
    if (!dryRun) await run('npm', ['version', target, '--no-git-tag-version'], { cwd: abs, signal })
    log('版本 bump：' + pkg.version + ' → ' + target + (dryRun ? '（dry-run 未写入）' : '（package.json + package-lock.json）'))
  } else {
    log('版本不变：沿用 ' + target + '（bump=none 或显式版本与当前相同）')
  }

  // 2) npm pack（校验可打包 + 产出 tgz 供 Release 附件）
  const { tgz, dest } = await packTgz(abs, target, { dryRun, signal, packDest: cfg.packDest })
  log('npm pack → ' + tgz)

  // 3) workflow 兜底（workflow 模式）
  if (mode === 'workflow' && !dryRun) {
    const wf = ensureWorkflow(abs)
    if (wf.created) log('已补写 .github/workflows/publish.yml（打 tag 将自动 npm publish）')
  }

  // 4) git add + commit
  const nowDirty = await isDirty(abs)
  let commit = null
  if (nowDirty) {
    const msg = commitMessage || 'chore: ' + pkg.name + ' v' + target
    if (!dryRun) {
      await run('git', ['add', '-A'], { cwd: abs, signal })
      await run('git', ['-c', 'user.name=' + identity.name, '-c', 'user.email=' + identity.email, 'commit', '-m', msg], { cwd: abs, signal })
      commit = await headSha(abs)
    }
    log('git commit：' + msg + (dryRun ? '（dry-run 跳过）' : commit ? '（' + commit.slice(0, 7) + '）' : ''))
  } else {
    log('无改动可提交')
  }

  // 5) push 分支
  if (!dryRun) await run('git', ['push', 'origin', 'HEAD'], { cwd: abs, signal })
  log('git push origin ' + branch + (dryRun ? '（dry-run 跳过）' : ''))

  // 6) tag + push tag
  if (!dryRun) {
    await run('git', ['tag', '-a', tag, '-m', pkg.name + ' ' + tag], { cwd: abs, signal })
    await run('git', ['push', 'origin', tag], { cwd: abs, signal })
  }
  log('tag：' + tag + (dryRun ? '（dry-run 跳过）' : ' 已推送'))

  // 7) GitHub Release（附 tgz + README + 安装说明）
  let releaseUrl = null
  const assets = [tgz]
  const readme = join(abs, 'README.md')
  if (existsSync(readme)) assets.push(readme)
  const inst = join(abs, 'docs', '安装说明.txt')
  if (existsSync(inst)) assets.push(inst)
  const notes = releaseNotes || defaultReleaseNotes(lastTag, pkg)
  if (!dryRun) {
    await run('gh', [
      'release', 'create', tag, ...assets,
      '--repo', remote.owner + '/' + remote.repo,
      '--title', tag,
      '--notes', notes,
    ], { cwd: abs, signal })
    releaseUrl = 'https://github.com/' + remote.owner + '/' + remote.repo + '/releases/tag/' + tag
  }
  log('GitHub Release：' + tag + (dryRun ? '（dry-run 跳过）' : ' 已创建 · ' + releaseUrl))

  // 8) npm 发布
  let npmPublished = false
  if (mode === 'direct') {
    const who = await npmWhoami()
    if (!who && !process.env.NODE_AUTH_TOKEN && !process.env.NPM_TOKEN) {
      throw new Error('npm 未登录且没有 NODE_AUTH_TOKEN/NPM_TOKEN 环境变量；direct 模式需要先 npm login 或提供 token')
    }
    if (!dryRun) await run('npm', ['publish'], { cwd: abs, signal, timeoutMs: 10 * 60 * 1000 })
    npmPublished = !dryRun
    log('npm publish（direct）' + (dryRun ? '（dry-run 跳过）' : '完成'))
  } else if (mode === 'workflow') {
    log('npm 发布：tag 已推送，GitHub Actions(publish.yml) 将自动 npm publish（需 repo 配置 NPM_TOKEN secret）')
  } else {
    log('npm 发布：跳过（npm_mode=none）')
  }

  try { rmSync(dest, { recursive: true, force: true }) } catch { /* ignore */ }

  return {
    package: pkg.name,
    oldVersion: pkg.version,
    version: target,
    tag,
    branch,
    remote: remote.owner + '/' + remote.repo,
    commit,
    releaseUrl,
    npmMode: mode,
    npmPublished,
    dryRun,
    steps,
  }
}

/** 默认 release notes：上次 tag 之后的 commit 列表（markdown）。 */
export function defaultReleaseNotes(lastTag, pkg) {
  const head = '## ' + (pkg.name || '') + ' v' + (pkg.version || '') + '\n'
  if (pkg.description) return head + '\n' + pkg.description + '\n'
  return head + '\n自动发布。\n'
}

/* ---------------- 预检状态（gh_status 工具） ---------------- */

export async function status(opts) {
  const { path, onStep = () => {}, signal = null, cfg = DEFAULT_CONFIG } = opts
  const out = { path: absPath(path), errors: [], warnings: [] }

  try {
    const repo = resolveRepo(path)
    out.abs = repo.abs
    out.package = repo.pkg.name
    out.version = repo.pkg.version
    out.nextVersion = bumpVersion(repo.pkg.version, cfg.defaultBump || 'patch')
    out.nextTag = 'v' + out.nextVersion
  } catch (e) {
    out.errors.push(e.message)
    return out
  }

  try { out.remote = await remoteInfo(out.abs) } catch (e) { out.errors.push(e.message) }

  try {
    out.branch = await currentBranch(out.abs)
    out.dirty = await isDirty(out.abs)
    out.lastTag = await latestTag(out.abs) || '(无 tag)'
    const since = await commitsSinceTag(out.abs, out.lastTag && out.lastTag !== '(无 tag)' ? out.lastTag : '')
    out.unreleasedCommits = since.count
    if (since.hasMore) out.unreleasedCommits = since.count + '+'
  } catch (e) { out.errors.push(e.message) }

  try {
    out.ghInstalled = await ghAvailable()
    out.ghAuthed = out.ghInstalled ? await ghAuthed() : false
    if (out.ghAuthed) { const u = await ghUser(); out.ghAccount = u.login }
  } catch (e) { out.errors.push(e.message) }

  try {
    const who = await npmWhoami()
    out.npmWhoami = who || '(未登录)'
    out.npmToken = !!(process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN)
  } catch (e) { out.errors.push(e.message) }

  try { out.publishWorkflow = workflowExists(out.abs) } catch (e) { out.errors.push(e.message) }

  if (!out.errors.length) {
    if (out.dirty === false && out.package && out.lastTag === 'v' + out.version) {
      out.warnings.push('当前版本 ' + out.version + ' 已有 tag，发布前会 bump patch 到 ' + out.nextVersion)
    }
    if (!out.npmWhoami && !out.npmToken) {
      out.warnings.push('npm 本地未登录；workflow 模式下打 tag 会由 GitHub Actions 用 NPM_TOKEN 发布（需 repo 配 secret）')
    }
    if (out.ghInstalled && !out.ghAuthed) out.warnings.push('gh 未登录')
    if (!out.ghInstalled) out.warnings.push('未安装 gh CLI')
  }
  return out
}
