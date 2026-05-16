# Claude Plugin Loading (PRD 0.2.17)

> 与 Anthropic 官方的 [Claude Code Plugin 协议](https://code.claude.com/docs/en/plugins-reference) 对接的最薄一层。MyAgents 负责"目录 + 启停"，SDK 负责"加载 + 运行"。
>
> 关联：
> - PRD：`specs/prd/prd_0.2.17_plugin_basic_support.md`
> - 研究：`specs/research/0514_research_claude_plugin_mechanism.md`
> - SDK 版本：`@anthropic-ai/claude-agent-sdk@0.2.119`，`Options.plugins: SdkPluginConfig[]`（仅 `type: 'local'`）

---

## 边界（最重要的两句话）

1. **MyAgents 不解释插件内组件**。`SKILL.md` 的 frontmatter 字段、`hooks.json` 的 30+ 种事件、`.mcp.json` 的 server 配置、`${CLAUDE_PLUGIN_ROOT}` 替换——**全部交给 SDK**。MyAgents 只把绝对路径喂给 `Options.plugins`。
2. **OpenClaw 的 `plugin` 和 Claude 的 `cc-plugin` 是两套独立体系**。前者是 IM 渠道 npm 包（飞书/微信适配器），存在 Rust Management API；后者是 Anthropic 协议的插件目录，存在 Node Sidecar 的 AppConfig + 磁盘。CLI 命名分别是 `myagents plugin *` vs `myagents cc-plugin *`，互不影响。

---

## 模块布局

```
src/server/plugins/
├── url-resolver.ts   # 解析用户输入：owner/repo / GitHub URL / zip URL / file://
├── fetcher.ts        # 拉取 → ExtractedTree（复用 skills/tarball-fetcher.ts）
├── manifest.ts       # plugin.json 解析 + 组件清单扫描（仅 UI 展示用）
├── installer.ts      # 树分析（detect plugin / marketplace / multi-plugin）+ 写盘
└── store.ts          # install / uninstall / toggle / list（withConfigLock 序列化）

src/shared/types/plugin.ts   # PluginEntry / PluginManifest / PluginComponentInventory / SSE event types
```

---

## 数据流

### 安装（`POST /api/plugin/install`）

```
renderer InstallDialog → apiPostJson('/api/plugin/install', { sourceUrl, installId })
  → admin-api 注册的路由 handler (src/server/index.ts:6845+)
      → broadcast('plugin:install-progress', { phase: 'fetching' })
      → store.installPlugin(sourceUrl, { onProgress })
          → resolvePluginUrl(sourceUrl)                       (url-resolver)
          → fetchPluginTree(source)                           (fetcher → tarball-fetcher)
          → analysePluginTree(tree, subPath)                  (installer)
              → 'plugin' | 'marketplace' | 'multi-plugin' | 'no-plugin'
          → withConfigLock 检查 name 冲突
          → clearBrokenSymlinkAt(installPath)                 (Pit of Success 红线：双 lstat 防 cpSync crash)
          → writePluginToDisk(installPath, tree, rootPath)    (复用 skills/installer.writeSkillFiles 的 zip-slip 防护)
          → withConfigLock { plugins.push(entry); enabledPlugins[id] = true }
      → broadcast('plugin:install-progress', { phase: 'done' })
      → broadcast('plugins:changed', { reason: 'install' })
      → schedulePluginRestartLazy() → agent-session.schedulePluginDeferredRestart()
          → forceReloadActiveSession('plugins')
              → 若有 turn 在跑：scheduleDeferredRestart('plugins') + schedulePreWarm()
              → 否则：abortPersistentSession() (下一次 pre-warm 拿到新 plugin 列表)
```

### SDK 注入

```
agent-session.ts::commonQueryOptions 构建处
  → getEnabledPluginSdkConfigs()           // 从 AppConfig 取 enabled & 存在的
    返回 [{ type: 'local', path: '/abs/path' }, ...]
  → 注入到 Options.plugins
  → SDK 自动展开 plugin 内组件，merge 到 skills/agents/mcpServers/hooks
```

外部 Runtime（Claude Code CLI / Codex / Gemini）路径不走这里——它们各自管自己的 plugin 体系。

---

## 磁盘布局

```
~/.myagents/
├── config.json                        # AppConfig.{plugins, enabledPlugins, pluginConfigs}
└── plugins/
    ├── <plugin-name>/                  # 每个插件一个目录，名字与 plugin.json::name 一致
    │   ├── .claude-plugin/plugin.json
    │   ├── skills/...
    │   ├── agents/...
    │   ├── .mcp.json
    │   ├── hooks/hooks.json
    │   └── ...
    └── data/
        └── <sanitized-id>/             # ${CLAUDE_PLUGIN_DATA}（如 node_modules、cache）
```

**沙箱性质**：插件代码以**当前用户权限**运行。安装弹窗显式警告"插件可执行任意代码 / 启动 MCP 进程 / 触发 hook 脚本"。

---

## SSE 事件

| Event | 时机 | Payload |
|-------|------|---------|
| `plugin:install-progress` | 安装的每个阶段 | `{ installId, phase: 'fetching'\|'extracting'\|'validating'\|'writing'\|'done'\|'failed', message?, error? }` |
| `plugins:changed` | install / uninstall / toggle 完成 | `{ reason: 'install'\|'uninstall'\|'toggle'\|'manifest_reload' }` |

注册位置：
- `src/server/sse.ts::SSE_EVENT_PRIORITIES`（`critical` 优先级——结构性事件不允许 coalesce/drop）
- `src/renderer/api/SseConnection.ts::JSON_EVENTS`
- `src/renderer/context/TabProvider.tsx` 把这两个事件 re-broadcast 成 `myagents:plugin-install-progress` / `myagents:plugins-changed` 的 window CustomEvent，`GlobalPluginsPanel` 监听这俩。

---

## 边界 & 红线

| 红线 | 落地点 |
|------|--------|
| 断 symlink 让 Node `cpSync` 抛 C++ 异常 abort sidecar | `installer.clearBrokenSymlinkAt()` + `fetcher.isBrokenSymlink()` lstat 双探 |
| SSRF | 复用 `tarball-fetcher.assertPublicUrl()` |
| zip-slip | 复用 `skills/installer.writeSkillFiles()` |
| Config race | 所有 AppConfig 修改走 `withConfigLock` |
| 大 payload 进 SSE | `plugin:install-progress` 只传 phase + 短文本 |
| `__dirname` 在 esbuild bundle 里硬编码 | 所有路径解析走绝对路径或 `fileURLToPath(import.meta.url)` |
| 外部 runtime 下不该注入 plugin | `schedulePreWarm` 已有 `isExternalRuntime` 守卫 |
| 新 SSE 事件不注册白名单导致静默丢消息 | 已注册 `JSON_EVENTS` + `SSE_EVENT_PRIORITIES` |
| 名称冲突 | `plugin` (OpenClaw) vs `cc-plugin` (Claude) 严格分开 |

---

## 排除范围（v0.2.18+ 处理）

- **Marketplace 协议**（`.claude-plugin/marketplace.json` + `/plugin marketplace add` 等价）
- **Project scope**（仓库级 `.claude/settings.json::enabledPlugins`）
- **`userConfig` 弹窗**（敏感 token 走 Keychain）
- **版本升级**（重装即可）
- **Orphan 7-day GC**
- **`npm` / `git-subdir` 源**
- **方案 C**（透传 `extraKnownMarketplaces` 让 SDK 自动读 `~/.claude/settings.json`）

碰到 `marketplace.json` 时 `analysePluginTree` 返回 `mode: 'marketplace'`，前端给出友好提示"请提供单个插件子目录的链接"。
