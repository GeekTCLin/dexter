# Dexter 🤖

**English** | [简体中文](README.zh-CN.md)

Dexter is an autonomous financial research agent that thinks, plans, and learns as it works. It performs analysis using task planning, self-reflection, and real-time market data — think *Claude Code, but built specifically for financial research*.

It ships with three interfaces: a terminal **CLI**, a **local web app**, and an optional **WhatsApp gateway**.

> **Unofficial fork.** This repository is a modified derivative of [virattt/dexter](https://github.com/virattt/dexter) (MIT). It is **not affiliated with or endorsed by** the original author. This fork adds a local web agent, China A-share / domestic-market data tools, keyless web search, and semantic memory. See [Acknowledgements](#-acknowledgements).

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-black.svg)](https://bun.com)
[![Language: TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org/)

## Table of Contents

- [⚠️ Disclaimer](#️-disclaimer)
- [✨ Features](#-features)
- [🏗️ Project Structure](#️-project-structure)
- [✅ Requirements](#-requirements)
- [💻 Install](#-install)
- [🚀 Run](#-run)
- [⚙️ Configuration](#️-configuration)
- [📊 Data Sources & Terms](#-data-sources--terms)
- [📚 Documentation](#-documentation)
- [🧪 Development](#-development)
- [🤝 Contributing](#-contributing)
- [🙏 Acknowledgements](#-acknowledgements)
- [📄 License](#-license)

## ⚠️ Disclaimer

This project is for **educational, entertainment, and informational purposes only**. It is not intended for real trading or investment.

- Not financial, investment, tax, or legal advice
- No guarantees of accuracy, completeness, or fitness for any purpose
- Outputs may be incorrect, incomplete, or out of date
- Creator and contributors assume no liability for any financial losses or damages
- Consult a licensed financial advisor before making investment decisions
- Past performance does not indicate future results

By using this software you agree to use it solely for learning and informational purposes and accept all risks associated with its use.

## ✨ Features

### Agent core

- **Task planning** — decomposes complex questions into structured research steps
- **Autonomous tool use** — selects and executes data tools in a bounded loop (`maxIterations`)
- **Self-validation** — checks its own work and iterates until the task is complete
- **Tiered context management** — micro-compaction, compaction, and truncation with token accounting
- **Streaming** — incremental answer text, thinking text, and tool progress
- **Retry & provider abstraction** — a single LLM layer across many providers

### Interfaces

| Interface | Command | Highlights |
| --- | --- | --- |
| **CLI** | `bun run start` | Interactive terminal UI (pi-tui), slash commands (`/model`, `/search`, `/memory`, `/history`, `/clear`, `/help`) |
| **Web** | `bun run web` | Local Bun server + React/Vite SPA. Auto-installs/builds the frontend, prints a tokenized `127.0.0.1` URL, opens the browser. SSE streaming, tool timeline, tool approvals, ask-user questions, cancel, multi-conversation history, lifecycle notices, Simplified-Chinese UI |
| **WhatsApp** | `bun run gateway` | Chat with Dexter from your own WhatsApp chat (Baileys), with cron/heartbeat digests |

### Data capabilities

| Area | Tools | API key |
| --- | --- | --- |
| **China A-share indices** | `get_index_snapshot`, `get_index_snapshots`, `get_index_prices` — 9 indices (上证综指, 深证成指, 创业板指, 沪深300, 中证500, 科创50, 中证1000, 上证50, 上证180); Eastmoney primary, Tencent fallback | **Not required** |
| **China market news & sentiment** | `domestic_search` with `flash` (7×24 news wire), `sentiment` (股吧 retail posts), `news` (keyword search), `announcements` (CNINFO official filings + PDF links) | **Not required** |
| **General web search** | `web_search` — keyless Bing (CN) + Baidu by default; optional Exa / Tavily / LangSearch fallbacks | **Not required** (optional keys as fallbacks) |
| **US financials & filings** | `get_financials`, `get_market_data` (US part), `read_filings`, `stock_screener` via `financialdatasets.ai` — **US markets only**. These tools are hidden from the model when the key is absent | `FINANCIAL_DATASETS_API_KEY` |
| **X / Twitter** | `x_search` — recent tweets, profiles, threads (last 7 days) | `X_BEARER_TOKEN` |

### Memory, skills, scheduling

- **Memory** — SQLite hybrid retrieval (vector similarity + FTS5 BM25), temporal decay and MMR re-ranking, session indexing
- **Semantic embeddings** — auto-selects OpenAI → Gemini → any OpenAI-compatible endpoint → local **Ollama**; degrades gracefully to keyword-only search when none is configured
- **Skills** — `SKILL.md`-based workflows discovered at startup (a DCF valuation skill is built in)
- **Scheduling** — durable cron jobs plus a heartbeat digest

### Model providers

OpenAI · Anthropic · Google · xAI · OpenRouter · Moonshot · DeepSeek · **OpenCode Go** · Ollama (local) · Ollama Cloud.
Switch at runtime from the CLI (`/model`), the web Settings page, or `.dexter/settings.json`.

## 🏗️ Project Structure

```
src/
  agent/        agent loop, prompts, context management, tool execution
  web/          local web agent backend (Bun HTTP + SSE, conversations, config)
  gateway/      WhatsApp gateway (channels, routing, sessions, heartbeat)
  tools/        tool registry and implementations
    finance/    financial data (US data, China A-share indices, formatters)
    search/     web_search, x_search, domestic_search (China news/sentiment)
    memory/ filesystem/ bash/ browser/ subagent/ cron/ ...
  memory/       persistent memory store + hybrid retrieval index
  model/        multi-provider LLM abstraction
  controllers/ components/   CLI UI layer
  skills/       SKILL.md discovery and loading
  evals/        LangSmith evaluation runner
web/            standalone React + Vite + Tailwind frontend for the web agent
docs/           setup and design documentation
```

## ✅ Requirements

- [Bun](https://bun.com) **v1.0+** (primary runtime for the CLI, web agent, and tests)
- Git
- Node.js **v20+** *(optional — only for the WhatsApp gateway, which runs through `tsx`)*
- At least one LLM provider API key
- *Optional:* Docker/WSL2 Ubuntu for a CI-parity environment; Playwright Chromium for the `browser` tool

**Installing Bun**

```bash
# macOS / Linux
curl -fsSL https://bun.com/install | bash

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"

bun --version
```

## 💻 Install

```bash
git clone https://github.com/GeekTCLin/dexter.git
cd dexter

# Install project dependencies (runs postinstall: playwright install chromium)
bun install
```

If you installed with `--ignore-scripts`, install the browser separately:

```bash
bunx playwright install chromium
```

The web frontend is a standalone package under `web/` — you do **not** need to install or build it manually; `bun run web` does it for you.

## 🚀 Run

### CLI

```bash
bun run start     # interactive
bun run dev       # watch mode
```

### Web app

```bash
bun run web
```

This single command installs/builds the frontend when needed (staleness-aware), starts the backend on `127.0.0.1`, prints a tokenized URL such as `http://127.0.0.1:3777/?token=…`, and opens your browser.

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `DEXTER_WEB_PORT` | `3777` | Backend port (bound to `127.0.0.1` only) |
| `DEXTER_WEB_OPEN` | unset | Set to `0` to skip auto-opening the browser |
| `DEXTER_WEB_SKIP_BUILD` | unset | Set to `1` to skip the frontend install/build step |
| `bun run web:dev` | — | Vite dev server with `/api` proxy to the backend |
| `bun run web:build` | — | Build the frontend only |

The server binds to `127.0.0.1`, requires a per-launch random token, and has no login or LAN exposure.

### WhatsApp gateway

```bash
bun run gateway:login   # scan the QR code once
bun run gateway         # start the gateway
```

## ⚙️ Configuration

Copy `env.example` to `.env` (gitignored) and fill in what you need.

```bash
cp env.example .env
```

| Group | Variables | Required |
| --- | --- | --- |
| LLM | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, `MOONSHOT_API_KEY`, `DEEPSEEK_API_KEY`, `OPENCODE_API_KEY` | At least one |
| Local LLM | `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`), `OLLAMA_CLOUD_API_KEY` | Only for Ollama |
| Memory embeddings | `MEMORY_EMBEDDING_MODEL`, `MEMORY_EMBEDDING_TIMEOUT_MS`, or `MEMORY_EMBEDDING_BASE_URL` / `MEMORY_EMBEDDING_API_KEY` | Optional — falls back to keyword search |
| US financial data | `FINANCIAL_DATASETS_API_KEY` | Only for US data (US markets only) |
| China indices | `DOMESTIC_INDEX_PROVIDER=eastmoney`, `DOMESTIC_INDEX_TIMEOUT_MS`, optional `DOMESTIC_INDEX_UA` | No key needed |
| Web search | Keyless Bing (CN) / Baidu; optional `EXASEARCH_API_KEY` / `TAVILY_API_KEY` / `LANGSEARCH_API_KEY` | Default works with no keys |
| Social | `X_BEARER_TOKEN` | Only for `x_search` |
| Tracing | `LANGSMITH_API_KEY`, `LANGSMITH_ENDPOINT`, `LANGSMITH_PROJECT`, `LANGSMITH_TRACING` | Optional |

- API keys can also be entered **after startup**: the CLI `/model` flow prompts for a missing key and writes it to `.env`; the web Settings page does the same.
- Values beginning with `your-` (the placeholder text in `env.example`) are treated as **unset**.
- Runtime preferences (`provider`, `modelId`, search provider, memory toggle, permissions) live in `.dexter/settings.json`.

### Local semantic memory (optional)

```bash
# install Ollama, then pull a Chinese-friendly embedding model
ollama pull bge-m3
```

```bash
# .env
MEMORY_EMBEDDING_MODEL=bge-m3
MEMORY_EMBEDDING_TIMEOUT_MS=60000   # first call loads the model into RAM
```

Changing the embedding provider or model triggers a full re-embed of the memory index.

## 📊 Data Sources & Terms

The MIT license covers **this source code only**. It does not grant rights to any third-party data, and it does not override any provider's terms of service.

- **China endpoints** (Eastmoney 东方财富, Cailianpress 财联社, Sina 新浪财经, Tencent 腾讯, Bing, Baidu) are *undocumented public web interfaces*. Their site terms, robots/exclusion policies, and copyright rules apply. Commercial use or redistribution of the data may require a license from the exchange or data vendor.
- **CNINFO 巨潮资讯** is the official public-disclosure platform for mainland China listed companies. Its content is regulator-mandated public disclosure, but bulk extraction may still be restricted by site terms.
- **financialdatasets.ai** is used with your own key and contract; redistribution is restricted to plans that expressly permit it.
- You are responsible for complying with each provider's terms, `robots.txt`, and applicable law (including personal-information rules for user-generated content).

See [`NOTICE`](NOTICE) for full provenance and third-party license notes.

## 📚 Documentation

- [Local setup guide (中文)](docs/local-setup.md) — dependencies, env vars, CLI/web/gateway startup, Windows notes, data-source coverage and cost
- [Web agent design](docs/web-agent-design.md) — architecture, API/SSE contract, milestones
- [Domestic index data integration (中文)](docs/domestic-index-data-integration.md) — China A-share index design and endpoints

## 🧪 Development

```bash
bun run typecheck          # tsc --noEmit
bun test                   # Bun test runner
bun test --watch           # watch mode

cd web && bun run typecheck && bun run build   # frontend
```

CI runs typecheck and tests on Linux with Bun, plus a separate build job for `web/`.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

Please keep pull requests small and focused — it makes review and merge much easier.

## 🙏 Acknowledgements

- [virattt/dexter](https://github.com/virattt/dexter) — the original Dexter project this repository derives from. The original project states that it is MIT licensed; this fork reproduces the MIT text in [`LICENSE`](LICENSE) and attributes the original work accordingly.
- All third-party libraries and data providers listed in [`NOTICE`](NOTICE).

This is an unofficial community fork and is not affiliated with the upstream author.

## 📄 License

[MIT](LICENSE) © 2025 Virat Singh (original project) and © 2026 GeekTCLin (modifications and additions).
