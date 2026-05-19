# Browy

[English](README.md) | [简体中文](README.zh-CN.md)

**住在浏览器里的 AI 智能体。** 一个 Chromium 浏览器扩展（Chrome、Edge、Brave），通过对话驱动你真实的、已登录的标签页。侧边栏适合日常工作，DevTools 面板 CLI 适合高级用户。复用你已有的 GitHub Copilot 订阅。

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-early%20access-blueviolet)](#状态)
[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-live-brightgreen)](https://chromewebstore.google.com/detail/iondecjdokngnlkfpipgolgkfegpmjca)
[![Docs](https://img.shields.io/badge/docs-browyhq.github.io-blue)](https://browyhq.github.io/zh-cn/)

<p align="center">
  <img src="docs/screenshots/browy-demo.gif" alt="Browy 实际效果：侧边栏、DevTools CLI、表单填写、网络读取" width="640" />
</p>

> ⚠️ **早期版本（v0.1.x）。** Browy 处于预览阶段。API、工具和磁盘格式可能在小版本之间发生变化。破坏性变更会在
> [CHANGELOG.md](CHANGELOG.md) 中记录。

---

## 目录

- [Browy 是什么](#browy-是什么)
- [快速安装](#快速安装)
- [安装会放下什么](#安装会放下什么)
- [两种和 Browy 交互的方式](#两种和-browy-交互的方式)
- [实用示例](#实用示例)
- [Browy 的不同之处](#browy-的不同之处)
- [Browy 与同类项目对比](#browy-与同类项目对比)
- [项目结构](#项目结构)
- [状态](#状态)
- [负责任的 AI](#负责任的-ai)
- [贡献](#贡献)
- [安全](#安全)
- [许可证](#许可证)

---

## Browy 是什么

Browy 是一个浏览器 AI 智能体。你把它装成一个 Chromium 扩展；它会在浏览器里增加两个 UI 表面（侧边栏对话和 DevTools 面板 CLI），两边都通过一个跑在你机器上的小型 Node 原生消息主机和模型通信。主机包装了
[GitHub Copilot SDK](https://www.npmjs.com/package/@github/copilot-sdk)，所以每一次模型调用都走你已有的 Copilot 订阅，不需要额外的 API key。

智能体通过 Chrome DevTools Protocol（用 `chrome.debugger`）驱动当前激活的标签页。它从可访问性树（屏幕阅读器读的同一棵树）上读取页面，按索引点击和输入，捕获网络与控制台事件，并在结构化工具不够用时执行 JavaScript。

**Browy 是给单个人类操作员用的生产力工具，不是用来在别人服务上跑无人值守自动化的工具。** 你指向一个标签页；它读取并对那个标签页采取动作；你在对话里实时看到每一步动作。回路里没有 Browy 的服务器，也没有别人可以靠跟它说话来淹没的收件箱。

可以理解为浏览器里的 Claude Code 或 Aider。Browser-Use 和 Skyvern 的开源替代品。

---

## 快速安装

### 第一步：安装扩展

[**在 Chrome Web Store 添加 Browy**](https://chromewebstore.google.com/detail/iondecjdokngnlkfpipgolgkfegpmjca)（一键）。同一份商店页面覆盖 Chrome、Edge 和 Brave。

**✓ 确认：** 把工具栏图标固定。点击它。侧边栏应该打开，并显示"主机未连接"提示。这是预期行为，第二步会修复。

### 第二步：安装本地原生消息主机

**Windows**（自带 Node，约 130 MB）：

```powershell
irm https://github.com/BrowyHQ/browy/releases/latest/download/install.ps1 | iex
```

**macOS / Linux**：

```bash
curl -fsSL https://github.com/BrowyHQ/browy/releases/latest/download/install.sh | bash
```

**✓ 确认：** 重新打开侧边栏。"主机未连接"提示应该消失。如果还在，运行
`browy --version`（Windows: `& "$env:LOCALAPPDATA\Browy\app\browy.exe" --version`）确认二进制已经装好。

### 第三步：登录 Copilot

点击侧边栏里的 **Sign in to GitHub Copilot**。会有一个终端窗口打开，里面是 device-flow 链接。把验证码粘贴到浏览器、授权 Browy，终端会自动关闭。

**✓ 确认：** 在任意一个标签页里输入"这个页面的标题是什么"。你应该看到一次 `snapshot` 工具调用，然后是流式回复。

完成了。试试[第一次对话](https://browyhq.github.io/zh-cn/first-chat/)里的五个具体例子。

> **从中国大陆访问？** GitHub Releases 和 `api.githubcopilot.com` 都可达但偏慢。参见[中国开发者指南](https://browyhq.github.io/zh-cn/china-setup/)里的
> `BROWY_RELEASE_URL` 镜像方案和延迟说明。

---

## 安装会放下什么

安装脚本保守，下面所有东西在重启和升级时原地保留。

| 路径 | 内容 |
|---|---|
| `%LOCALAPPDATA%\Browy\app\`（Windows） | 原生消息主机二进制、自带的 Node、辅助脚本 |
| `~/.browy/app/`（macOS / Linux） | 同上 |
| `~/.browy/data/files/` | 沙箱化的临时磁盘，`save_file` / `read_file` 工具操作的就是这里 |
| `~/.browy/data/notes.json` | 跨对话的持久化键值记忆 |
| `~/.browy/host/host.log` | 单文件循环 5 MB 诊断日志（轮转时被覆盖） |
| 原生消息清单 | 注册到 Chrome、Edge、Brave，让扩展能和主机通信 |
| Chrome 扩展存储 | 对话历史、模型选择、主题；永远不离开本地浏览器配置 |

这个表里没有任何东西会离开你的机器。智能体读取的页面内容会发给 GitHub Copilot，和你在终端里跑
`gh copilot` 是同一条通道。完整数据处理说明在 [browyhq.github.io/zh-cn/privacy/](https://browyhq.github.io/zh-cn/privacy/)。

---

## 两种和 Browy 交互的方式

| 表面 | 什么时候用 |
|---|---|
| **侧边栏对话** | 日常标签页自动化、抓取、表单填写、多标签任务。用工具栏图标或键盘快捷键打开。按浏览器配置持久化历史。 |
| **DevTools 面板 CLI** | 在 inspector 旁边的高级用户 REPL。斜杠命令（`/help`、`/model`、`/clear`、`/login`、`/js`）、键盘快捷键、按标签页的智能体会话。 |

两个表面共享会话状态、模型选择和对话历史。DevTools CLI 是给键盘驱动的工作流准备的；其他场景都用侧边栏。

---

## 实用示例

Browy 处理得很好的真实任务。每一项都链接到完整对话记录和截图。

- **批量抓取 YC 创业目录**：*"列出所有 2026 年秋季 YC 公司，附地点和一句话介绍。"*
- **审一个 GitHub PR**：*"总结这个 PR 的改动，标出任何看起来风险高的地方。"*
- **设置 Gmail 过滤器**：*"把所有 no-reply@\*.atlassian.net 的邮件自动归档。"*
- **跨多个标签页填注册表单**：多步、跨页、提交前停下来。

带截图的引导式演示见[第一次对话](https://browyhq.github.io/zh-cn/first-chat/)。

---

## Browy 的不同之处

- **作用在你真实的浏览器配置上。** 不是无头傀儡。你的 cookie、扩展、密码管理器、登录态都还在。多数"先去 X 登录一下"的步骤直接消失。
- **基于索引的可访问性树快照。** 每一回合，Browy 给模型一份编号好的可见交互元素列表（`[12]<button>Submit</button>`）。智能体按索引点击。没有脆弱的 CSS 选择器，没有 XPath 猜测。
- **懂 DevTools。** 网络请求、控制台日志、cookie、storage、`evaluate_js` 都是一等工具。调试你正在做的应用比操作别人的应用更有价值。
- **自带模型。** 你的 Copilot 订阅暴露的任何前沿模型都能选（Claude、GPT、Gemini、Llama、Codex）。在 DevTools CLI 里用 `/model` 切换，或者在设置里选。
- **一个订阅，不会有意外账单。** Browy 建在 GitHub Copilot SDK 之上。Browy 这一层没有自己的计量表。Copilot 收你多少，Browy 就收你多少。
- **开源，Apache-2.0。** 审计主机。审计扩展。固定一个已知良好的构建。智能体循环就在一个文件里（[`src/agent/loop.ts`](src/agent/loop.ts)），工具注册表在另一个文件里（[`src/agent/tools/browser.ts`](src/agent/tools/browser.ts)）。

---

## Browy 与同类项目对比

| | **Browy** | [Browser-Use](https://github.com/browser-use/browser-use) | [Skyvern](https://github.com/Skyvern-AI/skyvern) | [Aider](https://github.com/Aider-AI/aider) |
|---|---|---|---|---|
| 开源 | ✅ Apache-2.0 | ✅ MIT | ✅ AGPL | ✅ Apache-2.0 |
| 本地运行 | ✅ | ✅（Python） | ❌ 云端 | ✅ |
| 作用在你真实的浏览器配置 | ✅ | ❌ 全新沙箱 | ❌ 云端 | 不适用（终端） |
| 浏览器扩展 UI | ✅ 侧边栏 + DevTools | ❌ | ❌ | ❌ |
| 原生 DevTools 面板 | ✅ | ❌ | ❌ | ❌ |
| 前沿模型选择 | ✅ Claude、GPT、Gemini、Llama（走 Copilot） | 按 token 的 API | 按任务 | 按 token 的 API |
| 无头 CLI 模式 | ✅ `browy run` | ✅ | ✅ | ✅ |
| 计费方式 | 你已有的 Copilot 订阅 | 按 token 的 API | 按任务 | 按 token 的 API |

---

## 项目结构

```
browy/
├── extension/             ← Chromium 扩展（侧边栏 + DevTools 面板 + 选项页）
│   └── README.md          ← 侧边栏和 DevTools CLI 的功能文档
├── src/                   ← Node 原生消息主机（TypeScript）
│   ├── agent/             ← Copilot SDK 驱动、工具注册表、页面快照
│   ├── cli/               ← 独立 CLI 入口（`browy run`）
│   ├── transports/        ← 原生消息和 WebSocket 分帧
│   └── README.md          ← 架构和本地开发说明
├── scripts/               ← 构建、暂存、打包辅助脚本
├── installer/             ← NSIS 安装器 + install.ps1 / install.sh
├── packaging/             ← 按操作系统的原生消息清单
├── tests/                 ← Vitest 测试（页面快照、脱敏、智能体循环冒烟）
└── docs/                  ← README 用的截图；站点在 browyhq.github.io
```

---

## 状态

Browy 是 **v0.1.x**，早期版本。Chrome Web Store 商店页面对 Windows、macOS、Linux 上的 Chrome、Edge、Brave 都已上线。本地主机安装器从
[GitHub Releases](https://github.com/BrowyHQ/browy/releases) 分发。

已知的粗糙边缘：

- 在比较"难搞"的单页应用（LinkedIn、Notion、Discord、Figma）上跑长链路多步自动化时，需要更好的等待和重试策略。欢迎提带复现步骤的 issue。
- 简体中文之外的本地化还没开始。
- DevTools CLI 是键盘驱动的；REPL 里的鼠标选择仍然不顺。

路线图和正在进行的工作在 [GitHub 项目看板](https://github.com/orgs/BrowyHQ/projects)和文档站
[路线图页面](https://browyhq.github.io/zh-cn/roadmap/)上。

---

## 负责任的 AI

Browy 放大一个人类操作员。它不取代操作员。

- **你看见每一个动作。** 工具调用以行内卡片的形式在侧边栏里实时渲染。Browy 不会执行任何你看不到的工具。
- **触碰主机的工具默认关闭。** Shell、文件系统和 `web_fetch` 需要在设置里显式打开，按工具粒度。
- **没有后台活动。** 智能体只在你发消息时才行动。没有轮询、没有定时任务、没有屏幕外自动化。
- **页面内容发给 GitHub Copilot。** 和在终端里跑 `gh copilot` 是同一条通道。受你的 Copilot 订阅条款约束。
- **没有 Browy 的服务器。** 维护者读不到你的对话或页面内容。我们不收集遥测。
- **智能体驱动时 Chrome 会显示它标准的调试器横幅。** 你始终知道 Browy 在不在动作。

详细的安全与威胁模型说明在 [browyhq.github.io/zh-cn/security/](https://browyhq.github.io/zh-cn/security/)。

---

## 贡献

欢迎 PR。开发循环很小，代码库刻意写得可读。

- [CONTRIBUTING.md](CONTRIBUTING.md)：环境、开发循环、风格、PR 流程
- [架构](src/README.md)：扩展 ↔ port ↔ 原生主机 ↔ Copilot SDK
- [新手友好的 issue](https://github.com/BrowyHQ/browy/labels/good%20first%20issue)
- [讨论区](https://github.com/BrowyHQ/browy/discussions)：更大的问题和设计提案

贡献者名单在 [CONTRIBUTORS.md](CONTRIBUTORS.md)。

---

## 安全

发现了漏洞？请通过 GitHub 的私密漏洞上报通道：
<https://github.com/BrowyHQ/browy/security/advisories/new>。
**请不要开公开 issue。** 完整政策在 [SECURITY.md](SECURITY.md)。

---

## 许可证

Apache-2.0。见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
