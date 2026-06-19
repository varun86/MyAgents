---
type: prd
status: draft
created: 2026-06-19
updated: 2026-06-19
scope: "File Patch 展示协议：前端文件变更类工具卡保持 builtin AgentSDK 当前最新样式，同时把 builtin 与 external runtime 的 Edit/Write/fileChange 数据归一到同一套前端展示语义；历史数据不迁移、读侧自动兼容，新数据写入统一 display payload。明确不做全工具展示协议、不重做 diff viewer、不改变主 SSE/REST 消息协议。"
issue: 用户需求讨论收敛（Codex runtime Edit/fileChange 展示与 builtin AgentSDK 不一致：缺少 +N/-M 摘要、raw result 泄漏 [object Object]、折叠/展开样式分叉）
review: "pending（实现前建议先做一次 scoped dual-review：重点验证新 display payload 不重复大 diff/content、不破坏历史恢复、WriteTool/EditTool 是否完全脱离 runtime-specific 字段）"
---

# File Patch 展示协议 PRD

> **执行须知（给空 session 的你）**：本 PRD 自带完整 context，不需要回翻聊天记录。
> - 每次会话只自动加载 `CLAUDE.md`；本 PRD 引用的 `specs/ARCHITECTURE.md`、`specs/DESIGN.md`、`specs/tech_docs/multi_agent_runtime.md`、`specs/tech_docs/react_stability_rules.md` 需要主动 Read。
> - 本期是一个窄切口：只正式化**文件变更类工具展示协议**，不是全工具 `ToolDisplayPayload` 大重构。
> - 代码引用给符号名，不绑定行号；实现时用 `rg` 按符号名核对当前代码，因为本项目并行改动频繁。
> - 当前分支可能已有一轮临时修复（`src/shared/fileChange.ts`、`src/renderer/components/tools/toolInput.ts`、`EditTool.tsx` 等）。本 PRD 的目标是把这条线从“兼容 helper”提升成正式、可持续的 file patch display protocol。

## 背景与产品定位

用户这次看到的问题很具体：同样是“AI 修改文件”，builtin AgentSDK 下的 Edit/Write 工具卡已经有比较顺手的折叠摘要和展开样式；切到 Codex CLI runtime 后，前端看起来像另一套东西：

- 折叠态没有 builtin 那种 `+N -M` 信息。
- 展开态 raw diff/card 观感不一致。
- Codex `fileChange` 的 result 里甚至能出现 `[object Object]: /path`。

用户的判断也很明确：**前端展示样式先对齐现在 builtin AgentSDK 的最新样式，但数据协议层要开始统一。** 也就是说，这不是要给 Codex 打一个 UI 补丁，更不是要发明 Codex 专属卡片；正确方向是把“文件变更”抽成一个跨 runtime 的前端展示语义，让 builtin 和 external runtime 都对齐到同一套 file patch 协议。

这件事的核心价值不是多显示几行 diff，而是阻止复杂度继续在前端工具卡里发散。后续 Claude Code / Codex / Gemini / builtin SDK 只要产生文件变更，都应该先变成“文件变更语义”，再交给同一套 UI 渲染。

## 已验证的技术事实

### 当前工具卡结构

- `src/renderer/components/ToolUse.tsx::renderToolBody` 按 `tool.name` 路由到 `WriteTool`、`EditTool` 等组件。
- `src/renderer/components/ProcessRow.tsx` 负责外层折叠行，调用 `getToolSummaryNode(tool)` 显示 `+N -M` 这类摘要。
- `src/renderer/components/tools/toolBadgeConfig.tsx::getToolSummaryNode` 当前已承担部分摘要逻辑。
- `src/renderer/components/tools/WriteTool.tsx` 目前主要按 builtin `parsedInput.content/file_path` 渲染。
- `src/renderer/components/tools/EditTool.tsx` 目前已经开始兼容 Codex `changes[].diff`，但仍在组件内部知道 builtin 和 Codex 的字段差异。这不是终局。

### builtin AgentSDK 路径

- `src/server/agent-session.ts::handleToolUseStart` 创建 builtin `tool_use` block，初始 `inputJson` 为空。
- `src/server/agent-session.ts::handleToolInputDelta` 逐步累积 `inputJson`，节流解析 `parsedInput`。
- `src/server/agent-session.ts::handleContentBlockStop` 在工具输入结束时最终解析 `parsedInput`。
- builtin Edit/Write 的真实语义来自 SDK 工具输入：
  - Edit：`old_string/new_string/file_path/replace_all`
  - Write：`content/file_path`

### external runtime / Codex 路径

- `src/server/runtimes/codex.ts` 把 Codex `item.type === 'fileChange'` 映射为 MyAgents `toolName: 'Edit'`。
- Codex `fileChange.changes[].kind` 在新 schema 中可以是对象，如 `{type:"update", move_path:null}`，不是字符串。
- Codex `fileChange.changes[].diff` 是当前能支撑 `+N -M` 和展开 diff 的主要语义来源。
- `src/server/runtimes/external-session.ts::PersistContentBlock.tool` 持久化 external 工具块时保留 `input`、`inputJson`、`result`、`resultMeta`，但不保证有 `parsedInput`。
- `external-session.ts` 在 `tool_use_start` 时广播 `chat:tool-use-start`，前端 live 路径会把 `tool.input` 转成 `inputJson/parsedInput`；REST 历史恢复只 parse `ContentBlock[]`，不会自动补 `parsedInput`。

### 历史恢复事实

- `src/renderer/context/TabProvider.tsx::loadSession` 从 REST `/sessions/:id` 拿历史消息，只把 `msg.content` parse 成 `ContentBlock[]` 或字符串。
- 旧历史数据里可能有：
  - builtin：`tool.inputJson` + 可能有 `parsedInput`
  - external：`tool.input` + `inputJson` + `resultMeta`，不保证 `parsedInput`
  - 更老数据：可能只剩 raw `tool.result`
- 因此不能靠迁移历史解决；必须走 **read-many, write-one**：旧数据照旧读，渲染前归一；新数据写统一展示协议。

## 本期目标

1. **视觉层对齐 builtin 当前最新样式**
   - File Patch 类工具在折叠态、展开态、路径 chip、`+N -M`、状态 badge、错误/拒绝态上复用现有 builtin 工具卡视觉语言。
   - 不做 Codex 专属卡片风格。

2. **正式化 File Patch 前端展示协议**
   - 定义一个仅覆盖文件变更类工具的 `FilePatchDisplay` 协议。
   - `EditTool` / `WriteTool` / `getToolSummaryNode` 不再直接猜 runtime-specific 字段，而是先调用 `resolveFilePatchDisplay(tool)`。

3. **builtin 与 external runtime 都对齐**
   - builtin Edit/Write 转成 file patch display。
   - Codex `fileChange` 转成 file patch display。
   - 后续 Claude Code / Gemini 若提供文件变更语义，也只需要补 adapter，不改 UI。

4. **历史兼容**
   - 旧历史不迁移、不重写。
   - 前端读侧优先读新协议；没有新协议时从 legacy 字段归一化；实在缺语义时才 fallback raw result。

## 反向边界

本期明确不做：

- 不做全局大 `ToolDisplayPayload` union 覆盖 Bash/Search/Attachments/Task 等所有工具。
- 不重做一套全新的 diff viewer。
- 不改变主 SSE/REST 消息协议主干。
- 不迁移旧 session 历史文件。
- 不把 UI 样式塞进协议；协议只表达语义，不带 CSS/className。
- 不要求 runtime adapter 丢掉原始 `input/inputJson/result`；这些仍用于模型上下文、调试和 fallback。
- 不把 NotebookEdit 纳入 v1，除非实现时确认它可以无歧义映射为文件级 patch。Notebook cell 编辑的语义不是本期必赢场景。

## 核心机制

### 1. File Patch 是“前端展示协议”，不是 runtime 原始协议

Runtime adapter 仍然可以保留各自原始字段：

- builtin SDK 仍然有 `old_string/new_string/content`。
- Codex 仍然有 `changes[].diff`、`kind`、`move_path`。
- `tool.result` 仍然保留人类可读/调试文本。

但 UI 不直接消费这些 runtime-specific 字段。UI 只消费一个 materialized 的 `FilePatchDisplay`。

推荐结构：

```ts
export type FilePatchStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'declined'
  | 'stopped'
  | string;

export type FilePatchChangeKind =
  | 'add'
  | 'update'
  | 'delete'
  | 'move'
  | 'change';

export type FilePatchView =
  | { kind: 'old-new'; oldText: string; newText: string }
  | { kind: 'content'; content: string }
  | { kind: 'unified-diff'; diff: string };

export interface FilePatchChange {
  kind: FilePatchChangeKind;
  path?: string;
  movePath?: string;
  added: number;
  removed: number;
  view: FilePatchView;
}

export interface FilePatchDisplay {
  kind: 'file_patch';
  version: 1;
  source: 'builtin' | 'codex' | 'claude-code' | 'gemini' | 'legacy';
  status?: FilePatchStatus;
  summary: {
    files: number;
    added: number;
    removed: number;
  };
  changes: FilePatchChange[];
}
```

> 命名可以微调，但核心约束不变：UI 组件只拿 `FilePatchDisplay`，不直接判断“这是 builtin old_string 还是 Codex changes diff”。

### 2. 读多写一：历史兼容，新数据单写

提供一个单一入口：

```ts
export function resolveFilePatchDisplay(tool: ToolUseSimple): FilePatchDisplay | null;
```

解析顺序：

1. **新协议**：如果 `tool.display?.kind === 'file_patch'`，直接读取并 materialize。
2. **legacy builtin**：从 `parsedInput -> inputJson -> input` 读取 `old_string/new_string/content/file_path`，归一为 `FilePatchDisplay`。
3. **legacy Codex**：从 `parsedInput -> inputJson -> input` 读取 `changes[].diff/kind/path/move_path`，归一为 `FilePatchDisplay`。
4. **status fallback**：从 `tool.resultMeta.status` 读取；没有时兼容旧 result 前缀如 `[declined]\n...`。
5. **raw fallback**：如果没有足够语义，返回 `null`，工具卡走现有 raw result 展示。

新数据写入：

- 新完成的 file patch 工具块应写入 `tool.display.kind = 'file_patch'`。
- 原始 `input/inputJson/result/resultMeta` 继续保留。
- 历史文件不做批量迁移。

### 3. 避免 display payload 重复大文本

这是本期最重要的技术约束之一。Edit/Write 的 `old_string/new_string/content/diff` 可能很大，如果 `tool.display` 再完整复制一份，会让历史 JSON、SSE、内存占用翻倍，撞上 CLAUDE.md 的大 payload 红线。

因此实现时必须二选一：

1. **推荐 v1：`tool.display` 存 compact descriptor + derived stats**
   - `tool.display` 存 `kind/version/source/status/summary/change kind/path/movePath/added/removed/view.kind`。
   - 大文本仍从现有 `tool.input/inputJson/parsedInput` materialize。
   - `resolveFilePatchDisplay` 对 UI 返回完整 `FilePatchDisplay`，但持久化层不重复大文本。

2. **若选择 self-contained display payload**
   - 必须接入已有大 payload 处理策略（例如 refs / spill），不能把多 MB diff/content 直接复制进 `tool.display`。
   - 这会扩大改动面，不推荐作为 v1。

本 PRD 推荐方案 1。它满足“新数据走新协议”：新数据有稳定 display descriptor；同时不牺牲存储和传输。

### 4. 组件职责重分配

推荐新增/整理：

- `src/shared/toolDisplay/filePatch.ts`
  - 类型定义。
  - `resolveFilePatchDisplayFromToolLike(...)` 或底层纯函数。
  - diff 行数统计、kind/movePath 归一化。

- `src/renderer/components/tools/toolInput.ts`
  - 保留或移动为 shared/renderer 工具输入解析 helper。
  - 统一 `parsedInput -> inputJson -> input`。

- `src/renderer/components/tools/FilePatchTool.tsx`
  - 只负责展示 `FilePatchDisplay`。
  - 视觉对齐当前 builtin `EditTool` / `WriteTool`：
    - 外层折叠摘要仍由 `ProcessRow` + `getToolSummaryNode` 显示。
    - 内层 header：路径 chip、`+N -M`、status badge、`replace all`。
    - 展开态：builtin Edit 的 old/new stacked 视图继续作为 `view.kind === 'old-new'` 的渲染形态；Codex diff 用统一 diff block，但 spacing/token 与 builtin 对齐。

- `EditTool.tsx` / `WriteTool.tsx`
  - 变成薄壳：调用 `resolveFilePatchDisplay(tool)`；有 display 就渲染 `FilePatchTool`；没有再走旧 fallback。
  - 目标状态是：组件里不再出现 “Codex changes diff” 或 “builtin old_string” 这种 runtime-specific 分支。

- `toolBadgeConfig.tsx::getToolSummaryNode`
  - 对 Edit/Write 先调用 `resolveFilePatchDisplay(tool)`，用 `display.summary` 生成 `+N -M` 或 `+N`。
  - 不再在 summary 函数里重复写一套 old/new/changes 解析。

## 数据模型细节

### builtin Edit

输入：

```ts
{
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}
```

归一：

```ts
{
  kind: 'file_patch',
  source: 'builtin',
  changes: [{
    kind: 'update',
    path: file_path,
    added: countLines(new_string),
    removed: countLines(old_string),
    view: { kind: 'old-new', oldText: old_string, newText: new_string }
  }]
}
```

注意：`old_string === ''` 或 `new_string === ''` 是合法纯插入/删除语义，不能用 falsy 判断。

### builtin Write

输入：

```ts
{
  file_path: string;
  content: string;
}
```

归一：

```ts
{
  kind: 'file_patch',
  source: 'builtin',
  changes: [{
    kind: 'add',
    path: file_path,
    added: countLines(content),
    removed: 0,
    view: { kind: 'content', content }
  }]
}
```

如果这是覆盖已有文件，runtime 层未必知道旧内容；展示层仍按 Write 的“写入内容”显示 `+N`，不要伪造 removed 数。

### Codex fileChange

输入：

```ts
{
  file_path?: string;
  changes: Array<{
    path?: string;
    kind?: string | { type?: string; move_path?: string | null };
    diff?: string;
  }>;
}
```

归一：

```ts
{
  kind: 'file_patch',
  source: 'codex',
  status: tool.resultMeta?.status,
  changes: changes.map(change => ({
    kind: normalizeKind(change.kind),
    path: change.path,
    movePath: normalizeMovePath(change.kind),
    added,
    removed,
    view: { kind: 'unified-diff', diff: change.diff }
  }))
}
```

diff 统计约束：

- 只有匹配 unified diff hunk header（形如 `@@ -1,2 +1,3 @@`）后，才按 `+`/`-` 统计。
- hunk 前的 `--- a/file` / `+++ b/file` 不计入。
- hunk 内的 `+--- content` / `++++ content` 是真实新增行，必须计入。
- raw add/delete 内容里出现 `@@` 不代表 unified diff，不能误判。

状态约束：

- `status === 'failed' | 'declined'` 必须在结构化 UI 中显式可见。
- 不允许因为结构化 diff 分支绕过 raw `tool.result`，导致 `[declined]` 语义消失。

## 关键设计决策

### D1：样式以 builtin 当前工具卡为准，而不是为 Codex 设计新卡

原因：用户的目标是“对齐 builtin 最新样式”，不是让 Codex 看起来更特别。统一视觉语言能降低用户切 runtime 的认知成本，也能避免以后每个 runtime 都长出自己的工具卡。

### D2：只正式化 File Patch，不做全工具 display 协议

原因：文件变更是当前痛点，且 Edit/Write/fileChange 已经暴露出跨 runtime 语义同构。Bash/Search/Task/Attachments 的展示复杂度不同，强行一次性统一会扩大风险。先把 file patch 做成正确抽象，再按痛点推广。

### D3：协议表达语义，不表达样式

`FilePatchDisplay` 只描述 kind/path/movePath/status/summary/view，不带 CSS、className、颜色。UI 仍由组件和 DESIGN token 决定。这样协议可跨 runtime 和历史使用，不会把视觉实现固化进数据。

### D4：历史不迁移，读侧兼容

原因：历史消息量大、形态多，批量迁移风险高，且旧数据仍保留足够语义时完全可以读侧归一。正确路线是 `resolveFilePatchDisplay(tool)` 兼容旧字段；新数据开始写 display descriptor。

### D5：新 display payload 必须避免大文本重复

原因：`old_string/new_string/content/diff` 可能很大。重复写入 `tool.display` 会增加 SSE/IPC/历史 JSON 压力，也违反 CLAUDE.md 大 payload 红线。本期推荐 compact descriptor，不 self-contained 复制大文本。

### D6：raw result 只能是 fallback，不是主要展示协议

原因：raw result 是给模型上下文、调试和最后兜底用的。前端如果靠 parse raw result，会重新引入 `[object Object]`、status 前缀、schema 漂移等问题。

## 技术地基与红线

必须复用的现有机制：

- `ToolUseSimple` / `ToolUse`：现有工具块类型。
- `ProcessRow`：折叠行、icon、状态、summary 的外层容器。
- `ToolUse.tsx::renderToolBody`：工具体路由。
- `FilePath` / `ExpandableContainer` / `ExpandableResult`：现有工具卡基础组件。
- `TabProvider.loadSession`：历史 REST 恢复路径，不能要求它迁移旧 content。
- `agent-session.ts` / `external-session.ts`：新数据持久化时补 `tool.display` descriptor 的合理位置。

必须遵守的红线：

- 前端样式使用 DESIGN token，禁止硬编码颜色和任意 px 字号。
- 新增 React helper/组件遵守 `react_stability_rules.md`，不要制造 unstable effect 依赖。
- 大 payload 不直接重复进 SSE/IPC JSON；file patch display payload 不能复制多 MB 文本。
- 新增类型放在 shared 时保持纯依赖，不从 renderer/server 反向 import。
- 若新增 SSE 字段，必须确认 Rust proxy / frontend parse 路径不丢字段；本期优先避免新增 SSE event。

## 实施建议

### Phase 1：协议与 resolver

1. 新增或整理 `src/shared/toolDisplay/filePatch.ts`。
2. 定义 `FilePatchDisplay` / `FilePatchChange` / `FilePatchView` 类型。
3. 提供纯函数：
   - `normalizeFilePatchKind`
   - `countFilePatchLines`
   - `resolveFilePatchDisplayFromToolLike`
   - `buildFilePatchDisplayDescriptor`（若采用 compact persisted descriptor）
4. 把当前 `src/shared/fileChange.ts` 的逻辑迁入或包装进新模块，避免长期存在两个真源。

### Phase 2：前端消费统一协议

1. 新增 `FilePatchTool.tsx`。
2. `EditTool.tsx` / `WriteTool.tsx` 改为薄壳：
   - `const filePatch = resolveFilePatchDisplay(tool)`
   - 有则 `<FilePatchTool display={filePatch} tool={tool} />`
   - 无则保留旧 fallback。
3. `getToolSummaryNode` 对 Edit/Write 只读 `display.summary`。
4. `getToolLabel` / `getToolExpandedLabel` 可逐步复用 file patch display 的主路径，避免 label 仍然只看 `parsedInput`。

### Phase 3：新数据写 display descriptor

1. builtin `agent-session.ts` 在工具输入完成或持久化前，为 Edit/Write tool block 补 `tool.display`。
2. external `external-session.ts` 在 `tool_use_stop` / `tool_result` 合并完成后，为 Codex fileChange tool block 补 `tool.display`。
3. `src/server/runtimes/codex.ts` 继续保留 `tool_result.content` 的人类可读格式，但 UI 不再依赖它。
4. `src/renderer/types/chat.ts` 与 `external-session.ts::PersistContentBlock.tool` 同步增加 `display?: ToolDisplayPayload`。

### Phase 4：文档与收口

1. 更新 `specs/tech_docs/multi_agent_runtime.md` 的 Codex `fileChange` 映射，明确它写入 file patch display。
2. 可选更新 `specs/DESIGN.md` 的工具卡章节（如果存在对应章节；没有则不强行补大段）。
3. 删除或降级散落的 old/new/changes 解析分支，保证 file patch resolver 是单一真源。

## 验收标准

### 必赢场景

1. builtin SDK Edit：
   - 折叠态显示 `+N -M`。
   - 展开态保持当前 builtin old/new stacked 样式。
   - `replace_all` 显示不退化。

2. builtin SDK Write：
   - 折叠态显示 `+N`。
   - 展开态保持当前 Write 内容预览样式。
   - 历史恢复时即使没有 `parsedInput`，只要有 `inputJson` 或 `input`，仍能显示新样式。

3. Codex fileChange：
   - 折叠态显示 `+N -M`。
   - 展开态按文件展示 diff，样式与 builtin 工具卡同一视觉语言。
   - `kind` 是对象时不出现 `[object Object]`。
   - move 显示 `old -> new`。
   - `failed/declined` 状态可见。

4. 历史兼容：
   - 旧 builtin 历史无需迁移即可渲染。
   - 旧 Codex 历史如果保留 `changes[].diff`，自动渲染成 file patch 样式。
   - 只有 raw result 的极旧数据继续 fallback raw result，不崩溃。

5. 新数据：
   - 新完成的 file patch tool block 带 `tool.display.kind === 'file_patch'` descriptor。
   - 不重复持久化大文本；历史文件体积不会因 display payload 明显翻倍。

### 测试要求

- `src/shared/toolDisplay/filePatch.test.ts`
  - builtin Edit old/new。
  - builtin Write content。
  - Codex object kind。
  - move path。
  - failed/declined status。
  - unified diff hunk 内 `+---` / `++++`。
  - raw add/delete content 内 `@@`。

- `src/renderer/components/tools/FilePatchTool.test.tsx`
  - old-new view。
  - content view。
  - unified diff view。
  - status badge。
  - move `old -> new`。

- `EditTool.test.tsx` / `WriteTool.test.tsx`
  - shell component 正确调用 file patch display。
  - fallback raw result 保留。

- server unit tests：
  - `codex.ts` fileChange result 不泄漏 `[object Object]`。
  - 新 persisted display descriptor 不包含重复大文本。

推荐最终跑：

```bash
npm run test:unit -- src/shared/toolDisplay/filePatch.test.ts src/server/__tests__/codex-app-server-protocol.unit.test.ts
npm run test:dom -- src/renderer/components/tools/FilePatchTool.test.tsx src/renderer/components/tools/EditTool.test.tsx
npm run typecheck
npm run lint
```

## 开放问题

1. **display descriptor 的字段名**
   - 推荐 `tool.display`，但实现前要确认与现有 `ToolUseSimple` / history preview shrink 逻辑不冲突。

2. **descriptor 是否要版本化**
   - PRD 推荐 `version: 1`。如果实现者认为 file patch schema 足够窄，也可只在 `kind` 上版本，但必须能兼容后续 schema 漂移。

3. **新数据 live 阶段是否同步写 display**
   - 推荐：live UI 由 resolver 从输入即时 materialize；持久化时写 compact descriptor。这样不需要新增 SSE event，也不会让 streaming 每个 delta 都携带 display。

4. **Claude Code / Gemini 的文件变更映射**
   - 本期只要求不破坏。若它们已经有可识别文件变更事件，可接入；没有则后续补。

5. **历史 preview shrink**
   - `src/server/utils/session-message-preview.ts` 会 shrink `input/inputJson/parsedInput` 等字段。新增 `display` 后要确认 preview 不误删必要 summary；但 preview 不是完整历史，不应驱动主 UI。

## 附录：实现前必读文件

- `CLAUDE.md`
- `specs/ARCHITECTURE.md`
- `specs/DESIGN.md`
- `specs/tech_docs/multi_agent_runtime.md`
- `specs/tech_docs/react_stability_rules.md`
- `src/renderer/types/chat.ts`
- `src/renderer/types/stream.ts`
- `src/renderer/components/ProcessRow.tsx`
- `src/renderer/components/ToolUse.tsx`
- `src/renderer/components/tools/toolBadgeConfig.tsx`
- `src/renderer/components/tools/EditTool.tsx`
- `src/renderer/components/tools/WriteTool.tsx`
- `src/renderer/components/tools/utils.tsx`
- `src/renderer/context/TabProvider.tsx`
- `src/server/agent-session.ts`
- `src/server/runtimes/external-session.ts`
- `src/server/runtimes/codex.ts`
- `src/server/runtimes/types.ts`
- `src/server/utils/session-message-preview.ts`
