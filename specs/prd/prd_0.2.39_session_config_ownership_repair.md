---
type: prd
status: draft
created: 2026-06-23
updated: 2026-06-23
scope: "彻底修复 #395/#396：历史会话重开或切 Tab 后 model/provider/permissionMode 漂移到 Agent/项目默认值的问题。核心是把桌面 owned session 的配置权威重新收回 SessionMetadata snapshot，pending 空会话在任何配置改动前先 materialize，恢复路径禁止默认值抢跑写回；IM 会话在 Tab owner 存在期间使用临时 config hold，关闭后恢复 live-follow；IM 绑定迁移、/new、或不兼容切换 fork 时，旧 session 冻结成普通 owned session，新 session 按规则继承 IM 绑定。明确不做：不放行 im-sync，不用新缓存/guard 绕过，不尝试无证据自动还原已污染历史。"
issue: "GitHub #395, #396 + 群反馈：v0.2.38 会话模型/Provider/权限重开后漂移，DeepSeek 化，切回原 Provider 被安全边界弹窗拦截。"
research: "本会话 RCA；相关原始 PRD: specs/prd/prd_0.1.69_session_config_snapshot.md, specs/prd/prd_0.2.31_instant_history_disposition_fix.md"
review: "代码级 cross-review 已补入最终约束：桌面 Tab 显式配置改动会 promote IM session snapshot；IM handover 在 Rust 事务内先冻结旧 session 再移动 binding；pending materialize commit 必须 durable；external metadataBirthPending 必须 fail-closed。"
---

# PRD 0.2.39：Session 配置所有权修复

## 执行须知（给空 session 的你）

你接手实现前必须主动读这些文档和代码，不要只读本 PRD：

1. `specs/ARCHITECTURE.md`
2. `specs/tech_docs/session_architecture.md`
3. `specs/tech_docs/third_party_providers.md`
4. `specs/tech_docs/multi_agent_runtime.md`
5. 原始设计：
   - `specs/prd/prd_0.1.69_session_config_snapshot.md`
   - `specs/prd/prd_0.2.31_instant_history_disposition_fix.md`
6. 当前实现入口：
   - `src/renderer/App.tsx`：`handleLaunchProject`、pending session id、`updateTabSessionId` / Rust `cmd_upgrade_session_id` 链路
   - `src/renderer/context/TabProvider.tsx`：`loadSession`、`sendMessage`、`adoptMigratedSession`、`onSessionIdChange`
   - `src/renderer/pages/Chat.tsx`：`persistTabConfigChange`、`patchSnapshot`、`sessionMeta -> local state`、mount-time `/api/model/set`
   - `src/renderer/api/persistInputOption.ts`：Tab/Launcher 配置 dual-write helper
   - `src/renderer/api/sessionClient.ts`：`updateSession`
   - `src/renderer/utils/tabPersistence.ts`：pending tab restore 过滤
   - `src/server/index.ts`：`POST /sessions`、`PATCH /sessions/:id`、`/chat/send`
   - `src/server/agent-session.ts`：`initializeAgent`、`switchToSession`、`setSessionPermissionMode`、`setSessionModel`
   - `src/server/utils/admin-config.ts`：`resolveWorkspaceConfig`
   - `src/server/utils/session-materialization.ts`
   - `src/server/session-engine/*`
   - `src-tauri/src/sidecar/session_lifecycle.rs`

本 PRD 引用符号名而非固定行号。行号会随并发改动漂移，找不到时用 `rg "<symbol>"`。

本 PRD 是修复 #395/#396 的执行契约。它不是“再加一层保护”或“放宽某个 endpoint”的补丁单，而是一次配置所有权校正：把 work 放回正确 owner。

## 1. 背景与用户反馈

用户在 v0.2.38 上反馈两个看似不同的问题：

1. 某个对话本来使用 A 供应商 / A 模型，关闭重开后显示成 B 供应商 / B 模型，有时统一变成 DeepSeek。试图切回原 provider 时弹出：

   > 当前会话的历史记录不能安全切换到目标模型/Provider。切换后将保留当前会话，并在新 Tab 打开一个使用新模型/Provider 的会话。

2. 某个对话和 Agent 默认权限都设置为“自主行动”，但从这个对话切出再切回、关闭重启后，权限变成“行动”或“计划”。

用户给出的最小复现：

```text
1. 打开一个空 session 1，模型用 A
2. 新开 tab，新打开同工作区 session 2，并将模型从 A 切换为 B
3. 关闭再打开后，两个对话的模型统一变成 DeepSeek，权限全部从自主行动变成行动
```

后来用户又让小助理自检，补充了更有价值的信息：

- `resume=true` 的历史会话 boot banner 里统一显示 `model=deepseek-v4-flash`；
- `resume=false` 的新会话正常；
- 打开过的 session 会在 `sessions.json` 里被永久改写；
- 没有重新打开过的旧 session 仍保留正确模型；
- 出现过 `provider=sensenova` 但 `model=deepseek-v4-flash` 这种不合法配对。

这些信息把问题从“权限下拉没保存”缩窄为：**恢复已有 session / pending 空 session materialize / Chat 挂载配置推送路径，会把 Agent/项目默认值错当成当前会话配置，并可能写回 session snapshot。**

## 2. 已验证事实

### 2.1 问题存在，且不只是 UI 显示错

`sessions.json` 被改写说明这是持久化破坏，不只是前端 picker 显示错。用户“没打开过的旧 session 仍正确，打开过的变坏”说明打开或恢复过程本身会触发污染。

### 2.2 DeepSeek 不是根因

DeepSeek 是 fallback 结果。`resolveProvider(...)` 在指定 provider 缺失、不可用或未解析时会 fallback 到第一个可用 provider。用户环境里 DeepSeek 恰好可能是第一个可用项，或 DeepSeek alias/primary model 被 Agent 默认值带入。

根因不是 DeepSeek preset，而是 provider/model 所有权错位。

### 2.3 issue #395 里的 `im-sync` 方向不成立

`src/server/agent-session.ts::setSessionPermissionMode` 明确标注：`/api/session/permission-mode` 是 Rust IM router 专用，desktop permission changes 不应该走这里。它用 `source: 'im-sync'` 被 snapshot guard 拦住，是为了防止 IM/channel override 覆盖桌面 owned session snapshot。

放行 `im-sync` 会重开 #327 类问题：IM fullAgency / plan / channel config 可能静默降级或覆盖桌面会话安全策略。它只能解释部分日志现象，不能解释 model/provider 漂移，更不能修复 `sessions.json` 被改写。

### 2.4 当前代码存在三个可污染入口

#### 入口 A：pending 空会话没有真实 SessionMetadata

`App.tsx::handleLaunchProject` 对新工作区/新 Tab 使用 `createPendingSessionId(targetTabId)`。`tabPersistence.ts::serializeTabs` 明确过滤 pending tabs，pending 不是可恢复会话。

在 pending 状态下，用户改 model/provider/permission 时：

1. `Chat.tsx::persistTabConfigChange` 调 `persistInputOptionChange(...)`；
2. helper 先走 `patchSnapshot`；
3. `patchSnapshot` 调 `patchSessionMetadata(sessionId, patch)`；
4. 对 `pending-...` 做 `PATCH /sessions/:id` 会 404；
5. `sessionClient.updateSession` 对 404 返回 `null`；
6. `patchSnapshot` 不抛错；
7. `persistInputOptionChange` 继续写 Project / Agent 默认值；
8. 后续真实 session materialize 时，从 Agent 默认值吸入被污染配置。

这解释了用户的“空 session 1 / 空 session 2”复现。

#### 入口 B：恢复已有 session 时字段级 `session ?? agent` fallback

`admin-config.ts::resolveWorkspaceConfig(agentDir, sessionMeta)` 对 provider/model/permission 的优先级是：

```text
session snapshot -> Agent -> Project -> global/default
```

`Chat.tsx` 的 `sessionMeta -> local state` effect 也做字段级 fallback：

```text
sessionMeta.model ?? currentAgent.model
sessionMeta.permissionMode ?? currentAgent.permissionMode
sessionMeta.providerId ?? currentAgent.providerId
```

这个策略在 v0.1.69 原设计里用于 legacy / IM live-follow 兼容；但对已经声明为 owned 的桌面 session 来说，缺字段不应继续默默跟随 Agent。否则 Agent 默认值一变，旧会话就像变成了新默认。

#### 入口 C：Chat 挂载期自动 `/api/model/set` 可能用默认值抢跑

`Chat.tsx` 有 mount-time unified model-push effect，会在 sidecar 连接后把 `selectedModel` 推到 `/api/model/set`。`selectedModel` 初始来自 Agent/项目默认值，而 `sessionMeta` 是异步加载的。

如果 sidecar 刚恢复历史 session，但前端还没拿到该 session 的 snapshot，默认值就可能先被推给当前 sidecar。`/api/model/set` 本身不直接写 `sessions.json`，但它会改变 live sidecar config；后续用户操作或 patchSnapshot 会把这个错值持久化。

## 3. 回归时间线

这不是单点 commit。它是分阶段形成的所有权错位。

| 时间 / commit | 变化 | 与本 bug 的关系 |
|---|---|---|
| 2026-03-22 `f987c54a` | 引入 sidecar self-resolve workspace config，`currentModel` 为空时才写入 | 当时没有 session snapshot，不是 bug；后来成为“默认值已存在就不覆盖 snapshot”的风险点 |
| 2026-04-18 `b95ddb0f` (`v0.1.69`) | 引入 layered session config snapshot，Desktop/Cron owned，IM live-follow | 正确方向，但保留了字段级 `session ?? agent` fallback 和 pending 先无 snapshot 的缺口 |
| 2026-06-03 `45c03c6b` | 修 #300，`switchToSession` 恢复 model + providerEnv | 修了 real -> real switch 的一部分，未覆盖 initial resume / pending |
| 2026-06-04 `f03a0b56` | 修 #305，`sessionMeta` 未加载时也写 snapshot | 修了“用户快速改配置不落 session”的问题，但 pending 404 被当成功，导致继续向上写 Agent/Project |
| 2026-06-20 `0ae6f23c` (`v0.2.37`) | pending -> real handoff ownership 修复 | 保住 send/image/watch owner，但没有让“配置改动前 materialize”成为强规则 |
| 2026-06-21 owner/refactor 系列 (`v0.2.38`) | session sidecar owner 化、builtin owner split、restore 路径更集中 | 问题暴露更稳定；用户在 v0.2.38 高频复现 |

结论：**根因从 v0.1.69 的 snapshot 模型缺口开始存在，#300/#305 修掉了局部症状，v0.2.38 让恢复/pending 路径变成高频触发点。**

## 4. 产品目标

### 4.1 必须达成

1. 已有桌面会话重开后，显示和运行的 model/provider/permissionMode 必须来自这个 session 自己的 snapshot。
2. pending 空会话上任何配置改动都必须先生成真实 session，不再把“这个会话的改动”写成 Agent/项目默认值。
3. 打开历史会话不得因为挂载期默认值抢跑而改写 `sessions.json`。
4. IM / Cron live-follow 语义不能被破坏。
5. 外部 runtime 的 model/permission drift 同样要被纳入所有权规则；external 不涉及 provider，但涉及 runtimeConfig。
6. 对已经被污染的历史数据，能确定就修，不能确定就停止继续污染并给出诊断。

### 4.2 非目标

- 不放行 `im-sync`。
- 不新增一层 cache / flag / retry 去绕过污染；必须把配置写回正确 owner。
- 不改变 provider/runtime history boundary 的安全弹窗语义。弹窗只用于“当前 session 不能原地自然延续，必须 fork/new session”的变更；确认后旧 session 保持不变，新 session 使用目标配置。
- 不对所有 legacy session 做无证据猜测式自动还原。
- 不把纯 IM session 默认改成 snapshot-owned；无 Tab owner 时纯 IM 仍 live-follow Agent/Channel。
- 不改变“Tab 内显式改配置同时向上更新 Agent 模板”的现有体验，但要确保先写到当前 session。

## 5. 核心原则

### P1：Agent 是模板，Session 是对话自己的配置

桌面 owned session 一旦有 `configSnapshotAt`，model/provider/permission/reasoning/MCP/plugin 这类运行参数以 session snapshot 为权威。

Agent/Project/global default 只用于：

- 新 session 出生；
- pure IM / live-follow session；
- IM session 的 Tab owner 全部释放后，下一次 IM turn 重新 live resolve；
- legacy session 没有任何可靠 snapshot 时的兼容 fallback；
- 用户明确在 Agent 设置页改未来默认值。

### P2：pending 不是 session

`pending-...` 是 UI/sidecar handoff 占位符，不是可持久化会话。任何“per-session config mutation”打到 pending 都是类型错误。

正确做法不是吞掉 404，也不是写 Agent/Project 顶上，而是先 materialize。

### P3：恢复路径只能采纳，不得猜测

打开已有 session 时，front-end 与 sidecar 都应该采纳 session snapshot。挂载期的自动 push 只能在“这是新会话 / push authority 已确认”时执行。

历史会话 restore 的默认值抢跑属于 config-stomp。

### P4：用户显式操作可以改变当前 session，自动 effect 不可以

用户点击 model/provider/permission picker 是明确 intent；自动 project-sync、model-heal、mount-time model-push 不是 intent。

自动 effect 不能把 default 写进已有 session。用户操作可以写，但必须写到真实 session snapshot。

## 6. 目标架构

### 6.1 Session 配置权威状态机

引入一个纯 policy，用于前后端共识判断当前会话的配置 owner。命名可以是：

- `resolveSessionConfigAuthority(...)`
- 或扩展现有 `shouldSkipSnapshotWrite(...)`

建议放置：

- renderer 纯函数：`src/renderer/utils/sessionConfigOwnership.ts`
- server 纯函数：`src/server/session-core/session-config-ownership.ts`
- shared 类型：必要时放 `src/shared/sessionConfigOwnership.ts`

状态定义：

| 状态 | 判定 | 语义 |
|---|---|---|
| `pending` | `isPendingSessionId(sessionId)` | 还不是 session，任何 config mutation 前必须 materialize |
| `loading` | real `sessionId` 但 `sessionMeta` 未加载 | 自动 effect 不得 push；用户操作可以走 fail-closed patch 或等待加载 |
| `owned` | `sessionMeta.configSnapshotAt` 存在 | session snapshot 是权威；即使仍有 IM owner，后续 IM turn 也按 snapshot 运行 |
| `legacy-desktop` | 非 IM source，缺 `configSnapshotAt` | 旧会话，打开时只诊断不写；首次用户配置改动或有确证时再 migrate |
| `pure-im-live` | IM-shaped source、无 `configSnapshotAt`、无 Tab owner | live-follow Agent/Channel；每次 IM turn 按当前 Agent/Channel live 配置 resolve，不写 snapshot |
| `im-live-held` | IM-shaped source、无 `configSnapshotAt`、存在 Tab owner | Tab 打开时从 live sidecar 采纳当前配置并临时 hold；hold 期间桌面和 IM 后续 turn 都使用 held config，不跟随其它 Tab 对 Agent 默认值的修改；最后一个 Tab owner 释放后恢复 live-follow |
| `adopt-live-sidecar` overlay | 非 pending，`sidecarConfigDisposition === 'adopt'`，且不是 IM live-held | 这是 sidecar 同步方向 overlay，不是独立配置 authority，也不应作为 `SessionConfigAuthority.kind` 单独返回。当前 Tab 加入已运行 sidecar 时可以先采纳 live sidecar display state；随后仍必须按 `owned` / `legacy-desktop` / `pure-im-live` 判定最终配置归属。特别是 `owned + adopt` 仍然是 `owned`，不得从 live sidecar 反推覆盖 snapshot |

这个状态机要替代散落在 `Chat.tsx` 的 `sessionMeta ? ... : default` 判断和 `skipSnapshotWrite` 局部推断。

桌面端不允许同一个 session 同时打开在两个 Tab。再次打开同一 session 应聚焦已有 Tab，而不是创建第二个 Tab；因此本 PRD 不设计“两个桌面 Tab 同时写同一 session snapshot”的冲突合并语义。并发风险只来自自动 effect、pending materialize、Sidecar owner 释放和外部 IM/Cron owner。

**强约束：`isPendingSessionId(sessionId)` 的优先级高于 `sidecarConfigDisposition`。** 新空会话 instant flip 的常见形态是 `sessionId=pending-...` 且 `sidecarConfigDisposition='push'`，这不是矛盾：`push` 只表示“这个 Tab 拥有配置推送权”，不表示它已经是可持久化 session。因此所有 per-session config mutation 必须先判断 pending id，不管 disposition 是 `push` / `adopt` / `pending`。只按 disposition gate 会漏掉用户 #395/#396 的最小复现。

### 6.2 Desktop owned session 的读规则

当 session 是 `owned`：

- `providerId`：只读 `sessionMeta.providerId`。缺失本身不是 partial：builtin 下可表示订阅 / 默认 Provider，external runtime 本来就没有 provider。禁止的是用 `agent.providerId` 静默补齐并改写当前会话。
- `model`：只读 `sessionMeta.model`。缺失本身不是 partial：builtin 可表示 SDK / Provider 默认模型，external 可表示 CLI 默认模型。禁止的是用 `agent.model` / `agent.runtimeConfig.model` 静默补齐 owned session。
- `permissionMode`：只读 `sessionMeta.permissionMode`；缺失时只能落到 runtime 的不可变产品默认值（builtin=`auto`，external=对应 runtime default），不得直接显示 Agent/Project permission 后写回。
- `reasoningEffort`：`sessionMeta.reasoningEffort ?? 'default'`，`default` 是有意义字面值。
- `mcpEnabledServers`：有数组则 session wins；owned snapshot 下缺失不能回退到 Agent/Project MCP 列表，只能按空/产品默认运行并记录 diagnostic。legacy/no snapshot 才允许走原有 live fallback。
- `enabledPluginIds`：与 `mcpEnabledServers` 同级。owned snapshot 下有数组则 session wins；缺失不能回退到 Agent/Project plugin 列表，只能按空/产品默认运行并记录 diagnostic。legacy/no snapshot 才允许走原有 live fallback。

如果为了兼容必须展示来自 Agent/Project/global 的 fallback 值，UI 要把它标成“legacy fallback / 未锁定”，并且不能自动写回 session。只有用户显式确认或修复器能确定来源时才写。来自 runtime / provider 的产品默认值不是 Agent fallback，可以用于运行，但仍不能反推写回 snapshot。

`resolveWorkspaceConfig(...)` 也必须变成 authority-aware。只在调用处“无条件 set resolved”不够，因为当前 resolver 自己会把 `sessionMeta.providerId/model/permissionMode` 缺失字段 fallback 到 Agent/Project/global。对 `owned partial` 来说，这个 fallback 不能被当作 session 真值返回；正确返回应包含 diagnostic，例如：

```ts
type ResolvedWorkspaceConfig =
  | { authority: 'session-snapshot'; config: CompleteSessionConfig }
  | { authority: 'legacy-live-follow'; config: WorkspaceConfig }
  | { authority: 'partial-snapshot'; config?: PartialSessionConfig; missingFields: SnapshotField[]; needsRepair: true };
```

实现可以不使用这个精确类型名，但必须表达同一语义：`owned partial` 不能被 Agent 默认值静默补成完整结果。字段“缺失”是否 partial 必须按 runtime 和字段语义判断：external 的 `providerId` 缺失、external 的 `model` 缺失、builtin 的 `providerId` 缺失、以及缺失 `permissionMode` 落到 runtime 产品默认值，都不是自动 repair 证据；provider/model 明显不配对、字段值跨 runtime 不可用、或有证据表明 snapshot 被打开流程污染，才进入 partial/diagnostic。否则 `initializeAgent` 即使无条件应用 resolver 输出，也只是把 Agent 默认值更快地写进 live sidecar。

### 6.3 IM 的 live-follow / live-held / owned 规则

IM 不是简单的“永远 live-follow”，也不是“桌面打开就持久 snapshot”。正确语义取决于 Sidecar owner。

#### 6.3.1 pure IM：无 Tab owner 时 live-follow

pure IM session 没有 `configSnapshotAt`，且没有桌面 Tab owner 时，继续 live-follow Agent/Channel。

例如当前 Feishu bot 主 session 使用模型 A；用户没有在桌面打开它。另一个桌面 Tab 把同一 Agent 工作区默认模型改成 B 后，手机 Feishu 下一条消息应使用 B。这是 IM 渠道的正常 live-follow 心智。

这不意味着 server `PATCH /sessions/:id` 要按 IM source 丢弃 snapshot 字段。`PATCH /sessions/:id` 是桌面 Tab 的显式用户意图路径；如果它写入 snapshot 字段，即表示该 IM session 正在被桌面 owner promote。纯 IM live-follow 的保护来自“没有桌面配置写入”，不是来自 server 吞掉桌面 PATCH。

#### 6.3.2 im-live-held：Tab owner 存在期间临时 hold

当桌面 Tab 打开一个当前由 IM 绑定的 session 时，这个 session 多了一个 Tab owner。此时它进入 `im-live-held`：

- 打开瞬间从 live sidecar 采纳当前配置，例如模型 A、权限 `auto`；若当前没有 live sidecar，则按 Agent/Channel 当下 live-resolved config 生成 held config；
- held config 是运行态 owner 状态，不写 `configSnapshotAt`；
- 其它 Tab 把 Agent/工作区默认模型改成 B 时，当前 held session 不跳到 B；
- hold 期间手机 Feishu 继续向同一个 session 发消息，也继续使用 A；
- runtime 级配置变更（MCP/plugin/provider env 等）不应立即重启或改写当前 held IM session；最后一个 Tab owner 释放后，IM live-follow 才在下一次 turn / 新 session resolve 时采用最新配置；
- 切换 Tab 不释放 hold；关闭最后一个持有该 session 的桌面 Tab、应用退出或 Tab owner 异常释放，才释放 hold。

这个状态接近“临时锁住当前会话配置”，但不是持久 lock：它只表达“当前 session 同时被桌面查看/交互时，不能被其它 Tab 对 Agent 默认值的修改无事件跳变”。

#### 6.3.3 桌面发送消息不等于 owned

用户在 `im-live-held` Tab 里发送普通消息，不算显式配置改动，不应把 session 持久 snapshot-owned。该桌面 turn 使用 held config；关闭 Tab 后，如果 session 仍是 Feishu 主 session，后续 IM 消息恢复 live-follow 当前 Agent 配置。

#### 6.3.4 Tab 内手动改配置：升级为 session 优先模式

用户在 `im-live-held` Tab 内显式改模型 / Provider / 权限 / reasoning / MCP / plugin / runtime 配置时，表示用户要改变“这个 session 或这个 Feishu 绑定”的运行参数。这里必须先判定目标变更是否可以在当前 session 内自然延续：

- 可原地延续：把当前 session 升级为 `owned`；
- 不可原地延续：走 provider/runtime boundary fork，新 session 继承 Feishu 绑定，旧 session 冻结为普通 `owned` 历史。

可原地延续时的处理：

- 通过 `PATCH /sessions/:id` 写入完整 session snapshot；server 不得因 source 是 `*_private` / `*_group` 丢弃字段；
- 当前 session 的后续桌面 turn 和 IM turn 都按 snapshot 运行；
- 同时保留“Tab 内显式改配置会向上更新 Agent/工作区默认值”的现有体验，供后续新会话使用；
- 后续 Agent 默认值变化不再覆盖该 session；
- 直到 Feishu `/new` 绑定新的主 session，或桌面点击新对话创建新 session，新 session 才重新按当前 live 默认值开始。

#### 6.3.5 Feishu `/new`：渠道绑定迁移，旧 Tab 变普通 session

当 Feishu 发送 `/new` 时，语义是“这个 IM 渠道选择创建一个新 session 作为新的主 session”。处理规则：

- 新 Feishu 主 session 按当前 Agent/Channel live 配置创建；
- 原 session 失去 Feishu owner / Feishu tag；
- 如果原 session 正在桌面 Tab 打开，桌面表现只是 tag 消失，Tab 仍停留在原 session；
- 原 session 从此是普通历史 session，必须有完整 snapshot，记录 detach 当下这段 session 的有效运行配置；
- 如果原 session 原本是 `im-live-held`，detach 时用 held config 写入完整 snapshot；
- 如果原 session 是 pure IM live-follow 且没有 Tab owner，detach 时也要冻结成 `owned`：base config 取“该 IM session 在 detach 当下会实际使用的 live-resolved config”。如果 sidecar 正在运行，优先取 live sidecar config；否则按 Agent/Channel 当前配置 resolve；
- 如果原 session 已经是 `owned-complete`，保持原 snapshot，不做额外迁移。
- 如果原 session 是 `owned-partial`，detach 前必须按 partial repair 规则补齐或进入 fail-closed diagnostic；不能把 partial snapshot 直接变成普通历史 session。

这条规则避免 `/new` 后旧 session 因失去 IM live-follow 来源而回退到 Agent 默认值，也保证任何脱离 IM 绑定、进入普通历史列表的 session 都有自己的 snapshot。

#### 6.3.6 桌面 Tab 新对话 / 不兼容切换：新 session 继承 IM 绑定

当用户在 Feishu-bound 的桌面 Tab 上点击“新对话”时，保持现有体验：当前 Tab 切到新的 Feishu 主 session，旧 session 变普通 owned 历史 session。

同理，当用户在 Feishu-bound Tab 内做模型 / Provider / runtime 变更，且该变更不能在当前 session 内自然延续，必须通过 provider/runtime boundary fork/new session 时：

- 弹窗说明会保留当前 session，并新开一个使用目标配置的 session；
- 用户确认后，旧 session 保持原历史和原配置，并冻结为普通 owned session，失去 Feishu tag/owner；原 Tab 仍可停在旧 session；
- 新 session 使用目标配置，在新 Tab 打开，并继承 Feishu tag/owner，成为该 Feishu 渠道新的主 session；
- 这次用户配置变更仍按现有逻辑更新 Agent/工作区默认值，所以后续新 session 也以目标配置为默认。

因此，在 Feishu-bound Tab 里，“新对话”和“不兼容切换确认后 fork”都是 IM 绑定迁移动作；不是创建一个与 Feishu 无关的普通桌面 session。

### 6.4 IM session promotion / binding transfer 事务

`im-live-held` 手动改配置和 IM binding transfer 是两类不同事务，不能混成一个松散前端串联。

1. `held-im-config-change`：用户在打开该 IM session 的桌面 Tab 内显式修改模型 / Provider / 权限 / reasoning / MCP / plugin，且该变更可以在当前 session 原地自然延续。它走普通 `PATCH /sessions/:id`，但语义是“desktop user intent promote”：server 必须允许 IM source 写 snapshot 字段并 stamp `configSnapshotAt`。
2. `im-binding-transfer`：Feishu `/new`、桌面新对话、或不兼容切换 fork 导致原 session 失去 IM owner / tag，必须转成普通 owned 历史，并按场景把 IM 绑定迁移到新 session。它走 IM binding owner API / Rust handover command，不允许 renderer 分别 PATCH 两个 session 伪造迁移。

事务语义：

- `held-im-config-change` 校验当前 PATCH 是桌面 Tab 发起的 snapshot write，并先写 session snapshot，再向上更新 Agent/Project；
- `im-binding-transfer` 校验 source session 当前确实是 IM-bound；
- `im-binding-transfer` 从 held runtime config 或 detach 当下 live-resolved config 取完整 base snapshot；sidecar 活着时优先调用旧 sidecar 的 `/api/session/freeze-current`，以保留桌面 held 的真实配置；sidecar 不存在时才用 Agent/Channel live-resolved file-lock fallback；
- 对 `im-binding-transfer`，旧 session 直接用 base config 冻结，新 session 使用目标 config 或当前 live 默认；
- 写入完整 `configSnapshotAt`，将 session authority 转为 `owned`；
- `held-im-config-change` 后，该 session 仍保留 IM owner，后续 IM turn 使用 snapshot；
- `im-binding-transfer` 后移除旧 session 的 IM tag/owner，旧桌面 Tab 如存在则仍停留在原 session，只是变成普通 session；新 session 继承 IM tag/owner；
- 失败必须 fail-closed：不写 Agent/Project，不改变 picker，不释放 hold。

这个路径不能用 `source: 'im-sync'`。`im-sync` 仍然只代表 IM router 的同步写入，不能覆盖 owned snapshot。desktop promote 的来源是桌面用户对 session metadata 的 snapshot write；binding transfer 的来源是 Rust IM owner command。

#### IM binding transfer 必须是原子事务

`im-binding-transfer` 同时改旧 session snapshot、新 session、IM tag/owner、Sidecar owner 绑定，不能做成“先写一半，再靠 UI 状态补齐”的松散串联。推荐协议：

1. `prepareTarget`：准备目标 session。Feishu `/new` 或桌面新对话使用当前 live 默认创建新空 session；不兼容切换 fork 使用目标配置创建新 session。此时不移动 IM 绑定。
2. `adoptTargetUi`：桌面发起的新对话 / provider-runtime fork 必须先确认目标 Tab 能创建、目标 sidecar 能 ensure 成功；若 Tab 上限、sidecar 启动失败或 TabProvider adopt 失败，删除 prepared target，不冻结 source、不移动 IM 绑定。Feishu `/new` 没有桌面目标 Tab，可跳过这步。
3. `freezeSource`：Rust handover 在移动 binding 前冻结 source session。若 source sidecar 活着，调用 source sidecar `/api/session/freeze-current`，由 active `SessionEngine` 冻结 builtin/external 的真实 held config；若 source sidecar 已释放，使用 file-lock fallback 写 Agent/Channel 当下 live-resolved config。若 freeze 失败，释放刚 attach 的 target Agent owner，不移动 binding。
4. `moveBinding`：原子移动 Feishu tag/owner 到 target session，并从 source session 移除 tag/owner。这里必须由 IM binding owner API 统一完成，禁止 renderer 分别 PATCH 两个 session。移动前要复查 peer binding 没在 freeze 期间被其它 `/new` / handover 改掉。
5. `commitRuntime`：让 target sidecar/runtime identity 与新的 IM 主 session 对齐；source sidecar 如仍有 Tab owner，继续作为普通桌面 session 存活。
6. `refresh UI surface`：只有前五步全部成功后，桌面 UI 才显示 target session 的 Feishu tag；如果 target Tab 已经打开但 `moveBinding` / `commitRuntime` 失败，target 保持普通桌面 session，source 继续保持原 IM 绑定，并展示高优先级错误。

失败处理：

- `prepareTarget` 失败：无副作用；
- `adoptTargetUi` 失败：删除 prepared target，不冻结 source、不移动 IM 绑定；
- `freezeSource` 失败：不移动 IM 绑定；已 attach 的 target Agent owner 必须释放；桌面已打开的 target 保持普通 session，提示用户 Channel 未迁移；
- `moveBinding` 失败：由于 freeze 已成功但 binding 未移动的状态应被事务顺序避免；若仍发生，未被桌面 adopt 的 prepared target 删除，已经打开的 target 保留为普通桌面 session 且不得带 Feishu tag，并打高优先级诊断；
- `commitRuntime` 失败：尽力把 binding 移回 source；未被桌面 adopt 的 target 删除，已经打开的 target 保留为普通桌面 session 且不得带 Feishu tag。若无法回滚，必须阻断后续 IM turn 并打高优先级诊断；
- 任一失败都不得更新 Agent/Project 默认值，不得让 Feishu channel 同时指向两个 session，也不得让 source/target 同时带 Feishu tag。

### 6.5 Pending materialization 事务

新增一个明确的 session materialization API。推荐端点：

```text
POST /api/session/materialize
```

请求：

```ts
type MaterializeSessionRequest = {
  pendingSessionId: string;
  workspacePath: string;
  reason: 'config-change' | 'first-message' | 'explicit-new-session';
  snapshotPatch?: {
    providerId?: string | null;
    // null = explicitly clear. Provider change MUST clear providerEnvJson in the
    // same transaction; carrying an old env blob under a new providerId is data
    // corruption.
    providerEnvJson?: string | null;
    model?: string | null;
    runtime?: RuntimeType;
    permissionMode?: string | null;
    reasoningEffort?: string | null;
    mcpEnabledServers?: string[] | null;
    enabledPluginIds?: string[] | null;
  };
};
```

响应：

```ts
type MaterializeSessionResponse = {
  success: true;
  oldSessionId: string;
  sessionId: string;
  metadata: SessionMetadata;
};
```

职责：

1. 只对 `pending-...` 做 materialize mutation；real session 调用必须是幂等 no-op：已有 metadata 返回当前 metadata，缺 metadata 返回 404/409 诊断，不能创建第二个 session。
2. 用 Desktop owned 语义创建真实 `SessionMetadata`。
3. base snapshot 来自当前 Agent/Project 默认值；再应用 `snapshotPatch`。
4. **任何 `providerId` 变更必须同事务清空 `providerEnvJson`**，除非请求显式带了与该 provider 匹配的新 env snapshot。`providerEnvJson` 没有 providerId tag，旧 env blob 会在 `resolveWorkspaceConfig` 中继续 wins；因此 “新 providerId + 旧 baseUrl/key” 是必须禁止的数据污染。
5. 对 builtin：切换当前 facade/runtime identity 到真实 id，并按真实 id 重新 prewarm。
6. 对 external runtime：迁移或清理 `pendingExternalSessionBirth` / runtime thread binding，确保 `runtimeSessionId` 不丢、不仍绑定 pending id。
7. 返回真实 id 和 metadata。

#### Materialize 必须是两阶段事务，不允许半升级

这件事不能靠“renderer 先调 Node，再调 Rust，再自己改 UI”的松散串联完成。现有 `App.tsx::updateTabSessionId` 即使 `upgradeSessionId(...)` 返回 false 也会继续更新 UI tab id；这种半升级会产生“Node/metadata 是 real id，但 Rust SidecarManager 仍按 pending id 路由”的状态。

推荐协议：

1. `prepare`：Tab-scoped sidecar 创建 real `SessionMetadata` 和 snapshot，但**不切换** Node 内部 runtime identity，不停止 pending prewarm。返回 `preparedSessionId` 和 metadata。
2. `upgrade`：调用 Rust `cmd_upgrade_session_id(pending, prepared)`。失败则调用 `rollbackPrepare` 删除 prepared metadata，UI 仍停在 pending，配置改动整体失败。
3. `commit`：在同一个 sidecar 上提交 materialize，Node 内部把 `sessionId` / builtin 或 external owner state 切到 real id，重置 pending birth/prewarm，返回最终 metadata。失败则尽力 `cmd_upgrade_session_id(prepared, pending)` 回滚 Rust key 并删除 prepared metadata；若无法回滚，必须 fail-closed、停止继续写 Project/Agent，并打高优先级诊断。
4. `adopt UI`：只有 prepare + upgrade + commit 全部成功后，TabProvider/App 才能调用 `adoptMigratedSession` / `updateTabSessionId` / `setSessionMeta`。

Crash recovery 约束：

- `prepare` 写入的 real metadata 必须带 prepared marker（例如 `materializationState:'prepared'` 和来源 pending id）；
- prepared session 在 commit 前不得出现在历史列表、搜索入口或普通 session 统计里；
- 重复 `prepare` 必须合并新的 `snapshotPatch` 并重新持久化 prepared metadata，不能直接返回第一次 prepare 的旧 patch；
- `commit` 必须先 durable 清除 marker；如果 marker 清除失败，不能切换 Node/Rust/UI 到 real id；`rollback` 必须删除 prepared metadata；
- 如果应用在 prepare 后、commit 前崩溃，重启后最多留下隐藏的 prepared metadata，不能显示成用户可打开的“幽灵空会话”；后续 cleanup 可按 marker 安全删除。

实现形态可以是一个 renderer helper 协调三步，也可以新增 Rust orchestration command 由 Rust 调 pending sidecar HTTP 后再升级 key；但语义必须是上述两阶段事务。**验收必须覆盖**：`upgradeSessionId` 失败、commit 失败、重复点击配置造成并发 materialize、TabProvider adopt 失败。任一失败都不得继续 `patchProject` / `patchAgentConfig` / sidecar live push，也不得产生两个 id 指向同一进程。

### 6.6 Snapshot patch fail-closed

`patchSnapshot` 语义改成：

- real session PATCH 成功：返回 updated metadata；
- pending session：不允许直接 PATCH，必须先 materialize；
- real session 404：视为删除竞争，向用户报错，不继续写 Agent/Project；
- 其它 HTTP/JSON 错误：报错，不继续写 Agent/Project。

`persistInputOptionChange` 需要知道 snapshot write 是“必需”还是“可选”。

建议把 helper 参数改为：

```ts
snapshotWriteMode: 'required' | 'optional' | 'disabled'
```

语义：

- `required`：Desktop owned / pending materialized / legacy migrating。snapshot 失败则整体失败，不写 Project/Agent，避免“当前 session 没保存但模板被改”。
- `optional`：Launcher 或未来新 session template-only 场景。
- `disabled`：明确不涉及 session 的 template-only 场景。`im-live-held` 的显式配置改动不能用 `disabled`：可原地延续时 `PATCH /sessions/:id` promote 并原子写完整 snapshot；不可原地延续时走 IM binding transfer/fork，旧 session 不写目标配置。

当前 Chat 的 Tab 内显式配置改动应走 `required`，pending 时先 materialize 再 required。

`required` 失败时必须同时阻断所有后续副作用：

- 不调用 `patchProject`；
- 不调用 `patchAgentConfig`；
- 不调用 `/api/mcp/set`；
- 不调用 `/api/cc-plugin/session-enable`；
- 不调用 `/api/runtime/config`；
- 不允许同一次状态变化再通过 mount-time `/api/model/set` 把错值推给 sidecar。

这不是“toast 后继续”的场景。用户改的是当前会话；当前会话没写成，就不能悄悄改未来模板。

向上同步顺序：

- 当前 session 的 materialize / promote / transfer 成功之前，不允许更新 Agent/Project 默认值；
- 当前 session 已成功保存后，Agent/Project 模板更新失败不应反向破坏当前 session，只提示“当前会话已更新，但未来默认值未更新”；
- provider/runtime boundary fork 的 IM-bound 场景例外更严格：旧 session freeze、新 target 准备、绑定迁移必须先成功，才算当前 session 变更成功；Agent/Project 默认值更新失败时不得迁移绑定。

### 6.7 自动 effect 与用户 intent 分离

`Chat.tsx` 里所有自动配置 effect 必须按 authority gating：

| effect / site | owned history | pending | new fresh push | pure IM live / IM held / adopt |
|---|---|---|---|---|
| project-sync seed local state | 从 sessionMeta seed，不用 Agent | defer | Agent/Project seed | pure IM live 可从 Agent/Channel；IM held 从 held config；非 IM adopt 从 live sidecar config |
| sessionMeta -> local state | apply snapshot only | n/a | n/a | pure IM live 可 fallback 到 Agent/Channel；IM held 必须从 held config seed，不读取 Agent 新默认 |
| model-heal invalid model | 不自动写 snapshot；只提示或 block send | defer | 可 heal new template | pure IM live 可按 live config heal；IM held 不自动改 held config，只提示或等待显式操作 |
| unified model-push `/api/model/set` | 等 sessionMeta authority ready 后推 snapshot model；不得推 mount default | defer/materialize | 可 push Agent default | pure IM live 不由桌面 mount push；IM held 只能推 held config，不能推 Agent 新默认；非 IM adopt 后用户显式改才 push |
| persistTabConfigChange | user intent -> materialize/patch snapshot required | materialize first | patch created session/template | pure IM live 无 Tab 配置改动；IM held 显式改配置 -> 升级 owned；非 IM adopt 按 authority 处理 |

尤其要修：

- `sessionMeta -> local state` 不能对 owned session 做 `session ?? agent` 后再 set picker；
- unified model-push 不能在 `sessionMeta` 未加载时对 real history session 推 Agent default。特别是 history instant open 可能已经 `sidecarConfigDisposition='push'`，但 `sessionMeta=null`；此时仍必须视为 authority 未就绪，不得调用 `/api/model/set`；
- model-heal 不能在 pinned provider unavailable 时把 fallback provider 的 primaryModel 写进 Project/Agent。这部分 #300 已有 guard，但本 PRD 要保留测试。

### 6.8 Resume / initializeAgent 的 server 规则

`agent-session.ts::initializeAgent(nextAgentDir, initialPrompt, initialSessionId, options)` 对 real `initialSessionId` 必须：

1. 读取 `initMeta`；
2. 判断 session authority；
3. 如果是 owned desktop snapshot，强制把 `configState.currentProviderEnv/currentModel/currentPermissionMode/currentReasoningEffort` 设置为 snapshot resolver 的结果；
4. 不受已有 `configState.currentModel` 是否为空影响；
5. 再 prewarm / resume SDK。

当前 `switchToSession` 已经有“目标 session restore model/providerEnv”的思路；`initializeAgent(existingSessionId)` 要与它对齐。

注意：

- pure IM 仍可使用 Agent/Channel live-follow；Cron 必须区分 `new_task` 与 `current_session`：`new_task` 每 tick live resolve Agent 并创建新 snapshot，`current_session` 走固定 session snapshot；`im-live-held` 在 Tab owner 存在期间必须使用 held config，不重新 self-resolve 到 Agent 新默认；
- external runtime 的 restore 归 `external-session/runtime-config.ts` owner，不能从 route 手写分支；
- 新 endpoint 或 route 必须走 `SessionEngine` facade，不在 `index.ts` 新增 builtin/external 分支。

### 6.9 Legacy / partial snapshot 修复

把历史会话分为四类：

| 类型 | 处理 |
|---|---|
| `owned-complete`：有 `configSnapshotAt`，且关键字段完整或缺失字段都有 runtime/provider 稳定默认值 | 不动 |
| `owned-partial`：有 `configSnapshotAt` 但 provider/model 明显不配对、字段值跨 runtime 不可用、或缺少某个对该 runtime 必需且没有稳定默认值的字段 | 打诊断；能从 metadata / transcript 精确推断则补；不能推断则展示 legacy fallback，但不自动写错 |
| `legacy-desktop`：非 IM source，无 `configSnapshotAt` | 打开时只诊断不写；首次用户配置改动或有确证证据时 lazy migrate；base 来自现有 metadata 字段和可推断证据 |
| `pure-im-live`：IM source，无 `configSnapshotAt`，无 Tab owner | 普通打开/恢复时不迁移，继续 live-follow；发生 IM binding transfer / `/new` detach 时必须冻结为 owned |
| `im-live-held`：IM source，无 `configSnapshotAt`，有 Tab owner | 不因打开自动迁移；仅在可原地延续的 Tab 显式改配置、IM binding transfer、或 `/new` detach 时转为 owned |

推断优先级：

1. `sessionMeta` 已有字段；
2. `providerEnvJson` 能解码且 providerId 一致；
3. transcript 中最近 assistant/result usage model；
4. provider catalog 中该 model 只属于一个 enabled provider，并且不是 alias、不是自定义 provider、不是禁用 provider、不是多个供应商共享的模型名；
5. 当前 Agent/Project/global default（仅作为 UI fallback，必须标记为 fallback，不得作为 safe-fix 证据）。

权限漂移通常无法从 transcript 反推，不能自动还原为 `fullAgency` / `auto` / `plan`。缺失 `permissionMode` 可以按 runtime 产品默认值运行，但不能用 Agent/Project 当前值补；已污染或用户声称曾设置过但 snapshot 缺失的 `permissionMode` 只能停止继续污染，并在用户显式选择后写入完整 snapshot。

对已经污染的 session，不做猜测式自动还原。可以提供一次性 developer diagnostic：

```text
npm run session-config:doctor
```

或内部脚本，输出：

- session id；
- source/runtime；
- configSnapshotAt；
- providerId/model 是否配对；
- model 是否存在于 provider models；
- permissionMode 是否缺失；
- 建议动作：safe-fix / needs-user-choice / no-op。

所有自动修复前备份 `~/.myagents/sessions.json`。

## 7. 详细实施方案

### Phase 1：纯 policy 与测试

新增/整理纯函数：

```ts
type SessionConfigAuthority =
  | { kind: 'pending' }
  | { kind: 'loading' }
  | { kind: 'owned'; complete: boolean; missingFields: SnapshotField[] }
  | { kind: 'legacy-desktop' }
  | { kind: 'pure-im-live' }
  | { kind: 'im-live-held'; heldConfig: CompleteRuntimeConfig };

type SessionConfigOverlay =
  | { kind: 'adopt-live-sidecar' }
  | null;
```

输入：

```ts
{
  sessionId?: string | null;
  sessionMeta?: SessionMetadata | null;
  sessionMetaLoaded: boolean;
  sidecarConfigDisposition?: 'pending' | 'push' | 'adopt';
  hasTabOwner?: boolean;
  isImBoundSession?: boolean;
  heldRuntimeConfig?: CompleteRuntimeConfig | null;
}
```

测试覆盖：

- pending id -> `pending`
- real id + meta null + not loaded -> `loading`
- configSnapshotAt + complete -> `owned complete`
- configSnapshotAt + 缺失但有稳定默认值的字段 -> `owned complete`
- configSnapshotAt + provider/model 明显不配对或字段跨 runtime 不可用 -> `owned partial`
- IM source + no configSnapshotAt + no Tab owner -> `pure-im-live`
- IM source + no configSnapshotAt + Tab owner -> `im-live-held`
- desktop/no source + no configSnapshotAt -> `legacy-desktop`
- non-IM disposition adopt -> authority 仍按 metadata/source 判定，同时返回 `adopt-live-sidecar` overlay；不得把 overlay 当 session authority

### Phase 2：pending materialization 与 held IM promotion/transfer

后端：

- 在 `SessionEngine` 增加 `materializePendingSession(...)` 方法；
- IM binding transfer 走现有 IM owner / Rust handover 事务；可原地延续的 held IM promotion 不新增独立 promote API，而是一次 desktop-user-intent 的 required snapshot `PATCH /sessions/:id`，成功后 session authority 变为 `owned`；
- builtin adapter 调 `agent-session.ts` public facade；
- external adapter 调 `external-session.ts` public facade；
- 内部复用 `createMaterializedSessionMetadata(...)` / `snapshotForOwnedSession(...)`；
- 应用 `snapshotPatch`；
- 切换当前 runtime identity；
- 对 prewarm 中的 pending subprocess 走语义化 abort；
- 对 external runtime，显式处理 `pendingExternalSessionBirth`、`runtimeSessionId`、已启动但未提交的 runtime thread。不能让 Codex/Gemini 的 thread binding 停留在 pending id，也不能丢掉已经由 prewarm 得到的 runtime session identity。
- 返回 metadata。

前端：

- `Chat.tsx::persistTabConfigChange` 在 authority `pending` 时先调 materialize；
- `Chat.tsx::persistTabConfigChange` 在 authority `im-live-held` 且用户显式改配置时：可原地自然延续则先做 required snapshot `PATCH /sessions/:id` 完成 promote；不可原地延续则确认后调 transfer/fork；
- materialize 成功后再 `persistInputOptionChange(snapshotWriteMode:'required')`；
- required snapshot `PATCH /sessions/:id` 成功后刷新 `sessionMeta`，将 UI authority 转为 `owned`，再执行 Agent template dual-write；不得再对同一 patch 做第二次 snapshot PATCH。transfer/fork 成功后旧 Tab 仍指向旧 session。触发源是“新对话”时，当前 Tab 切到新的 Feishu-bound session；触发源是不兼容 Provider/runtime fork 时，新 Feishu-bound session 在新 Tab 打开。
- 更新 TabProvider/App/Rust session id；
- 失败时 toast，不写 Agent/Project。

验收：

- pending tab 改模型后 `sessions.json` 立即出现真实 session；
- 关闭重开仍显示该模型；
- 第二个 pending tab 改模型不会改变第一个真实 session。
- 新空 Tab 的 `sessionId=pending-...` 且 `sidecarConfigDisposition='push'` 时，改 provider/model/permission 仍然先 materialize；不能因为 disposition 是 `push` 直接 PATCH pending。
- materialize 期间 `upgradeSessionId` 失败、commit 失败、并发重复点击配置，均 fail-closed：不写 Agent/Project，不 live-push sidecar，不更新 UI 到 real id。
- Agent 带旧 `providerEnvJson` 时，pending materialize 改到新 `providerId/model` 必须清空旧 env snapshot，不能产生新 providerId + 旧 env blob。
- 桌面 Tab 打开 Feishu session A 后，另一个 Tab 把 Agent 默认改成 B；当前 held Feishu session 的桌面显示和手机 Feishu 后续消息仍使用 A，直到最后一个 Tab owner 释放或 `/new` detach。
- held Feishu session 在 Tab 内手动改模型/权限时，必须 promote 为 owned；promote 失败不写 Agent 默认，不改变当前 live sidecar。
- Feishu `/new` 时，新主 session 用当前 live 默认 B；旧 session 失去 Feishu tag/owner，并以 detach 当下有效配置写入 snapshot 成为普通 owned session。若旧 session 正在桌面 Tab 打开，Tab 仍停在旧 session，只是 tag 消失。
- Feishu-bound 桌面 Tab 点击“新对话”时，当前 Tab 切到继承 Feishu 绑定的新 session；旧 session 冻结为普通 owned session。
- Feishu-bound 桌面 Tab 内做不兼容 Provider/runtime 切换并确认 fork 时，新 session 在新 Tab 打开，继承 Feishu 绑定并使用目标配置；旧 session 保持原历史和原配置并冻结为普通 owned session。

### Phase 3：snapshot write fail-closed

修改：

- `sessionClient.updateSession`：保留 404 语义，但让调用方区分 `not-found` 与 success-null；
- `patchSnapshot`：pending 或 404 不能被当成功；
- `persistInputOptionChange`：加入 `snapshotWriteMode`，required 失败直接返回错误，不继续 project/agent patch。

兼容：

- Launcher template-only 改动走 `optional` 或不传 snapshot；
- pure IM live-follow 走 `disabled`；
- desktop Chat 显式改动走 `required`；
- `im-live-held` 显式改动若可原地自然延续，先走 required snapshot PATCH 完成 promote；成功后只做 Agent/Project template sync，不再重复写同一 snapshot patch。若不可原地延续，确认后走 IM binding transfer/fork。任一失败时不写 Agent/Project。

### Phase 4：恢复路径权威化

修改 server：

- `initializeAgent` 对 `initialSessionId && initMeta` 时，使用 session authority；
- owned session 无条件 `configSetProviderEnv(resolved.providerEnv)`、`configSetModel(resolved.model)`、`setPermissionPlanState(...)`、`configSetReasoningEffort(...)`；
- 不再用 `!configState.currentModel` 阻止 owned snapshot 覆盖；
- `switchToSession` 保持同样规则；
- external runtime restore 走 existing owner API，不在 route 层分支。

修改 renderer：

- real history session 在 `sessionMeta` 未加载前，自动 model-push 不运行；
- owned session local state 只从 snapshot seed；
- legacy/partial 使用明确 UI 状态，不自动写回。

验收：

- boot banner 的 `resume=true model=...` 与 session snapshot 一致；
- provider/model 不合法配对不再由打开动作产生；
- 权限重开后不从 `fullAgency` 变 `auto/plan`。
- 同一 Node sidecar 曾经持有 DeepSeek live state 后，再 initialize/resume 一个 SensNova owned session，boot banner、`/api/session/config`、下一轮 `query()` env 都必须变成 SensNova snapshot，即使旧 `configState.currentModel/currentProviderEnv` 非空。

### Phase 5：legacy / partial 诊断和 lazy migration

实现：

- 打开 real desktop session 时，如果 authority 是 `legacy-desktop` 或 `owned partial`，记录 diagnostic log；
- 用户首次显式改 config 时，写完整 snapshot；
- 可安全推断的字段自动补齐；
- 不可推断时不猜，保留提示或 developer diagnostic。

建议加入内部脚本：

```text
scripts/session-config-doctor.ts
```

输出 JSON/Markdown report，默认 dry-run，带 `--fix-safe` 才修。

### Phase 6：回归测试与 dogfood

新增测试：

1. pending session config change materializes real session before snapshot patch。
2. pending snapshot PATCH 不会静默继续写 Agent/Project。
3. pending id + `sidecarConfigDisposition='push'` 仍走 materialize。
4. required snapshot 404/500 不调用 Project/Agent patch，也不调用 MCP/plugin/runtime sidecar push。
5. real history open 在 `sessionMeta=null` 且 disposition 已为 `push` 时不触发 mount-time `/api/model/set`；snapshot loaded 后只推 snapshot model。
6. owned partial 不做 `session ?? agent` 自动写回。
7. pure IM session 的 snapshot patch guard 仍然生效。
8. external runtime model/permission restore 不被 builtin Agent default 污染；pending external materialize 不丢 `runtimeSessionId`。
9. provider/model pair mismatch 不会由 restore 产生。
10. providerId 变更原子清 `providerEnvJson`，包括 pending materialize 和普通 snapshot patch。
11. 配置型空 session 重启后能恢复配置、能删除、不会被当作有消息会话统计，也不会在首次发送前触发 provider history boundary 弹窗。
12. IM live-held：Feishu session 被桌面 Tab 打开为 A 后，另一个 Tab 把 Agent 默认改成 B；原 Tab 和手机 Feishu 后续同 session 消息都继续用 A。
13. 关闭未手动改配置的 held IM Tab 后，Feishu 主 session 恢复 live-follow；下一条 IM 消息用当前 Agent 默认 B。
14. held IM Tab 内手动改配置会 promote 为 owned；后续桌面和 IM 同 session turn 都用 snapshot，不再跟随 Agent 默认。
15. Feishu `/new` 会创建新的 IM 主 session 并使用当前 live 默认；旧 session 失去 Feishu tag/owner 并有完整 snapshot。若旧 session 正在桌面 Tab 打开，Tab 仍停在原 session，只是 tag 消失。
16. Feishu-bound 桌面 Tab 点击“新对话”会迁移 Feishu 绑定到新空 session；旧 session 冻结为普通 owned session。
17. Feishu-bound 桌面 Tab 内触发不兼容 Provider/runtime 切换并确认 fork 时，新 session 继承 Feishu 绑定并使用目标配置；旧 session 不被原地改写。
18. 关闭 held Tab 时若同一个 IM turn 正在运行，该 turn 继续使用 held config；hold 释放只影响下一 turn。
19. 桌面重复打开同一 session 会聚焦已有 Tab，不创建第二个同 session Tab。

真机 dogfood：

- 在 v0.2.38 数据上复制一份 `~/.myagents`；
- 打开用户类似场景：
  - 空 session A 改 provider/model/permission；
  - 空 session B 改另一个 provider/model/permission；
  - 关闭重开；
  - 打开历史 owned session；
  - 切 provider 触发安全边界；
  - IM session 打开为 Tab；
- 检查 unified log：
  - `[boot] resume=true model=...`；
  - `resolveWorkspaceConfig` source；
  - `PATCH /sessions/:id`；
  - materialize event；
  - no `im-sync` broadening。

## 8. 验收标准

1. #395：会话权限设置为 `fullAgency` 后，切 Tab、关闭重启、重新打开历史会话，仍为 `fullAgency`。
2. #396：`resume=true` boot banner 的 model 与该 session snapshot 一致，不统一变 DeepSeek。
3. 用户复现路径：两个空 session 分别改 A/B 后，关闭重开不会互相污染。
4. 对已有历史会话，只要 metadata 有正确 snapshot，打开动作不会改写 `sessions.json`。
5. 对 pending session，任何配置改动前都会生成真实 session id；`PATCH pending-...` 不再出现静默成功。
6. provider/model pair 不会出现 `provider=sensenova` + `model=deepseek-v4-flash` 这类由打开动作制造的不合法组合。
7. provider/runtime history boundary 弹窗只在目标变更不能原地自然延续、必须 fork/new session 时出现；用户确认后旧 session 保持不变，新 session 使用目标配置。不因 UI 漂移后的“切回原模型”出现。若当前 Tab 是 Feishu-bound，新 session 必须继承 Feishu 绑定。
8. pure IM session 在无 Tab owner 时仍 live-follow；`im-live-held` 在 Tab owner 存在期间保持 held config；IM router 的 `/api/session/permission-mode` 对 snapshotted session 仍被 guard 拦截。
9. materialize 中 `upgradeSessionId` / commit / TabProvider adopt 任一失败都不会更新 UI 到 real id，不会继续写 Agent/Project，不会留下两个 session id 指向同一 sidecar。
10. providerId 变更必定清空旧 `providerEnvJson`；不会出现新 providerId 配旧 baseUrl/API key。
11. 配置型空 session 重启后能恢复配置、能删除、不会被计为有消息会话，也不会在首次发送前触发 provider history boundary 弹窗。
12. held IM Tab 关闭前，另一个 Tab 对 Agent 默认模型/权限/runtime 的修改不影响该 session；关闭后 Feishu 主 session 恢复 live-follow。
13. held IM Tab 内显式改模型/权限/runtime 后，如可原地自然延续，该 session 变 owned；如不可原地延续，确认后 fork 出继承 Feishu 绑定的新 session，旧 session 保持原配置。
14. Feishu `/new` 时，旧 session 丢失 Feishu tag/owner、不跳模型，并以 detach 当下有效配置写完整 snapshot；如果旧 session 有桌面 Tab，Tab 仍停在旧 session。
15. Feishu-bound 桌面 Tab 点击“新对话”与不兼容切换 fork 都会迁移 Feishu 绑定到新 session；前者当前 Tab 切到新 session，后者新 Tab 打开。
16. held Tab 关闭时如果当前 IM turn 正在运行，该 turn 继续使用 held config；下一 turn 才按释放后的 live-follow/snapshot 规则 resolve。
17. `npm run typecheck && npm run lint && npm run test:unit && npm run test:dom` 通过。

## 9. 兼容性与代价

### 9.1 用户可见变化

- 空会话里只要改了模型/Provider/权限，就会生成真实 session，历史列表可能出现“还没发消息但有配置”的会话。
- 这是正确代价：用户已经表达了“这个会话”的配置 intent。后续可用“空且无消息且无用户内容”的清理策略优化。
- 这类“配置型空 session”必须可删除、可恢复配置，但不应被消息统计当作已有对话，也不应因为空历史触发 provider history boundary 弹窗。

### 9.2 历史数据

- 完整 snapshot 的历史会话不应改变。
- legacy/no snapshot 会话会在首次显式配置改动时被锁定。
- 已经被 v0.2.38 打开的污染 session 不一定能自动还原；只能基于 transcript/provider catalog 做 safe repair。
- 自动修复前必须备份 `sessions.json`。

### 9.3 IM / Cron

- pure IM live-follow 保持：没有桌面 Tab owner 时，Agent/Channel 默认配置变化会影响下一次 IM turn。
- 桌面 Tab 打开 IM 主 session 时进入运行态 `im-live-held`，该 session 在 Tab owner 存在期间不跟随其它 Tab 对 Agent 默认值的修改；这会让桌面正在查看的 session 和手机 IM 同 session 对话保持一致。
- 关闭未手动改配置的 held Tab 后，hold 消失；如果该 session 仍是 IM 主 session，后续 IM turn 恢复 live-follow 当前 Agent/Channel 默认。若关闭时已有 IM turn 在跑，本 turn 继续使用 held config，下一 turn 才重新 resolve。
- held Tab 内手动改配置会 promote 为 owned；这是用户明确要改变该 session 的 intent，后续 IM turn 也按 snapshot。
- IM `/new` 是渠道绑定迁移：新主 session 使用当前 live 默认；旧 session 失去 IM tag/owner，并以 detach 当下有效配置写 snapshot 变普通 owned session。若旧 session 正在桌面 Tab 打开，该 Tab 仍停留原 session，只是 tag 消失。
- Feishu-bound 桌面 Tab 上点击“新对话”保持现有行为：当前 Tab 切到新的 Feishu 主 session，旧 session 冻结为普通 owned session。
- Feishu-bound 桌面 Tab 内做不兼容 Provider/runtime 切换时，确认 fork 后新 session 在新 Tab 打开，继承 Feishu 绑定并使用目标配置，旧 session 不原地改写。
- Cron current_session 如果有 owned snapshot，继续 snapshot wins；new_task 每 tick 用 Agent 当前默认创建新 snapshot。
- 不放宽 `im-sync`，不让 IM router 直接写桌面 snapshot；IM 绑定迁移和 IM-held 只通过 owner policy + transfer/promote 事务处理。

### 9.4 外部 runtime

- 外部 runtime 不涉及 provider，但涉及 model/permission/reasoningEffort。
- 新 config endpoint 必须走 `SessionEngine`，不要在 route 写 `shouldUseExternalRuntime()` 分支。
- external owner state 在 `src/server/runtimes/external-session/*`，不要把状态写回 facade。
- pending materialize 必须处理 external runtime 的 pending birth / runtime thread binding / `runtimeSessionId`。Codex/Gemini 可能已经有 prewarm thread，不能在 pending -> real 时丢失或复活错误 thread。

### 9.5 工程成本

成本中等，风险中等：

- 涉及 renderer Chat/App/TabProvider、server SessionEngine/agent-session/external-session、SessionStore/Rust upgrade id 链路；
- 需要较多测试；
- 但修复方向是移除错位，而不是新增概念。materialize endpoint 是把 pending 这个已经存在的占位显式收口成 real session，不是新状态管理体系。

## 10. 关键设计决策

### D1：不修 `im-sync`，而是修 Desktop session ownership

`im-sync` guard 是安全边界。放行它会让 IM 覆盖 desktop snapshot。#395/#396 的 root cause 是 Desktop/pending/restore 所有权错位，不能用 IM endpoint 做补丁。

### D2：pending 配置改动必须 materialize

pending 不是 session。所有当前会话级配置都必须落到真实 SessionMetadata。吞掉 `PATCH pending-...` 404 再写 Agent/Project，是本 bug 的核心污染路径。

### D3：owned session 缺字段不是 live-follow 许可

对 pure IM 来说 `session ?? agent` 是 live-follow；对 Desktop owned session 来说，缺字段只能解释为“使用 runtime/provider 稳定默认值”或“进入 legacy/partial diagnostic”，不能解释为“继续跟随 Agent 当前默认值”。两者不能共用同一 fallback 语义。

### D4：自动 effect 不代表用户 intent

mount-time model-push、project-sync、model-heal 都不得改变历史 session。只有用户显式 picker 操作才能改变当前 session snapshot。

### D5：修复不猜历史，只停止继续污染

已经被改坏的 session 无法总是从代码里推回原始 provider/model/permission。能从 transcript 和 provider catalog 精确推断就修；不能推断就给诊断，不做自信但错误的自动恢复。

### D6：IM Tab hold 是 owner 生命周期状态，不是持久锁

IM 主 session 无 Tab owner 时 live-follow；桌面 Tab 打开它后临时 hold 当前配置；关闭 Tab 后释放 hold。这个状态本身不写 snapshot，但一旦 IM 绑定迁移、`/new`、桌面新对话或不兼容切换 fork 让旧 session 失去 IM owner，它就必须以当下有效配置冻结成普通 owned session。这样既避免“正在看的 Tab 被其它 Tab 的默认值修改带着跳”，也保证脱离 IM 绑定后的历史 session 有自己的配置快照。

### D7：安全弹窗只服务 fork/new session，不服务原地修复

如果目标变更可以在当前 session 自然延续，就不需要弹窗，直接按 session authority 写入。只有 runtime 切换、不可兼容 Provider 切换等不能在同一 session 内安全延续的场景才弹窗。用户确认后创建新 session / 新 Tab，旧 session 完全保持原配置和历史，不在原地改写。若旧 session 是 Feishu-bound，Feishu 绑定迁移到新 session；旧 session 冻结为普通 owned 历史。

## 11. 开放问题

1. 空且无消息但已有配置的 session 是否展示在历史列表？建议先展示，后续再做清理策略。
2. `owned partial` 的 UI 是否需要明显提示用户“该历史会话来自旧版本，部分配置无法确认”？建议先用 log + developer diagnostic，避免打扰大多数用户。
3. `session-config-doctor` 是否纳入 release，还是只做开发者脚本？建议先开发者脚本。

## 12. Sub-agent Review

### 12.1 对抗性场景审查（Nash）— 已采纳

审查结论：PRD 覆盖 #395/#396 主因，但第一版对 pending materialize、providerEnvJson、required snapshot fail-closed、external pending birth、legacy repair 的约束不够硬。

已按审查意见补入：

1. **Materialize 不允许半升级**：补入两阶段 prepare / Rust upgrade / commit / rollback 协议，要求 `upgradeSessionId`、commit、TabProvider adopt 任一失败都 fail-closed，不更新 UI 到 real id，不写 Agent/Project，不 live-push sidecar。
2. **pending id 优先于 disposition**：补入强约束，`isPendingSessionId(sessionId)` 高于 `sidecarConfigDisposition`。新空会话常见形态是 pending id + disposition `push`，不能只按 disposition 判断。
3. **providerId 变更原子清 `providerEnvJson`**：补入 request schema 与验收，防止新 providerId 复用旧 baseUrl/API key。
4. **resolver 必须 authority-aware**：补入 `resolveWorkspaceConfig` 不能对 `owned partial` 返回 Agent fallback 当作完整 snapshot 的要求。
5. **mount-time `/api/model/set` race**：补入 real history session 在 `sessionMeta=null` 即使 disposition 已 `push` 也不得推 Agent default 的验收。
6. **required snapshot fail-closed**：补入 snapshot 失败时阻断 Project/Agent/MCP/plugin/runtime push 的硬要求。
7. **历史污染修复不猜测**：补入 provider catalog 唯一性不足的限制；permissionMode 不能从 transcript 自动还原。
8. **legacy 打开不写**：修正“打开时 lazy migrate”为“打开只诊断；用户显式改动或有确证才写”。
9. **external pending birth**：补入 Codex/Gemini pending materialize 必须迁移/清理 runtime thread binding 与 `runtimeSessionId`。
10. **配置型空 session**：补入可恢复、可删除、不计消息、不触发 provider boundary 的验收。

### 12.2 架构审查（Harvey/Faraday/Wegener/Ptolemy）— 已采纳

代码级 cross-review 已覆盖 `ARCHITECTURE.md`、SessionEngine facade、builtin/external owner 边界、IM live-follow 语义和 Rust handover 事务。审查指出的约束已并入本 PRD 与实现：

1. `im-live-held` 必须落在现有 Sidecar owner 生命周期内；held config 是运行态 owner 状态，不新增持久 lock 表。
2. 可原地延续的 IM-held promote 走 desktop required snapshot PATCH；binding transfer 走 Rust IM handover 事务；不得由 renderer 分别 PATCH 两个 session 伪造迁移。
3. session-engine route 不手写 builtin/external 分支；freeze-current、held IM config snapshot、external metadataBirthPending 通过 SessionEngine facade 承载。
4. `im-sync` 仍只代表 IM router 同步写入；不能覆盖 owned snapshot。server PATCH 不能再按 IM source 吞掉 desktop snapshot 字段。
5. `/new` / handover 必须先冻结旧 session，再移动 IM tag/owner；freeze 失败时不移动 binding、不更新 Agent/Project。
6. pending materialize 的 prepared marker 清除必须 durable；重复 prepare 必须合并新 patch；external runtime 必须保留 `runtimeSessionId` / pending birth 语义。

## 附录 A：排查命令

```bash
rg -n "persistTabConfigChange|patchSnapshot|shouldSkipSnapshotWrite|sessionMeta.*currentAgent|/api/model/set" src/renderer/pages/Chat.tsx
rg -n "resolveWorkspaceConfig|initializeAgent|switchToSession|setSessionPermissionMode|setSessionModel" src/server/agent-session.ts src/server/utils/admin-config.ts
rg -n "createPendingSessionId|upgradeSessionId|adoptMigratedSession|onSessionIdChange" src/renderer src-tauri/src
rg -n "shouldDropSnapshotPatchOnImSession|configSnapshotAt|providerEnvJson" src/server
```

## 附录 B：相关历史 PRD/issue

- `specs/prd/prd_0.1.69_session_config_snapshot.md`
- `specs/prd/prd_0.2.31_instant_history_disposition_fix.md`
- GitHub #395：会话权限模式切换 Tab 或重开后自动回退
- GitHub #396：小助理自检补充，resume=true 历史会话模型统一 DeepSeek / sessions.json 被改写
- #300 / #301：provider/model reset 与 sidecar-config-disposition config-stomp 类问题
- #305：in-Tab model/permission change lost after close+reopen
- #327：IM config sync 不得覆盖 snapshotted desktop session
