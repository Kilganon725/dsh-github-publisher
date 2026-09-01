# 🚀 dsh-github-publisher

> DeepSeek Harness **全自动 GitHub 发布插件**：你说一句「**发布 dsh-sysmon**」，
> 它就自动 **bump 版本 → npm pack → commit + push → 打 tag → 建 GitHub Release（附 .tgz）→ 发 npm**，
> 再也不用手动敲一堆 `git` / `gh` / `npm` 命令。

---

## 它做什么

一个命令，替代你之前这套手动流程：

```bash
# 以前（手动）：
git add -A && git commit -m "..." && git push
npm pack                          # 出 .tgz
git tag v0.1.2 && git push origin v0.1.2
gh release create v0.1.2 ./xxx-0.1.2.tgz
# npm 发布（打 tag 触发 workflow，或本地 npm publish）
```

```text
# 现在（全自动）：
gh_status("/path/to/dsh-sysmon")     # 预检
gh_publish("/path/to/dsh-sysmon")    # 一键发布
```

`gh_publish` 自动完成：

1. **版本 bump** —— 默认 `patch`（0.1.5 → 0.1.6），可 `minor`/`major`/`none` 或显式 `version`
2. **npm pack** —— 产出 `<name>-<version>.tgz`（同时校验「能正常打包」）
3. **workflow 兜底** —— 若仓库缺 `.github/workflows/publish.yml`，自动补写（打 tag 即触发 npm 发布）
4. **commit + push** —— `git add -A` + 提交（默认消息 `chore: <name> v<version>`）+ `git push`
5. **打 tag** —— 推送 `vX.Y.Z`
6. **GitHub Release** —— `gh release create`，自动附上 `.tgz` + `README.md` + `docs/安装说明.txt`
7. **npm 发布** —— `workflow` 模式（默认）交给 tag 触发的 Actions；`direct` 本地直发；`none` 跳过

## 提供的两个工具

| 工具 | 作用 |
| --- | --- |
| `gh_status(path)` | 只读预检：远端/分支/脏工作区/最近 tag/未发布 commit、gh 登录、npm 登录、workflow、下次版本号 |
| `gh_publish(path, bump?, version?, npm_mode?, commit_message?, release_notes?, dry_run?)` | 一键全自动发布 |

### 参数速查

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `path` | 必填 | 插件仓库路径 |
| `bump` | `patch` | `patch` / `minor` / `major` / `none` |
| `version` | — | 显式版本号（X.Y.Z），优先于 bump |
| `npm_mode` | `workflow` | `workflow`（打 tag 由 Actions 发）/ `direct`（本地直发）/ `none`（不发） |
| `commit_message` | 自动 | 自定义提交信息 |
| `release_notes` | 自动 | 自定义 Release notes |
| `dry_run` | `false` | `true` = 只预检 + pack 预演，不真推送 |

## 安装

```bash
# 方式一：npm（发布后）
dsh plugin --profile web add dsh-github-publisher

# 方式二：GitHub
dsh plugin --profile web add github:Kilganon725/dsh-github-publisher

# 方式三：本地源码目录
dsh plugin --profile web add "/Users/relphchris/Desktop/DeepSeek Harness/dsh-github-publisher"
```

装完**重启 dsh web 并刷新页面**。

## 使用

### 从想法到发布（完整流程）

当你说「我有个想法，帮我做成插件并发布」时，模型会：

1. 先问你是否**启用全自动发布**（发布到 GitHub + npm）
2. 确认后：**实现功能 → 跑测试 → 写 README/安装说明 → 建仓库（新插件）→ `gh_publish` 一键发 npm + GitHub**

### 已有插件直接发布

新会话里直接说（或让模型调工具）：

```
先 gh_status("/Users/relphchris/Desktop/DeepSeek Harness/dsh-sysmon")
然后 gh_publish("/Users/relphchris/Desktop/DeepSeek Harness/dsh-sysmon")
```

常用变体：

```
gh_publish(path, dry_run=true)                       # 先预演，确认没问题
gh_publish(path, bump="minor")                       # 发一个小版本
gh_publish(path, version="1.0.0")                    # 显式版本
gh_publish(path, npm_mode="none")                    # 只发 GitHub，不发 npm
gh_publish(path, commit_message="fix: xxx", release_notes="...")
```

## 前置要求

- 已安装 DeepSeek Harness (dsh)，Node.js >= 20
- **git**（必需）
- **gh CLI** 且已 `gh auth login`（建 Release 用）—— macOS：`brew install gh`
- 发布 npm 二选一：
  - `workflow` 模式（默认）：仓库在 GitHub 配了 `NPM_TOKEN` secret（你现有的 `dsh-sysmon` 已配好）
  - `direct` 模式：本机 `npm login`，或环境变量 `NODE_AUTH_TOKEN` / `NPM_TOKEN`

## 配置（可选）

在 profile 的 cordis.patch.yml 给插件行加 `config`：

```yaml
- insert:
    - id: github-publisher
      name: dsh-github-publisher
      config:
        defaultBump: patch      # patch/minor/major/none
        npmMode: workflow       # workflow/direct/none
        timeoutMs: 600000       # 单条命令超时（毫秒）
```

## 安全与干跑

- **先 `dry_run` 再真发**：`dry_run=true` 只做只读预检 + `npm pack` 预演，不 push、不打 tag、不建 Release、不发 npm。
- 版本不会重复发布：若 `vX.Y.Z` tag 已存在会直接报错，防误覆盖。
- 提交身份自动处理：优先用 git 配置的 user.name/email，缺失时用 gh 账号（`<id>+<login>@users.noreply.github.com`），不污染全局 git config。

## 卸载

```bash
dsh plugin --profile web remove dsh-github-publisher
```
