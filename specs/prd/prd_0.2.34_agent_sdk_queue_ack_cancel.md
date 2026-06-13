---
type: prd
status: draft
created: 2026-06-13
updated: 2026-06-13
scope: "修正 builtin AgentSDK mid-turn 排队语义：用户气泡上屏必须代表 SDK 已确认消费；排队第 1 位在 SDK dequeue 前也应可取消。移除 turn-end fallback 的假确认，改用 SDKUserMessageReplay / assistant-start confirmation / cancel_async_message 作为真实边界。"
issue: "用户反馈：工具调用完成后，排队内容显示已发送，但模型没有收到。排查确认 builtin runtime 存在 no-replay fallback 上屏路径。"
review: "落地前已做双视角根因分析：主线排查 + codex read-only 独立分析一致确认根因是 local queue / SDK commandQueue / model-context inclusion 状态边界混淆。"
---

# PRD 0.2.34 — AgentSDK 排队确认与可取消边界

> 执行须知：本 PRD 触及 builtin Claude Agent SDK、持久 session、SSE 队列事件和前端排队 UI。实现前 MUST 读取 `specs/ARCHITECTURE.md`、`specs/tech_docs/session_architecture.md`、`specs/tech_docs/multi_agent_runtime.md`，并核对本地 `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` / 打包 JS 的真实接口。不要凭旧注释假设 SDK 没有取消能力。

## 1. 背景

用户在 AI 正在执行工具时发送新消息，MyAgents 会把这条消息放入排队区。现有 builtin runtime 为了支持 mid-turn injection，会把第一条排队消息提前 yield 给 Claude Agent SDK，让 CLI 在合适的 tool break 或 turn boundary drain 它。

用户反馈的异常是：

> 排队内容发出去了，甚至已经上屏成用户气泡，但 AI 没有看见这条内容。

这不是纯前端错觉。排查确认：后端确实存在一条没有 SDK 消费确认也广播 `queue:started` 的路径。

## 2. 现状链路

### 2.1 正确路径：SDK replay 确认

当 SDK/CLI 从 commandQueue drain 了 MyAgents yield 的 queued message，会发回：

```ts
SDKUserMessageReplay {
  type: 'user',
  isReplay: true,
  uuid: queueId,
  shouldQuery?: boolean
}
```

`agent-session.ts::handleQueuedCommandReplay()` 收到 matching `uuid === inFlightToCliId` 后：

1. 把 user message push 到 `messages[]`
2. 写入 MyAgents JSONL
3. 广播 `queue:started`
4. 前端把 queue pill 变成正式用户气泡
5. 清空 in-flight slot，promote 下一条 pending queue

这条路径语义正确：`queue:started` 代表 SDK 已经确认消费该 queued message。

### 2.2 错误路径：turn-end fallback 假确认

`agent-session.ts::handleMessageComplete()` 当前逻辑：

```text
当前 turn result 到达
且 inFlightToCliId !== null
且不是普通 stop
=> decideInFlightActionOnResult(...)=surface
=> push user message
=> broadcast queue:started
=> 清空 in-flight slot
```

这条路径没有收到 `SDKUserMessageReplay`。它只是假设：

```text
上一轮完成 + queued item 已交给 SDK = SDK 会处理它 / 模型会看见它
```

这个等式不成立。SDK stdin 写入、CLI commandQueue pending、SDK dequeue/replay、模型上下文包含，是四个不同状态。当前代码把它们折叠成一个 `queue:started`，导致 UI 可能显示一个未被模型消费的用户气泡。

本地日志已出现真实样本：

```text
Message queued mid-turn ... queueId=cf721388...
In-flight queue item cf721388... surfaced via queue:started (turn-end fallback, no mid-turn replay)
```

## 3. 根因

根因是状态边界混淆：

| 状态 | 当前代码是否区分 | 正确语义 |
|------|----------------|----------|
| MyAgents 本地 queued | 是 | 可取消 |
| 已 yield 给 SDK / CLI commandQueue pending | 半区分，UI 标 `isInFlight` | 仍未确认模型接收；应可尝试取消 |
| SDK 已 dequeue / replay / 开始 assistant 输出 | 是，但 fallback 绕过 | 不可取消；可正式上屏 |
| 模型开始响应该消息 | 间接通过后续 assistant stream | 正在执行 |

旧注释认为 in-flight item 不可取消，因为“SDK 没有 API 撤回”。这个前提已经过期。当前本地 SDK 0.3.173 / Claude Code 2.1.173 暴露：

```ts
/**
 * Drops a pending async user message from the command queue by uuid.
 * No-op if already dequeued for execution.
 */
subtype: 'cancel_async_message'
message_uuid: string
```

打包 JS 中也存在 `querySession.cancelAsyncMessage(uuid)`。因此第一位排队消息不是绝对不可取消，而是：

```text
SDK commandQueue pending => 可取消
SDK 已 dequeue/replay/开始 assistant 输出 => 不可取消
```

## 4. 产品目标

### 4.1 用户可感知目标

1. **上屏即可信**：正式聊天气泡只在 AI/SDK 确认接收后出现。
2. **排第 1 位也能撤回**：排队第一位如果尚未被 SDK dequeue，用户点叉号应取消成功。
3. **取消失败要诚实**：如果太晚，SDK 已经消费该消息，取消按钮消失或取消请求返回失败，不假装成功。
4. **不中断现有 mid-turn injection 优势**：如果 SDK 在工具中途 replay，消息仍然插入到正确时间点，AI 后续输出继续响应该消息。

### 4.2 工程目标

1. `queue:started` 只代表“已确认消费”，不再承载“猜测会消费”。
2. 使用 SDK 原生 `SDKUserMessageReplay`、assistant-turn start 和 `cancel_async_message` 作为边界。
3. 保持 builtin 与 external runtime 分流清晰，不把外部 runtime 的 turn-level queue 语义混进 builtin。
4. 不引入新的通信模式；继续使用已有 SSE 事件和 `/chat/queue/cancel` API。

## 5. 范围

### 5.1 本期做

1. 移除 builtin runtime 的 natural turn-end `queue:started` fallback。
2. builtin in-flight queue item 取消时调用 SDK `cancelAsyncMessage(queueId)`。
3. 取消成功后广播 `queue:cancelled` 并清空 in-flight slot，再 promote 下一条 pending。
4. 取消失败时返回明确失败，保留等待确认的状态；若 replay 或下一轮 assistant 首输出随后到达，正常上屏。
5. 前端对 `isInFlight` 的第 1 位也显示取消按钮；取消期间不乐观移除，等后端 SSE。
6. 更新旧注释、类型说明和单测，删除“SDK 无法撤回”的过期假设。

### 5.2 本期不做

1. 不重写 external runtime queue。external runtime 是 turn-level queue，本问题是 builtin SDK queued_command 路径。
2. 不新增复杂队列事件枚举。先复用 `queue:added` / `queue:started` / `queue:cancelled`，只收紧语义。
3. 不在前端新增 toast 弹窗噪音。取消失败时可以保留输入不恢复，后续如需要再统一做 queue error UI。
4. 不改 SDK 源码，不 fork SDK。
5. 不做历史会话回填修复。旧日志里已经 fallback 上屏的消息不 retroactively 修正。

## 6. 正确状态机

### 6.1 builtin queue item 生命周期

```text
local queued
  |
  | wakeGenerator / yield to SDK
  v
sdk pending async message
  |                      |
  | cancel_async_message | SDKUserMessageReplay / assistant-start
  | cancelled=true       |
  v                      v
cancelled           consumed by SDK
                        |
                        v
                  queue:started + user bubble
```

### 6.2 状态边界

| 事件/动作 | 后端状态 | 前端表现 |
|-----------|----------|----------|
| `/chat/send` while busy | 本地排队或 in-flight to SDK | 排队 pill |
| `queue:added { isInFlight:false }` | MyAgents pending | 显示取消 + 立即发送 |
| `queue:added { isInFlight:true }` | SDK commandQueue pending | 仍显示取消 + 立即发送 |
| `SDKUserMessageReplay` | SDK 已消费 | 移除 pill，上屏用户气泡 |
| result 后首个 assistant 输出 | SDK 已开始响应该 queued message | 在输出前移除 pill，上屏用户气泡 |
| `cancel_async_message=true` | SDK 未消费且已撤回 | 移除 pill，恢复输入 |
| `cancel_async_message=false` | SDK 可能已消费 | 保留 pill，等待 replay 或后续终态 |
| plain stop/error | 当前 in-flight 未确认消费 | 广播 cancelled，移除 pill |

### 6.3 `queue:started` 新语义

`queue:started` 从本期起只允许在以下场景发出：

1. 收到 matching `SDKUserMessageReplay`。
2. builtin natural `result` 后收到下一轮 assistant 首个输出，作为 SDK boundary drain 的确认信号。
3. external runtime turn-end drain 真正调用 `sendExternalMessage()` 的既有路径（外部 runtime 语义不在本期重构范围）。

builtin natural `result` 不能再直接发 `queue:started`。

## 7. 实现设计

### 7.1 SDK cancel helper

在 `agent-session.ts` 内封装 helper：

```ts
async function cancelSdkAsyncMessage(queueId: string): Promise<'cancelled' | 'not-cancelled' | 'unavailable' | 'error'>
```

要求：

- 从当前 `querySession` 读取能力。
- 优先调用运行时存在的 `cancelAsyncMessage(queueId)`。
- TypeScript 类型缺方法时用局部结构类型补齐，不改 SDK 包。
- 调用必须有短超时（5s 级别）。超时视为 `error`，不清本地 queue pill，不假装取消成功。
- 若没有 live `querySession`，返回 `unavailable`。
- catch 后返回 `error`，日志包含 queueId，但不假装取消成功。

### 7.2 `cancelQueueItem` 改为 async

当前 `cancelQueueItem(queueId)` 是同步函数。它需要改成 async：

```ts
export async function cancelQueueItem(queueId: string): Promise<QueueCancelResult>
```

三类位置：

1. `messageQueue`：本地 splice，立即成功。
2. `pendingMidTurnQueue`：本地 splice，立即成功。
3. `inFlightToCliId === queueId`：
   - 调 `cancelSdkAsyncMessage(queueId)`
   - `cancelled`：capture `inFlightMetadata.messageText`，移除 pending request，`clearInFlightSlot()`，广播 `queue:cancelled`，`promoteNextFromPending()`，返回 text
   - `not-cancelled`：返回 `not_cancelled`，不广播 cancelled，不清 slot
   - `unavailable/error`：返回结构化失败，不广播 cancelled，不清 slot

`/chat/queue/cancel` endpoint 对 builtin 分支改为 await，并按失败原因返回：

- `not_cancelled`：409，表示 SDK 已经接受/消费，不能再撤回。
- `unavailable`：503，表示当前 session 没有可用 SDK cancel 控制面。
- `error`：500，表示 SDK cancel 调用失败或超时。
- `not_found`：404，表示本地也找不到该 queue item。

### 7.3 移除 natural turn-end fallback

`handleMessageComplete()` 中：

- `forced` 分支可以继续 surface，因为用户点击“立即发送”就是要打断当前 turn，让 SDK post-abort drain 当前 in-flight item。该逻辑属于独立 force-send 语义。
- natural completion 且无 replay：不能 surface，不能 push user bubble。
- natural completion 后，如果 in-flight slot 仍存在，应保持它，等待 SDK replay 或下一轮 assistant 首输出；不能只因为 result 到达就把 `isStreamingMessage` 设回 true 来制造“新 turn 已开始”的假状态。
- assistant-start confirmation 必须有显式 `awaitingAssistantStartAckQueueId`，且只匹配某个 terminal boundary 后被保留下来的同一个 queueId。不能靠 `!isStreamingMessage && inFlightToCliId` 这种宽条件，否则 refusal fallback / replacement assistant 可能误 ACK。
- 如果 session abort / subprocess exit 发生在确认信号之前，未确认的 in-flight item 必须广播 `queue:cancelled` 并清理 pending request。不要静默 clear，也不要盲目 requeue，避免 SDK 已消费但信号丢失时重复发送。
- persist 调度必须按调用当下的 message count 做快照，避免上一轮 fire-and-forget persist 扫进下一轮刚创建、尚未写 usage 的 assistant。

需要重点检查：

- `setSessionState('idle')` 条件必须把 `inFlightToCliId !== null` 计入 busy，否则等待 replay 的 pending async message 会被误判 idle。
- `isSessionBusy()` 也应计入 `inFlightToCliId !== null` 和 `promotedItemInFlight`，避免 auto-injection / direct send 穿插。
- `promoteNextFromPending()` 只在 replay / assistant-start confirmation / cancel success / confirmed terminal drop 后调用。

### 7.4 Force-send 保持可用但收紧语义

现有 `forceExecuteQueueItem()` 对 in-flight item 设置 `forceSurfaceInFlightId`，然后 interrupt 当前 response。保留这个入口，但补充约束：

- force 的 surface 只能用于用户显式点击“立即发送”的 item。
- natural completion 不再复用 force surface 逻辑。
- force 后如果 SDK replay 先到，以 replay 为准，避免重复上屏。
- interrupt 开始时要捕获当时的 in-flight queueId。若 replay(A) 先到并 promote(B)，后续 interrupt result / stopped 属于 A，不能误 drop B；但这个 terminal boundary 可以把 B 标记为等待 assistant-start ACK，防止 SDK boundary drain B 时没有 replay 而卡住。

### 7.5 前端 UI

`QueuedMessageBubble.tsx`：

- 不再因为 `qm.isInFlight` 隐藏 X。
- tooltip 可以区分：
  - pending：`取消排队`
  - in-flight：`撤回发送`
- 不乐观删除。现有 `cancelQueuedMessage()` 已经等 HTTP 返回，SSE 再清队列，保持。

`QueuedMessageInfo` 注释更新：

- `isInFlight` 表示“已交给 SDK commandQueue，但尚未 replay 确认”。
- 它不再意味着“不可取消”，而是“取消需要走 SDK 控制面，可能失败”。

## 8. 用户体验

### 8.1 成功 cancel

1. AI 正在跑工具。
2. 用户发送消息，消息出现在排队区。
3. 该消息排第 1 位，显示取消按钮。
4. 用户点取消。
5. 若 SDK 还没 dequeue，消息从排队区消失，文本和图片恢复到输入框。
6. 聊天历史中不会出现这条消息。

### 8.2 cancel 太晚

1. 用户点取消时 SDK 已经 dequeue。
2. 后端 cancel 返回失败，不广播 `queue:cancelled`。
3. 排队 pill 暂时保留，直到 replay 或下一轮 assistant 首输出到达。
4. 确认信号到达后 pill 消失，正式用户气泡上屏。
5. 用户不会看到“取消成功但 AI 又回答了”的矛盾状态。

### 8.3 turn 结束但 SDK 没 replay

1. 上一轮 AI 完成。
2. 排队消息仍保持 pill 状态，不变成正式气泡。
3. 系统等待 SDK 的真实 replay，或下一轮 assistant 首输出这个可验证路径。
4. 用户不会再看到“消息上屏但 AI 完全没理”的假确认。

## 9. 测试计划

### 9.1 单测

1. `decideInFlightActionOnResult`
   - natural completion 不再 `surface`
   - force-send 仍 `surface`
   - plain stop 仍 `drop`
2. 新增 SDK cancel decision helper / queue cancel 纯逻辑测试
   - in-flight cancel success 清 slot + broadcast cancelled + promote next
   - in-flight cancel false 不清 slot、不 broadcast
   - replay after cancel false 仍能上屏
3. 前端 `QueuedMessageBubble`
   - `isInFlight=true` 仍渲染取消按钮
   - pending / in-flight tooltip 正确

### 9.2 静态验证

```bash
npm run typecheck
npm run lint
```

### 9.3 手工验收

1. builtin Claude Agent SDK 下，AI 执行长工具时发送新消息，确认排队第一位有取消按钮。
2. 立即点取消，若 SDK 未消费，消息消失并恢复到输入框。
3. 不取消，等待 SDK replay，消息才正式插入聊天。
4. 触发工具即将结束时发送消息，确认不会出现“turn-end fallback no mid-turn replay”后直接上屏。
5. external Codex / Gemini runtime 排队行为不回归。

## 10. 风险与回滚

| 风险 | 控制 |
|------|------|
| SDK JS 有 `cancelAsyncMessage` 但 d.ts 没声明 | 局部结构类型 + runtime capability check |
| cancel 与 replay 竞态 | replay 是最终确认；cancel success 才清 slot；cancel false 不动状态 |
| 移除 fallback 后队列 pill 卡住 | `isSessionBusy` / state transition 把 in-flight 计入 busy；session abort/exit 对未确认 in-flight 发 `queue:cancelled` |
| force-send 回归 | 保留 forced surface 单独分支；interrupt target queueId 防 replay-first 后误删下一条 |
| IM cancel 行为漂移 | `cancelImRequest` 另行扩展 in-flight requestId cancel，未知状态不假成功 |

回滚路径：恢复 `decideInFlightActionOnResult` natural surface 和前端隐藏 in-flight X。但回滚会重新打开“上屏不代表 AI 看见”的语义漏洞，只能作为临时止血。

## 11. 验收标准

1. builtin natural completion 无 replay 时不再广播 `queue:started`。
2. `queue:started` 日志和 UI 上屏只来自 SDK replay、assistant-start confirmation 或明确 force-send。
3. 排队第一位 `isInFlight=true` 时前端仍显示取消按钮。
4. 点击取消第一位时，后端调用 SDK `cancel_async_message`；成功则移除，失败则不假装成功。
5. `npm run typecheck`、`npm run lint` 通过，相关单测覆盖新状态边界。
