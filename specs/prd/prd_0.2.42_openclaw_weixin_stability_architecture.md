---
type: prd
status: draft
created: 2026-06-28
updated: 2026-06-28
scope: "彻底修复 GitHub #413：openclaw-weixin bridge health status contract 不清导致 monitor 重启语义不稳、IM activeSessions 映射易失导致上下文断裂、pure IM provider/model 路由身份分裂导致 channel override 不生效和 400 model drift。核心是把 health predicate、peer-session binding durability、ProviderRoute identity 放回正确 owner；明确不做 quota fallback、无证据账号迁移、历史 session 猜测合并、/identity 伪修复和 stale im_bots 目录清扫作为主修复。"
issue: "GitHub #413（openclaw-weixin 连接稳定性；#397 修复后遗留问题；issue 最新更新时间 2026-06-27）"
research: "specs/ARCHITECTURE.md; specs/tech_docs/plugin_bridge_architecture.md; specs/tech_docs/im_integration_architecture.md; specs/tech_docs/session_architecture.md; specs/tech_docs/third_party_providers.md; specs/tech_docs/multi_agent_runtime.md; specs/prd/prd_0.2.41_provider_route_identity_architecture.md; specs/prd/prd_0.2.40_session_config_snapshot_identity_repair.md; GitHub #413; unified logs 2026-06-22/25/27 sampled; installed openclaw-weixin monitor/channel sources; plugin-sdk config-runtime shim"
review: "completed：sub-agent 架构 review 已完成，blocker 已折回正文。关键修正：Weixin 当前 lastEventAt 是 getUpdates poll heartbeat 兼容字段，不能直接降级为诊断；cfg.channels crash 真实路径是 openclaw/plugin-sdk/config-runtime shim；pure IM ProviderRoute 必须复用 IM runtime policy 并先做 provider/model membership 验证；runtime-drift 和 metadata_birth_pending 也是 activeSessions mutation。"
---

# PRD 0.2.42：OpenClaw Weixin 稳定性与 IM 路由所有权修复

## 执行须知（给空 session 的你）

你接手实现前必须主动读这些文档和代码，不要只读本 PRD：

1. `specs/ARCHITECTURE.md`
2. `specs/tech_docs/plugin_bridge_architecture.md`
3. `specs/tech_docs/im_integration_architecture.md`
4. `specs/tech_docs/session_architecture.md`
5. `specs/tech_docs/third_party_providers.md`
6. `specs/tech_docs/multi_agent_runtime.md`
7. 相关 PRD：
   - `specs/prd/prd_0.2.41_provider_route_identity_architecture.md`
   - `specs/prd/prd_0.2.40_session_config_snapshot_identity_repair.md`
   - `specs/prd/prd_0.2.39_session_config_ownership_repair.md`
8. 当前实现入口：
   - `src/server/plugin-bridge/gateway-health.ts`
     - `buildReadyHealth`
     - `buildFunctionalHealth`
     - `DEFAULT_STALENESS_MS`
   - `src/server/plugin-bridge/index.ts`
     - OpenClaw-format `openclawConfig`
     - `startAccount` context
     - `/health/live`
     - `/health/ready`
     - `/health/functional`
     - `/identity`
   - `src/server/plugin-bridge/compat-runtime.ts`
     - `runtime.config.loadConfig`
   - `src/server/plugin-bridge/sdk-shim/plugin-sdk/config-runtime.js`
     - `loadConfig`
     - `writeConfigFile`
     - `mutateConfigFile`
   - `src/server/plugin-bridge/sdk-shim/plugin-sdk/_handwritten.json`
     - 手写 shim 保护列表
   - `src-tauri/src/im/bridge.rs`
     - `BridgeAdapter::listen_loop`
     - `fetch_display_name`
   - `src-tauri/src/im/agent_channel.rs`
     - `create_bot_instance`
     - `shutdown_bot_instance`
     - listen loop watcher
     - terminal callback that updates active sessions
   - `src-tauri/src/im/config_store.rs`
     - `monitor_agent_channels`
   - `src-tauri/src/im/router.rs`
     - `SessionRouter::commit_ensure_sidecar`
     - `SessionRouter::restore_sessions`
     - `SessionRouter::active_sessions`
     - `SessionRouter::record_response`
     - `SessionRouter::upgrade_peer_session_id`
   - `src-tauri/src/im/health.rs`
     - `HealthManager::set_active_sessions`
     - `HealthManager::persist`
     - `HealthManager::start_persist_loop`
   - `src-tauri/src/im/handover.rs`
     - active session upsert/removal persistence pattern
   - `src-tauri/src/im/runtime_change.rs`
     - rotated active sessions persistence pattern
   - `src-tauri/src/im/heartbeat.rs`
     - heartbeat ensure-sidecar path that calls `commit_ensure_sidecar`
   - `src-tauri/src/im/state.rs`
     - command/status ensure-sidecar path that calls `commit_ensure_sidecar`
   - `src-tauri/src/im/enqueue.rs`
     - `enqueue_to_sidecar`
   - `src/server/index.ts`
     - `/api/im/enqueue`
     - `resolveImProviderEnv`
   - `src/server/utils/resolve-session-config.ts`
     - `resolveEffectiveConfig`
   - `src/server/session-engine/builtin-adapter.ts`
     - `providerEnvForRouteRequest`
     - `enqueueImMessage`
   - 当前安装的 openclaw-weixin 插件源码（用于核实插件 status/config 语义；实现时不要把绝对路径写死到代码）
     - `node_modules/@tencent-weixin/openclaw-weixin/src/monitor/monitor.ts`
     - `node_modules/@tencent-weixin/openclaw-weixin/src/channel.ts`

本 PRD 引用符号名而不是固定行号。行号会随并发改动漂移，找不到时用 `rg "<symbol>"`。

本 PRD 是修复 #413 的执行契约。它不是“多加几次 retry”或“重启后扫 sessions.json 猜映射”的补丁清单，而是一次 owner 归位：

- Plugin Bridge health 只判断 gateway 是否真的不可用；先把插件 status 字段归一成 transport heartbeat / inbound event，再决定是否 restart。
- IM router 继续拥有 peer -> session binding，但 binding 一变就由 channel health durable 保存。
- builtin provider/model 路由身份用现有 `ProviderRoute` 原子表达，不再让 `providerEnv` 和 `model` 分开漂移。

## 1. 背景与用户反馈

GitHub #413 反馈的是 openclaw-weixin 在 0.2.41 上的稳定性问题。#397 已修复了部分 session sidecar lifecycle 和 provider routing 问题，但 WeChat channel 仍出现：

1. `openclaw-weixin` bridge health check 定期失败，Rust 侧看到 `/health/functional` 失败或端口不可达。
2. Monitor 一天内多次 `Monitor started`，2026-06-25 单日最多 8 次。
3. `state.json.activeSessions` 只剩一个当前映射，重启 / bridge 重建 / monitor 重启后映射可能丢失，下一条微信消息创建新 session，上下文断裂。
4. 历史累计多个 `source: "openclaw-weixin_private"` session，用户看到“你的对话怎么都乱了”。
5. bot account id 曾从一个 `@im.bot` 变到另一个 `@im.bot`，旧 token 和新会话不连续。
6. `triggerWeixinChannelReload` 曾报 `Cannot read properties of undefined (reading 'channels')`。
7. `/identity returned null displayName` 高频出现。
8. `~/.myagents/im_bots/` 有 stale 空目录。
9. 2026-06-25 仍出现新的 400：请求打到 DeepSeek Anthropic endpoint，但 model 是 `mimo-v2.5-pro`。这不是 #397 的 `[1m]` suffix 旧问题，而是 provider/model 身份漂移。

用户的核心意志是：不要再用局部补丁把系统“勉强跑起来”。要从真正正确的方向处理，让长期服务可维护性越来越好，不留下技术债，也不要过度防御。

因此本 PRD 把现象拆成三条主链路和三条非主链路。主链路必须修；非主链路只做正确归类，不混进本期核心修复。

## 2. 已验证技术事实

### 2.1 health failure -> listen loop exit -> monitor restart 是现有设计链路

`BridgeAdapter::listen_loop` 每 30s probing `/health/functional`。连续 3 次非 2xx 后，它会打印 `Bridge process appears dead` 并退出 listen loop。

`agent_channel.rs` 里的 watcher 看到 listen loop 非正常结束，会把 channel health 标成 `Error` 并发送 shutdown。

`config_store.rs::monitor_agent_channels` 每 30s 扫描 Agent Channel，发现 `Error` / `Stopped` 后走 auto-restart。

所以 issue 里的 “Monitor started 很多次” 不必解释成插件进程自己 crash。只要 MyAgents watchdog 把 health 判为失败，它就会主动拆掉旧 bridge 并重建 channel。这条链路是代码设计，不是偶然现象。

### 2.2 当前 functional health 直接消费未归一化 status

`buildFunctionalHealth` 当前规则：

- `ready` 不通过时返回 503。
- `hasGateway=false` 认为 send-only，返回 200。
- `waitingForQrLogin=true` 返回 200。
- `gatewayStatus.running === false` 返回 503。
- 如果 `gatewayStatus.lastEventAt` 存在，且距今超过 `DEFAULT_STALENESS_MS`（90s），返回 503，reason 是 `gateway-status-stale`。
- 如果没有 `lastEventAt`，才会用 `lastForwardAt` 做诊断并最终返回 200 unknown/stale。

这个规则的问题不是“stale 一定是假阳性”，而是 `lastEventAt` 字段语义没有被 Plugin Bridge 归一化。当前安装的 `@tencent-weixin/openclaw-weixin` 里，`monitor.ts` 在每次成功 `getUpdates` 后都会 `setStatus({ accountId, lastEventAt: Date.now() })`，即使 `resp.msgs` 为空；只有真正有 inbound message 时才额外写 `lastInboundAt`。也就是说，对当前 Weixin 插件而言，`lastEventAt` 实际上是 **poll success heartbeat 兼容字段**，不是纯业务事件。

因此本期不能简单把 stale `lastEventAt` 一律降级为 200 diagnostic。正确修复是先建立 status normalizer：

- 对 openclaw-weixin 当前版本：`lastEventAt` 兼容映射为 `lastPollSuccessAt`；`lastInboundAt` 才是业务 inbound event。
- 对其它插件：只有明确声明为 transport heartbeat 的字段才 restart-driving；纯 inbound/business event stale 只能 diagnostic。

本机 unified log 抽样显示：多条 `/health/functional returned 503` 的 `/status` body 同时显示 `ready=true`、`gatewayStatus.running=true`，`lastEventAt` 很旧。结合 Weixin 插件源码，这更像 “getUpdates poll heartbeat stale / backoff” 而不是单纯 idle false positive。PRD 的修复目标是让 health reason 准确：业务 idle 不杀，poll heartbeat 真的 stale 仍可杀并重启。

### 2.3 activeSessions 不是完全没持久化，而是持久化边界太晚

IM peer -> session binding 的 owner 是 `SessionRouter.peer_sessions`。

启动时，`create_bot_instance` 从 `HealthManager.get_state().active_sessions` 读旧映射，调用 `SessionRouter::restore_sessions` 恢复。恢复后 `sidecar_port=0`，下一条消息再 ensure sidecar。

新消息触发 sidecar ensure 后，`SessionRouter::commit_ensure_sidecar` 会把 mapping 写回 `peer_sessions`。但这个 mutation 只更新内存。

当前 activeSessions 写入 health state 的主要机会是：

- `HealthManager::start_persist_loop` 每 5s 持久化当前 health state。
- AI terminal callback 里 `record_response` / `upgrade_peer_session_id` 后调用 `set_active_sessions`。
- `shutdown_bot_instance` 关闭前调用 `set_active_sessions`，随后最终 `persist`。
- handover / runtime_change 等少数特殊路径已经在 mutation 后手动 `set_active_sessions` + `persist`。

因此问题不是“没有 state.json”，而是“新 binding 建立后，没有在 binding mutation 边界立即 durable persist”。如果 health-triggered restart 在 `commit_ensure_sidecar` 之后、5s persist 或 terminal callback 之前发生，新 mapping 就可能丢失。

`activeSessions` 只有一个槽本身不是 bug。如果一个 channel 当前只有一个 private peer 活跃，一个 mapping 是正确数量。真正的 bug 是 mapping 易失、sessionKey/account/chat identity 漂移，以及缺少 mutation-boundary persistence。

### 2.4 IM provider routing 仍然把 provider env 和 model 分开传

`resolve-session-config.ts::resolveEffectiveConfig` 对 `ownerKind === 'im'` 的 pure IM 语义是 live-follow Agent + Channel Overrides。这是正确方向。问题是返回结果里 `providerRoute` 仍是 `undefined`，只带 `providerId`、`model`、`providerEnvJson`。

Rust `enqueue_to_sidecar` 对 builtin runtime 只把 `providerEnv` 和 `model` 放进 `/api/im/enqueue` body，没有 provider route。

Node `/api/im/enqueue` 里 #237 已经加了 `resolveImProviderEnv(agentDir, payload.botId)`，试图从磁盘 providerId 重新 resolve fresh provider env，避免 Rust cached providerEnv 过期。这修掉了一部分 stale env 问题，但没有把 `providerId + model` 变成一个原子身份：

- `resolvedProviderEnv` 来自 fresh resolve 或 payload fallback。
- `resolvedModel` 仍然是独立的 `payload.model`。
- `resolvedProviderRoute` 只有 desktop handover snapshot 存在时才用。
- pure IM 仍然以 `providerEnv + model` 进入 SessionEngine。

`builtin-adapter.ts::providerEnvForRouteRequest` 已经有运行时 materialization 机制：如果 request 带 concrete `providerRoute`，会校验 request.model 与 route.model 是否互相矛盾，并从 providerId live materialize env；provider 不可用或缺 key 返回 409。但它不负责校验 “model 是否属于 provider”。这个 membership 校验必须在进入 engine 前用 `resolveExplicitProviderRoute(...)` 或等价 helper 完成。pure IM 现在既没构造 ProviderRoute，也没做 membership 校验，所以仍可能出现 DeepSeek endpoint + MiMo model 这类漂移。

### 2.5 `cfg.channels` reload crash 的真实入口是 SDK shim `config-runtime`

当前 `plugin-bridge/index.ts` 在 register 前会构造 OpenClaw-format config：

```ts
{
  channels: {
    [channelKey]: {
      enabled: true,
      ...pluginConfig,
      dmPolicy: 'open',
      groupPolicy: 'open',
    },
  },
}
```

并在 plugin id 与 inferred brand key 不一致时补一个 plugin id alias。`compat-runtime.ts::runtime.config.loadConfig` 也返回 `channels[currentPluginId]` 形状。

但 issue 里的 `triggerWeixinChannelReload` 不走 `runtime.config.loadConfig`。当前安装的 Weixin 插件在 QR 登录成功后会调用 `triggerWeixinChannelReload()`；该路径来自插件源码，并通过 `openclaw/plugin-sdk/config-runtime` 读取/写入 config。MyAgents 仓库里的 `src/server/plugin-bridge/sdk-shim/plugin-sdk/config-runtime.js` 目前是自动生成 stub，`loadConfig()` / `writeConfigFile()` / `mutateConfigFile()` 都返回 `undefined`。这正好解释了 `Cannot read properties of undefined (reading 'channels')`。

所以本期不只是抽 startup normalizer，还必须给 `plugin-sdk/config-runtime` 做手写 Bridge shim，返回同一份 normalized OpenClaw config，并把该 shim 加进 `_handwritten.json`，防止下一次 `generate:sdk-shims` 覆盖。

### 2.6 `/identity null` 和 stale `im_bots` 目录不是主因

`/identity` 对没有 resolver 的插件返回 `displayName: null` 是当前设计，Rust 已经把它作为 debug 诊断处理。Weixin / Wecom 没 resolver 时，UI 应该 fallback 到 platform label。伪造 displayName 不是修复。

`~/.myagents/im_bots/` 下的空目录是 legacy migration / 清理噪声。真正的 Agent Channel state 已经在 `~/.myagents/agents/<agentId>/channels/<channelId>/`。空目录不解释 health failure、monitor restart、activeSessions 易失或 provider drift。本期不把清理目录当主修复。

### 2.7 402 quota 不是 MyAgents bug

issue 评论已更正：SensNova 每 5 小时 quota reset，402 是 provider 配额窗口用尽。它可以有更好的用户提示或未来 fallback 体验，但不是 #413 的 root cause。本期不做 provider quota fallback。

## 3. 根因模型

### R1：health predicate owner 错位

Plugin Bridge health 的 owner 是“bridge/gateway 是否处于可服务状态”。当前 `buildFunctionalHealth` 直接读取插件原始 `gatewayStatus.lastEventAt`，但没有先归一化这个字段到底是 poll heartbeat、inbound business event，还是插件自定义 timestamp。

结果是两头都不稳：

- 如果某插件的 `lastEventAt` 是纯 inbound event，业务空闲会被错杀。
- 如果 Weixin 当前的 `lastEventAt` 是 poll success heartbeat，503 可能是合理重启信号，但日志 reason 仍叫 `gateway-status-stale`，实现者容易误修成永远 200，掩盖真实 `getUpdates` failure/backoff。

正确方向是由 Plugin Bridge 定义 status contract 和 plugin-specific compatibility normalizer，再让 `/health/functional` 只看归一化后的 restart-driving 字段。

### R2：binding durability 不在 binding mutation 边界

IM router 是 peer -> session binding 的 owner，但 durable persistence 不是在 `commit_ensure_sidecar` 这类 mutation 点发生，而是依赖后续 terminal callback、periodic persist、shutdown persist。

结果是：重启或 false health kill 越频繁，越容易卡在“内存已有新 binding，磁盘 state 还没有”的窗口。下一次启动 restore 不到 mapping，就创建新 session。

### R3：pure IM provider/model identity 没走 canonical ProviderRoute

pure IM 的产品语义是 live-follow Agent + Channel Overrides；它不应该 freeze 成 owned desktop snapshot。但 live-follow 解析出的 builtin provider/model 仍必须是原子 route identity。当前实现只把 `providerEnv` 和 `model` 作为两个松散字段传递，让 stale env、payload model、session resume model、channel override model 有机会错配。

结果是：channel override 指向 SensNova / deepseek-v4-flash，但请求可能走 DeepSeek endpoint 或携带其它 provider 的 model，产生 400 model name error。

### R4：config reload shape 没有被唯一入口约束

OpenClaw plugin 消费的 config shape 是 `cfg.channels[...]`。startup 走 `openclawConfig` normalizer，但 Weixin QR 登录后的 reload 通过 `openclaw/plugin-sdk/config-runtime` 读取 config；MyAgents 当前对应 shim 返回 `undefined`。这不是 Weixin 专属业务逻辑问题，是 Plugin Bridge SDK shim 没有承担 config-runtime owner。

## 4. 产品目标

### 4.1 必须达成

1. openclaw-weixin 在长时间无业务消息但 `getUpdates` poll heartbeat 正常的 idle 状态下不应被 MyAgents watchdog 重启。
2. `getUpdates` poll heartbeat 真的 stale、gateway error、ready failure、process failure 仍能被 Rust watchdog 发现并重启，不把 health 放宽到“永远 200”。
3. 新建或恢复的 WeChat peer -> session mapping 在 binding mutation 后立即 durable persist。MyAgents 重启、bridge 重建、monitor 重启后，同一 peer 继续路由到同一 session。
4. pure IM 每条消息仍 live-follow Agent + Channel Overrides；但 builtin provider/model 必须用 `ProviderRoute` 原子进入 SessionEngine。
5. 已知 providerId + model 时，provider 不可用、缺 key、model 不属于 provider 都要 fail loud，不 fallback 到 stale `providerEnv` 或其它 provider。
6. Desktop handover / owned session snapshot 语义不能被 pure IM live-follow 修复破坏。owned session 继续由 session snapshot 拥有配置。
7. External runtime 不引入 builtin provider route。Codex / Claude Code / Gemini runtime 继续按 `session-engine` external adapter 语义执行。
8. OpenClaw config shape 的 startup / reload / QR restart 统一走同一个 normalizer，保证 `cfg.channels[...]` 存在。
9. 日志和测试能证明：业务 idle 不重启、poll heartbeat stale 会重启、binding mutation 会 persist、channel override provider/model 不漂移。

### 4.2 非目标

- 不修 provider 402 quota，也不在本期做 SensNova -> DeepSeek 自动 fallback。
- 不根据 accountId 变化自动合并历史 session。没有稳定 identity 或用户确认时，自动合并会把不同账号/peer 的上下文错接。
- 不扫 `sessions.json` 猜测 activeSessions 映射。历史 mapping 已经丢失时，除非有明确 metadata 证据，否则不能重建。
- 不把 pure IM session 改成 owned snapshot。pure IM 无 Tab owner 时仍 live-follow Agent/Channel。
- 不把 `/identity displayName=null` 当错误处理，也不伪造 identity。
- 不把 stale empty `im_bots` 目录清理作为本期核心修复。可以后续做 migration janitor，但不阻塞 #413。
- 不重写 OpenClaw plugin 或 ilinkai 协议。MyAgents 只修自己的 bridge health semantics、config shape、routing/persistence owner。

## 5. 目标架构

### 5.1 Bridge health 三层语义

维持现有三层 endpoint，但修正 `/health/functional` 的 restart-driving predicate：

| Endpoint | Owner | 语义 | restart-driving |
| --- | --- | --- | --- |
| `/health/live` | Node bridge process | HTTP server 正在监听 | 仅证明进程活着 |
| `/health/ready` | Plugin Bridge | plugin loaded，gateway registered / started，或等待 QR | ready 不通过可阻止发送 |
| `/health/functional` | Gateway runtime | gateway 明确不可服务时 fail；业务 idle 只诊断；transport heartbeat stale 可 fail | Rust watchdog 依据它重启 |

`buildFunctionalHealth` 新规则：

1. `buildReadyHealth` 不通过，返回 503，原因沿用 ready failure。
2. `hasGateway=false`，返回 200 `send-only`。
3. `waitingForQrLogin=true`，返回 200 `awaiting-qr-login`。
4. `gatewayError` 或 `startAccount` promise reject，返回 503。
5. `gatewayStatus.running === false` 只有在 status contract 表示 terminal stopped / unrecoverable 时才返回 503。若插件把 polling backoff / idle 暂态写成 `running:false`，bridge adapter 必须先 normalize，不能直接把暂态解释成死亡。
6. 先把原始 `gatewayStatus` 归一化成 `normalizedStatus`。对 openclaw-weixin 当前版本，`lastEventAt` 映射为 `lastPollSuccessAt`，`lastInboundAt` 才表示业务 inbound event；对其它插件，`lastEventAt` 默认只能 diagnostic，除非插件/adapter 明确声明它是 transport heartbeat。
7. `lastPollSuccessAt` / `lastHeartbeatAt` stale 可以返回 503，并使用明确 reason，例如 `gateway-poll-stale`，避免继续把 poll failure 打成含糊的 `gateway-status-stale`。
8. 纯业务 inbound event stale 不能返回 503，只能返回 200 diagnostic，例如 `state:'idle'`。
9. 如果没有 transport heartbeat，functional 对 idle gateway 返回 200 unknown/stale，并在 body 里提示缺少 heartbeat。Rust 不能因为缺少这个字段重启。

这不是放弃健康检查。真正 failure 仍然由 `gatewayError`、process HTTP failure、ready failure、terminal stopped status、transport heartbeat stale 触发。修的是“未归一化 timestamp 被直接拿来驱动重启”的判据。

### 5.2 Plugin gateway status contract

为了避免每个 OpenClaw plugin 自己随意解释 status 字段，本期在 Plugin Bridge 层定义最小 status contract：

```ts
type GatewayRuntimeStatus = {
  running?: boolean;          // true = receive loop intended to run; false = terminal stopped only
  connected?: boolean;        // platform login / connection state, diagnostic
  lastEventAt?: number;       // raw plugin field; must be normalized before health decision
  lastInboundAt?: number;     // inbound business event, diagnostic only
  lastForwardAt?: number;     // MyAgents forward success, diagnostic only
  lastPollSuccessAt?: number; // transport heartbeat, if plugin can provide it
  lastError?: string;         // explicit gateway error, restart-driving when current
};
```

`lastEventAt` 不能直接参与 health decision。Plugin Bridge 必须先通过 normalizer 把它解释成 `lastPollSuccessAt`（Weixin 当前兼容）或只作为 diagnostic raw field。`lastInboundAt` 和 `lastForwardAt` 不 restart-driving。`lastPollSuccessAt` 可以 restart-driving。

### 5.3 activeSessions durable write boundary

新增一个小的 owner helper，名字可选：

- `persist_active_sessions_from_router`
- `sync_active_sessions_to_health`
- `persist_router_active_sessions`

职责非常窄：

1. 在持有 router lock 的 mutation 临界区内，只做同步数据变更并取 `router.active_sessions()` snapshot。
2. 释放 router lock 后，调 `health.set_active_sessions(active_sessions).await`。
3. 释放 router lock 后，立即 `health.persist().await`。
4. persist 失败时记录 `ulog_warn!`，并把错误返回给调用方决定是否继续。发送消息路径可以继续投递，但必须留下结构化 warning；reset/handover 这类显式管理操作应把失败返回给 UI 或 command result。

必须调用这个 helper 的 binding mutation 点：

- 所有 `SessionRouter::commit_ensure_sidecar` callsite 之后，且在对应后续动作前完成。当前至少包括 `router.ensure_sidecar` 主路径、`heartbeat.rs` 心跳路径、`state.rs` command/status path。不要把 `commit_ensure_sidecar` 本身改成 async，也不要在持有 router lock 时 await health persist。
- `SessionRouter::check_and_reset_on_runtime_drift` 返回 `Some(...)` 之后。该函数会换 session_id、清 port、重置 message_count、设置 `metadata_birth_pending=true`；如果 ensure 后续失败或应用重启，磁盘仍指向旧 session 就会错路由。
- terminal callback 中 `record_response` / `upgrade_peer_session_id` 后。这里已 `set_active_sessions`，需要补即时 `persist` 或改走 helper。
- 首次 enqueue 成功后的 `mark_metadata_birth_consumed` 之后。`metadata_birth_pending` 会序列化进 activeSessions，消费后也需要 durable projection，避免重启后重复 birth 语义。
- `/new` / reset session 的 peer binding 更新点。
- handover 中 target upsert 和 stale binding removal。现有 `handover.rs` 已有 `set_active_sessions + persist`，可以改成 helper，避免分叉实现。
- runtime change 中 rotated session 更新。现有 `runtime_change.rs` 已有 `set_active_sessions + persist`，可以改成 helper。
- shutdown 前最终写入仍保留，作为最后兜底，但不再承担“新 binding 首次 durable”的责任。

不做：

- 不新增后台 repair daemon。
- 不扫所有 sessions 自动补 mapping。
- 不把 mapping 放进 Plugin Bridge。Plugin Bridge 不拥有 MyAgents session。

### 5.4 IM ProviderRoute live-follow

pure IM 仍是 live-follow，但 live-follow 解析结果必须是 route identity：

```ts
type ImBuiltinProviderRouting =
  | { status: 'resolved'; providerRoute: ProviderRoute; model: string }
  | { status: 'subscription'; providerRoute: ProviderRoute; model: string }
  | { status: 'legacy-env'; providerEnv: ProviderEnv; model?: string; reason: string }
  | { status: 'not-applicable'; runtime: ExternalRuntimeType }
  | { status: 'error'; statusCode: 409; message: string };
```

实现策略：

1. 在 Node sidecar 增加 `resolveImProviderRouting(agentDir, channelId)`，替代 pure IM 的 `resolveImProviderEnv(...)` 单 env 输出。
2. 这个 helper 从磁盘最新 config 读取 Agent + Channel，但不能只用 raw `resolveEffectiveConfig` 决定 runtime。它必须复用 `resolveSessionConfig(..., 'im', { managedCodexProviderReady })` 或同一层 provider execution policy，确保 managed Codex provider（`providerId === codex-sub`）被解析成 runtime `codex`，不会被误构造成 builtin ProviderRoute。
3. providerId 兼容链仍需沿用 #237：`channel.overrides.providerId` -> legacy channel-root `channel.providerId` -> `agent.providerId` -> `config.defaultProviderId`。如果当前 `resolveSessionConfig` 不支持 legacy channel-root 字段，应把这段兼容逻辑下沉进 IM config resolver，而不是在新 helper 里另造一份长期分叉。
4. model 走 `channel.overrides.model` -> `agent.model`；如果没有 model，则按现有产品语义进入 incomplete route / explicit error，而不是猜 provider primary model。
5. 如果 effective runtime 是 external / managed-provider runtime，返回 `not-applicable`，不构造 builtin route。
6. 如果 builtin 且 `providerId + model` 具体存在，先用 `resolveExplicitProviderRoute(...)` 或等价 helper 验证 provider 存在、启用、声明该 model，再构造 concrete `ProviderRoute`，交给 `providerEnvForRouteRequest` materialize。
7. 如果 providerId 已知但 provider 不存在、禁用、缺 API key、model 不属于 provider，返回 409，不能 fallback 到 stale `payload.providerEnv`。
8. 只有在无法匹配 agent/channel 的 legacy 情况，才允许 `payload.providerEnv` fallback，并打 explicit warning。fallback 是兼容历史，不是正常路径。
9. `payload.model` 只作为 legacy input 或 diagnostics。正常 pure IM 的 model 以 route.model 为准。

Rust `enqueue_to_sidecar` 可以继续发送 `providerEnv` 兼容旧 sidecar，但应新增 `providerId` 或 `providerRoute` diagnostics 字段。权威解析放 Node sidecar，因为 sidecar 已经有 provider registry / API key / `ProviderRoute` materializer，也能避免 Rust cached env 过期。

### 5.5 owned session 与 pure IM 的边界

不能因为修 channel override 就把所有 IM session 都 live override：

- pure IM / agent-channel message：无 desktop owned snapshot，按 Agent + Channel live-follow。每 turn 用最新 channel override 解析 `ProviderRoute`。
- desktop handover / opened owned session：如果 session 有 `configSnapshotAt` 或 snapshotResolvedConfig，则 session snapshot 拥有配置。此时 `/api/im/enqueue` 继续使用 `snapshotResolvedConfig.providerRoute`，不能被 live channel override 覆盖。
- IM binding migration / `/new` / runtime incompatible fork：按现有 session architecture 规则冻结旧 session 或创建新 session，不在 provider routing helper 内偷偷切 owner。

一句话：`ProviderRoute` 是 provider/model 的身份表达，不改变 session config ownership。

### 5.6 OpenClaw config normalizer 与 config-runtime shim 唯一入口

抽出一个纯函数，名字可选：

- `buildOpenClawConfig(pluginConfig, entryModule, capturedPluginId?)`
- `normalizeOpenClawChannelConfig(...)`

要求：

1. 输出一定有 `channels` object。
2. inferred `channelKey` 和 `capturedPlugin.id` 不一致时，两者都指向同一份 channel config。
3. `dmPolicy` / `groupPolicy` 仍由 MyAgents 强制为 `open`，访问控制留在 Rust 层。
4. `plugin-bridge/index.ts` startup、`compat-runtime.ts::runtime.config.loadConfig`、`sdk-shim/plugin-sdk/config-runtime.js::loadConfig` / `writeConfigFile` / `mutateConfigFile` 全部使用同一个 builder 或同一个 normalized config snapshot。
5. `config-runtime` 必须是手写 shim，并加入 `sdk-shim/plugin-sdk/_handwritten.json`，避免生成脚本覆盖。
6. `writeConfigFile` / `mutateConfigFile` 在 Bridge mode 下可以是 no-op 或只更新内存 normalized snapshot，但不能返回 `undefined` 导致插件读取 `cfg.channels` 崩溃。
7. 加单测覆盖 `openclaw-weixin`、`@larksuite/openclaw-lark`、plugin id != channel key、`config-runtime.loadConfig()` 返回 `channels` 的情况。

## 6. 关键设计决策

### D1：修 health predicate，不修 monitor

Monitor 的职责是重启 dead channel。它看到 `Error` 后重启是合理的。真正错的是 `/health/functional` 直接消费未归一化的 plugin status 字段，让实现者无法分辨业务 idle、poll heartbeat stale、terminal stopped。

如果在 monitor 上加更长 backoff、更多 retry、忽略 weixin 错误，只会把错误 owner 往下游推，还可能让真实 dead gateway 更晚恢复。本期只调整 status normalization + health 判定，monitor 逻辑保持“Error/Stopped 可重启”的语义。

### D2：`lastEventAt` 是 raw compatibility field，不是直接 health predicate

长轮询 IM 的正常状态可能是几个小时没有业务 event。正确 health 指标是 transport heartbeat，不是“最近有无 inbound message”。

但当前 Weixin 插件已经把 `lastEventAt` 用作成功 `getUpdates` heartbeat。为了兼容已安装插件，本期必须支持 `openclaw-weixin lastEventAt -> lastPollSuccessAt` 的 normalizer；同时把业务 inbound 语义放到 `lastInboundAt`。没有 heartbeat 的插件宁可返回 diagnostic unknown，也不能用纯业务 event stale restart。

这条决策是本 PRD 的核心架构点。

### D3：activeSessions 的持久化必须跟随 binding mutation

`peer_sessions` 是 router 的内存 truth；`health.state.activeSessions` 是它的 durable projection。Projection 应该在 truth mutation 后立即刷新，而不是等 terminal callback 或周期循环。

这不是“多加一次保存”这么简单，而是把 durable projection 放回 owner 边界。handover / runtime_change 已经局部这样做，本期把它普遍化。

### D4：ProviderRoute 是 pure IM 的 runtime input，不是 owned snapshot

pure IM 不能 freeze 成 owned snapshot，否则 channel override 就会失去 live-follow 语义。但每次 live-follow 解析出的 provider/model 仍应是 `ProviderRoute`，因为 model 不是全局唯一，providerEnv 是运行时派生物。

这同时满足两个约束：

- IM channel override 每 turn 生效。
- provider endpoint 和 model 不再分裂漂移。

### D5：known providerId 失败时 fail loud，不 fallback

如果 channel override 明确指定 `providerId: "sensenova"`，但 provider 缺 key 或 disabled，正确结果是 409/明确错误，而不是 fallback 到 DeepSeek 或 payload stale env。fallback 会掩盖配置错误，并制造“看似正常但用错 provider”的隐性事故。

legacy fallback 只能用于没有 providerId / 无法匹配 agent-channel 的旧路径，并必须有 warning。

### D6：账号 ID 迁移不能自动猜

issue 提到 bot account id 从旧 `@im.bot` 变成新 `@im.bot`，中间有空窗。没有稳定用户 identity 映射时，自动把旧 sessions 合到新 account 是危险操作：同一个 chat id 在不同账号空间可能不是同一个语义实体。

正确方向：

- 当前修复保证未来 mapping durable，减少新碎片。
- 如果插件能提供稳定 peer identity 或账号迁移映射，再做 explicit migration 工具。
- 已经碎片化的历史只在用户确认或证据充分时合并。

### D7：stale 目录清理和 identity fallback 是后续 hygiene，不进入核心路径

把 stale `im_bots` 目录清理塞进本期，会让风险面扩大但不解决 root cause。`/identity null` 也只是诊断噪声。本期只保证它们不被误诊为主因。

## 7. 实施方案

### Phase A：修 Plugin Bridge functional health

修改：

- `src/server/plugin-bridge/gateway-health.ts`
- `src/server/plugin-bridge/gateway-health.unit.test.ts`
- 如需要，`src/server/plugin-bridge/index.ts` 的 status body 字段命名

具体要求：

1. 新增 status normalizer。输入是 raw `gatewayStatus` + `pluginId/pluginName`，输出至少包含 `lastPollSuccessAt?`、`lastInboundAt?`、diagnostics。
2. 对 openclaw-weixin 当前版本，兼容映射 raw `lastEventAt` 为 `lastPollSuccessAt`；保留 raw timestamp 到 body diagnostics。未来插件若显式上报 `lastPollSuccessAt`，以显式字段优先。
3. 对未声明 heartbeat 语义的其它插件，raw `lastEventAt` 不 restart-driving，只作为 diagnostic。
4. `lastPollSuccessAt` / `lastHeartbeatAt` stale 返回 503，reason 使用 `gateway-poll-stale` 或等价明确名称。
5. 保留 `ready` failure、`gatewayError`、terminal stopped 的 503。
6. 更新 `gateway-health.unit.test.ts`：
   - openclaw-weixin `running:true + fresh lastEventAt` 返回 200，reason 表示 poll heartbeat healthy。
   - openclaw-weixin `running:true + stale lastEventAt` 返回 503，reason 表示 poll heartbeat stale。
   - generic plugin `running:true + stale lastEventAt` 返回 200 diagnostic，除非显式给 `lastPollSuccessAt`。
   - generic plugin `running:true + stale lastPollSuccessAt` 返回 503。
   - `gatewayError` 返回 503。
   - `running:false` 的 terminal stopped 返回 503。
   - waiting QR 返回 200。
   - no status / no heartbeat 返回 200 unknown/stale diagnostic。

验收日志：

- 长时间业务 idle 但 `getUpdates` 仍成功时，不出现 `/health/functional returned 503`。
- `getUpdates` 连续失败/backoff 导致 poll heartbeat stale 时，`/health/functional` 明确返回 503，reason 指向 poll stale，而不是含糊的 status stale。
- 如果 bridge process 真挂，Rust HTTP request error 仍会累计 failure 并重启。

### Phase B：收口 activeSessions persistence helper

修改：

- `src-tauri/src/im/agent_channel.rs`
- `src-tauri/src/im/router.rs`（如果 helper 放 router-adjacent）
- `src-tauri/src/im/health.rs`（如果 helper 放 health-adjacent）
- `src-tauri/src/im/handover.rs`
- `src-tauri/src/im/runtime_change.rs`

具体要求：

1. 新增一个 helper，复用 `router.active_sessions()` + `health.set_active_sessions(...)` + `health.persist()`，但 helper 的 await 部分必须在 router lock 外执行。
2. 用 `rg "commit_ensure_sidecar|check_and_reset_on_runtime_drift|mark_metadata_birth_consumed|upsert_peer_session|remove_peer_sessions"` 做 mutation inventory；当前 `router.rs` 主路径、`agent_channel.rs` message path、`heartbeat.rs`、`state.rs` 都要覆盖。
3. 在每个 `commit_ensure_sidecar` 后 snapshot active sessions，释放 lock，然后 persist，并在第一条 message enqueue / heartbeat send / command status query 前完成。
4. 在 `check_and_reset_on_runtime_drift` 返回 `Some` 后 snapshot + persist；不要等后续 ensure 成功。
5. terminal callback 改走 helper，确保 session id upgrade 后立即 persist。
6. 首次 enqueue 成功后 `mark_metadata_birth_consumed` 也改走 helper，确保 `metadata_birth_pending=false` 落盘。
7. handover / runtime_change 现有 `set_active_sessions + persist` 改走 helper，避免两个模式长期分叉。
8. shutdown final persist 保留。
9. persist failure 必须 structured log，包含 channel id、agent id、session key 或短 session id。

测试建议：

- Rust 单测或 integration-ish temp dir 测试：commit binding 后 helper 会把 activeSessions 写入 state file。
- runtime drift reset 后，即使后续 ensure 失败，state file 也指向新 session_id 且 `metadata_birth_pending=true`。
- 首次 enqueue 成功并 consume metadata birth 后，state file 中 `metadata_birth_pending=false`。
- 重启恢复测试：用保存的 state 构造新 `SessionRouter::restore_sessions`，同一 sessionKey 恢复同一 sessionId。
- 失败路径测试：persist failure 不 panic，但返回 warning/error 给管理操作。

### Phase C：pure IM `/api/im/enqueue` 改走 ProviderRoute

修改：

- `src/server/index.ts`
- `src/server/utils/resolve-session-config.ts`
- 可能新增 `src/server/utils/resolve-im-provider-routing.ts`
- `src-tauri/src/im/enqueue.rs`（payload diagnostics / providerId 字段）
- 相关测试文件，优先扩展现有 provider route / IM provider env tests

具体要求：

1. 新增 Node helper：从 disk-first config 按 `agentDir + botId/channelId` 定位 Agent + Channel，复用 `resolveSessionConfig(..., 'im', { managedCodexProviderReady })` 或同一层 provider execution policy；不要只调用 raw `resolveEffectiveConfig(agent, channel)` 后自行判断 runtime。
2. 把 #237 的 providerId 兼容链纳入该 resolver：`overrides.providerId` -> legacy channel-root `providerId` -> `agent.providerId` -> `defaultProviderId`，且 agent/workspace 无法匹配时不落 global default。
3. 对 builtin runtime，先用 `resolveExplicitProviderRoute(...)` 验证 provider/model membership，再输出 concrete `ProviderRoute`。
4. `/api/im/enqueue` pure IM 分支优先使用 `resolvedImProviderRouting.providerRoute`，传给 `engine.enqueueImMessage({ providerRoute })`。
5. `model` 与 `providerRoute.model` 不重复传，或只作为一致性校验输入。不能让 payload model 覆盖 route model。
6. 如果 helper 找到 providerId 但 route validation/materialization 失败，返回 409，message 指明 provider unavailable / missing API key / model mismatch。
7. 如果 `snapshotResolvedConfig` 存在，保持 snapshot owner，不走 live channel override。
8. 如果 external runtime / managed Codex runtime，provider route not-applicable，继续对应 engine adapter 路径。
9. 保留 legacy fallback：只有 agent/channel 无法匹配、或旧 payload 无 providerId 时，才允许 `payload.providerEnv`，并加 warning。

测试建议：

- channel override providerId+model wins over agent default。
- legacy channel-root `providerId` 仍被识别，且 `overrides.providerId` 优先级高于 legacy root 字段。
- agent 无 providerId 时，按现有 #237 行为使用 `config.defaultProviderId`；agent/workspace 无法匹配时不使用 defaultProviderId，保留 legacy fallback。
- channel override providerId known but API key missing -> 409，不 fallback。
- providerRoute/model mismatch -> 409。
- snapshotResolvedConfig 存在时，snapshot providerRoute wins，不被 channel override 改写。
- external runtime 下不构造 providerRoute。
- legacy no channel match 时仍可 fallback payload providerEnv，并打 warning。

### Phase D：OpenClaw config normalizer 单点化

修改：

- `src/server/plugin-bridge/index.ts`
- `src/server/plugin-bridge/compat-runtime.ts`
- `src/server/plugin-bridge/sdk-shim/plugin-sdk/config-runtime.js`
- `src/server/plugin-bridge/sdk-shim/plugin-sdk/_handwritten.json`
- 新增或扩展 plugin-bridge config unit test

具体要求：

1. 抽纯函数构造 OpenClaw config。
2. startup、runtime `loadConfig()`、`openclaw/plugin-sdk/config-runtime` 的 `loadConfig()` / `writeConfigFile()` / `mutateConfigFile()` 复用同一函数或共享 normalized config。
3. `config-runtime.js` 改成手写 shim 后同步加入 `_handwritten.json`。
4. 覆盖 `channels` 永远存在。
5. plugin id alias 逻辑保留。
6. 单测直接 import config-runtime shim，确认 QR reload 路径拿到的 config 不是 `undefined`，且有 `channels[pluginId]`。

本 phase 解决 `triggerWeixinChannelReload` 类错误的架构归位。当前仓库没有这个函数，但当前安装的 openclaw-weixin 插件有；它走的是 SDK shim config-runtime，所以必须修 shim，而不是只修 `compat-runtime.ts`。

### Phase E：诊断与非主链路处理

1. `/identity null` 保持 debug，不升级 error。必要时降低噪声或在 UI fallback 上明确 platform label。
2. stale empty `im_bots` 目录只加后续 TODO，不在本期自动删除非空目录。
3. 402 quota 在用户提示层可后续优化，不在本期 provider route 修复里做 fallback。
4. 历史碎片 session 不自动合并。可在 issue 回复中说明：修复后防止新增碎片；既有碎片需要 explicit migration/用户确认。

## 8. 验收标准

### 8.1 Bridge stability

1. openclaw-weixin 登录后，长时间无业务消息但 `getUpdates` 成功时，`/health/functional` 保持 200。
2. openclaw-weixin `getUpdates` 连续失败/backoff 导致 normalized `lastPollSuccessAt` stale 时，`/health/functional` 返回 503，reason 指向 poll heartbeat stale。
3. unified log 不再把同一类问题含糊记录成 `gateway-status-stale`；需要区分 business idle、poll stale、gateway error。
4. 人为 kill bridge process 或让 `/health/ready` 明确失败，Rust watchdog 仍能 3 次失败后重启。
5. QR waiting 状态不触发 unfunctional restart。

### 8.2 Session continuity

1. 新 WeChat peer 第一次消息创建 session 后，state file 立即出现对应 activeSessions mapping，不需要等 AI 回复完成。
2. 在第一条消息入队后、AI 回复完成前重启 MyAgents，下一次同 peer 消息恢复同一 sessionId。
3. bridge health restart 后，同 peer 不创建新 session。
4. handover / runtime change 仍会正确更新 activeSessions，且没有重复实现散落。

### 8.3 Provider routing

1. channel override 指向 SensNova + `deepseek-v4-flash` 时，pure IM 请求进入 SessionEngine 的 `providerRoute` 与 override 一致。
2. 不会出现 DeepSeek endpoint + `mimo-v2.5-pro` 这类跨 provider/model 错配。
3. provider missing key 时返回明确 409，不 fallback 到其它 provider。
4. desktop handover owned session 继续使用 snapshot providerRoute，不被 live channel override 覆盖。
5. external runtime IM 消息不携带 builtin providerRoute。

### 8.4 Regression

1. `npm run test:unit` 覆盖 plugin bridge health 和 provider routing helper。
2. Rust 相关 tests 覆盖 activeSessions mutation-boundary persistence。
3. `npm run lint` / `npm run typecheck` / Rust clippy 不引入红线违规。
4. Windows 10 Pro 上至少手测：idle、restart、same peer continuity、provider override、quota 402 非 bug提示不被误判。

## 9. Pit-of-Success 红线对照

- Rust localhost HTTP 仍必须用 `local_http` client，不引入裸 `reqwest::Client::new()`。
- Rust spawn 仍用 `tauri::async_runtime::spawn`，不引入裸 `tokio::spawn`。
- Plugin Bridge / Sidecar 子进程环境仍走既有 bridge spawn 路径，不绕过 `apply_to_subprocess`。
- IM/Cron provider routing self-resolve 必须 disk-first，不能信任 React state。
- 新增同步/注入/等待 turn 类 endpoint 必须走 `src/server/session-engine/` facade。本期 `/api/im/enqueue` 已在 engine facade 内，保持这个边界。
- builtin provider route materialization 复用 `providerEnvForRouteRequest` / `materializeProviderRouteEnv`，不复制一套 provider env 解析。
- 不把 `providerEnvJson` 当新权威字段写入，不持久化 API key blob。
- Node fetch 如新增插件 reload HTTP 调用，必须用 cancellable fetch / abort signal；本期 health pure function 不涉及。
- 新增 helper/normalizer 尽量是纯函数并配 unit test。

## 10. 开放问题

1. openclaw-weixin 是否能上报真正的 transport heartbeat（`lastPollSuccessAt`）？如果不能，本期仍可先把 stale event 改成 diagnostic，不阻塞。
2. `gatewayStatus.running:false` 在 openclaw-weixin 当前实现里是否只表示 terminal stopped？如果插件把 backoff 暂态写成 false，需要在 bridge adapter normalize，而不是直接 503。
3. 旧版本 `triggerWeixinChannelReload` 属于插件内部还是 MyAgents 旧代码？当前仓库无符号。本期通过 normalizer 单点化预防，不追旧符号。
4. 已碎片化的 9 个 openclaw-weixin sessions 是否需要用户可控 migration 工具？这需要另起 PRD，因为它涉及用户确认和 identity 证据。

## 11. 反向边界

实现过程中不要做以下“看似顺手”的事：

1. 不把 monitor backoff 拉长来掩盖 false health。
2. 不把 `/health/functional` 简单改成永远 200。
3. 不在 Plugin Bridge 保存 MyAgents session mapping。
4. 不扫 `sessions.json` 自动把最新 Weixin session 绑回 current peer。
5. 不把 pure IM session 一律 snapshot-owned。
6. 不在 providerId 明确但不可用时 fallback 到 first available provider。
7. 不把 `/identity` null 升级成 error。
8. 不删除非空 legacy `im_bots` 目录。

## 附录 A：Issue #413 当前结论摘要

GitHub #413 当前实际需要修的点：

1. Bridge health check fail。
2. Monitor 频繁重启。
3. activeSessions 映射易失。
4. 400 model name 新变种：routing 漂移到错误 provider。
5. Channel override 在 session resume / pure IM enqueue 中不稳定。
6. 旧 session 恢复可能携带过期 provider 配置。

不作为本期 bug 修：

1. 402 quota，属于 SensNova 5 小时 quota window 用尽。
2. `/identity null`，当前无 resolver 时 expected diagnostic。
3. stale empty `im_bots` 目录，属于 hygiene。

## 附录 B：本机日志抽样证据

本机 unified logs 中存在如下模式：

```text
[bridge:openclaw-weixin] /health/functional returned 503 Service Unavailable, failure 1/3,
status={"ok":true,"pluginName":"@tencent-weixin/openclaw-weixin","pluginId":"openclaw-weixin","ready":true,
"waitingForQrLogin":false,"gatewayStatus":{"accountId":"...@im.bot","running":true,"lastStartAt":...,"lastEventAt":...}}

[bridge:openclaw-weixin] Bridge process appears dead (3 consecutive health check failures), exiting listen loop
[im] Listen loop for bot ... exited unexpectedly, marking as error
```

这说明被杀时 bridge 并非显式 unready，gateway 也显示 running true；false health 的关键是 stale event。

## 附录 C：实现后建议回复 issue 的说明

修复完成后，issue 回复应把用户可见变化说清楚：

1. 修掉 health status contract 后，Weixin channel 不会因为业务空闲被 watchdog 重启；但 `getUpdates` heartbeat 真实 stale 时仍会明确重启。
2. activeSessions 在 binding 创建时立即持久化，bridge/app restart 后同一 peer 会继续同一 session。
3. pure IM provider routing 改为 ProviderRoute 原子路由，channel override 不再和旧 session/providerEnv 分裂。
4. 402 quota 不是 MyAgents bug；配额窗口恢复后会正常。
5. 旧碎片 session 不会自动合并，避免无证据错接上下文；如需要，可后续提供用户确认的 migration 工具。
