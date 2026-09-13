# 本地启动说明

本文档说明如何在本地从零启动 Dexter（CLI 与 Web 两种界面）并标注所需依赖。

---

## 1. 前置依赖

| 依赖 | 版本/说明 | 是否必需 | 用途 |
| --- | --- | --- | --- |
| **Bun** | ≥ 1.4（主运行时） | 必需 | 运行 CLI、Web 服务、测试、构建脚本 |
| **Git** | 任意较新版本 | 必需 | 拉取代码、git 依赖 |
| **Node.js** | ≥ 20 | 可选 | 仅 `gateway`（WhatsApp）脚本经 `tsx` 运行；其余均走 Bun |
| **Playwright 浏览器** | chromium | 可选 | `browser`（网页抓取）工具；缺失时该工具不可用 |
| **WSL2 (Ubuntu)** | 22.04 LTS | Windows 推荐 | 提供 POSIX shell，启用 `bash` 工具并规避原生依赖问题 |

> 支持平台：macOS / Linux 原生体验最佳；Windows 建议使用 WSL2（原因见第 7 节）。

### 运行时依赖（`package.json` 自动安装，无需手动装）
- **LLM/编排**：`@langchain/{core,openai,anthropic,google-genai,ollama,exa,tavily}`、`langsmith`、`zod`
- **CLI/TUI**：`@mariozechner/pi-tui`（终端 UI 库）
- **抓取/解析**：`playwright`、`@mozilla/readability`、`linkedom`、`turndown`、`axios`
- **存储**：`better-sqlite3`（原生模块，Node 回退用）、`bun:sqlite`（Bun 下默认，内置）、`lru-cache`
- **其他**：`@whiskeysockets/baileys`（WhatsApp 通道）、`croner`、`qrcode-terminal`、`gray-matter`、`dotenv`、`diff`

> **原生/系统级依赖需特别注意**：`better-sqlite3`（编译原生绑定）、`playwright`（首次下载浏览器）、`libsignal`（baileys 的 git 依赖）。详见第 6、7 节。

---

## 2. 安装

```bash
# 1) 克隆
git clone https://github.com/GeekTCLin/dexter.git
cd dexter

# 2) 安装主项目依赖（会自动执行 postinstall: playwright install chromium）
bun install

# 3) 安装 Web 前端依赖（web/ 是独立包，有自己的 lockfile）
cd web && bun install && cd ..
```

若使用了 `--ignore-scripts`（如 CI），需手动补装浏览器：

```bash
bunx playwright install chromium
```

> 第 3 步（Web 前端依赖）可省略：运行 `bun run web` 时会在前端未安装或未构建的情况下自动执行（见第 5 节）。

---

## 3. 配置环境变量（`.env`）

API key 存放于项目根目录的 `.env`（已被 `.gitignore` 忽略），**不写入** `.dexter/settings.json`。

```bash
# Windows PowerShell
Copy-Item env.example .env
# macOS / Linux
cp env.example .env
```

然后编辑 `.env`，至少填写一个 LLM 提供商的 key。全部变量分组如下：

| 分组 | 变量 | 必需性 |
| --- | --- | --- |
| LLM | `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` / `XAI_API_KEY` / `OPENROUTER_API_KEY` / `MOONSHOT_API_KEY` / `DEEPSEEK_API_KEY` / `OPENCODE_API_KEY` | 至少一个 |
| 本地 LLM | `OLLAMA_BASE_URL`（默认 `http://127.0.0.1:11434`）、`OLLAMA_CLOUD_API_KEY` | 使用 Ollama 时 |
| 财务数据 | `FINANCIAL_DATASETS_API_KEY` | 使用美股财务工具时 |
| 国内指数 | `DOMESTIC_INDEX_PROVIDER=eastmoney`、`DOMESTIC_INDEX_TIMEOUT_MS=15000`、可选 `DOMESTIC_INDEX_UA` | 不需要 key |
| 联网搜索 | `EXASEARCH_API_KEY` / `PERPLEXITY_API_KEY` / `TAVILY_API_KEY` / `LANGSEARCH_API_KEY` | 使用 `web_search` 时（按优先级 Exa→Perplexity→Tavily→LangSearch） |
| 社交情绪 | `X_BEARER_TOKEN` | 使用 `x_search` 时 |
| 追踪 | `LANGSMITH_API_KEY` / `LANGSMITH_ENDPOINT` / `LANGSMITH_PROJECT` / `LANGSMITH_TRACING` | 可选 |

> 也可以**启动后再输入**：CLI 里执行 `/model`，选择提供商与模型；若检测到该提供商缺少 key，会提示输入并写入 `.env`。
> `your-` 开头的占位值会被视为“未设置”。

---

## 4. 启动 CLI（终端界面）

```bash
# 正常启动
bun run start

# 开发模式（文件变更自动重启）
bun run dev
```

启动后：输入 `/` 查看命令（`/model`、`/search`、`/memory`、`/history`、`/clear`、`/help` 等）。

---

## 5. 启动 Web 界面

Web 端由两部分组成：`src/web/`（Bun HTTP + SSE 后端）与 `web/`（React + Vite 前端，独立包）。**只需一条命令**：`bun run web` 会自动完成前端依赖安装与构建（含过期检测），启动后端，并自动在默认浏览器打开带 token 的地址。

```bash
bun run web
```

首次启动若 `web/node_modules` 或 `web/dist` 不存在，会自动执行 `bun install` / `bun run build`（首次会多花一点时间）；之后仅在 `web/src` 等源文件比上次构建更新时才重新构建。

启动后终端会打印（并自动打开）：

```
Dexter web agent running at http://127.0.0.1:3777/?token=<随机token>
```

token 通过 URL 传入，之后存于 sessionStorage。

可用开关与命令：

- 自定义端口：环境变量 `DEXTER_WEB_PORT`（默认 `3777`）。
- 禁止自动打开浏览器：`DEXTER_WEB_OPEN=0`。
- 跳过自动安装/构建（例如已自行构建）：`DEXTER_WEB_SKIP_BUILD=1`。
- 仅构建前端：`bun run web:build`（等价于 `cd web && bun run build`）。
- 前端开发模式（Vite 热更新 + 后端 /api 代理，需同时跑前后端）：
  ```bash
  bun run web:dev
  ```
  单独开发前端：`cd web && bun run dev`（Vite 将 `/api` 代理到 `127.0.0.1:3777`）。
- 安全模型：仅绑定 `127.0.0.1`，每次启动生成随机 token，无登录、不监听局域网。

---

## 6. 可选：WhatsApp 网关

```bash
bun run gateway:login   # 首次登录（扫码）
bun run gateway         # 启动网关
```
需要 Node.js（脚本经 `tsx` 运行）及 baileys 相关依赖。

---

## 7. Windows 注意事项 / 常见问题

1. **`bash` 工具在 Windows 不可用（设计如此）**
   `src/tools/registry.ts` 仅在 `process.platform !== 'win32'` 时注册 `bash`（它依赖 `/bin/sh` 与 POSIX 进程组）。这是预期行为，非缺陷。需要完整能力请用 WSL2 / macOS / Linux。

2. **`libsignal`（baileys 的 git 依赖）安装失败**
   现象：`error: UNABLE_TO_VERIFY_LEAF_SIGNATURE downloading tarball @whiskeysockets/libsignal-node@github:...`。
   优先方案（安全）：配置正确的 CA 或代理，例如 `set NODE_EXTRA_CA_CERTS=<你的CA.pem>`。
   临时绕过（不安全，不推荐长期使用）：`set NODE_TLS_REJECT_UNAUTHORIZED=0 && bun install --ignore-scripts`，完成后**恢复** TLS 校验。
   若缺少该依赖，导入链（registry/agent/gateway）会报 `Cannot find package 'libsignal'`。

3. **`better-sqlite3` 原生绑定缺失**
   现象：`Could not locate the bindings file`。在 Bun 下**不影响运行**——记忆子系统优先使用内置 `bun:sqlite`，`better-sqlite3` 仅在 Node 回退路径使用。

4. **Playwright 浏览器未安装**
   现象：`browser` 工具报错或首次调用失败。执行 `bunx playwright install chromium`。

5. **`test` 在 Windows 上的失败属预期**
   `src/tools/bash/shell-runner.test.ts` 依赖 POSIX shell，在 Windows 会失败；WSL/Ubuntu 下全绿。

6. **推送/依赖下载 TLS 告警**
   Git Credential Manager 可能提示 “TLS certificate verification has been disabled”，这是全局 git 配置问题，与项目无关；建议保持 `git config --global http.sslVerify true`。

---

## 8. 目录与持久化（运行时生成，均已 gitignore）

| 路径 | 内容 |
| --- | --- |
| `.env` | API key（不要提交） |
| `.dexter/settings.json` | 提供商 / 模型 / 搜索偏好 / 记忆 / 权限设置 |
| `.dexter/messages/chat_history.json` | CLI 长期聊天历史 |
| `.dexter/conversations/<id>.json` | Web 端会话（每条会话一个文件） |
| `.dexter/memory/MEMORY.md` 与 `index.sqlite` | 持久化记忆及索引 |
| `.dexter/`（其余） | 网关会话、凭据、日志等 |

---

## 9. 校验与测试

```bash
bun run typecheck          # TypeScript 类型检查
bun test                   # 单元测试（Bun test runner）
cd web && bun run typecheck && bun run build   # 前端类型检查与构建
```

> 建议在 WSL/Ubuntu（或 CI 的 ubuntu-latest）执行完整校验，以获得全绿结果。

---

## 10. 快速开始（TL;DR）

```bash
bun install
cp env.example .env        # 填入至少一个 LLM key
bun run start              # CLI

# 或 Web（一条命令：自动安装/构建前端 + 启动 + 自动打开浏览器）
bun run web
```
