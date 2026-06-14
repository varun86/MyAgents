<div align="center">

# MyAgents

**活在你的电脑里，真正能干活的个人 Agent**

[中文](#中文) | [English](#english)

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![macOS](https://img.shields.io/badge/macOS-13.0+-black.svg)](https://www.apple.com/macos/)
[![Windows](https://img.shields.io/badge/Windows-10+-blue.svg)](https://www.microsoft.com/windows/)
[![Website](https://img.shields.io/badge/Website-myagents.io-green.svg)](https://myagents.io)

**官网**: [https://myagents.io](https://myagents.io)

![MyAgents Screenshot](index.png)

</div>

---

<a name="中文"></a>

## 中文

MyAgents 是一款开源桌面端 AI Agent，同时具备「Claude Code」的强大 Agent 能力和灵活的 IM Bot 交互——二合一，一键安装零门槛。

截止 2026 年 1 月，AI 的智能飞速提升，已经让软件开发者首先变成了十倍百倍生产力的人。而 2026 年注定是智能丰裕的元年，我们希望这股 AI 的力量能被更多的人所掌握，无论你是学生、内容创作者、教育工作者、各种行业专家、产品经理等任何一个「想要去做些什么的人」。我们希望「MyAgents」能为你的电脑注入灵魂，让他成为你的思维放大器，将你的品味、想法变成现实对世界产生更大的影响。

### 快速体验
- 直接访问 https://myagents.io 点击下载安装包
- Mac 版本支持 Apple Silicon 和 Intel 芯片
- Win 版本支持 Windows 10 及以上

### 核心能力

- **图形界面零门槛** - Chrome 风格多标签页，每个 Tab 独立运行一个 Agent，真正的并行工作流
- **多 Agent Runtime（实验室）** - 除内置 Claude Agent SDK 外，可选 **Claude Code CLI** 或 **OpenAI Codex CLI** 作为外部 Runtime，按场景挑顺手的引擎
- **多模型自由切换** - Anthropic、DeepSeek、Moonshot、智谱、MiniMax、火山方舟、ZenMux、硅基流动、OpenRouter 等 10+ 供应商，按需选择，成本可控
- **Skills 技能系统** - 把常用流程沉淀成 Agent 可复用的能力模块，内置 + 自定义双轨
- **MCP 工具集成** - 内置 MCP 协议支持（STDIO/HTTP/SSE），连接外部工具和数据源，Agent 能力可无限扩展
- **自定义 Agent** - 配置独立的 Prompt、工具、模型，打造专属 Agent
- **Agent + Channel 架构** - 内置 Telegram / 钉钉适配器，更多 IM 平台（飞书 / 微信 / QQ 等）通过 OpenClaw 插件接入；支持多 Bot 管理、交互式权限审批、多媒体消息
- **定时任务系统** - 固定间隔 / Cron 表达式 / 一次性三种调度，Chat 内、AI 工具调用、IM Bot 全场景可用
- **内嵌终端** - 分屏右侧交互式 PTY（xterm.js + portable-pty），自动定位到工作区目录，与 Tab 共享生命周期
- **内嵌浏览器** - Tauri 多 Webview 子视图，AI 生成的链接和 HTML 文件一键预览，独立 Cookie 持久化
- **全文搜索** - 基于 Tantivy + jieba 的本地搜索引擎，Session 历史与工作区文件秒级检索，纯本地不上传
- **自配置 CLI 与 MA 小助理** - 内置 `myagents` 命令让 AI 和用户都能通过 Bash 直接管理应用配置；MA 小助理是产品首席客服，能直接帮你诊断问题、配置工具
- **智能权限管理** - 行动 / 规划 / 自主三种模式，安全可控
- **本地数据，持续进化** - 所有对话、文件、记忆都存在本地，隐私有保障，API 直连供应商。随着使用积累，你的 AI 会越来越懂你
- **完全开源免费** - Apache-2.0 协议，代码完全公开

### 支持的模型供应商

| 供应商 | 模型 | 类型 |
|--------|------|------|
| Anthropic | Claude Sonnet 4.6, Opus 4.6, Haiku 4.5 | 订阅/API |
| DeepSeek | DeepSeek Chat, Reasoner | API |
| Moonshot | Kimi K2.5, K2 Thinking, K2 | API |
| 智谱 AI | GLM 5, 4.7, 4.5 Air | API |
| MiniMax | M2.5, M2.5 Lightning, M2.1, M2.1 Lightning | API |
| 火山方舟 Coding Plan | Doubao Seed 2.0 Code, GLM 4.7, DeepSeek V3.2, Kimi K2.5 | API |
| 火山方舟 API调用 | Doubao Seed 2.0 Pro, Code Preview, Lite | API |
| ZenMux | ZenMux Auto, Gemini 3.1 Pro, Claude 4.6, Doubao Seed 2.0 等 | API |
| 硅基流动 | Kimi K2.5, GLM 4.7, DeepSeek V3.2, Step 3.5 Flash 等 | API |
| OpenRouter | GPT-5.2 Codex, GPT-5.2 Pro, Gemini 3 等多模型 | API |

### 系统要求

#### 最终用户

- **macOS 13.0 (Ventura)** 或更高版本，支持 Apple Silicon 和 Intel 芯片
- **Windows 10** 或更高版本

#### 开发者

- macOS 13.0+ / Windows 10+ / Linux（Ubuntu 20.04+ AppImage/deb）
- [Node.js](https://nodejs.org) (v20+) - 开发时需要；生产构建内置 Node.js v24，最终用户无需安装
- [Rust](https://rustup.rs)（必须通过 rustup 安装；仓库根目录 `rust-toolchain.toml` 固定实际 toolchain）

### 快速开始（开发者）

#### 安装

```bash
git clone https://github.com/hAcKlyc/MyAgents.git
cd MyAgents
./setup.sh
```

#### 构建

```bash
# Debug 构建 (含 DevTools)
./build_dev.sh

# 生产构建 (macOS DMG)
./build_macos.sh

# 生产构建 (Windows NSIS)
# PowerShell: .\build_windows.ps1
```

### 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri v2 (Rust) + 多 Webview |
| 前端 | React 19 + TypeScript + TailwindCSS + xterm.js |
| Agent Runtime | Node.js v24 + Claude Agent SDK（默认）/ Claude Code CLI / OpenAI Codex CLI / Gemini CLI |
| 社区生态 | Node.js（MCP Server / npm 包 / `myagents` CLI，统一 runtime，应用内置） |
| 通信 | Rust HTTP/SSE Proxy（reqwest，统一 localhost no-proxy） |
| 终端 | portable-pty（PTY 进程）+ xterm.js（前端渲染） |
| 搜索 | Tantivy + tantivy-jieba（中文分词） |
| 插件 | OpenClaw Plugin Bridge（独立 Node.js 进程加载社区 Channel 插件） |

### 架构

**Session-Centric 多实例 Sidecar 架构** — 每个会话拥有独立的 Agent 进程，严格 1:1 隔离；多 Owner 共享机制让 Tab、定时任务、Agent Channel 安全复用同一 Sidecar；Rust 代理层统一接管所有流量，零 CORS 问题；**单一 runtime** 内置 Node.js v24（跑 Sidecar / Plugin Bridge / MCP / 社区 npm 生态 / `myagents` CLI），Windows 还附带静默安装 Git for Windows，用户无需安装任何依赖。

```
┌────────────────────────────────────────────────────────────────────┐
│                          Tauri Desktop App                         │
├────────────────────────────────────────────────────────────────────┤
│  React Frontend                                                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────────────┐ │
│  │  Chat 1  │  │  Chat 2  │  │ Settings │  │   Agent Channels    │ │
│  │  Tab SSE │  │  Tab SSE │  │ 全局 API │  │  TG / 钉钉 / 插件   │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────────┬──────────┘ │
│       │             │             │                   │            │
├───────┼─────────────┼─────────────┼───────────────────┼────────────┤
│  Rust │             │             │                   │            │
│  ┌────┴─────────────┴─────┐  ┌────┴─────┐  ┌──────────┴──────────┐ │
│  │     SidecarManager     │  │  Global  │  │    ManagedAgents    │ │
│  │  Session:Sidecar 1:1   │  │ Sidecar  │  │    Plugin Bridge    │ │
│  │  Owner Tab/Cron/Agent  │  │          │  │     (OpenClaw)      │ │
│  └────┬─────────────┬─────┘  └──────────┘  └──────────┬──────────┘ │
│       ▼             ▼                                 ▼            │
│  Node.js Sidecar  (Claude Agent SDK / CC / Codex / Gemini CLI)     │
│    + MCP Server / 社区 npm 生态 / myagents CLI（统一 runtime）     │
└────────────────────────────────────────────────────────────────────┘
```

> 完整架构说明、Session 切换机制、Owner 生命周期等详见 [技术架构文档](specs/ARCHITECTURE.md)。

### 贡献

请参阅 [CONTRIBUTING.md](CONTRIBUTING.md) 了解贡献指南。

### 许可证

[Apache License 2.0](LICENSE)

---

<a name="english"></a>

## English

MyAgents is an open-source desktop AI Agent that combines the powerful Agent capabilities of "Claude Code" with flexible IM Bot interaction — two-in-one, one-click install, zero barrier.

As of early 2026, AI capability is advancing rapidly — software developers were the first to become 10x or 100x more productive. 2026 is going to be the inaugural year of intelligence abundance. We hope MyAgents brings that power to everyone — students, content creators, educators, domain experts, product managers, anyone who *wants to make something*. We want MyAgents to be the soul of your computer, an amplifier for your taste and ideas, turning intent into impact.

### Quick Download
- Visit https://myagents.io to download the installer
- Mac version supports both Apple Silicon and Intel chips
- Windows version supports Windows 10 and above

### Core Capabilities

- **Zero-Barrier GUI** - Chrome-style multi-tab interface, each Tab runs an independent Agent for true parallel workflows
- **Multi-Agent Runtime (Lab)** - Beyond the built-in Claude Agent SDK, optionally pick **Claude Code CLI** or **OpenAI Codex CLI** as the external runtime — choose the engine that fits your task
- **Multi-Model Freedom** - Anthropic, DeepSeek, Moonshot, Zhipu, MiniMax, Volcengine, ZenMux, SiliconFlow, OpenRouter and 10+ providers, choose by need, control your cost
- **Skills System** - Codify your common workflows into reusable capability modules the Agent can invoke; built-in + custom
- **MCP Tool Integration** - Built-in MCP protocol support (STDIO/HTTP/SSE), connect external tools and data sources for unlimited extensibility
- **Custom Agents** - Configure dedicated prompts, tools, and models to build your own Agents
- **Agent + Channel Architecture** - Built-in Telegram / DingTalk adapters; more IM platforms (Feishu / WeChat / QQ etc.) plug in via the OpenClaw plugin ecosystem; multi-bot management, interactive permission approval, multimedia messages
- **Cron Task System** - Three scheduling modes — fixed interval / cron expression / one-shot — usable from Chat, AI tool calls, and IM bots
- **Embedded Terminal** - Interactive PTY in the right split panel (xterm.js + portable-pty), auto-rooted at the workspace, lifecycle bound to the Tab
- **Embedded Browser** - Tauri multi-Webview child view, AI-generated links and HTML files preview in one click, with persistent cookie store
- **Full-Text Search** - Local Tantivy + jieba search engine, sub-second retrieval over session history and workspace files — fully local, nothing uploaded
- **Self-Config CLI & MA Helper** - Built-in `myagents` command lets both AI and you manage app config from Bash; the MA Helper is the in-app support agent that diagnoses issues and configures tools for you
- **Smart Permissions** - Act / Plan / Auto modes for safety and control
- **Local Data, Continuous Evolution** - All conversations, files, and memories stay on your machine. API connects directly to providers. Your AI grows smarter the more you use it
- **Fully Open Source** - Apache-2.0 license, code fully open

### Supported Model Providers

| Provider | Models | Type |
|----------|--------|------|
| Anthropic | Claude Sonnet 4.6, Opus 4.6, Haiku 4.5 | Subscription/API |
| DeepSeek | DeepSeek Chat, Reasoner | API |
| Moonshot | Kimi K2.5, K2 Thinking, K2 | API |
| Zhipu AI | GLM 5, 4.7, 4.5 Air | API |
| MiniMax | M2.5, M2.5 Lightning, M2.1, M2.1 Lightning | API |
| Volcengine Coding Plan | Doubao Seed 2.0 Code, GLM 4.7, DeepSeek V3.2, Kimi K2.5 | API |
| Volcengine API | Doubao Seed 2.0 Pro, Code Preview, Lite | API |
| ZenMux | ZenMux Auto, Gemini 3.1 Pro, Claude 4.6, Doubao Seed 2.0 and more | API |
| SiliconFlow | Kimi K2.5, GLM 4.7, DeepSeek V3.2, Step 3.5 Flash and more | API |
| OpenRouter | GPT-5.2 Codex, GPT-5.2 Pro, Gemini 3 and more | API |

### System Requirements

#### End Users

- **macOS 13.0 (Ventura)** or later, Apple Silicon and Intel supported
- **Windows 10** or later

#### Developers

- macOS 13.0+ / Windows 10+ / Linux (Ubuntu 20.04+ AppImage/deb)
- [Node.js](https://nodejs.org) (v20+) — required at build time; Node.js v24 is bundled into production builds so end users install nothing
- [Rust](https://rustup.rs) (install via rustup; the repository pins the actual toolchain in `rust-toolchain.toml`)

### Quick Start (Developers)

#### Installation

```bash
git clone https://github.com/hAcKlyc/MyAgents.git
cd MyAgents
./setup.sh
```

#### Build

```bash
# Debug build (with DevTools)
./build_dev.sh

# Production build (macOS DMG)
./build_macos.sh

# Production build (Windows NSIS)
# PowerShell: .\build_windows.ps1
```

### Tech Stack

| Layer | Technology |
|-------|------------|
| Desktop Framework | Tauri v2 (Rust) + multi-Webview |
| Frontend | React 19 + TypeScript + TailwindCSS + xterm.js |
| Agent Runtime | Node.js v24 + Claude Agent SDK (default) / Claude Code CLI / OpenAI Codex CLI / Gemini CLI |
| Community Ecosystem | Node.js (MCP servers / npm packages / `myagents` CLI — single runtime, bundled in app) |
| Communication | Rust HTTP/SSE Proxy (reqwest, unified localhost no-proxy) |
| Terminal | portable-pty (PTY process) + xterm.js (frontend renderer) |
| Search | Tantivy + tantivy-jieba (Chinese tokenizer) |
| Plugin | OpenClaw Plugin Bridge (separate Node.js process loading community Channel plugins) |

### Architecture

**Session-Centric multi-instance Sidecar architecture** — each session owns an isolated Agent process with strict 1:1 mapping; a multi-owner mechanism lets Tabs, scheduled tasks, and Agent Channels safely share the same Sidecar; the Rust proxy layer handles all traffic with zero CORS issues. **Single runtime**: Node.js v24 is bundled for everything (Sidecar / Plugin Bridge / MCP / community npm ecosystem / `myagents` CLI), plus Git for Windows is silently installed on Windows — users install nothing.

```
┌────────────────────────────────────────────────────────────────────┐
│                          Tauri Desktop App                         │
├────────────────────────────────────────────────────────────────────┤
│  React Frontend                                                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────────────┐ │
│  │  Chat 1  │  │  Chat 2  │  │ Settings │  │   Agent Channels    │ │
│  │  Tab SSE │  │  Tab SSE │  │Global API│  │  TG / DT / Plugin   │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────────┬──────────┘ │
│       │             │             │                   │            │
├───────┼─────────────┼─────────────┼───────────────────┼────────────┤
│  Rust │             │             │                   │            │
│  ┌────┴─────────────┴─────┐  ┌────┴─────┐  ┌──────────┴──────────┐ │
│  │     SidecarManager     │  │  Global  │  │    ManagedAgents    │ │
│  │  Session:Sidecar 1:1   │  │ Sidecar  │  │    Plugin Bridge    │ │
│  │  Owner Tab/Cron/Agent  │  │          │  │     (OpenClaw)      │ │
│  └────┬─────────────┬─────┘  └──────────┘  └──────────┬──────────┘ │
│       ▼             ▼                                 ▼            │
│  Node.js Sidecar  (Claude Agent SDK / CC / Codex / Gemini CLI)     │
│    + MCP servers / community npm ecosystem / myagents CLI          │
└────────────────────────────────────────────────────────────────────┘
```

> For full details on session switching, owner lifecycle, and communication flow, see the [Architecture Documentation](specs/ARCHITECTURE.md).

### Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

### License

[Apache License 2.0](LICENSE)
