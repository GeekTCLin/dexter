# Dexter 🤖

[English](README.md) | **简体中文**

Dexter 是一个自主的金融研究 Agent：它在工作中思考、规划并自我修正，通过任务拆解、自我反思与实时行情数据完成分析。可以理解为「**专为金融研究打造的 Claude Code**」。

它提供三种使用界面：终端 **CLI**、**本地 Web 应用**，以及可选的 **WhatsApp 网关**。

> **非官方分支。** 本仓库是 [virattt/dexter](https://github.com/virattt/dexter)（MIT）的修改版衍生项目，**与原作者无任何隶属或背书关系**。本分支新增了本地 Web Agent、中国 A 股/国内市场数据工具、免 key 联网搜索与语义记忆。详见[致谢](#-致谢)。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-black.svg)](https://bun.com)
[![Language: TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org/)

## 目录

- [⚠️ 免责声明](#️-免责声明)
- [✨ 功能特性](#-功能特性)
- [🏗️ 项目结构](#️-项目结构)
- [✅ 环境要求](#-环境要求)
- [💻 安装](#-安装)
- [🚀 启动](#-启动)
- [⚙️ 配置](#️-配置)
- [📊 数据来源与使用条款](#-数据来源与使用条款)
- [📚 文档](#-文档)
- [🧪 开发](#-开发)
- [🤝 参与贡献](#-参与贡献)
- [🙏 致谢](#-致谢)
- [📄 许可证](#-许可证)

## ⚠️ 免责声明

本项目**仅用于学习、娱乐与信息参考**，不适用于真实交易或投资。

- 不构成财务、投资、税务或法律建议
- 不保证准确性、完整性或适用性
- 输出内容可能错误、不完整或过时
- 作者与贡献者不对任何财务损失或损害承担责任
- 做出投资决策前请咨询持牌财务顾问
- 历史业绩不代表未来收益

使用本软件即表示你同意仅将其用于学习与信息参考目的，并自行承担全部风险。

## ✨ 功能特性

### Agent 内核

- **任务规划** —— 将复杂问题拆解为结构化研究步骤
- **自主工具调用** —— 在受限循环内（`maxIterations`）选择并执行数据工具
- **自我校验** —— 检查自身产出并迭代直至任务完成
- **分层上下文管理** —— 微压缩、压缩与截断，并统计 token 用量
- **流式输出** —— 回答增量文本、思考文本与工具进度
- **重试与多提供商抽象** —— 统一 LLM 层，支持多种提供商

### 使用界面

| 界面 | 命令 | 特性 |
| --- | --- | --- |
| **CLI** | `bun run start` | 交互式终端界面（pi-tui）；斜杠命令 `/model`、`/search`、`/memory`、`/history`、`/clear`、`/help` |
| **Web** | `bun run web` | 本地 Bun 服务 + React/Vite 单页应用。自动安装/构建前端，打印带 token 的 `127.0.0.1` 地址并自动打开浏览器；SSE 流式输出、工具时间线、工具授权、用户提问、取消、多会话历史、生命周期提示、简体中文界面 |
| **WhatsApp** | `bun run gateway` | 在微信之外用 WhatsApp 直接对话（Baileys），支持定时任务与心跳摘要 |

### 数据能力

| 领域 | 工具 | API Key |
| --- | --- | --- |
| **中国 A 股指数** | `get_index_snapshot`、`get_index_snapshots`、`get_index_prices` —— 覆盖 9 个指数（上证综指、深证成指、创业板指、沪深300、中证500、科创50、中证1000、上证50、上证180）；东方财富为主源，腾讯为备源 | **无需** |
| **国内市场资讯与舆情** | `domestic_search`：`flash`（7×24 快讯）、`sentiment`（股吧散户帖）、`news`（关键词搜索）、`announcements`（巨潮官方公告 + PDF 直链） | **无需** |
| **通用联网搜索** | `web_search` —— 默认免 key 的 Bing（国内）+ 百度；可选 Exa / Tavily / LangSearch 作为兜底 | **无需**（可选 key 作兜底） |
| **美股财务与公告** | `get_financials`、`get_market_data`（美股部分）、`read_filings`、`stock_screener`，经 `financialdatasets.ai` —— **仅覆盖美股**。未配置 key 时这些工具不会暴露给模型 | `FINANCIAL_DATASETS_API_KEY` |
| **X / Twitter** | `x_search` —— 近期推文、用户资料、话题串（近 7 天） | `X_BEARER_TOKEN` |

### 记忆、技能与调度

- **记忆** —— SQLite 混合检索（向量相似度 + FTS5 BM25），带时间衰减与 MMR 重排，支持会话索引
- **语义嵌入** —— 自动选择 OpenAI → Gemini → 任意 OpenAI 兼容端点 → 本地 **Ollama**；未配置时自动降级为纯关键词检索
- **技能** —— 启动时发现 `SKILL.md` 工作流（内置 DCF 估值技能）
- **调度** —— 持久化定时任务与心跳摘要

### 模型提供商

OpenAI · Anthropic · Google · xAI · OpenRouter · Moonshot · DeepSeek · **OpenCode Go** · Ollama（本地）· Ollama Cloud。
可在 CLI（`/model`）、Web 设置页或 `.dexter/settings.json` 中随时切换。

## 🏗️ 项目结构

```
src/
  agent/        Agent 循环、提示词、上下文管理、工具执行
  web/          本地 Web Agent 后端（Bun HTTP + SSE、会话、配置）
  gateway/      WhatsApp 网关（渠道、路由、会话、心跳）
  tools/        工具注册表与实现
    finance/    金融数据（美股数据、中国 A 股指数、格式化器）
    search/     web_search、x_search、domestic_search（国内资讯/舆情）
    memory/ filesystem/ bash/ browser/ subagent/ cron/ ...
  memory/       持久化记忆存储与混合检索索引
  model/        多提供商 LLM 抽象层
  controllers/ components/   CLI 界面层
  skills/       SKILL.md 发现与加载
  evals/        LangSmith 评测运行器
web/            独立打包的 React + Vite + Tailwind 前端
docs/           安装与设计文档
```

## ✅ 环境要求

- [Bun](https://bun.com) **v1.0+**（CLI、Web Agent 与测试的主要运行时）
- Git
- Node.js **v20+**（*可选 —— 仅 WhatsApp 网关需要，通过 `tsx` 运行*）
- 至少一个 LLM 提供商 API Key
- *可选：* Docker/WSL2 Ubuntu 以获得与 CI 一致的环境；`browser` 工具需要 Playwright Chromium

**安装 Bun**

```bash
# macOS / Linux
curl -fsSL https://bun.com/install | bash

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"

bun --version
```

## 💻 安装

```bash
git clone https://github.com/GeekTCLin/dexter.git
cd dexter

# 安装项目依赖（postinstall 会执行 playwright install chromium）
bun install
```

若使用 `--ignore-scripts` 安装，请单独安装浏览器：

```bash
bunx playwright install chromium
```

Web 前端是 `web/` 下的独立包，**无需手动安装或构建**——`bun run web` 会自动处理。

## 🚀 启动

### CLI

```bash
bun run start     # 交互模式
bun run dev       # 文件变更自动重载
```

### Web 应用

```bash
bun run web
```

该命令会按需自动安装/构建前端（带过期检测），在 `127.0.0.1` 上启动服务，打印形如 `http://127.0.0.1:3777/?token=…` 的地址，并自动打开浏览器。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEXTER_WEB_PORT` | `3777` | 后端端口（仅绑定 `127.0.0.1`） |
| `DEXTER_WEB_OPEN` | 未设置 | 设为 `0` 可禁止自动打开浏览器 |
| `DEXTER_WEB_SKIP_BUILD` | 未设置 | 设为 `1` 可跳过前端安装/构建 |
| `bun run web:dev` | — | Vite 开发服务器，`/api` 反向代理到后端 |
| `bun run web:build` | — | 仅构建前端 |

服务仅绑定 `127.0.0.1`，每次启动生成随机 token，无登录、无局域网暴露。

### WhatsApp 网关

```bash
bun run gateway:login   # 首次扫码登录
bun run gateway         # 启动网关
```

## ⚙️ 配置

将 `env.example` 复制为 `.env`（已被 gitignore），按需填写。

```bash
cp env.example .env
```

| 分组 | 变量 | 必需性 |
| --- | --- | --- |
| LLM | `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GOOGLE_API_KEY`、`XAI_API_KEY`、`OPENROUTER_API_KEY`、`MOONSHOT_API_KEY`、`DEEPSEEK_API_KEY`、`OPENCODE_API_KEY` | 至少一个 |
| 本地 LLM | `OLLAMA_BASE_URL`（默认 `http://127.0.0.1:11434`）、`OLLAMA_CLOUD_API_KEY` | 仅使用 Ollama 时 |
| 记忆嵌入 | `MEMORY_EMBEDDING_MODEL`、`MEMORY_EMBEDDING_TIMEOUT_MS`，或 `MEMORY_EMBEDDING_BASE_URL` / `MEMORY_EMBEDDING_API_KEY` | 可选——不配则降级为关键词检索 |
| 美股财务数据 | `FINANCIAL_DATASETS_API_KEY` | 仅美股数据需要（**仅覆盖美股**） |
| 国内指数 | `DOMESTIC_INDEX_PROVIDER=eastmoney`、`DOMESTIC_INDEX_TIMEOUT_MS`，可选 `DOMESTIC_INDEX_UA` | 无需 key |
| 联网搜索 | 默认免 key 的 Bing（国内）/ 百度；可选 `EXASEARCH_API_KEY` / `TAVILY_API_KEY` / `LANGSEARCH_API_KEY` | 默认即可用 |
| 社交 | `X_BEARER_TOKEN` | 仅 `x_search` 需要 |
| 追踪 | `LANGSMITH_API_KEY`、`LANGSMITH_ENDPOINT`、`LANGSMITH_PROJECT`、`LANGSMITH_TRACING` | 可选 |

- API Key 也可在**启动后输入**：CLI 的 `/model` 流程会在缺少 key 时提示输入并写入 `.env`；Web 设置页同理。
- 以 `your-` 开头的占位值（即 `env.example` 中的示例文本）会被视为**未设置**。
- 运行时偏好（`provider`、`modelId`、搜索提供商、记忆开关、权限）保存在 `.dexter/settings.json`。

### 本地语义记忆（可选）

```bash
# 安装 Ollama 后拉取一个中文友好的嵌入模型
ollama pull bge-m3
```

```bash
# .env
MEMORY_EMBEDDING_MODEL=bge-m3
MEMORY_EMBEDDING_TIMEOUT_MS=60000   # 首次调用会把模型加载进内存
```

更换嵌入提供方或模型会触发记忆索引的全量重嵌入。

## 📊 数据来源与使用条款

MIT 许可证**仅覆盖本仓库源代码**，不授予任何第三方数据的权利，也不会覆盖或替代任何服务商的条款。

- **国内数据端点**（东方财富、财联社、新浪财经、腾讯、Bing、百度）属于*未公开文档化的网页接口*，适用各站点的服务条款、robots/反爬政策与版权规则。商业使用或再分发相关数据，可能需要向交易所或数据供应商取得授权。
- **巨潮资讯** 是中国内地上市公司的官方信息披露平台，内容属监管强制公开披露，但批量抓取仍可能受站点条款限制。
- **financialdatasets.ai** 需使用你自己的 key 与合同；其数据再分发仅限明确包含该权利的套餐。
- 你需要自行确保遵守各提供商的服务条款、`robots.txt` 与适用法律（含用户生成内容涉及的个人信息规则）。

完整的来源说明与第三方许可证信息见 [`NOTICE`](NOTICE)。

## 📚 文档

- [本地启动说明（中文）](docs/local-setup.md) —— 依赖、环境变量、CLI/Web/网关启动、Windows 注意事项、数据覆盖与成本
- [Web Agent 设计](docs/web-agent-design.md) —— 架构、API/SSE 契约、里程碑
- [国内指数数据接入（中文）](docs/domestic-index-data-integration.md) —— A 股指数设计端点说明

## 🧪 开发

```bash
bun run typecheck          # tsc --noEmit
bun test                   # Bun 测试运行器
bun test --watch           # 监听模式

cd web && bun run typecheck && bun run build   # 前端
```

CI 在 Linux + Bun 上运行类型检查与测试，并为 `web/` 单独设置构建任务。

## 🤝 参与贡献

1. Fork 本仓库
2. 创建特性分支
3. 提交修改
4. 推送到分支
5. 发起 Pull Request

请尽量保持 PR 小而聚焦，便于审查与合并。

## 🙏 致谢

- [virattt/dexter](https://github.com/virattt/dexter) —— 本仓库所衍生的原始 Dexter 项目。原项目声明采用 MIT 许可证；本分支在 [`LICENSE`](LICENSE) 中复现 MIT 文本，并对原始作品作出署名。
- [`NOTICE`](NOTICE) 中列出的全部第三方库与数据提供商。

本项目是非官方社区分支，与上游作者无隶属关系。

## 📄 许可证

[MIT](LICENSE) © 2025 Virat Singh（原始项目）与 © 2026 GeekTCLin（修改与新增部分）。
