# dsh-quick-reply 开发约定

DSH 插件：在 Web UI 的会话输入区停靠一个「快捷发送」按钮，点一下把一条预设短语发到当前会话；短语里可以写 `/技能名`，候选来自当前会话的技能列表。

## 结构

| 文件 | 作用 |
|---|---|
| `client.js` | 浏览器端 UI bundle（`window.__ModuleLoader__.load`）：停靠按钮、面板、编辑、拖拽排序、技能候选。纯逻辑挂在返回对象的 `core` 上，是 Node 里唯一可测的部分 |
| `client.test.mjs` | `node --test` 用例：桩 loader 求值 `client.js`，覆盖 `core` 纯函数与可选技能服务下的 dock 注册 |
| `index.js` | host 侧空插件，只导出 `name` / `apply`，让插件进 Loader |
| `cordis.patch.yml` | bundle patch，由 `package.json` 的 `dsh.bundle.patch` 声明 |
| `locale/{en,zh}.json` | 插件**展示元信息**（`meta.title` / `meta.description`） |
| `screenshots.json` | 列表站/市场的截图清单，指向仓库内已有的 `docs/panel.png` |
| `docs/panel.png` | README 与市场用的面板截图 |

三套文案互不相通，改一边不等于改了另一边：

- `locale/*.json` 的 `meta.*`：插件**列表**里的标题与描述；
- client 半 `ctx.locale.register(NS, DICTS)` 的字典（命名空间 `conversation.quickReply`）：**运行期 UI 文案**；
- `README.md` / `README.zh.md`：给用户的正文，两份内容必须对等。

## 命令

```sh
npm test            # node --test，无依赖、离线全绿
npm pack --dry-run  # 核对发布白名单：运行时文件一个不少，测试/临时文件一个不多
```

## 发版

版本由 tag 触发 CI 发布（Trusted Publishing / OIDC，带 provenance）。**禁止本地 `npm publish`**——账号的 token 已被 2FA 策略禁用，只有 CI 能发。

```sh
git checkout master && git pull origin master
# 编辑 package.json 的 version，必须等于 tag 去掉 v 前缀
git commit -am "chore: release X.Y.Z"
git push origin master
git tag vX.Y.Z && git push origin vX.Y.Z
```

- `package.json` 的 `files` 是发布白名单：新增运行时文件立刻登记，发布前用 `npm pack --dry-run` 核对（`screenshots.json`、`AGENTS.md` 是仓库侧文件，不进包）。
- `repository.url` 必须指回本仓库：awesome-dsh-plugin 的 npm 映射靠它认领，漏了站点永远不显示 npm 安装命令；该字段随版本固化，改地址要重新发版才生效。
- 收录到 awesome-dsh-plugin 的条目格式、两项 CI 与合并后站点生效时序，见工作区根 `AGENTS.md` §6 与 `dsh-mcp-autoload/PUBLISHING.md`。

## 硬约束

- **client bundle 不是 ESM**：`client.js` 里不能 `import`，只能 `require` 宿主冻结模块表里的包（`react`、`react-dom`、`@deepseek-ai/dsh-client-ui-primitives`）。这些**不是 npm 依赖**——宿主在浏览器里提供，profile 的 `node_modules` 里没有它们，所以不要写进 `peerDependencies` 或 `dependencies`（同作者的 `dsh-mcp-autoload` 同样 require 但未声明；声明为 peer 会让 npm 去 registry 解析并可能报 `ERESOLVE`）。host 半目前没有任何 require。
- **返回对象上的 `inject` 是硬依赖**：Cordis 要求其中每个名字都有实现，缺一该插件停在 PENDING、`apply` 根本不执行。可选服务（`remote.skills`、`webTerminals`、`sidebarRight`）必须 `scope.get()` 后判空降级，不要放进 `inject`。技能服务直接用 `scope.get('remote.skills')`：`scope.get('remote')?.skills` 仍会触发 `remote.skills` 的依赖检查，导致子插件 FAILED、dock 不注册。`package.json` 的 `dsh.client.inject` 是另一回事——那是 client 模块图的**前置加载顺序**，不是服务依赖，两者名字撞车不要混。
- **dock order**：`conversation.composer.dock` 只有负 order 能用，本插件占 `-100`（分配表见工作区根 `AGENTS.md` §2.5）。改 order 前先查表。
- **持久化**：key 带版本 `dsh-quick-reply:items:v1`；读取失败、损坏 JSON、超长、越界都要回落到默认值并限幅（`MAX_ITEMS=20`、`MAX_TEXT_LENGTH=2000`）。默认四条：`按推荐执行` / `我已做完，你继续` / `端到端测试一下` / `/handoff`。
- **技能语法**只认宿主的手势文法 `/(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/`；编辑区里的 `/` 按钮只在**新增**短语或编辑**已含 `/token`** 的短语时出现（`allowSkill`），不含标记的短语保持纯文本。候选上限 `MAX_MATCHES=50`。
- **发送**走当前会话的 `conversation.send(text)`，是一句话直接发出、没有二次确认。不要在文档里声明代码里没有的行为（例如"以 queue 模式提交"——代码没有传 mode）。
- **图标**用 primitives 内置图标并守卫取不到的情况（`typeof Icon === 'function' ? h(Icon) : null`）；样式只引宿主主题 token 并带 fallback，注入的 `<style>` 要引用计数、归零才 remove。
- 全 ESM、**无构建步骤**（源码即发布产物）、2 空格缩进、单引号。
- 本目录常年多会话并行：改动在 worktree 里做，只显式 `git add` 自己改的文件，禁止 `git add -A`。

## 投稿状态（awesome-dsh-plugin）

- gate 要求目标仓库**创建满 1 天**：本仓库 `created_at = 2026-10-31T04:29:51Z`，即 **2026-11-01 12:29:51 CST 之后**才可提 PR（gate 快照会自动重跑，不必推空提交）。
- 需要在仓库上打 `dsh-plugin` topic（GitHub topic，与 `package.json` 的 npm keywords 不是一回事）。
- 条目文件 `data/plugins/micln__dsh-quick-reply.yml`，分类 `ui`；工作区根留有同名快照。条目描述只陈述可核实功能，会被维护者逐句对照源码。
