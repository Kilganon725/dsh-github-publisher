// dsh-github-publisher 校验脚本：结构 + JS 语法 + 补丁格式 + 关键导出
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('..', import.meta.url)))
const fail = (msg) => { console.error('❌ ' + msg); process.exitCode = 1 }

// 1) package.json
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (!pkg.name || !pkg.version || !pkg.main) fail('package.json 缺 name/version/main')
if (!existsSync(join(root, pkg.main))) fail('main 不存在: ' + pkg.main)

// 2) JS 语法
for (const f of ['lib/index.js', 'lib/core.js']) {
  try { execFileSync(process.execPath, ['--check', join(root, f)], { stdio: 'pipe' }) }
  catch (e) { fail(f + ' 语法错误: ' + (e.stderr?.toString() || e.message).slice(-300)) }
}

// 3) cordis.patch.yml 里有 insert + 插件名
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
if (!patch.includes('dsh-github-publisher') || !patch.includes('insert')) fail('cordis.patch.yml 格式不对')

// 4) 关键导出
const core = await import(join(root, 'lib/core.js'))
for (const k of ['normalizeConfig', 'resolveRepo', 'parseVersion', 'bumpVersion', 'publish', 'status', 'ensureWorkflow', 'packTgz']) {
  if (typeof core[k] !== 'function') fail('core.js 缺导出 ' + k)
}

// index.js 依赖 @deepseek-ai/dsh-tools（profile 运行时解析）；standalone 校验时
// 直接检查导出声明文本，并尝试带 dsh 安装目录解析。
const src = readFileSync(join(root, 'lib/index.js'), 'utf8')
for (const k of ['name', 'inject', 'apply']) {
  const ok = new RegExp('export (?:const|function) ' + k + '\\b').test(src)
  if (!ok) fail('index.js 缺导出 ' + k)
}
if (!/inject\s*=\s*\[\s*['"]tools['"]/.test(src)) fail('index.js 未注入 tools')
try {
  const idx = await import(join(root, 'lib/index.js'))
  for (const k of ['name', 'inject', 'apply']) {
    if (idx[k] === undefined) fail('index.js 导出 ' + k + ' 为空')
  }
} catch (e) {
  if (String(e.code) !== 'ERR_MODULE_NOT_FOUND') fail('index.js 加载失败: ' + e.message)
}

if (process.exitCode) {
  console.error('❌ 校验未通过')
} else {
  console.log('✅ dsh-github-publisher 校验通过（name=' + pkg.name + ' v' + pkg.version + '）')
}
