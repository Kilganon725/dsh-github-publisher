// dsh-github-publisher 宿主插件：给模型提供 gh_status / gh_publish 两个工具，
// 把「一个 dsh 插件仓库」全自动发布到 GitHub（+ npm）：
//   bump 版本 → npm pack → commit/push → 打 tag → gh Release（附 .tgz）→ npm 发布。
// 纯 Node + 调用 git/gh/npm CLI，无额外运行时依赖。
import { basename } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  normalizeConfig, absPath, resolveRepo, bumpVersion, parseVersion,
  publish, status, DEFAULT_CONFIG,
} from './core.js'

export const name = 'dsh-github-publisher'
export const inject = ['tools', 'systemPrompt']

function guidance(cfg) {
  const bump = cfg.defaultBump || DEFAULT_CONFIG.defaultBump
  return [
    '【全自动发布约定 · dsh-github-publisher】',
    '当用户提出「一个想法/需求」，要你实现成一个 dsh 插件并发布时，走完整流程：',
    '1) 先确认：主动问用户「是否启用全自动发布（发布到 GitHub + npm）」，得到肯定答复后再继续。',
    '2) 实现：把想法做成插件（写代码）。',
    '3) 测试：跑 validate + 单测，并用 gh_publish(path, dry_run=true) 做真实预演，确认无误。',
    '4) 写文档：README.md + docs/安装说明.txt + LICENSE + cordis.patch.yml + .github/workflows/publish.yml。',
    '5) 建仓库（仅新插件需要）：git init 并提交后 gh repo create <owner>/<name> --public --source . --push；已有仓库跳过。',
    '6) 全自动发布：gh_publish(path) 一次完成 bump 版本 → npm pack → commit/push → 打 vX.Y.Z tag → gh Release（附 .tgz/README/安装说明）→ npm 发布（workflow 模式由打 tag 触发 GitHub Actions）。',
    '若用户只是说「发布 dsh-xxx」（已有插件），直接 gh_status(path) 预检 + gh_publish(path) 一键发布即可。',
    '常用参数：bump=patch|minor|major|none（默认 ' + bump + '）；version=显式版本；npm_mode=workflow（默认）|direct|none；dry_run=true 预演；commit_message/release_notes 自定义。拿不准先 gh_status 或 dry_run。',
  ].join('\n')
}

function safePath(p) {
  return absPath(p)
}

function formatStatus(s) {
  if (s.errors && s.errors.length) {
    return '❌ 预检失败：\n' + s.errors.map((e) => '· ' + e).join('\n')
  }
  const lines = []
  lines.push('📋 ' + s.package + ' @ ' + s.version + ' · ' + s.abs)
  if (s.remote) lines.push('远端：' + s.remote.owner + '/' + s.remote.repo + ' · 分支 ' + s.branch + (s.dirty ? ' · 有未提交改动' : ' · 干净'))
  lines.push('下次发布：' + s.nextVersion + '（tag ' + s.nextTag + '）')
  lines.push('gh CLI：' + (s.ghInstalled ? (s.ghAuthed ? '已登录 ' + s.ghAccount : '未登录') : '未安装'))
  lines.push('npm：' + (s.npmWhoami || '(未登录)') + (s.npmToken ? ' · 有 NODE_AUTH_TOKEN/NPM_TOKEN' : ''))
  lines.push('publish workflow：' + (s.publishWorkflow ? '已存在' : '缺失（发布时会自动补写）'))
  lines.push('最近 tag：' + s.lastTag + ' · 未发布 commit：' + s.unreleasedCommits + ' 条')
  if (s.warnings && s.warnings.length) lines.push('⚠️ ' + s.warnings.join('；'))
  return lines.join('\n')
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config)

  if (ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
    ctx.systemPrompt.section({ name: 'github-publisher', order: 940, text: guidance(cfg) })
  }

  /* ---------- gh_status ---------- */
  ctx.tools.register(defineTool({
    name: 'gh_status',
    description: '预检一个 dsh 插件仓库的发布条件（只读，不改任何东西）：git 远端/分支/脏工作区/最近 tag/未发布 commit 数、gh CLI 是否登录、npm 是否登录、publish workflow 是否存在、以及下一次 bump 后的版本号与 tag。发布前先调它确认。',
    parameters: {
      path: { type: 'string', required: true, description: '插件仓库路径（绝对路径，或相对当前工作目录）' },
    },
    timeoutMs: 60 * 1000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          package: { type: 'string', required: true },
          version: { type: 'string', required: true },
          next_version: { type: 'string', required: true },
          dirty: { type: 'boolean', required: true },
          gh_authed: { type: 'boolean', required: true },
          npm_whoami: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const s = await status({ path: safePath(args.path), cfg, signal: exec.signal })
      return {
        text: formatStatus(s),
        package: s.package || '',
        version: s.version || '',
        next_version: s.nextVersion || '',
        dirty: !!s.dirty,
        gh_authed: !!s.ghAuthed,
        npm_whoami: s.npmWhoami || '',
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'gh_status ' + basename(safePath(args.path)),
      kind: 'read',
      content: '预检发布条件',
    }),
  }))

  /* ---------- gh_publish ---------- */
  ctx.tools.register(defineTool({
    name: 'gh_publish',
    description: '全自动把一个 dsh 插件仓库发布到 GitHub（+ 可选 npm）：自动 bump 版本（默认 patch）、npm pack 生成 .tgz、确保 .github/workflows/publish.yml 存在、git commit+push、打并推送 vX.Y.Z tag、用 gh release create 创建 Release（附 .tgz/README/安装说明.txt）、按 npm_mode 发布 npm。npm_mode=workflow（默认）时打 tag 即由 GitHub Actions 用 NPM_TOKEN 发布；direct 时本地 npm publish（需已 npm login 或 NODE_AUTH_TOKEN）；none 跳过。dry_run=true 时只做只读预检+pack 预演，不 push/tag/release/publish。',
    parameters: {
      path: { type: 'string', required: true, description: '插件仓库路径（绝对路径，或相对当前工作目录）' },
      bump: { type: 'string', description: '版本递增方式：patch/minor/major/none（默认 patch）', enum: ['patch', 'minor', 'major', 'none'] },
      version: { type: 'string', description: '显式指定版本号（X.Y.Z），优先于 bump' },
      npm_mode: { type: 'string', description: 'npm 发布方式：workflow（默认，打 tag 由 Actions 发）/direct（本地直发）/none（不发）', enum: ['workflow', 'direct', 'none'] },
      commit_message: { type: 'string', description: '自定义 commit message（默认 chore: <name> v<version>）' },
      release_notes: { type: 'string', description: '自定义 Release notes（默认取 package 描述）' },
      dry_run: { type: 'boolean', description: 'true=只预检+pack 预演，不真正 push/tag/release/publish（默认 false）' },
    },
    timeoutMs: 15 * 60 * 1000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          package: { type: 'string', required: true },
          version: { type: 'string', required: true },
          tag: { type: 'string', required: true },
          release_url: { type: 'string', required: true },
          npm_mode: { type: 'string', required: true },
          npm_published: { type: 'boolean', required: true },
          dry_run: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const r = await publish({
        path: safePath(args.path),
        bump: args.bump,
        version: args.version,
        npmMode: args.npm_mode,
        commitMessage: args.commit_message,
        releaseNotes: args.release_notes,
        dryRun: args.dry_run === true,
        cfg,
        signal: exec.signal,
      })
      const head = (r.dryRun ? '🧪 DRY-RUN（未改动远端）\n' : '✅ 发布完成\n')
        + '包：' + r.package + '\n'
        + '版本：' + r.oldVersion + ' → ' + r.version + '\n'
        + 'tag：' + r.tag + ' · 分支：' + r.branch + ' · 远端：' + r.remote + '\n'
      const lines = r.steps.map((s, i) => (i + 1) + '. ' + s)
      return {
        text: head + (r.releaseUrl && r.releaseUrl !== '(dry-run 跳过)' ? 'Release：' + r.releaseUrl + '\n' : '') + '\n' + lines.join('\n'),
        package: r.package,
        version: r.version,
        tag: r.tag,
        release_url: r.releaseUrl || '',
        npm_mode: r.npmMode,
        npm_published: r.npmPublished,
        dry_run: r.dryRun,
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'gh_publish ' + basename(safePath(args.path)) + (args.dry_run ? '（dry-run）' : ''),
      kind: 'execute',
      content: '全自动发布到 GitHub' + (args.npm_mode === 'none' ? '' : ' + npm'),
    }),
  }))
}
