# PRD 0.2.34 — 系统预设工作区软删除

status: implemented
created: 2026-06-11
implemented: 2026-06-11
owner: MyAgents

## 1. 背景

Mino 是 MyAgents 首次启动时自动创建的默认工作区。它不是用户手动添加的普通项目，而是产品提供的系统预设工作区：文件模板来自 bundled resources，产品级 Agent 默认能力来自 `PRESET_TEMPLATES`。

当前实现里，启动流程会执行 `ensureBundledWorkspace()`：

- Rust `cmd_initialize_bundled_workspace` 确保 `~/.myagents/projects/mino` 目录存在。
- Renderer `ensureBundledWorkspace()` 如果发现该目录存在但 `projects.json` 中没有同路径 Project，会自动重新注册。
- Launcher 的“移除工作区”只从 `projects.json` 删除 Project 记录，不删除目录。

因此用户在 Launcher 移除 Mino 后，下一次重启会再次看到 Mino。用户反馈：“每次重启都会多一个 mino 出来，我已经有 mino 了，但是重启更新后就会多一个 mino 出来，我就需要删除一次。”

根因不是重复复制目录，而是产品语义冲突：

- “移除工作区”表达用户不想在列表看到它。
- “内置 Mino 自愈”把缺失注册视为损坏并自动恢复。
- 数据模型没有记录“用户主动隐藏了系统预设工作区”。

## 2. 目标

建立清晰的系统预设工作区生命周期模型：

1. Mino 首次启动仍自动创建并展示。
2. Mino 作为系统预设工作区，不再按普通 Project 物理删除注册；用户移除时执行软删除，即隐藏。
3. 隐藏后的 Mino 重启、更新后不会自动重新出现在工作区列表。
4. 普通用户工作区保持当前语义：从列表移除 Project 记录，但不删除本地工作区文件。
5. 启动自愈能力保留：只有在没有用户隐藏意图时，才自动恢复内置 Mino 注册。
6. 恢复能力在数据模型和服务逻辑上预留；本期不增加前端恢复交互。

## 3. 非目标

- 不删除 `~/.myagents/projects/mino` 目录或任何用户工作区文件。
- 不新增“删除工作区文件”能力。
- 不做前端“恢复 Mino”入口。
- 不按名称 `Mino` / `mino` 合并工作区；用户可以拥有自己的 `/Documents/project/mino`。
- 不把所有 `templateSource: 'builtin'` 的工作区都视为系统预设。用户从内置模板创建出来的新工作区仍是普通用户工作区。
- 不改变 Mino 模板默认 Agent 能力策略。

## 4. 当前 Ground Truth

### 4.1 Mino 初始化

- `src-tauri/src/commands.rs::cmd_initialize_bundled_workspace` 固定使用 `~/.myagents/projects/mino`。
- 目录不存在时从 resources 复制；目录存在时返回 `is_new: false`。

### 4.2 Mino 注册恢复

- `src/renderer/config/services/appConfigService.ts::ensureBundledWorkspace()` 调 Rust 初始化命令。
- 当 `is_new === true` 时，注册 Project 并写 `displayName: 'Mino'`、`templateId: 'mino'`、`templateSource: 'builtin'`。
- 当 `is_new === false` 但 `projects.json` 无同路径 Project 时，也会重新注册。

### 4.3 工作区移除

- `src/renderer/pages/Launcher.tsx` 的确认文案明确写着“不会删除项目文件”。
- `removeProject()` 只从 `projects.json` 删除 Project。
- 这对普通用户工作区是合理的，但对系统预设 Mino 会丢失用户的隐藏意图。

### 4.4 Project 过滤

- Launcher 当前只过滤 `project.internal`。
- 其它工作区选择、任务中心候选等路径也需要共享“用户可见工作区”语义，避免遗漏隐藏项。

## 5. 设计

### 5.1 Project 增加生命周期归属

在 `Project` 上增加可选字段：

```ts
workspaceType?: 'user' | 'system-preset';
systemPresetId?: 'mino';
hidden?: boolean;
hiddenAt?: string;
```

语义：

- 缺省 `workspaceType` 视为普通用户工作区，兼容旧数据。
- `workspaceType: 'system-preset'` 表示该 Project 是应用提供的系统预设实例。
- `systemPresetId: 'mino'` 表示当前唯一系统预设 Mino。
- `hidden: true` 表示软删除：Project 记录保留，文件保留，但不出现在用户工作区列表中。

不复用 `templateSource: 'builtin'`：

- `templateSource` 描述文件内容来源。
- `workspaceType` 描述生命周期归属。
- 用户从内置 Mino 模板创建的新工作区可以 `templateSource: 'builtin'`，但它仍是 `workspaceType: 'user'`。

### 5.2 系统预设工作区注册

首次注册内置 Mino 时写入：

```ts
{
  workspaceType: 'system-preset',
  systemPresetId: 'mino',
  templateId: 'mino',
  templateSource: 'builtin',
  displayName: 'Mino'
}
```

已有默认 Mino 迁移时只按路径匹配：

- 路径等于 `~/.myagents/projects/mino`。
- 不按名称匹配，避免误伤用户自己的 `mino` 工作区。

### 5.3 启动恢复策略

`ensureBundledWorkspace()` 调整为：

1. 确保 bundled Mino 目录存在。
2. 读取 `projects.json`。
3. 如果存在同路径 Project：
   - 补齐 `workspaceType/systemPresetId/template` 元数据。
   - 保留 `hidden` 状态。
   - 不新增 Project。
4. 如果不存在同路径 Project：
   - 视为注册缺失，恢复注册。
   - 恢复出来的 Project 默认不隐藏。

因为软删除保留 Project 记录，所以“用户隐藏”与“注册损坏”可以被结构区分。

### 5.4 移除策略

新增 Project 层 helper：

```ts
isSystemPresetProject(project): boolean
isProjectVisibleToUser(project): boolean
removeOrHideProject(projectId): Promise<void>
```

语义：

- 普通 Project：沿用现有删除记录逻辑。
- 系统预设 Project：patch `hidden: true` 与 `hiddenAt`，不删除 Project 记录。
- 如果 `defaultWorkspacePath` 指向被隐藏 Project，同步清空。

前端文案：

- 普通工作区继续显示“移除工作区”。
- 系统预设工作区确认文案应表达“隐藏默认 Mino 工作区”，并说明不会删除本地文件，未来可恢复。

本期可以不增加恢复按钮，但代码路径必须支持后续恢复：

```ts
patchProject(project.id, { hidden: false, hiddenAt: undefined })
```

### 5.5 可见工作区过滤收口

用统一 helper 替代各处手写 `!project.internal`：

```ts
isProjectVisibleToUser(project)
```

规则：

- `internal === true` 不可见。
- `hidden === true` 不可见。
- 其它 Project 可见。

首批接入：

- Launcher 工作区列表。
- Launcher 默认工作区 fallback。
- 其它本次变更能明确定位到的工作区候选列表。

后续若发现其它入口泄漏 hidden Project，应继续收口到同一 helper，而不是新增局部判断。

## 6. 边界与兼容

- 老用户已有 `~/.myagents/projects/mino` Project：启动时补齐系统预设元数据，不改变其 Agent 配置。
- 老用户已经从列表删除过 Mino：因为旧版本没有 tombstone，首次升级后仍可能恢复一次；从本版本开始再次隐藏后不再重启出现。
- 用户自己的 `/Documents/project/mino`：不被标记为系统预设，不参与软删除。
- 用户从模板库创建的 Mino 派生工作区：普通 Project，可从列表移除，不软删除。
- `projects.json` 损坏或内置 Mino 注册丢失：只要没有 hidden Project 记录，仍自动恢复。
- `defaultWorkspacePath` 指向隐藏 Project：清空，让 Launcher fallback 到其它可见工作区。

## 7. 验收标准

1. 首次启动或没有 Mino 记录时，应用仍创建并展示默认 Mino 工作区。
2. 默认 Mino Project 持久化后带 `workspaceType: 'system-preset'` 与 `systemPresetId: 'mino'`。
3. 用户在 Launcher 移除默认 Mino 后，`projects.json` 中该 Project 仍存在但 `hidden === true`。
4. 重启或重新执行配置加载后，隐藏的 Mino 不再出现在 Launcher 工作区列表。
5. 用户自己的同名 `mino` 工作区不被识别为系统预设，移除后仍从 `projects.json` 删除记录。
6. 从内置 Mino 模板创建的新工作区不是系统预设，移除后仍按普通 Project 处理。
7. `defaultWorkspacePath` 指向隐藏 Mino 时会被清空。

## 8. 实现文件

- `src/shared/config-types.ts`
  - 扩展 `Project` 类型。
  - 增加系统预设工作区相关类型和 helper。
- `src/renderer/config/services/projectService.ts`
  - 增加普通删除与系统预设隐藏的统一入口。
- `src/renderer/config/services/appConfigService.ts`
  - 调整 `ensureBundledWorkspace()` 注册/恢复策略。
- `src/renderer/config/ConfigProvider.tsx`
  - 暴露 remove/hide 统一行为。
  - 清理指向隐藏工作区的默认工作区配置。
- `src/renderer/pages/Launcher.tsx`
  - 使用统一可见性 helper。
  - 系统预设工作区使用“隐藏”文案。
- 单测
  - 覆盖软删除、启动恢复、可见性过滤、同名用户工作区不误判。

## 9. 开发备注

- 不引入按名称去重。
- 不新增恢复 UI。
- 不删除工作区文件。
- 所有路径比较继续使用 `workspacePathsEqual()` / `normalizeWorkspacePathIdentity()`。
- 配置写盘仍遵循 disk-first 与 lock 规则。
