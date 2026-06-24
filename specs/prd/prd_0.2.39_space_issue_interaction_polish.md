---
type: prd
status: draft
created: 2026-06-24
updated: 2026-06-24
scope: "团队 Space Issue 交互与数据生命周期重设计：在现有 Space tab 上重做 Issue 列表、创建弹窗、详情页评论与派发区、状态变更、复制 issue 口令，并修复团队 tab 每次激活就全量刷新页面的基础体验问题。核心是去掉假功能和浮层感，把 Space 数据收敛为稳定的前端数据层 + 显式 revalidate，复用现有 Space/Rust/CLI/registered-agent/dispatch 链路，不做新的 Space 数据模型、不做多 Space UI、不重建云端权限体系。"
issue: "用户需求（2026-06-24，基于三张截图反馈团队 tab / Issue 创建 / Issue 详情交互）"
research: ""
review: "pending（实现前建议先做两个 PoC：① SpaceDataStore/useSyncExternalStore 后 tab 激活不清屏且只静默 revalidate；② `myagents issue <id>` 只读短别名命中现有 space issue-get 路由，不扩大 comment/status 写入口）"
---

# Space Issue 交互与数据生命周期优化 PRD

> **执行须知（给空 session 的你）**：本 PRD 是在 2026-06-24 用户对 Space Issue UI 的截图反馈上收口的交互规格。动手前必须主动读：
> - `specs/ARCHITECTURE.md`，尤其是「MyAgents Cloud Space」：Space 不是 Sidecar / Runtime；云端登录、Issue、附件、registered-agent dispatch 由 Rust Tauri command 拥有。
> - `specs/tech_docs/space_cloud.md`：确认 Space 的本地状态、registered agent、dispatch 与 CLI 边界。
> - `specs/DESIGN.md`：本需求是前端交互与视觉重排，必须使用现有 token、字号、OverlayBackdrop、CustomSelect、toast、close-layer 规范。
> - `specs/prd/prd_0.2.39_myagents_cloud_space.md`：本 PRD 是它的交互修订，不推翻 Cloud Space 的一期架构。
> - 相关代码符号：`src/renderer/pages/Space.tsx::{IssuesWorkspace,IssueStreamRow,CreateIssueDialog,IssueDetailDrawer}`、`src/renderer/api/spaceCloud.ts`、`src-tauri/src/space_cloud.rs::{process_pending_dispatches,build_dispatch_task_md}`、`src/cli/myagents.ts` 的 `space issue` 路由。
>
> 引用符号名而非行号；行号会随并发修改漂移。

## 1. 背景与产品判断

用户现在不是要新增 Space 能力，而是要把已能跑通的 Issue 体验从“临时 demo UI”推到可用产品面。

截图里暴露的问题有三类：

1. **列表太像浮起来的一张卡**。Issue 是团队空间里的工作流对象，不应该被装在一个大白卡里。用户明确说“就在地板上来做列表”，意思是列表应该融在页面底纸上，用行、边界、hover 和信息层级组织，而不是用一个大容器把内容托起来。
2. **创建 Issue 里有假的产品概念**。`Backlog`、`Priority`、`Agent 可见`、右上角全屏按钮都没有真实逻辑，显示出来会让用户以为这些能力已经存在。这里应该只保留真实字段：标题、正文、tag、附件、持续创建。
3. **详情页的信息轴不清楚**。正文、评论、附件、派发操作都在，但评论部分的主标题太弱，正文和评论之间缺少呼吸，发送按钮文字冗余，右侧“诊断与 CLI”把调试信息暴露给普通操作面。
4. **网络请求策略错位**。用户切回团队 tab 时，页面会重新进入加载态并串行刷新 session/tags/skills/agents/issues。这不是“数据新鲜”，而是把 tab 激活误当成页面初始化。正确体验应该是前端数据稳定常驻，后端请求只更新数据，数据确实变化时再细粒度更新 UI。

这次优化的北极星是：**去掉假功能，把真实能力摆到正确位置，让 Issue 列表、创建、评论、状态、派发都像一个团队协作工具，而不是一个技术验证页；同时让团队 tab 像一个稳定工作台，而不是每次切回来都重新开机。**

## 2. 已验证技术事实

### 2.1 架构事实

- Space 不是 AI Runtime，也不属于 Session Sidecar。React 只负责编排 UI，所有 Space HTTP 请求通过 `src/renderer/api/spaceCloud.ts` 的 Tauri invoke 进入 Rust。
- 本地 registered agent 保存在 `~/.myagents/space/registered_agents.json`，通过 `spaceListLocalAgents()` 暴露给 renderer。
- Issue 派发已经有现成链路：renderer 调 `spaceDispatchIssue(issueId, registeredAgentId)`，云端创建 dispatch；Rust `process_pending_dispatches()` 拉 pending dispatch，创建本地 Task 并自动运行。
- Agent 读写 Issue 的 CLI 已存在：`myagents space issue get/comment/status`，对应 `src/cli/myagents.ts` 的 `space/issue-*` 路由和 `src-tauri/src/management_api.rs` 的 Space handler。

### 2.2 当前 UI 事实

- `IssuesWorkspace` 当前把列表放在 `rounded-xl border bg-[var(--paper-elevated)]/50 shadow-sm` 容器里，这正是用户说的“浮起来的一层”。
- `IssueStreamRow` 当前在 `in_progress` 时用 `localAgents[0]?.displayName` 作为 assignee label。这不是后端返回的真实指派关系，应该移除，除非后续 API 返回真实 assignment / dispatch metadata。
- `CreateIssueDialog` 当前展示 `Backlog`、`Priority`、`Agent 可见` 和 `Maximize2` 全屏按钮，但这些概念没有真实字段或动作。
- `IssueDetailDrawer` 当前已有 `spaceDispatchIssue`、`spaceCommentIssue`、`spaceUploadIssueAttachments`，但没有使用已经导出的 `spaceSetIssueStatus` / `spaceCloseOwnIssue`。
- `IssueDetailDrawer` 当前右侧 `details` 展示“诊断与 CLI”，且 CLI 文案还是旧的 `myagents space issue pull --id ...` 形态，与当前 CLI surface 不一致。
- `App.tsx::MemoizedTabContent` 在切 tab 时没有卸载 Space，只是把非 active tab 设为 invisible / `content-visibility:hidden`。因此“切回刷新”不是组件卸载导致，而是 `Space.tsx` 自己的 `useEffect(() => { if (isActive) loadSession() }, [isActive,...])` 把 active transition 当成全量初始化。
- `Space.tsx::loadSession()` 会设置 page-level `loading=true`，读取 session，再读取 official tags；session 变化又触发 `loadSkills()` / `loadLocalAgents()`，issues mode 触发 `loadIssues()`，active transition 还触发 `spaceProcessDispatchesOnce()`。这是一条 fan-out 请求链，足以造成整页刷新观感。
- 项目已有同类正确模式：`src/renderer/hooks/taskCenterStore.ts` 用 module-level store + `useSyncExternalStore` 给 Task Center 数据一个单一 owner，避免每个页面实例各自 Promise.all 取数。Space 应该采用同一类模式。

## 3. 本期范围

### 3.1 要做

1. 重做 Issues 列表，让它直接落在页面底纸上，不再是一张浮起的大卡。
2. 简化创建 Issue 弹窗，只保留真实字段，并实现“持续创建”。
3. 精修 Issue 详情页：状态放到最上方、评论标题增强、正文和评论拉开、评论之间才加分割线、发送按钮只留图标、回复身份下拉删除。
4. 右侧移除“诊断与 CLI”，在“派发给 Agent”下提供两个真实操作：`指派Agent` 与 `复制 issue 口令`。
5. 支持有权限用户在详情顶部直接切换 Issue 状态。
6. 为复制口令补一个短 CLI 入口默认方案：`myagents issue <issueId>` 作为 `myagents space issue get <issueId> --json` 的别名。
7. 新增 Space 数据层与刷新策略：Space tab、Issues/Skills/Agents 子页、Issue detail、Skill detail、创建/登记 overlay 共享稳定快照；tab 激活只做静默 freshness 检查，不清空页面。

### 3.2 明确不做

- 不新增 Backlog / Priority / visibility / assignee 数据模型。
- 不实现创建弹窗右上角全屏模式。
- 不做多 Space UI。文案可说“当前团队空间”，实际 Phase 1 仍落在当前 `session.space` / official Space 能力上。
- 不重做云端 dispatch / Task / CLI 架构。
- 不把 `IssueDispatch` 暴露成用户或 Agent 需要理解的概念。
- 不做 Issue 正文编辑。
- 不做评论分页扩展；沿用当前 `spaceGetIssue(id)` 默认取评论的行为。
- 不引入 React Query / SWR 等新第三方状态库；复用项目内 `useSyncExternalStore` store 模式。
- 不把 UI open state（当前 mode、filter、打开哪个 overlay）持久化进磁盘；它们仍是 Space tab 的本地 UI 状态，数据快照才是 store owner。

## 4. 核心交互

### 4.1 Issue 列表：从“大卡片”变成“地板上的行列表”

列表区域改为页面主体里的无外框列表：

- 移除包裹列表的 `rounded-xl`、大面积 `paper-elevated` 背景、外边框和 `shadow-sm`。
- 保留顶部工具栏：搜索标题、tag filter、status filter、刷新、管理、新建 Issue。
- 列表 header 变成普通行头：左侧显示 `N issues`，右侧显示“按发布时间排序 · 点击查看详情”，但它只是文字层级，不是卡片标题栏。
- 每个 Issue 是一行：`border-b border-[var(--line-subtle)]`、hover 用 `var(--hover-bg)`，active 用轻量 inset 或 accent 左线，不做卡片阴影。
- 行信息建议顺序：
  - 第一行：title、tag、status。
  - 第二行：author、createdAt、comment count、attachment count（如果有）。
- 删除 `IssueStreamRow` 里基于 `localAgents[0]` 的假指派标签。没有真实指派数据就不显示 assignee。
- 空态也在底纸上显示，不放进大虚线卡片；可以是一行弱提示“暂无匹配 Issue”。

验收信号：截图 #1 中央区域不再有一个浮起的大白盒，Issue 列表像原生地铺在 Space 内容区。

### 4.2 创建 Issue：只显示真实字段，实现持续创建

创建弹窗保留 modal 形态，但删除假概念。

Header：

- 保留面包屑 `MyAgents社区 > New issue`。
- 删除右上角 `Maximize2` 全屏按钮。
- 只保留关闭按钮。

正文：

- 保留大标题输入 `Issue title`。
- 保留正文 `Add description...`。
- 标题和正文继续作为主输入面，避免引入表单卡片。

Footer 左侧：

- 删除 `Backlog`。
- 删除 `Priority`。
- 删除 `Agent 可见`。
- 把 tag 和附件放在同一行：
  - tag 使用现有 `CustomSelect`，只从 `SpaceTag` 里选。
  - 附件用 Paperclip 图标按钮。
  - 已选附件以小 chip 在同一行或下一行自然换行显示，显示 basename 和数量。

Footer 右侧：

- `持续创建` 使用真实 switch state，默认关闭。
- 提交按钮仍是主按钮 `创建 Issue`。

提交行为：

- title/body 继续按当前逻辑必填，除非后续单独决定正文可空。
- 成功后总是 toast 成功，附件上传成功时包含附件数量。
- 成功后总是刷新 Issue 列表。
- 持续创建开启：
  - 不关闭弹窗。
  - 不打开新 Issue 详情。
  - 清空 title、body、filePaths。
  - tag 默认建议保留当前选择，方便连续录入同一类 issue；若实现者判断“清空页面”必须包含 tag，可重置为默认 tag，但要在实现说明中写明。
  - focus 回标题输入框。
- 持续创建关闭：
  - 关闭弹窗。
  - toast 成功。
  - 列表刷新即可。
  - 不自动打开刚创建的 Issue 详情；用户如果想看详情，从刷新后的列表里点击。

### 4.3 Issue 详情：状态在最上方，评论成为清晰主区

详情仍用右侧 drawer / overlay，不整页跳转。

顶部元信息行：

- 最左侧是当前状态。
- 如果当前用户有权限，状态 badge 是可点击控件，点击打开状态菜单。
- 状态后面跟 tags、时间。
- 这行放在标题上方，是 Issue 的“控制行”。

状态权限：

- `owner/admin`：可使用 `spaceSetIssueStatus(issueId, status)` 切换到允许的所有状态：`open`、`triaged`、`in_progress`、`resolved`、`closed`、`declined`、`duplicate`、`archived`。
- 普通 member：没有任意状态切换权。若是作者且 issue 未关闭，只显示“关闭 Issue”动作，走 `spaceCloseOwnIssue(issueId)`。
- 无权限：状态为静态 badge。
- 成功后 toast、reload detail、触发 `onChanged()` 刷新列表。

正文与评论：

- 标题保持 `text-3xl`，正文保持 `text-base` / 阅读行高。
- 正文和评论之间拉开至少 `var(--space-10)` 的距离，视觉上结束正文后再进入评论区。
- 不在正文和评论标题之间画重分割线；用间距和标题层级分开。
- 评论标题改成真正的 section title，例如 `评论与处理记录`：
  - `text-lg font-semibold text-[var(--ink)]`
  - 左侧保留 `MessageSquare` 图标。
  - 右侧弱显示 `N 条`。
- 评论标题和第一条评论之间不加分割线。
- 评论和评论之间才加 `border-t` 或 `divide-y`。
- 空评论态不加顶部分割线，直接弱提示“暂无评论，可以在下方补充信息。”

评论输入：

- 删除 `以 owner 回复` / `以 admin 回复` 下拉。当前没有多身份选择，这个控件只制造噪音。
- 输入框底部工具栏改为：附件按钮、占位弹性区域、发送按钮。
- 发送按钮去掉“发送”文案，只留 `Send` 图标，提供 `aria-label="发送评论"` 和 tooltip/title。
- 发送成功后清空输入、reload detail、刷新列表。

### 4.4 右侧栏：只保留附件和 Agent 操作

附件 section 保留，但视觉上减少虚线噪音；上传按钮继续走 `spaceUploadIssueAttachments`。

删除整个“诊断与 CLI” section。

在“派发给 Agent”下提供两个按钮：

1. `指派Agent`
2. `复制 issue 口令`

#### 指派Agent

交互：

- 按钮点击后打开下拉菜单。
- 菜单展示当前 Space 内登记在本机的 Registered Agent 列表，数据来自 `spaceListLocalAgents()`。
- 菜单项显示：
  - `displayName`
  - `workspaceLabel` 或匹配到的 Project 名称
  - `status`
- `status !== active` 的 agent 可以展示但不可点击，并给出 disabled 文案。
- 点击 active agent 后立即调用 `spaceDispatchIssue(issueId, agent.id)`。
- 成功 toast：`已指派给 ${agent.displayName}`。
- 成功后 reload detail、刷新列表。
- 成功后可以 best-effort 调一次现有 `spaceProcessDispatchesOnce()`，这样当被指派 Agent 就在当前机器时，不必等下一次 60s polling。失败只 toast warning，不回滚云端 dispatch。

技术含义：

- “指派 Agent”就是现有 dispatch 行为，不新增 assignee 字段。
- 云端仍负责把 Issue status 置为 `in_progress`、写 event/system comment、阻止重复 pending dispatch。
- UI 不要自己伪造“已指派给谁”的状态；如果后端没有返回真实 dispatch summary，详情 reload 后只显示状态变化和评论/事件。

#### 复制 issue 口令

点击后复制一段预设文本到剪贴板，并 toast `已复制 issue 口令`。

复制文本建议：

```text
这是来自「{spaceName}」团队空间的 issue。

请先读取该 issue，理解标题、正文、附件和评论上下文，再与用户讨论并决策下一步动作。不要在未确认前直接开始修改、执行或关闭 issue。

Issue ID: {issueId}

命令：
myagents issue {issueId}

兼容命令：
myagents space issue get {issueId} --json
```

说明：

- `{spaceName}` 来自 `session.space.name`，例如 `MyAgents社区`。
- 用户明确希望口令表达“这是来自于 XXXXX 团队空间的 issue，请读取该 issue 理解其内容与用户讨论决策下一步的动作”。
- `myagents issue {issueId}` 是本 PRD 建议新增的短命令别名。现有长命令保留在复制文本里，避免旧 runtime 或未更新 CLI 的用户卡住。
- 复制实现复用现有 `src/renderer/utils/markdownClipboard.tsx::copyPlainText`，不要手写一套 clipboard fallback。

## 5. Space 数据与页面生命周期架构

这部分是本期的基础体验修复。团队 tab 不能再由 `Space.tsx` 组件本身在每次 active transition 上全量初始化。正确 owner 应该是一个 Space 级前端数据 store。

### 5.1 当前错误模型

当前模型大致是：

```text
Space component active
  -> loadSession()
      -> setLoading(true)
      -> spaceGetSession()
      -> spaceGetOfficial()
  -> session effect
      -> loadSkills()
      -> loadLocalAgents()
  -> mode/issues effect
      -> loadIssues()
  -> active + localAgents effect
      -> spaceProcessDispatchesOnce()
```

问题不在某一个请求慢，而在 owner 放错了：

- tab 激活是 UI 可见性事件，不是数据初始化事件。
- session/tags/issues/skills/agents 是 Space 域数据，不应该由页面实例生命周期拥有。
- overlay 打开时的 detail 数据也不应该在 overlay 每次 mount 时从空白开始。
- 网络请求失败不能清空已有好数据。
- 手动刷新、创建、评论、状态切换、指派、上传 Skill、登记 Agent 都应该走统一 mutation/invalidate，而不是每个组件自己决定刷新谁。

### 5.2 目标模型

新增一个 Space 数据 store，建议文件：

```text
src/renderer/pages/space/spaceStore.ts
src/renderer/pages/space/useSpaceData.ts
src/renderer/pages/space/spaceStore.test.ts
```

如果实现者先不拆目录，也可以放在 `src/renderer/pages/Space.tsx` 旁边；但 PRD 建议把 store 独立出来，因为 `Space.tsx` 已经是一个大文件，继续塞请求生命周期会加重问题。

目标模型：

```text
SpaceDataStore（module-level single owner）
  - owns session / tags / issues / issue details / skills / skill details / skill files / local agents
  - owns in-flight request dedupe, latest-wins, lastFetchedAt, stale flags, per-slice error
  - exposes subscribe/getSnapshot/actions

Space tab
  - useSpaceData(isActive)
  - renders snapshot immediately
  - keeps UI state locally: mode, filters, selectedIssueId, selectedSkillId, overlays

Mutations
  - call store actions
  - update local snapshot optimistically or patch from response
  - then silent revalidate affected slice
```

参考项目内模式：`src/renderer/hooks/taskCenterStore.ts`。Space 不需要照抄 Task Center 的所有字段，但要复用它的核心思想：**数据 owner 是一个常驻 store，页面只是订阅者。**

### 5.3 Store state

建议状态形态：

```ts
type SpaceSlice = 'session' | 'tags' | 'issues' | 'issueDetail' | 'skills' | 'skillDetail' | 'skillFile' | 'agents';

interface SpaceDataState {
  session: SpaceSession | null;
  tags: SpaceTag[];
  issuesByKey: Record<string, {
    items: SpaceIssue[];
    hasMore: boolean;
    nextCursor?: string | null;
    lastFetchedAt: number;
    isLoading: boolean;
    error: string | null;
  }>;
  issueDetails: Record<string, {
    detail: SpaceIssueDetail | null;
    lastFetchedAt: number;
    isLoading: boolean;
    error: string | null;
  }>;
  skills: {
    items: SpaceSkill[];
    lastFetchedAt: number;
    isLoading: boolean;
    error: string | null;
  };
  skillDetails: Record<string, {
    detail: SpaceSkillDetail | null;
    lastFetchedAt: number;
    isLoading: boolean;
    error: string | null;
  }>;
  skillFiles: Record<string, {
    text: string;
    binary?: boolean;
    mimeType?: string;
    sizeBytes?: number;
    lastFetchedAt: number;
    isLoading: boolean;
    error: string | null;
  }>;
  localAgents: {
    items: LocalRegisteredAgent[];
    lastFetchedAt: number;
    isLoading: boolean;
    error: string | null;
  };
  boot: 'idle' | 'loading' | 'ready' | 'signedOut' | 'error';
}
```

`issuesByKey` 的 key 由 `q/tag/status/limit/cursor` 组成。当前列表通常只需要第一页 key；以后分页也自然扩展。

### 5.4 Fetch policy

#### 首次进入 Space tab

- 如果 store `boot === idle`：显示首次加载页，执行 `ensureBootstrapped()`.
- `ensureBootstrapped()` 拉 `spaceGetSession()`；已登录再拉 `spaceGetOfficial()`、当前默认页必要数据。
- 首次加载完成后，store 保持 `ready` 或 `signedOut`，后续切 tab 不回到 `idle`。

#### tab 激活

`isActive` 从 false 到 true 时：

- 不调用 `loadSession()`。
- 不设置 page-level `loading=true`。
- 调 `spaceStore.revalidateVisible({ reason:'activate', maxAgeMs: 30_000, silent:true })`。
- 只刷新当前可见 slice：
  - Issues mode：session/tags 若过期则静默刷新；当前 issue query 若过期则静默刷新；打开的 issue detail 若过期则静默刷新。
  - Skills mode：skills list 若过期则静默刷新；打开的 skill detail/file 若过期则静默刷新。
  - Agents mode：localAgents 若过期则静默刷新。
- 静默刷新期间旧 UI 保持不动，只在 toolbar 或局部区域显示小 spinner / `刷新中`。

#### 手动刷新

- 用户点击刷新是 force revalidate 当前 mode。
- 手动刷新可以显示按钮 loading 和 toast。
- 手动刷新失败不清空旧数据；toast error + slice error 即可。

#### 过滤条件变化

- Issue filter/search 变化后，生成新的 issue query key。
- debounce 仍可保留。
- 如果该 key 已有缓存，立即显示缓存并静默刷新。
- 如果该 key 没有缓存，只在列表区域显示 loading/empty，不要重置整个 Space 页面、sidebar、overlay。

#### overlay 打开

- 打开 Issue detail：先显示 `issueDetails[id]?.detail` 缓存；没有缓存再显示 detail 内部 loading。
- 关闭 overlay 不清除 detail cache。后续重新打开同一个 issue 立即可见，再静默刷新。
- 打开 Skill detail/file 同理。

### 5.5 Mutation policy

所有写操作都走 store actions，写成功后更新相关 slice。

```ts
actions.createIssue(input, { continuous })
actions.commentIssue(issueId, body)
actions.uploadIssueAttachments(issueId, filePaths)
actions.setIssueStatus(issueId, status)
actions.closeOwnIssue(issueId)
actions.dispatchIssue(issueId, agentId)
actions.uploadSkillZip(input)
actions.installSkill(input)
actions.registerAgent(input)
actions.processDispatchesOnce()
actions.refresh(scope, options)
```

规则：

- mutation 成功后先 patch 本地 snapshot，保证 UI 立即响应。
- 然后 silent revalidate 受影响 slice，修正服务端最终状态。
- mutation 失败不改本地数据，显示 toast。
- 已有详情打开时，comment/status/attachment/dispatch 成功必须同步更新 detail 或立即 revalidate detail，不能只刷新列表。
- 创建 Issue 非持续模式：关闭弹窗，刷新当前 list，不打开 detail。
- 创建 Issue 持续模式：弹窗保持打开，清空 title/body/filePaths，list 刷新或 prepend 新 issue。

### 5.6 In-flight、latest-wins、错误策略

Store 必须处理网络竞态：

- 同一 slice 同一 key 的请求 dedupe：已有 in-flight 时复用 promise 或忽略重复请求。
- latest-wins：filter 从 A 切 B，再切 C，A/B 较晚返回也不能覆盖 C。
- partial failure preserve old data：某 slice 请求失败，保留上一次成功数据。
- per-slice loading：`issuesLoading` 不能让整个 Space page loading。
- per-slice error：错误显示在当前区域或 toast，不重置 session/sidebar/mode/overlay。

### 5.7 UI state 与 data state 分离

不要把这些 UI 状态放进 store：

- 当前 `mode`：issues / skills / agents。
- 当前 filters：`issueQ`、`selectedTag`、`selectedStatus`。
- 当前打开的 overlay：`issueDetailId`、`createIssueOpen`、`registerOpen`。
- Skill 子屏幕：`screen`、`detailMode`、`selectedPath`。

它们属于当前 Space tab 的交互状态。数据 store 只负责“某个 key 的数据是什么、是否在刷新、最近什么时候刷新、有没有错误”。

### 5.8 子页面与 overlay 的 owner 归属

| UI | 读哪些 store slice | 写操作 | 刷新规则 |
|---|---|---|---|
| Space shell/sidebar | session/tags/issues count/skills count/agents count | logout | logout 清空 store 并进入 signedOut |
| IssuesWorkspace | issuesByKey/current filters/tags | refresh current query | filter change -> query-key revalidate |
| CreateIssueDialog | tags | createIssue/upload initial attachments | success -> patch issues, close or reset |
| IssueDetailDrawer | issueDetails[id]/localAgents/session | comment/status/close/upload/dispatch/copy prompt | mutation -> patch detail + revalidate detail/list |
| SkillsWorkspace | skills | uploadSkillZip | success -> patch skills + select detail |
| SkillDetailWorkspace | skillDetails[id]/skillFiles[fileKey] | installSkill | install 不刷新列表，toast 即可 |
| AgentsWorkspace | localAgents | processDispatchesOnce | success -> refresh agents and current issues |
| RegisterAgentDialog | projects from config, store localAgents after success | registerAgent | success -> patch agents |

### 5.9 Refresh trigger matrix

| Trigger | 行为 |
|---|---|
| First Space tab mount | bootstrap，允许 full-page loading 一次 |
| Switch away/back | no clear, no full-page loading, silent visible-slice revalidate if stale |
| Manual Refresh | force current mode, button loading + toast |
| Issue create | patch/prepend or invalidate current query; no auto detail open |
| Comment/status/attachment | patch detail, update list row metadata/status, silent revalidate detail/list |
| Dispatch | call dispatch, optional best-effort `spaceProcessDispatchesOnce`, update status/list/detail |
| Skill upload | patch skills, select uploaded skill, detail revalidate |
| Skill install | no data refresh needed, toast result |
| Register agent | patch localAgents, no page reload |
| Logout/session expired | clear store to signedOut |

## 6. 技术方案

### 6.1 Renderer 改动

主要文件：`src/renderer/pages/Space.tsx`。

新增数据层文件建议：

- `src/renderer/pages/space/spaceStore.ts`
- `src/renderer/pages/space/useSpaceData.ts`
- `src/renderer/pages/space/spaceStore.test.ts`

`Space.tsx` 应从“拥有所有请求与状态”降级为“消费 store snapshot + 持有本 tab UI state”。实现过程中可以顺手拆组件，但不要把这次需求变成大规模视觉重构；真正必须抽走的是数据 owner。

建议拆出纯 helper，便于测试与降低 JSX 复杂度：

- `buildIssueCommandPrompt({ spaceName, issueId })`
- `getIssueStatusOptions({ admin, isAuthor, status })`
- `canCloseOwnIssue(session, issue)`
- `formatAgentSecondaryLabel(agent, projects)`
- `resetCreateIssueForm({ preserveTag })`

需要调整 imports：

- 从 `spaceCloud.ts` 引入 `spaceSetIssueStatus`、`spaceCloseOwnIssue`。
- 从 `src/renderer/utils/markdownClipboard.tsx` 引入 `copyPlainText`。
- lucide icons 删除未用的 `Maximize2`、`Terminal`；新增 `Copy` 或相近图标。

控件约束：

- tag 和状态选择继续用 `CustomSelect` 或自定义 popover，不用原生 `<select>`。
- create/detail overlay 继续使用 `<OverlayBackdrop>` 和 `useCloseLayer`。
- 不新增裸 overlay div。
- 不写硬编码颜色，使用 DESIGN token。
- 不写 `text-[Npx]` 任意字号，使用 `text-xs/sm/base/lg/xl/2xl/3xl`。

### 6.2 CLI 短命令别名

现有命令是：

```bash
myagents space issue get <issueId> --json
```

本 PRD 建议新增一个只读短别名：

```bash
myagents issue <issueId> [--json] [--comments-limit 5] [--comments-cursor <cursor>]
```

它等价于 `myagents space issue get <issueId> ...`。

实现方式：

- 在 `src/cli/myagents.ts::buildRoute` 增加 `group === 'issue'` 分支，映射到 `space/issue-get`。
- 在 `buildRequestBody` 增加 `group === 'issue'` 分支：
  - `issueId = action || flags.issueId`
  - `workspacePath = resolveSpaceWorkspacePath(flags)`
  - 转发 `agentId`、`commentsLimit`、`commentsCursor/cursor`
- 更新 top help，说明这是读取 Space Issue 的短入口。
- 不新增 Rust management API。仍走现有 `/api/space/issue-get`。
- 不给 comment/status 增加短别名，避免 `myagents issue resolved` 这类歧义。

### 6.3 Status 切换

`spaceCloud.ts` 已经导出：

- `spaceSetIssueStatus(id, status)`
- `spaceCloseOwnIssue(id)`

实现者只需要在 `IssueDetailDrawer` 接入，不需要新增 API。

状态菜单建议做成轻量 button + popover，而不是把当前状态替换成一直可见的 select。原因是状态是 issue 顶部元信息，静态时应像 badge；只有有权限并点击时才进入编辑。

### 6.4 Agent 指派

当前 drawer 已有 `agentId` state 和 `dispatch()` 方法，但 UI 是常驻 `CustomSelect + 派发给本地工作区`。改为按钮触发菜单：

- 移除常驻 select。
- 菜单打开时展示 `localAgents`。
- 点击 agent 直接 dispatch，不需要先选择再二次点击。
- `busy` 最好拆成 `dispatchingAgentId`，避免评论发送、状态切换、附件上传共享一个粗粒度 busy 状态导致按钮互相影响。

### 6.5 测试与验证建议

本 PRD 本身不要求实现，但后续实现应至少覆盖：

- Unit：`buildIssueCommandPrompt` 输出包含 space name、issue id、短命令和兼容长命令。
- Unit：status permission helper 区分 admin、作者、无权限用户。
- Component/manual：持续创建开启后创建成功不关闭弹窗、清空字段、focus 回标题。
- Component/manual：持续创建关闭后关闭弹窗、toast 成功、刷新列表。
- Manual：列表区域无大卡容器和阴影，行 hover 正常。
- Manual：详情页发送评论按钮只有图标但有可访问 label。
- Manual：指派 active agent 调用 `spaceDispatchIssue`，成功后 toast 并刷新。
- CLI：`myagents issue <id> --json` 与 `myagents space issue get <id> --json` 命中同一路由。
- Store：inactive -> active 不触发 page-level loading，不清空 session/issues/skills/agents/detail；只触发 silent visible-slice revalidate。
- Store：同一 issue detail 关闭后再打开，先显示缓存再静默刷新。
- Store：请求失败保留旧数据，toast 或局部 error，不整页回到加载态。

## 7. 关键设计决策

### D1：删除假字段，而不是先做 UI 占位

`Backlog`、`Priority`、`Agent 可见` 目前没有数据模型，也没有行为。保留它们会让用户形成错误预期。正确做法是直接删除，等后续真的需要 priority / visibility 时，从产品模型、权限、API 到 UI 一起设计。

### D2：Issue 列表不再使用大卡容器

用户说“就在地板上来做列表”。这和 DESIGN.md 中“密集列表不要堆叠 N 张卡”的原则一致。列表用行、分割线、hover、active 状态组织，静态不应有大面积 elevated 背景和阴影。

### D3：指派 Agent 复用 dispatch，不新增 assignee

现有 Cloud Space 设计里 `IssueDispatch` 是内部派发日志，Agent 不感知，UI 也不应把它误说成 issue assignee 字段。`指派Agent` 只是创建 dispatch；真实执行仍由 Rust polling 和本地 Task 完成。

### D4：复制口令给人和 Agent 都能读

复制文本不是调试 CLI block，而是一段可发给 Agent 或用户的操作口令。它必须先讲清产品语义：这是哪个团队空间的 issue、先读再讨论决策，不要直接执行。CLI 命令只是这段口令里的可执行入口。

### D5：状态编辑放到 Issue 顶部

状态是 Issue 当前处理阶段，不应该藏在右侧工具区或评论框附近。放在标题上方的第一行，用户进入详情就能看到和操作；无权限时保持静态，避免制造“点了但失败”的体验。

### D6：Space 数据必须有单一前端 owner

团队 tab 的数据不是某个 React 页面实例的私有临时状态。它和 Task Center 一样，是一个产品域的数据快照。用 module-level store + `useSyncExternalStore` 给它一个 owner，能自然解决切 tab 全量刷新、overlay 重开空白、多个子页各自请求、失败清空好数据等问题。

### D7：tab 激活不是初始化

`isActive=true` 只能表达“现在可见”，不等于“重新启动 Space”。激活时最多静默刷新当前可见 slice，绝不设置全页 loading、绝不重置 overlay、绝不重置当前子页面。

### D8：`myagents issue <id>` 只做读入口

用户给出的口令命令足够短，适合作为“打开/读取这个 issue”的入口。短命令只映射到 `space issue get`，不扩展 comment/status 写操作，避免 `myagents issue resolved` 这类歧义。写操作仍使用显式的 `myagents space issue comment/status`。

## 8. 验收标准

1. Issue 列表不再被一个带外框、圆角、阴影的大容器包住；列表行直接在内容底纸上展开。
2. 创建 Issue 弹窗中不再出现 `Backlog`、`Priority`、`Agent 可见`、全屏按钮。
3. 创建 Issue 的 tag 和附件入口在同一行。
4. `持续创建` 开启时，每次创建成功 toast，弹窗保持打开，标题/正文/附件清空，用户可继续录下一条。
5. `持续创建` 关闭时，创建成功 toast，弹窗关闭，列表刷新，不自动打开新 Issue 详情。
6. Issue 详情顶部第一行显示状态；有权限用户可从这里切换状态。
7. 评论 section 标题比现在更强，不使用 uppercase 小标签形态；标题和评论列表之间没有多余分割线。
8. 正文和评论之间有明显间距。
9. 评论之间才出现分割线。
10. 评论发送按钮只保留图标，但保留可访问 label。
11. 评论输入框上的“以 owner/admin 回复”控件消失。
12. 右侧不再出现“诊断与 CLI”。
13. 右侧“派发给 Agent”下有 `指派Agent` 和 `复制 issue 口令` 两个按钮。
14. `指派Agent` 下拉展示当前本机登记在该 Space 的 Registered Agent，点击 active agent 后触发现有 dispatch。
15. `复制 issue 口令` 复制的文本包含团队空间名、issue id、阅读并讨论下一步动作的 prompt、`myagents issue <id>` 命令和兼容长命令。
16. 切到其它 tab 再切回团队 tab，页面不清屏、不进入全页 loading、不关闭 overlay、不重置 Issues/Skills/Agents 子页状态。
17. 切回团队 tab 时，只对当前可见数据做静默过期检查；有新数据才细粒度更新对应列表/详情。
18. Issues、Skills、Agents、Issue detail、Skill detail、CreateIssueDialog、RegisterAgentDialog 共享同一个 Space 数据快照，不各自拥有独立初始化请求链。
19. 网络请求失败时保留旧数据，并在局部或 toast 提示错误。

## 9. 开放问题

1. **tag 在持续创建后是否保留**：本 PRD 倾向保留当前 tag，方便批量创建同类 issue；如果“页面清空”需要完全重置，则实现时把 tag 重置为默认。
