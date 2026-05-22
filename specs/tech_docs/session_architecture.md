# Session 架构

> Session 的标识、存储、状态同步机制。Sidecar Owner 模型、Session 切换四场景见 `ARCHITECTURE.md` 的核心抽象与模块地图。

## Session ID

每个 Session 由一个 UUID v4 标识，作为消息存储、前端展示、SDK 上下文恢复的统一 key。SDK 通过 `query({ sessionId })` 接收并使用此 UUID 作为它内部的 session_id，两端 ID 始终一致。

### 数据结构

```typescript
interface SessionMetadata {
    id: string;                 // UUID v4
    agentDir: string;           // 工作区路径
    title: string;
    createdAt: string;
    lastActiveAt: string;
    sdkSessionId?: string;      // SDK session_id（统一架构下 === id）
    unifiedSession?: boolean;   // true = 当前架构创建
    stats?: SessionStats;
    cronTaskId?: string;
    runtime?: RuntimeType;      // 'builtin' | 'claude-code' | 'codex' | 'gemini'
    // 分层 config snapshot 字段（owned session 冻结）
    model?: string;
    permissionMode?: PermissionMode;
    mcpEnabledServers?: string[];
    providerId?: string;
    providerEnvJson?: string;
}

interface SessionStats {
    messageCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens?: number;
    totalCacheCreationTokens?: number;
}
```

### Session ID 前缀约定

| 前缀 | 格式 | 用途 | 何时生成 |
|------|------|------|---------|
| 无 | UUID v4 | 标准 session | `createSessionMetadata()` / 首条消息 |
| `pending-` | `pending-{tabId}` | 新 Tab 占位符 | Tab 创建时，等待首条消息产生真实 UUID |
| `cron-standalone-` | `cron-standalone-{uuid}` | 独立定时任务 | 创建不绑定 Tab 的定时任务 |

### SDK `sessionId` 与 `resume` 互斥

SDK 约束：`sessionId` 和 `resume` 参数不能同时传递。

```typescript
querySession = query({
    prompt: messageGenerator(),
    options: {
        // 新 session：传 sessionId 让 SDK 使用我们的 UUID
        // 历史 session：传 resume 恢复对话上下文
        ...(resumeFrom
            ? { resume: resumeFrom }
            : { sessionId: sessionId }
        ),
        // 可选：rewind 截断点（与 resume 配合）
        ...(rewindResumeAt
            ? { resumeSessionAt: rewindResumeAt }
            : {}
        ),
    }
});
```

### Resume 的真正用途

持久 Session 架构下（`messageGenerator()` 全程 `while(true)` yield），`resume` 不是每轮对话的机制，仅用于：

| 场景 | 说明 |
|------|------|
| 恢复历史 session | 用户从历史记录切换到旧 session |
| Rewind 后截断历史 | `resumeSessionAt` 截断 SDK 消息树 |
| Subprocess crash 恢复 | `finally` 块触发 `schedulePreWarm()` 重建 session |
| 配置变更重启 | MCP / Agent 变更导致 session 中止后恢复 |

### `sessionRegistered` 状态

```typescript
let sessionRegistered = false;
```

- `true` —— SDK 已持久化此 session，后续只能用 `resume` 访问
- `false` —— SDK 未注册，可以用 `sessionId` 创建新 session

system-init 事件中验证 SDK 确认使用了我们的 UUID：
```typescript
if (nextSystemInit.session_id) {
    const isUnified = nextSystemInit.session_id === sessionId;
    sessionRegistered = true;
    updateSessionMetadata(sessionId, {
        sdkSessionId: nextSystemInit.session_id,
        unifiedSession: isUnified,
    });
}
```

### sdkUuid 追踪

每条 assistant / user 消息存 SDK 分配的 UUID，用于 `rewindFiles()` 和 `resumeSessionAt` 截断。

**关键规则**：assistant 的 `sdkUuid` 必须存储**最后一条**消息（text）的 UUID，而非第一条（thinking）。SDK 对一轮 assistant 回复输出多条 `type=assistant` 消息——先 thinking（UUID "A"），再 text（UUID "B"）。`resumeSessionAt` 保留指定 UUID 及之前的所有消息，若使用 thinking UUID 会丢失 text 部分。

```typescript
// 每次 type=assistant 都更新，确保最终值是最后一条（text）的 UUID
if (sdkMessage.uuid) {
    currentAssistant.sdkUuid = sdkMessage.uuid;
}
```

### currentSessionUuids 新鲜度追踪

每个 Sidecar 进程维护 `currentSessionUuids: Set<string>`，记录当前 SDK session 分配的所有消息 UUID。

| 操作 | 时机 |
|------|------|
| 清空 | 非 resume 的新 session 启动时 |
| 从磁盘 seed | `switchToSession` / `loadMessagesFromStorage` 时 |
| 追加 | SDK 返回 assistant / user 消息时 |
| 校验 | rewind / fork 时判断 UUID 是否属于当前 session |

**新鲜度规则**：若 `lastAssistantUuid ∉ currentSessionUuids`（旧 UUID，来自其他 session），rewind 拒绝使用 `resumeSessionAt`，改为新建 session。

### awaitSessionTermination 超时防护

所有等待 session 终止的操作通过 `awaitSessionTermination(10_000, label)` 执行，带 10 秒超时。超时后强制清理状态（`querySession = null`、`isProcessing = false`、`isStreamingMessage = false`），防止死锁。

调用场景：`resetSession`、`switchToSession`、`rewindSession`、`enqueueUserMessage`（provider change）、`startStreamingSession`、`forceAbortCurrentTurnAndRecover`。

---

## 存储

### 目录结构

```
~/.myagents/
├── sessions.json          # 会话索引（SessionMetadata 数组）
├── sessions.lock/         # 文件锁（目录，非文件）
├── sessions/
│   ├── {session-id}.jsonl # 消息数据（JSONL 格式）
│   └── ...
└── attachments/
    └── {session-id}/      # 附件文件
```

### JSONL 选型理由

| 特性 | JSON | JSONL |
|------|------|-------|
| 追加消息 | O(n) 全文件重写 | O(1) 追加一行 |
| 崩溃恢复 | 文件可能损坏 | 最多丢失最后一行 |
| 并发写入 | 需要文件锁 | 追加通常是原子的 |
| 部分读取 | 需要解析整个文件 | 可以逐行读取 |

### SessionMessage 格式

```typescript
interface SessionMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;          // JSON 字符串或纯文本
    timestamp: string;
    attachments?: MessageAttachment[];
    usage?: MessageUsage;     // 仅 assistant 消息
    toolCount?: number;
    durationMs?: number;
}
```

### 性能优化

**行数缓存**：避免每次保存消息都读取整个 JSONL 文件计数。`lineCountCache: Map<sessionId, count>` 冷启动时读文件，追加时增量更新。

**增量统计**：只计算新增消息的 token 用量，而非全量重算。统计更新在文件锁内执行避免 TOCTOU：
```typescript
const newMessages = messages.slice(existingCount);
if (newMessages.length > 0) {
    appendFileSync(filePath, linesToAppend);  // JSONL 不需要锁，每个 session 文件单写者
    const incrementalStats = calculateSessionStats(newMessages);
    withSessionsLock(() => {
        // sessions.json 在锁内 read-modify-write
    });
}
```

**文件锁**：`sessions.json` 多 Sidecar 共享需锁。MyAgents 走 `withFileLock` / `with_file_lock`（详见 `pit_of_success.md` 的「withFileLock」节）。

### 损坏行容错

```typescript
function readMessagesFromJsonl(filePath: string): SessionMessage[] {
    const lines = content.split('\n').filter(line => line.trim());
    const messages: SessionMessage[] = [];
    for (let i = 0; i < lines.length; i++) {
        try {
            messages.push(JSON.parse(lines[i]));
        } catch {
            console.warn(`Skipping corrupted line ${i + 1}`);
        }
    }
    return messages;
}
```

### Session ID 路径穿越防御

```typescript
function isValidSessionId(sessionId: string): boolean {
    return /^[a-zA-Z0-9-]+$/.test(sessionId)
        && sessionId.length > 0
        && sessionId.length < 100;
}
```

---

## 双重存储：MyAgents 与 SDK

### 背景

Claude Agent SDK 内置了独立的 session 持久化机制（`persistSession` 选项默认 `true`）。MyAgents 调用 SDK 时，**两端各自独立写入会话数据**，形成双重存储。

### 存储位置对比

```
~/.myagents/sessions/                ← MyAgents 写入
├── {session-id}.jsonl               ← 精简业务数据

~/.claude/projects/{project-slug}/   ← SDK 自动写入
├── {sdk-session-id}.jsonl           ← SDK 内部完整格式
```

`{project-slug}` 由 `agentDir` 路径转换而来（例如 `/Users/zhihu/Documents/project/ai-max` → `-Users-zhihu-Documents-project-ai-max`）。

### 数据格式差异

**SDK JSONL**（每行包含完整元数据）：
```jsonc
// 消息链路：parentUuid 构建消息树，isSidechain 标记分支对话
{ "type": "user",      "parentUuid": "...", "isSidechain": false, "cwd": "...", "sessionId": "...", "version": "...", "gitBranch": "...", "message": {...}, "uuid": "...", "timestamp": "...", "permissionMode": "..." }
{ "type": "assistant",  "parentUuid": "...", "isSidechain": false, "cwd": "...", "sessionId": "...", "version": "...", "gitBranch": "...", "message": {...}, "requestId": "...", "uuid": "...", "timestamp": "..." }
// 操作记录
{ "type": "queue-operation", "operation": "...", "timestamp": "...", "sessionId": "..." }
```

**MyAgents JSONL**（精简业务数据）：
```jsonc
{ "id": "...", "role": "user",      "content": "...", "timestamp": "..." }
{ "id": "...", "role": "assistant",  "content": "...", "timestamp": "...", "usage": {...}, "toolCount": 3, "durationMs": 4200 }
```

### 为什么不能禁用 SDK 持久化

设置 `persistSession: false` 会导致两个关键功能失效：

1. **Session Resume**：配置变更（Provider / Model / MCP / Agent）时通过 `resumeSessionId` 恢复对话上下文，SDK resume 机制依赖其自身 JSONL 文件中的消息树（`parentUuid` 链）来重建完整的会话状态。
2. **`/insights` 报告**：SDK 内置命令，扫描 `~/.claude/projects/` 下的 session 数据生成使用分析报告，禁用后无数据源。

### 为什么不能去掉 MyAgents 存储

MyAgents 自身的存储服务于不同的业务场景：

1. **会话列表与历史浏览**：前端通过 `sessions.json` 索引和 `{id}.jsonl` 加载历史消息
2. **业务指标**：`usage`、`toolCount`、`durationMs` 等 SDK 不记录的数据
3. **统一索引**：`sessions.json` 提供全局会话元数据（标题、创建时间、统计摘要），无需遍历文件系统

### 架构决策

**保留双重存储，各司其职。** 两份数据的格式、用途、消费者完全不同：

| 维度 | SDK 存储 | MyAgents 存储 |
|------|----------|---------------|
| 写入者 | SDK 内部自动写入 | MyAgents `agent-session.ts` |
| 读取者 | SDK resume / `/insights` | MyAgents 前端 UI |
| 格式 | 消息树 + 操作记录 | 扁平消息列表 + 业务指标 |
| 索引 | 无（按文件遍历） | `sessions.json` 全局索引 |
| 生命周期 | 跟随 SDK 项目目录 | 跟随 MyAgents 数据目录 |

体积参考：SDK 存储约 1.7× MyAgents 存储（SDK 携带完整上下文元数据 + queue-operation 内部记录）。可定期清理过期的 SDK session 数据（例如 >30 天的已关闭 session）。

---

## 状态同步与新会话机制

### SSE 断连 **不是** 取消权威（load-bearing 不变量）

关 Tab / 网络波动导致 `/chat/stream` 断连，**绝不能**用来取消进行中的 turn。turn 的生命周期归 Rust 的 **Sidecar Owner 模型**（Tab / CronTask / BackgroundCompletion / Agent 四种 owner），不归前端 SSE 连接：

- 零 client 时的 `broadcast()` 是 no-op，turn 照常在 sidecar 跑完并持久化；重连后由 `chat:message-replay` 补发。
- 真正卡死的 turn 由 10 分钟 inactivity watchdog 收口（见 `agent-session.ts` / `external-session.ts`，原语 `utils/inactivity-watchdog.ts`）。
- 用户主动放弃用 **Stop**（`interruptCurrentResponse`），不是关 Tab。

历史教训：`390d38ee`（4-25）曾给 `/chat/stream` 加 last-consumer grace interrupt，把"关 Tab"误当"杀 turn"，regress 了 BackgroundCompletion 与 cron/session-send（turn 被 interrupt → `[ERROR turn_failed]` 投回飞书）。最终修法是**彻底删除该 interrupt**；`index.ts` 留有 load-bearing 注释禁止复活。改 SSE 断连相关逻辑前 MUST 理解这条。

### 问题场景

```
1. 用户正在对话，messages = [msg1, msg2, msg3]
2. 用户点击「新对话」→ 前端清空 messages = []
3. SSE 连接断开（网络波动、超时等）
4. SSE 重连 → 后端发送 chat:message-replay 事件
5. 前端收到旧消息 → messages = [msg1, msg2, msg3]  ← BUG
```

**根因**：前后端状态不同步。前端认为是新会话，后端仍持有旧会话数据。

### 解决方案：前后端同步重置 + 防护标志

```typescript
// TabProvider.tsx
const resetSession = useCallback(async (): Promise<boolean> => {
    setMessages([]);
    seenIdsRef.current.clear();
    isNewSessionRef.current = true;            // 防护标志
    const response = await postJson('/chat/reset');
    return response.success;
}, [postJson]);
```

```typescript
// agent-session.ts
export async function resetSession(): Promise<void> {
    abortPersistentSession();                  // 中止持久 session
    messageQueue.length = 0;
    if (sessionTerminationPromise) await sessionTerminationPromise;

    clearMessageState();
    shouldAbortSession = false;
    messageResolver = null;

    sessionId = randomUUID();                  // 生成新 sessionId
    sessionRegistered = false;

    clearSessionPermissions();

    broadcast('chat:init', { ... });
    schedulePreWarm();
}
```

### 防护标志（Defense in Depth）

即使有同步重置，仍可能存在竞态。`isNewSessionRef` 作为额外防护：

```typescript
// 新会话期间，跳过所有可能带来旧数据的事件
case 'chat:init':
case 'chat:message-replay':
case 'chat:message-chunk':
case 'chat:thinking-start':
case 'chat:tool-use-start':
    if (isNewSessionRef.current) break;
    // 正常处理...
```

### 标志重置时机（关键）

`isNewSessionRef` MUST 在 **API 调用之前** 重置：

```typescript
const sendMessage = async (text) => {
    isNewSessionRef.current = false;  // ← 必须在这里！
    const response = await postJson('/chat/send', { text });
    return response.success;
};
```

**为什么不能等 API 返回后**：API 是异步的，期间后端会发 `chat:message-replay`（用户消息），如果标志还是 `true` 用户消息会被过滤丢失。

### 9 种结束场景必须重置的状态

| 变量 | 用途 |
|-----|------|
| `isLoading` | 流式输出中 |
| `sessionState` | 会话状态（`'idle'` / `'running'`） |
| `systemStatus` | 系统任务状态（如 `'compacting'`） |
| `isStreamingRef` | 内部流跟踪 |

每个场景 MUST 重置全部 4 个：

```typescript
isStreamingRef.current = false;
setIsLoading(false);
setSessionState('idle');
setSystemStatus(null);
```

| # | 场景 | 触发时机 |
|---|------|---------|
| 1 | `chat:message-complete` | AI 正常完成 |
| 2 | `chat:message-stopped` | 用户点击停止，后端确认 |
| 3 | `chat:message-error` | AI 回复出错 |
| 4 | `chat:init` 同步 | SSE 重连，后端状态为 idle |
| 5 | `chat:status` 同步 | 后端广播状态变为 idle |
| 6 | `stopResponse` 超时 | 停止请求 5s 后无 SSE 确认 |
| 7 | `stopResponse` 失败 | 停止请求网络错误 |
| 8 | `resetSession` | 用户点击「新对话」 |
| 9 | `loadSession` | 用户加载历史会话 |

---

## 相关文件

| 文件 | 职责 |
|------|------|
| `src/server/types/session.ts` | `SessionMetadata` 类型定义、`createSessionMetadata()` |
| `src/server/SessionStore.ts` | 存储层实现 |
| `src/server/agent-session.ts` | Session 管理与消息持久化、`switchToSession()`、system-init 处理 |
| `src/renderer/api/sessionClient.ts` | 前端 API 客户端 |
| `src/renderer/utils/formatTokens.ts` | Token / 时长格式化工具 |
| `src/renderer/context/TabProvider.tsx` | 前端 reset / 防护标志 |

## 相关文档

- `ARCHITECTURE.md` 的核心抽象「Sidecar Owner 模型」「持久 Session」「Pre-warm 机制」
- `ARCHITECTURE.md` 的模块「Session 切换与持久化」（四场景 + 分层 config snapshot）
- `pit_of_success.md` 的「withFileLock」「Snapshot Helpers」
- `multi_agent_runtime.md` 的「External Session Handler」（外部 Runtime 的会话生命周期）
