---
type: prd
status: draft
created: 2026-06-19
updated: 2026-06-19
scope: "Analytics entry and funnel reliability: make launcher input, thought capture, workspace card open, history open, task dispatch, and AI turn completion form a precise, joinable, documented event contract. This PRD fixes provenance misclassification, history join gaps, event registry/documentation drift, and early server-side event loss. It does not build dashboards or collect user content."
issue: "产品需求（用户希望深度分析真实使用习惯；2026-06-19 analytics audit 收敛）"
research: "N/A"
review: "pending（实现前建议先跑静态事件清单审计，确认 im_bot_* 是否已被 agent_channel_* 完全替代）"
---

# PRD 0.2.36 — 埋点入口与漏斗可靠性收口

> **执行须知（给空 session 的你）**：本 PRD 自带完整背景与技术地基，按顺序读即可执行，不需要回翻本次聊天。
> - 每次会话只自动加载 `CLAUDE.md`；本需求是埋点系统的设计 / 评估 / 收口，动手前 MUST 主动 Read `specs/ARCHITECTURE.md`。
> - 本 PRD 直接依赖 `specs/prd/analytics_design.md`（当前埋点唯一权威文档）和 `specs/prd/prd_0.2.19_analytics_session_provenance.md`（session provenance / surface / active context 的原设计），实现前必须读。
> - 代码入口以符号名为准，不要依赖行号。引用的核心符号：`track()`、`trackServer()`、`SESSION_SCOPED_AUTO_INJECT_EVENTS`、`setPendingSurface()`、`consumePendingSurface()`、`handleLaunchProject()`、`trackSessionNewForBirth()`、`trackTabEvent()`、`handleThoughtCreate()`、`handleTaskRun()`。
> - 本期只修埋点契约和数据准确性，不做分析后台 / dashboard / 数据仓库建模。

---

## 1. 背景与用户意志

用户现在不是想“多打几个点击事件”，而是想**深度分析用户真实使用习惯**。

他关心的是这些真实路径：

- 在首页直接通过对话发起任务；
- 在首页切到“想法”，记录一个想法；
- 从右侧工作区卡片创建一个新 session；
- 从历史记录打开一条旧 session；
- 后续这些入口到底有没有继续发消息、跑了多少 turn、用了什么 runtime、有没有变成任务。

这类问题靠孤立事件回答不了。正确的数据形态应该是：

```text
入口事件
  -> session_new / session_switch
  -> message_send
  -> message_complete / ai_turn_complete
  -> task_create / task_run / thought_create
```

这些事件必须能用稳定 ID join，且入口归因不能把不同场景混在一起。

当前系统已经有健康的基础：前端 `src/renderer/analytics/` 统一 `track()` 队列，服务端 `src/server/analytics.ts` 上报 `ai_turn_complete`，PRD 0.2.19 引入了 `session_id`、`Surface`、`agent_hash`、Active Context 和 `pendingSurface`。问题不在“没系统”，而在**几个关键字段不准、部分事件无法 join、事件清单开始漂移**。

本期目标就是把这些缝补成一个可靠的数据契约。

---

## 2. 已验证代码事实

以下事实来自本地代码审计。

| 领域 | 已确认事实 | 证据线索 |
|---|---|---|
| Analytics 基础设施 | 前端统一走 `track()`，队列在 `queue.ts`；服务端走 `trackServer()`。 | `src/renderer/analytics/tracker.ts`、`queue.ts`、`src/server/analytics.ts` |
| Active Context | `track()` 只对 `SESSION_SCOPED_AUTO_INJECT_EVENTS` 自动注入 `session_id`，避免 `workspace_open` / `history_open` 被旧 session 污染。 | `tracker.ts::SESSION_SCOPED_AUTO_INJECT_EVENTS` |
| Tab 级事件 | `TabProvider` 有 `trackTabEvent()`，会显式传当前 Tab 的 `session_id` / `tab_id`，避免后台 Tab SSE 事件被前台 Tab context 污染。 | `src/renderer/context/TabProvider.tsx::trackTabEvent` |
| session 出生归因 | `pendingSurface.ts` 用 `setPendingSurface()` / `consumePendingSurface()` 跨 `App` 与 `TabProvider` 传递下一次 `session_new.triggered_by`。 | `src/renderer/analytics/pendingSurface.ts` |
| 工作区新会话入口 | `handleLaunchProject()` 在无 `sessionId` 时打 `workspace_open`，并按 `initialMessage ? 'launcher_input' : 'agent_card'` 设置 pending surface。 | `src/renderer/App.tsx::handleLaunchProject` |
| 历史入口 | `handleLaunchProject()` 在有 `sessionId` 时打 `history_open`，但当前显式传 `session_id: null`。 | `src/renderer/App.tsx::handleLaunchProject` |
| session_new 字段 | `trackSessionNewForBirth()` 当前用 `has_initial_message: surface !== 'new_chat_button'` 推断首条消息。 | `src/renderer/context/TabProvider.tsx::trackSessionNewForBirth` |
| 首页想法 | `ThoughtInput` 创建成功后打 `thought_create { source:'desktop', location:'launcher' | 'task_center' }`。 | `src/renderer/components/task-center/ThoughtInput.tsx` |
| 任务中心 | GUI 的 `task_create` / `task_run` / `task_stop` / `task_delete` 已在任务组件里上报；CLI 路径在 `admin-api.ts` 里用 `trackServer()` 上报。 | `TaskCenter.tsx`、`TaskListPanel.tsx`、`src/server/admin-api.ts` |
| AI turn | builtin 与 external runtime 成功 turn 都会上报 `ai_turn_complete`，带 `source` / `session_id` / `runtime` / token / duration。 | `src/server/agent-session.ts`、`src/server/runtimes/external-session.ts` |
| 事件漂移 | 实际调用但未进入 `EventName` 的事件包括 `launcher_cron_stage`、`launcher_cron_create_standalone`、`reasoning_effort_switch`、`session_fork`、`floating_ball_pet_select`；文档还缺若干浮球和导出事件。 | 静态 grep `track(` / `trackServer(` / `trackTabEvent(` |
| 旧事件疑似失效 | `im_bot_create` / `im_bot_toggle` / `im_bot_remove` 在 `EventName` 和文档中存在，但未找到真实调用点。 | 静态 grep |

---

## 3. 当前问题

### P0-1：`has_initial_message` 会误判工作区卡片打开

当前 `session_new.has_initial_message` 由 `surface !== 'new_chat_button'` 推断。

这会导致：用户只是点击工作区卡片打开空会话，`surface='agent_card'`，却被记成 `has_initial_message=true`。这会直接污染一个关键产品问题：

> 用户点击工作区后，是只是打开看看，还是马上发起了对话？

### P0-2：`history_open` 不能精确 join 到目标 session

当前首页历史入口打 `history_open` 时显式 `session_id:null`。这么做避免了旧 Active Context 污染，但也丢了目标 session id。

结果：

- 能数“用户点了历史记录”；
- 但不能精确 join “点的是哪条 session，后续有没有继续发消息”。

如果只能靠 `tab_id + 时间窗口` 推断，漏斗分析会在多 Tab / 快速切换 / 后台 SSE 场景里不可靠。

### P0-3：所有 `initialMessage` 新会话都被归成 `launcher_input`

`handleLaunchProject()` 用 `initialMessage ? 'launcher_input' : 'agent_card'` 判定 surface。

这把不同入口混在一起：

- 首页输入框发消息；
- 从想法卡点击“AI 讨论”自动发 `/task-alignment`；
- 工作区初始化 `/init`；
- Bug report / 问题诊断自动发诊断 prompt；
- 未来其它内部自动起手消息。

它们都带 `initialMessage`，但不是同一种用户行为。这样会高估首页输入框使用占比。

### P1-1：事件清单与真实调用漂移

`track()` 接受 `EventName | string`，所以未登记事件也能悄悄上报。好处是灵活，坏处是文档和类型不再保护数据契约。

本次静态审计发现：

- 真实调用但不在 `EventName`：`launcher_cron_stage`、`launcher_cron_create_standalone`、`reasoning_effort_switch`、`session_fork`、`floating_ball_pet_select`、服务端 `ai_turn_complete`。
- 真实调用但不在 `analytics_design.md`：浮球 summon/expand/toggle/pet_select、message export、thinking copy/export、restore last session、session fork、reasoning effort、launcher cron。
- 文档 / 类型中存在但没有真实调用：`im_bot_create`、`im_bot_toggle`、`im_bot_remove`。

### P1-2：早期服务端事件可能被丢弃

`trackServer()` 依赖前端 `initAnalytics()` 写入 `~/.myagents/analytics_config.json`。当前逻辑如果 config 未加载，`trackServer()` 直接 no-op；后续事件会重试加载 config，但**已经发生的事件不会补发**。

这对大多数桌面路径影响不大，因为 app 启动后很快会 init analytics；但对“真实使用习惯”分析，`ai_turn_complete` 是核心口径，应该尽量避免成功 turn 因 config race 丢失。

---

## 4. 目标

### 4.1 产品分析目标

本期完成后，数据应能稳定回答：

1. 首页输入框、工作区卡片、历史记录、想法 AI 讨论、问题诊断、初始化等入口各占多少。
2. 工作区卡片打开后，有多少只是打开空会话，有多少真的发了首条消息。
3. 历史记录点击后，目标 session 后续是否继续发消息 / 完成 turn。
4. 想法从创建到 AI 讨论、从 AI 讨论到任务创建、从任务创建到运行的漏斗。
5. 各入口按 runtime / agent_hash / token cost / tool_count 的表现。
6. 事件清单是否与代码一致，后续加埋点不会悄悄漂移。

### 4.2 工程目标

1. `session_new` 的 `has_initial_message` 来自真实 birth context，不再由 surface 猜。
2. `history_open` 显式带目标 `session_id`，且不会被 Active Context 覆盖。
3. `initialMessage` 的来源可区分，至少不再全部归为 `launcher_input`。
4. 建立事件名静态校验：真实调用、`EventName`、`analytics_design.md` 三者不再无声漂移。
5. 服务端 analytics config race 不再导致成功 turn 直接丢失。

---

## 5. 非目标

本期不做：

- 不建 dashboard / 图表 / 数据仓库 SQL。
- 不新增第三方 analytics SDK。
- 不收集对话内容、文件路径、用户自定义明文名称、API Key、Provider URL。
- 不改变现有 analytics endpoint / API key 机制。
- 不重构整个埋点模块。
- 不为每个按钮都加 click 事件；仍坚持“事件是业务对象状态变化，不是 UI 点击”。
- 不改 IM / Agent Channel 产品架构，只清理或补齐对应事件。

---

## 6. 事件模型设计

### 6.1 三个维度继续保持正交

沿用 `analytics_design.md` / PRD 0.2.19 的思路：

| 维度 | 回答什么 | 示例 |
|---|---|---|
| `source` | 哪个渠道 / 进程触发 | `desktop` / `cli` / `cli_agent` / `cron` / `im` / `floating_ball` |
| `surface` / `triggered_by` | 桌面里哪个界面入口 | `launcher_input` / `agent_card` / `history_click` / `task_center` / `bug_report` |
| `intent` | 这次入口的语义目的 | `send_message` / `open_workspace` / `open_history` / `thought_alignment` / `workspace_init` / `support_diagnostics` |

不要拆成 `session_new_from_xxx` 这种事件爆炸。

### 6.2 新增 `EntryIntent`

在 `src/renderer/analytics/types.ts` 新增：

```ts
export type EntryIntent =
  | 'send_message'
  | 'open_workspace'
  | 'open_history'
  | 'thought_alignment'
  | 'workspace_init'
  | 'support_diagnostics'
  | 'new_chat'
  | 'fork'
  | 'unknown';
```

说明：

- `Surface` 回答“用户在哪个 UI 表面触发”；
- `EntryIntent` 回答“他触发这件事想干什么”；
- `has_initial_message` 回答“这次 session 出生是否真的带首条消息”。

### 6.3 扩展 `Surface`

当前 `Surface` 缺少几个真实桌面入口。新增：

```ts
| 'task_center'
| 'bug_report'
| 'agent_setup'
```

取值建议：

| 场景 | `triggered_by` | `entry_intent` | `has_initial_message` |
|---|---|---|---|
| 首页输入框发消息 | `launcher_input` | `send_message` | true |
| 工作区卡片打开空会话 | `agent_card` | `open_workspace` | false |
| 工作区卡片 `/init` | `agent_setup` | `workspace_init` | true |
| 历史记录点击 | `history_click` | `open_history` | false |
| 想法卡 AI 讨论 | `task_center` | `thought_alignment` | true |
| Bug report / 问题诊断 | `bug_report` | `support_diagnostics` | true |
| Chat 内新对话 | `new_chat_button` | `new_chat` | false |
| Fork session | `unknown` 或后续专门 surface | `fork` | 可选，按实际是否携带首条消息 |

### 6.4 `session_new` params

扩展为：

```ts
export interface SessionNewParams {
  session_id: string;
  tab_id?: string;
  triggered_by: Surface;
  entry_intent: EntryIntent;
  runtime: AnalyticsRuntime;
  has_initial_message: boolean;
  agent_hash: string | null;
}
```

兼容性：新增字段 additive-only；分析端对旧客户端按 `entry_intent ?? 'unknown'` 处理。

### 6.5 `history_open` params

改为显式目标 session：

```ts
export interface HistoryOpenParams {
  session_id: string;
  agent_hash: string | null;
  runtime: AnalyticsRuntime;
}
```

关键要求：

- `session_id` 是用户点击的目标 session id。
- 这是显式传值，不依赖 Active Context 注入。
- `history_open` 仍不加入 `SESSION_SCOPED_AUTO_INJECT_EVENTS`，避免未传时被旧 session 污染。

### 6.6 `workspace_open` params

扩展：

```ts
export interface WorkspaceOpenParams {
  agent_hash: string | null;
  runtime: AnalyticsRuntime;
  entry_intent: EntryIntent;
  has_initial_message: boolean;
  session_id: null;
}
```

`workspace_open` 是 pre-session 入口事件，`session_id` 保持 `null`，真正 join 靠随后 `session_new`。

---

## 7. 实现方案

### R1 — 用 birth context 替代裸 `Surface`

将 `pendingSurface.ts` 升级为 pending birth context。

新增类型：

```ts
export interface PendingSessionBirthContext {
  surface: Surface;
  entryIntent: EntryIntent;
  hasInitialMessage: boolean;
}
```

API：

```ts
setPendingSessionBirth(tabId, context)
consumePendingSessionBirth(tabId, fallback)
clearPendingSessionBirth(tabId)
```

保留旧 `setPendingSurface()` 可作为短期 wrapper，但新代码必须用 context。

fallback 策略：

- launcher organic mint：`{ surface:'launcher_input', entryIntent:'send_message', hasInitialMessage:true }`
- reset/new chat：`{ surface:'new_chat_button', entryIntent:'new_chat', hasInitialMessage:false }`
- unknown：`{ surface:'unknown', entryIntent:'unknown', hasInitialMessage:false }`

然后改 `trackSessionNewForBirth()`：

```ts
const birth = consumePendingSessionBirth(tabId, fallback);
track('session_new', {
  session_id: newSessionId,
  tab_id: tabId,
  triggered_by: birth.surface,
  entry_intent: birth.entryIntent,
  has_initial_message: birth.hasInitialMessage,
  runtime: meta.runtime,
  agent_hash: meta.agentHash,
});
```

**禁止**再用 `surface !== 'new_chat_button'` 推断。

### R2 — 修正 `handleLaunchProject()` 的入口分类

`handleLaunchProject(project, sessionId?, initialMessage?)` 根据调用方传入 context，而不是自己只看 `initialMessage`。

新增可选参数：

```ts
type LaunchProjectAnalyticsContext = {
  surface: Surface;
  entryIntent: EntryIntent;
};
```

签名建议：

```ts
handleLaunchProject(project, sessionId, initialMessage, analyticsContext?)
```

默认规则：

- `sessionId` 存在：history open；
- `initialMessage` 存在且没有 analyticsContext：launcher input（保留旧路径 fallback）；
- 否则：agent card open workspace。

调用方必须显式传：

| 调用方 | context |
|---|---|
| `Launcher` 首页输入框 | `{ surface:'launcher_input', entryIntent:'send_message' }` |
| `Launcher` 工作区卡片空打开 | `{ surface:'agent_card', entryIntent:'open_workspace' }` |
| Agent overlay `/init` | `{ surface:'agent_setup', entryIntent:'workspace_init' }` |
| `OPEN_AI_DISCUSSION` | `{ surface:'task_center', entryIntent:'thought_alignment' }` |
| Bug report / support diagnostics | `{ surface:'bug_report', entryIntent:'support_diagnostics' }` |

`workspace_open` 同步带 `entry_intent` 和 `has_initial_message: !!initialMessage`。

### R3 — 修正 `history_open`

当前：

```ts
track('history_open', { ..., session_id: null })
```

改为：

```ts
track('history_open', {
  session_id: sessionId,
  agent_hash,
  runtime: targetRuntime,
});
```

要求：

- `runtime` 仍使用目标 session 的 frozen runtime，不用当前 agent config。
- 如果 planner 后续 `jump-to-tab`、`open-new-tab`、`switch-current-tab`，都不影响 `history_open` 的目标语义。
- Chat 内部历史下拉继续打 `session_switch { session_id: id }`，语义是“切到该 session”；首页历史入口可以同时有 `history_open` 和后续 session lifecycle 事件，但不重复打 `session_new`。

### R4 — 事件名登记与文档漂移测试

新增一个静态测试或脚本，校验：

1. 所有 `track('literal')`、`trackTabEvent('literal')`、`trackServer('literal')` 的 literal 事件名必须在 canonical registry 中。
2. canonical registry 中的事件必须在 `specs/prd/analytics_design.md` 出现。
3. registry 中允许标记 `deprecated`，但 deprecated 事件必须没有新调用点，或只在兼容层出现。

实现方式可以二选一：

**推荐方案：新增 canonical registry**

```ts
// src/shared/analytics/events.ts
export const ANALYTICS_EVENT_NAMES = [
  'app_launch',
  'ai_turn_complete',
  ...
] as const;

export type AnalyticsEventName = typeof ANALYTICS_EVENT_NAMES[number];
```

renderer `EventName` 复用它；server `trackServer()` 接受 `AnalyticsEventName | string` 的过渡期可以保留，但静态测试必须覆盖 literal。

**保守方案：不迁移类型，先加测试**

测试读取 `types.ts` 的 `EventName` union、grep 调用点、grep `analytics_design.md`，先把漂移挡住。

本期至少修复以下漂移：

- 将 `launcher_cron_stage`、`launcher_cron_create_standalone`、`reasoning_effort_switch`、`session_fork`、`floating_ball_pet_select` 加入类型和文档，或明确删除调用。
- 将浮球、导出、thinking copy/export、restore last session 等真实事件补进 `analytics_design.md`。
- 对 `im_bot_create` / `im_bot_toggle` / `im_bot_remove` 做产品决策：
  - 如果旧 IM Bot UI 已被 Agent Channel 替代，则从 active EventName 移到 deprecated 文档区；
  - 如果仍有旧 UI，则补真实 `track()` 调用。

### R5 — 服务端 analytics config race 收口

修改 `trackServer()`：

- 当 config 缺失但 analytics 可能尚未初始化时，不立刻丢弃事件；
- 将事件放入短 TTL pending 队列，定时重试加载 config；
- 如果 30 秒内仍没有 config，丢弃 pending 队列；
- 如果 config 明确 disabled，也丢弃。

约束：

- pending 队列上限 100 条，防内存泄漏；
- 不阻塞主流程；
- 不因为 analytics 失败影响 AI turn；
- 不把用户内容放入事件 params。

这样可以覆盖 app 刚启动 / sidecar 先完成 turn / config 稍后写入的竞态。

---

## 8. 数据口径

### 8.1 标准漏斗

上线后推荐用如下 join 口径：

```text
session_new.session_id
  -> message_send.session_id
  -> message_complete.session_id
  -> ai_turn_complete.session_id
```

入口分组：

```text
session_new.triggered_by + session_new.entry_intent
```

### 8.2 首页行为口径

| 用户行为 | 主事件 | join |
|---|---|---|
| 首页输入框发消息 | `session_new { triggered_by:'launcher_input', entry_intent:'send_message' }` | `session_id -> message_send / ai_turn_complete` |
| 首页想法记录 | `thought_create { source:'desktop', location:'launcher' }` | thought 本身；若后续 AI 讨论，见下一行 |
| 想法 AI 讨论 | `task_align_discuss` + `session_new { triggered_by:'task_center', entry_intent:'thought_alignment' }` | `session_id -> ai_turn_complete`；后续 `task_create { origin:'thought_dispatch' }` |
| 工作区卡片打开 | `workspace_open { entry_intent:'open_workspace', has_initial_message:false }` + `session_new` | 看 `message_send` 是否出现判断是否继续使用 |
| 历史记录打开 | `history_open { session_id: target }` | 目标 `session_id -> 后续 message_send / ai_turn_complete` |

---

## 9. 隐私与安全

保持现有规则：

- 不收集对话内容。
- 不收集文件路径。
- 不收集 API Key、Provider URL、自定义 Provider 名称。
- Agent / Workspace 名只允许 hash，继续用 `hashAgentNameSync()` / `hashAgentName()`，不得上传明文。
- `entry_intent` / `triggered_by` 只能是枚举值，不允许塞 raw UI label 或用户输入。
- `history_open.session_id` 是本机随机 session id，与现有 `message_send.session_id` 同级，不新增 PII 风险。

---

## 10. 验收标准

### 10.1 手动验收

1. 首页输入框发送“你好”：
   - `session_new.triggered_by='launcher_input'`
   - `entry_intent='send_message'`
   - `has_initial_message=true`
   - 后续 `message_send.session_id` 与 `session_new.session_id` 一致。

2. 点击工作区卡片只打开会话、不输入：
   - `workspace_open.entry_intent='open_workspace'`
   - `session_new.triggered_by='agent_card'`
   - `session_new.has_initial_message=false`
   - 没有 `message_send`。

3. 点击工作区初始化 `/init`：
   - `session_new.triggered_by='agent_setup'`
   - `entry_intent='workspace_init'`
   - `has_initial_message=true`
   - `message_send.skill='init'` 或可从 text slash 解析得到。

4. 在首页历史记录打开旧 session：
   - `history_open.session_id` 等于目标 session id；
   - 后续若用户继续发消息，`message_send.session_id` 等于同一个 id。

5. 在想法模式创建想法：
   - `thought_create.source='desktop'`
   - `location='launcher'`。

6. 从任务中心想法卡点击“AI 讨论”：
   - `task_align_discuss` 触发；
   - 新 session 的 `triggered_by='task_center'`
   - `entry_intent='thought_alignment'`
   - `has_initial_message=true`。

7. 成功 AI turn：
   - builtin 与 Codex / Claude Code / Gemini 路径的 `ai_turn_complete.session_id` 非空率不下降；
   - config race 场景下不因 config 文件稍晚写入而直接丢弃首个成功 turn。

### 10.2 自动测试

最低要求：

- `track()` Active Context 测试：
  - session scoped 事件自动注入；
  - `history_open` 不自动注入；
  - caller 显式 `session_id` 优先。
- pending birth context 测试：
  - consume once；
  - tab 隔离；
  - fallback 正确。
- `trackSessionNewForBirth()` 或抽出的纯函数测试：
  - `agent_card/open_workspace` -> `has_initial_message=false`；
  - `launcher_input/send_message` -> true；
  - `task_center/thought_alignment` -> true。
- 静态事件 registry 测试：
  - 真实 literal 调用都在 registry；
  - registry 事件都在 `analytics_design.md`；
  - deprecated 事件有明确标记。
- server analytics queue 测试：
  - config missing 时 pending；
  - config 后到时 flush；
  - disabled / timeout 时丢弃且不 throw。

### 10.3 命令

实现完成后至少跑：

```bash
npm run typecheck
npm run lint
npm run test:unit
```

如果新增 React 组件测试或 DOM 测试，补跑对应测试池。

---

## 11. 分期建议

### Phase A — 修 P0 准确性

- pending surface -> pending birth context；
- `session_new.has_initial_message` 不再猜；
- `handleLaunchProject()` 支持 explicit analytics context；
- `history_open.session_id` 改为目标 session id。

### Phase B — 收口事件契约

- 补 `EventName` / server event registry；
- 补 `analytics_design.md`；
- 处理 `im_bot_*` 去留；
- 加静态漂移测试。

### Phase C — 服务端可靠性

- `trackServer()` config race pending queue；
- 单测覆盖。

### Phase D — 数据验收

- dogfood 跑 6 条手动路径；
- 导出 dev log / analytics debug 输出，确认 join 通。

---

## 12. 关键设计决策

### D1：不新增“点击事件爆炸”，而是修正 `session_new` 入口契约

原因：用户要分析真实使用习惯，核心是会话和 turn 漏斗，不是按钮点击热力图。入口必须落到 `session_new`，后续靠 `session_id` join。

### D2：`history_open` 应显式带目标 `session_id`

原因：不带 ID 的历史点击只能按时间猜，无法在多 Tab 下可靠分析。显式传目标 ID 不会引入 PII，也不会触发 Active Context 污染。

### D3：`has_initial_message` 必须来自真实上下文，不从 surface 推断

原因：surface 和是否带首条消息不是同一维度。工作区卡片可打开空会话，也可发 `/init`；想法讨论和 bug report 都带 initialMessage，但不是 launcher input。

### D4：引入 `entry_intent`，避免滥用 `surface`

原因：`surface` 回答“从哪里来”，`entry_intent` 回答“来做什么”。这能避免把 `launcher_input` 扩成一个万能桶。

### D5：用静态测试挡住文档漂移

原因：`track()` 接受 string 是为了兼容和快速迭代，但没有测试就会让数据契约腐烂。文档是分析端建表依据，必须和代码同步。

### D6：服务端事件先短暂 pending，不阻塞、不无限保留

原因：`ai_turn_complete` 是真实使用量核心事件，不能因为前端 config 稍晚写入就丢；但 analytics 不能影响主流程，也不能无限占内存。

---

## 13. 开放问题

1. `im_bot_create` / `im_bot_toggle` / `im_bot_remove` 是否已经被 `agent_channel_*` 完全替代？
   实现前先确认产品现状。若替代成立，标记 deprecated 并从 active checklist 移除。

2. `session_fork` 是否应纳入正式 `EventName`？
   代码已有调用，tracker allowlist 也提到它，但 EventName 缺失。建议纳入。

3. 是否要给 `workspace_open` 带未来真实 `session_id`？
   本期不做，因为 workspace_open 发生在 session 出生前；用随后 `session_new` join 更干净。

4. 是否需要 `first_message_send` 独立事件？
   本期不做。用 `session_new.has_initial_message` + 每 session 第一条 `message_send` 可推导。

---

## 14. 附录：必须同步更新的文件

实现时至少会触及：

- `src/renderer/analytics/types.ts`
- `src/renderer/analytics/pendingSurface.ts`（或改名为 `pendingBirthContext.ts`）
- `src/renderer/analytics/tracker.ts`
- `src/renderer/App.tsx`
- `src/renderer/pages/Launcher.tsx`
- `src/renderer/context/TabProvider.tsx`
- `src/server/analytics.ts`
- `specs/prd/analytics_design.md`

测试建议新增或扩展：

- `src/renderer/analytics/*.test.ts`
- `src/server/analytics.unit.test.ts`
- 一个 analytics event registry 静态测试（位置按现有测试约定决定）

---

## 15. 附录：上线后要看的健康指标

发布后一周检查：

- `session_new.entry_intent` 分布是否合理，`unknown` 占比应接近 0。
- `session_new.has_initial_message=false` 的 `agent_card/open_workspace` 是否存在，且比例符合实际工作区卡片浏览行为。
- `history_open.session_id` 非空率应为 100%。
- `message_send.session_id` 非空率应 > 99%。
- `ai_turn_complete.session_id` 非空率不低于当前版本。
- 事件 registry 静态测试在 CI 中稳定运行。
