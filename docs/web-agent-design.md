# Dexter Web Agent 设计（本地单人版）

> 本文是设计与决策的权威记录（经四轮确认）。实现以此为准。

## 1. 目标与范围

- 目标：为 Dexter 提供一个比终端更好用的**本地 Web 界面**。
- v1：打开页面 → 配置 API → 对话；整体功能与 CLI 大致对齐。
- 长期：Web 逐步成为主力界面，CLI 保留给脚本/开发。
- **v1 非目标**：远程/LAN 访问、多用户与鉴权体系、多会话侧边栏、图表与分享导出、消息队列/插话、规则与心跳管理。

## 2. 决策摘要

| # | 决策 | 选择 |
|---|---|---|
| Q1 | 部署形态 | 本地单人版，绑定 `127.0.0.1` |
| Q2 | v1 价值 | 进页面配置 API + 对话，功能≈CLI；富输出/多会话/流式后续深化 |
| Q3 | 与 CLI 关系 | v1 增量并存，目标形态 Web 主力 |
| Q4 | 架构与落位 | Dexter 仓库内新增 `src/web/`，Bun HTTP 服务直接驱动 `Agent` |
| Q5 | 前端栈 | React + TypeScript + Vite + Tailwind（`web/` 子目录 SPA） |
| Q6 | 会话模型 | v1 单活跃会话，数据结构预留 `conversationId` |
| Q7 | 配置面 | provider/model、API key、搜索源、记忆开关 |
| Q8 | 安全边界 | 仅 `127.0.0.1` + 每次启动随机 token；不开 LAN |
| Q9 | 视觉方向 | 沉稳「研究工作站」：浅/深色、事件用等宽、单一强调色 |
| Q10 | 传输 | SSE 下行 + 普通 POST 上行 |
| Q11 | 前端组织 | `react-router-dom`（`/`、`/settings`）+ `zustand` + 自写 SSE hook |
| Q12 | 构建 | 开发 Vite(proxy `/api`) / 生产 `vite build` 由 Bun 托管；`bun run web`、`bun run web:dev` |
| Q13 | 工具权限 | 新增 `web` 通道，CLI 等价：保留 `bash` 与 `ask_user_question` |
| Q14 | 命令对齐 | v1：model、search、memory、clear、history、help |
| Q15 | wire 格式 | SSE `event: agent` + `data:{runId,seq,type,payload}`；大结果走 `resultRef` |
| Q16 | 持久化 | `.dexter/conversations/<id>.json` 为 Web 真相源 + 继续写平铺 `chat_history.json` |
| Q17 | CI | `web/` 独立包，CI 新增 `web` job（typecheck + build） |
| Q18 | v1 交互 | 发消息/流式/停止/审批/追问表单/Markdown+表格；缓：队列、子代理树、图表、导出 |
| Q19 | 里程碑 | M1 后端骨架 → M2 聊天闭环 → M3 交互 → M4 配置与会话 |

## 3. 架构总览

```
浏览器 (web/ React SPA)
   │  POST /api/chat            ┌───────────────────────────────┐
   │  GET  /api/runs/:id/events  │  src/web/  Bun HTTP 服务       │
   │  POST /api/runs/:id/*       │  RunManager ── Agent.create()  │
   └────────────────────────────►│  for await (event of run())    │
                                 │  → SSE 下行                    │
                                 └──────────────┬────────────────┘
                                                │ 复用
                          src/agent/*, src/utils/{config,model,env}, src/memory/*
```

- 单进程：Bun HTTP 服务既提供 JSON/SSE API，也托管前端构建产物。
- 直接调用 `Agent`（不经过 `src/gateway/` 的 WhatsApp 频道机制）。
- 事件来源即 `Agent.run(query): AsyncGenerator<AgentEvent>`（`src/agent/agent.ts:128`），事件类型见 `src/agent/types.ts:294`。

## 4. 后端 API 契约

鉴权：所有 `/api/*` 需 `X-Dexter-Token: <token>`，或 `?token=<token>`（`EventSource` 无法设自定义头，故 SSE 走查询参数）。token 每次启动随机生成，随启动横幅打印。

| Method | Path | Body / Query | 返回 |
|---|---|---|---|
| POST | `/api/chat` | `{conversationId?, message}` | `{runId, conversationId}` |
| GET | `/api/runs/:runId/events` | `?token=&from=<seq>` | SSE 流 |
| POST | `/api/runs/:runId/approve` | `{decision}` | `{ok}` |
| POST | `/api/runs/:runId/answer` | `{answers, declined?}` | `{ok}` |
| POST | `/api/runs/:runId/cancel` | — | `{ok}` |
| GET | `/api/tool-results/:id` | — | 完整工具结果 |
| GET | `/api/config` | — | `{provider, modelId, models, searchProvider, memoryEnabled, hasApiKey}` |
| POST | `/api/config/model` | `{provider, modelId}` | `{ok}` |
| POST | `/api/config/api-key` | `{provider, key}` | `{ok}` |
| POST | `/api/config/search` | `{searchProvider}` | `{ok}` |
| POST | `/api/config/memory` | `{enabled}` | `{ok}` |
| GET | `/api/conversations` | — | 会话列表 |
| GET | `/api/conversations/:id` | — | 会话详情 |

`decision ∈ 'allow-once' | 'allow-session' | 'allow-always' | 'deny'`（`src/agent/types.ts:38`）。

### SSE wire 格式

```
id: 42
event: agent
data: {"runId":"r_x","seq":42,"type":"tool_end","payload":{...}}

```

- `seq`：单调递增，支持 `Last-Event-ID`/`?from=` 补发。
- `type` = `AgentEvent` 的判别字段；`payload` = 该事件去掉 `type`。
- `tool_end.result` 体积大，仅发 `{preview, resultRef, bytes}`，完整内容走 `GET /api/tool-results/:id`。
- 流以 `event: done` 结束（`done` 携带最终 `answer`）。

## 5. Agent 集成

- `src/web/run-manager.ts`：`runId → { agent, conversationId, eventBuffer[], pendingApproval, pendingQuestion, abortController }`。
- `requestToolApproval`（`src/agent/types.ts:57`）实现为一个 Promise：暂存 resolver，向前端推 `tool_approval` 帧；由 `POST /api/runs/:id/approve` resolve。
- `requestUserInput`（`src/agent/types.ts:65`）同理：暂存 `{questions}`，由 `POST /api/runs/:id/answer` resolve（类型见 `src/tools/ask-user-question/types.ts`）。
- 参考实现：`src/gateway/agent-runner.ts:74` 的 `onEvent` 回调式 `for await` 循环。
- **通道**：以 `channel: 'web'` 创建 Agent；将 `'web'` 加入 `CLI_ONLY_TOOLS` 的等价白名单，使 `bash` 与 `ask_user_question` 不被剔除（当前门控在 `src/agent/agent.ts:29,85`）；并在 `src/agent/channels.ts` 增加 `web` profile。

## 6. 前端结构（`web/`）

- 路由：`/` 聊天、`/settings` 配置。
- 状态：`zustand` store（消息、活跃 run 事件、pendingApproval/pendingQuestion、连接态）。
- 传输：`EventSource`（token 走查询参数）；配置与动作走 `fetch`。
- 组件：`ChatLog`、`MessageItem`（`react-markdown`+`remark-gfm` 渲染 Markdown 与表格）、`ToolEventRow`、`ThinkingRow`、`AnswerBox`、`ApprovalDialog`、`QuestionForm`、`Composer`、`SettingsPanel`、`ConnectionBanner`。
- 样式：Tailwind；浅/深色；事件/工具行用等宽字体；单一强调色。

## 7. 配置面

复用后端既有函数：
- model：`src/utils/model.ts`（`getModelsForProvider` 等）+ `src/utils/config.ts` `getSetting/setSetting('provider'|'modelId')`。
- API key：`src/utils/env.ts` `saveApiKeyForProvider`（写 `.env`）。
- 搜索源：`setSetting('webSearchPreferredProvider')` + `SEARCH_PROVIDERS`。
- 记忆：`setSetting('memory')`（`enabled`）。

## 8. 持久化

- Web 真相源：`.dexter/conversations/<conversationId>.json`，`{id, title, createdAt, updatedAt, messages[]}`。
- 同时继续写平铺 `.dexter/messages/chat_history.json`（复用 `src/utils/long-term-chat-history.ts`），保持 CLI `/history` 一致。
- 启动加载最近会话；数据结构预留多会话。

## 9. 安全

- 仅绑定 `127.0.0.1`。
- 每次启动随机 token（`crypto.randomUUID()`/randomBytes），所有 `/api/*` 校验。
- 无账号体系；v1 不开 LAN。
- 工具调用仍受既有 permission 引擎约束（`src/permissions/`），审批在 UI 中呈现。

## 10. 构建 / 运行 / CI

- 根脚本：`bun run web`（起 API + 托管 `web/dist`）；`bun run web:dev`（并发 Vite dev + Bun API）。
- `web/` 为**独立包**（自带 `package.json`/lockfile），**不使用 root workspaces**，避免与后端锁文件互相干扰；根脚本通过 `cd web` 调用。
- Vite dev：`server.proxy['/api'] → http://127.0.0.1:3777`。
- 端口：后端 `DEXTER_WEB_PORT` 默认 `3777`。
- CI（`.github/workflows/ci.yml`）新增 `web` job：`bun install` + `tsc --noEmit` + `vite build`。

## 11. v1 交互边界

- **做**：发消息、实时流（thinking/工具/回答）、停止/取消、审批 allow/deny、多问题表单、Markdown + 表格、错误展示。
- **缓**：消息队列/插话、子代理树可视化、图表、分享导出。

## 12. 里程碑与验收

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 后端骨架 | Bun 服务 + 启动 token + `POST /api/chat` + `GET /api/runs/:id/events`（SSE，单 run） | `curl` 能收到完整事件序列 |
| M2 聊天闭环 | 前端发消息 → 流式渲染 thinking/工具/回答（Markdown+表格） | 浏览器端到端可对话 |
| M3 交互 | 审批 + `ask_user_question` 桥接 + 停止/取消 | 审批/追问/取消均可用 |
| M4 配置与会话 | provider/model、API key、搜索源、记忆开关 + 会话持久化 | 配置生效并落盘，重启可恢复 |

总验收：根 `bun run typecheck`、现有 `bun test` 全绿、CI `web` job 通过、手动 E2E 脚本。

## 13. 风险与未决

- `EventSource` 不能设自定义头 → token 走查询参数（已在设计中处理）。
- 大工具结果需引用化，避免 SSE 帧过大。
- `bash` 工具在 Windows 平台本就禁用（`src/tools/registry.ts:221`），Web 端同样受限。
- 断线重连依赖 `seq`/`Last-Event-ID` 补发。
- 前端依赖（React/Vite）安装需要网络。
