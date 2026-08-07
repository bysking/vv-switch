# vv-switch

> LLM API 协议转换代理 —— 让 Claude Code、OpenAI Codex 和 VS Code Copilot 连接任意 LLM 提供商，同时提供请求日志可视化与协议转换排查工具

[![Version](https://img.shields.io/badge/version-0.5.3--rc4-blue)](./package.json)
[![License](https://img.shields.io/badge/license-Commercial-green)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/typescript-6.x-blue)](./tsconfig.json)

## 概述

vv-switch 是一个轻量级 API 代理，运行在本地（默认http://localhost:4321），作为 Claude Code、OpenAI Codex 以及任意 OpenAI Chat Completions 客户端（如 VS Code Copilot 自定义端点）与各类 LLM 提供商之间的中间层。它支持三种客户端协议的转换与透传：

| 客户端                                      | 客户端协议                                      | 转换目标                                                      |
| ------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| **Claude Code**                       | Anthropic Messages API (`/v1/messages`)       | Chat Completions 或直转 Anthropic 兼容端点                    |
| **OpenAI Codex**                      | Responses API (`/v1/responses`)               | Chat Completions API 或原生 Responses API                     |
| **OpenAI 端点**（如 VS Code Copilot） | Chat Completions API (`/v1/chat/completions`) | Chat Completions / Anthropic 兼容端点（按供应商协议自动转换） |

通过协议转换，你可以使用 DeepSeek、阿里百炼（DashScope）、智谱等任何支持 Chat Completions、Anthropic 兼容接口或原生 Responses API 的提供商来驱动 Claude Code、Codex 和 VS Code Copilot 等客户端。

## 快速开始

### 使用 npx（推荐）

```bash

# 不带日志启动 (推荐)
npx @bysking/vv-switch

# 带日志启动服务（默认端口 4321），日志在当前目录 .vv-switch-logs，记得通过页面日志tab,及时删除日志，避免内存占用
npx @bysking/vv-switch --logs 



# 开启协议转换链路日志（用于排查协议兼容问题, 最多保留最近5轮日志）
npx @bysking/vv-switch --protocol-log
```

### 本地开发

```bash
# 克隆后安装依赖
pnpm install

# 开发模式（tsx watch + 日志）
pnpm dev

# 普通启动
pnpm start

# 打包
pnpm build
```

### 配置步骤

启动后：

1. 浏览器访问 **http://localhost:4321** 打开配置页面
2. 在 **供应商管理** 页面添加 LLM 提供商（名称、baseUrl、apiKey、模型、协议类型）
3. 在 **应用配置** 页面选择目标（Claude / Codex / OpenAI 端点），点击应用
4. 正常使用 `claude` 或 `codex` 命令即可；OpenAI 端点客户端（如 VS Code Copilot）将本地地址指向 `http://localhost:4321/v1` 即可
5. 按 `Ctrl+C` 停止服务，自动还原原始配置（OpenAI 端点无需写外部配置，故无需还原）

> 💡 新手上手可以参考根目录的 [`.vv-switch-providers.json.example`](./.vv-switch-providers.json.example) 了解配置格式。

## 功能说明

### 1. 协议转换

#### Responses API → Chat Completions（Codex 支持）

- `POST /v1/responses` → `POST /chat/completions`
- 支持流式 SSE 和非流式两种模式
- 完整支持 tool calling（多轮工具对话）
- 支持 `temperature`、`max_tokens`、`top_p`、`reasoning_effort` 等参数映射
- 推理内容（reasoning_content）转换

#### Responses API → Responses API（Codex 支持，`protocolType: "responses"`）

- `POST /v1/responses` → `POST /v1/responses`
- 适用于原生 OpenAI Responses API 或兼容端点
- 支持流式 SSE 和非流式透传
- 保留 Responses API 原始请求/响应结构，仅按供应商配置补默认 model

#### Anthropic Messages → Chat Completions（Claude 支持，`protocolType: "chat"`）

- `POST /v1/messages` → `POST /chat/completions`
- system prompt、content block 转换
- tool_use / tool_result 双向转换
- tool_choice 映射（any → required, auto → auto, tool → function）
- extended thinking block 跳过处理
- `top_k` 参数传递

#### Anthropic Messages → Anthropic Messages（Claude 支持，`protocolType: "anthropic"`）

- 直接透传 Anthropic 格式请求到上游兼容端点
- 仅替换 model 字段和修正 message ID
- 适用于 DashScope `/apps/anthropic`、智谱等原生 Anthropic 兼容端点
- SSE 流式事件直接透传，保证最小延迟

#### Chat Completions → Chat Completions / Anthropic（OpenAI 端点支持）

- `POST /v1/chat/completions` → 按活跃供应商协议转发（`chat` 转 `/chat/completions`、`anthropic` 转 `/v1/messages`）
- 面向直接使用 OpenAI Chat Completions API 的客户端，如 **VS Code Copilot 自定义端点**
- 完整支持流式 SSE（`chat.completion.chunk`）、非流式、tool calling（含增量 `tool_calls`）、`reasoning_content` 透传
- 客户端请求的 `model` 字段会被忽略，实际模型由「OpenAI 端点」活跃供应商决定

### 2. 流式支持（SSE）

全链路 SSE 流式支持，双向协议转换：

- Chat Completions SSE → Responses API SSE 事件流
- Chat Completions SSE → Anthropic Messages SSE 事件流
- Chat Completions SSE → Chat Completions SSE（OpenAI 端点，`chat.completion.chunk`）
- 上游 Anthropic SSE → 下游 Anthropic SSE 透传
- 正确的增量文本 delta、工具调用参数 delta、finish reason、usage tokens 处理

### 3. 工具调用（Tool Calling）

- 多轮工具对话完整支持
- Tool 定义、tool call、tool result 在各协议间正确映射
- 针对不支持 tool role 消息的上游提供商的降级方案（将 tool result 格式化为 user 消息发送）

### 4. 能力探测（Capability Detection）

vv-switch 会自动检测上游 LLM 提供商的能力，并据此决定是否启用降级方案：

- **Provider 自报告**：每个 provider 在 `discover()` 中返回默认能力图
- **动态探测**：对不确定的能力进行实际调用验证（如 tool calling、vision、streaming 等）
- **能力缓存**：探测结果缓存，避免重复请求
- **能力分级**：`NATIVE`（原生支持）/ `PROXY`（代理层模拟）/ `UNSUPPORTED`（不支持）

支持的能力维度：`chat`、`responses`、`tool_call`、`parallel_tool`、`reasoning`、`thinking`、`json_schema`、`stream`、`vision`、`prompt_cache` 等。

### 5. 中间件管道（Middleware Pipeline）

请求处理采用洋葱模型的中间件管道，每个请求依次经过：

| 中间件               | 职责                             |
| -------------------- | -------------------------------- |
| `auth`             | 认证鉴权                         |
| `logging`          | 请求日志记录                     |
| `metrics`          | 请求指标统计（耗时、token 数等） |
| `capability-check` | 能力检查与降级决策               |
| `rate-limit`       | 速率限制                         |
| `retry`            | 自动重试（上游失败时）           |

中间件管道支持重试场景 —— 某个中间件可以在 catch 中再次调用 `next()` 触发重试。

### 6. Prompt Rules 规则管理

支持通过正则规则动态修改请求中的消息内容，用于：

- 注入系统提示词
- 替换敏感词 / 特定表述
- 针对不同客户端调整 prompt 格式

规则存储在 `~/.vv-switch-prompt-rules.json`，可配置作用目标（`all` / `system` / `user` / `assistant`）、匹配模式、替换内容和正则标志。

### 7. 供应商管理

通过 Web UI 管理多个 LLM 提供商配置：

- 添加/编辑/删除供应商
- 连接测试（调用 `/v1/models` 端点验证）
- 每个供应商可独立设置为 Claude、Codex 和 OpenAI 端点的活跃供应商（三者互不干扰）
- 配置持久化存储在 `~/.vv-switch-providers.json`

### 8. 配置注入与自动还原

**应用配置时：**

- **Claude Code**：修改 `~/.claude/settings.json`，将 `ANTHROPIC_BASE_URL` 指向 vv-switch 代理地址，设置模型相关环境变量
- **OpenAI Codex**：修改 `~/.codex/config.toml`，添加 `vv-switch` 模型提供商
- **OpenAI 端点**：不写任何外部配置文件（客户端由用户自行指向 vv-switch），仅在 `~/.vv-switch-providers.json` 中标记 `activeForOpenai` 活跃供应商

**停止服务时：**

- 捕获 `SIGINT` / `SIGTERM` 信号
- 自动还原备份的原始配置（Claude / Codex）
- 清理活跃状态标记（含 OpenAI 端点）

### 9. 日志与可视化

- JSONL 格式日志保存在 `.vv-switch-logs/` 目录
- 内置 HTML 日志查看器，支持：
  - 会话列表、搜索过滤
  - 按调用方（claude/codex）过滤
  - JSON / Table 两种视图模式
  - 条目详情抽屉、复制功能
  - 自动刷新

### 9.1 协议日志（Protocol Log）

面向**协议转换排查**的独立日志，与上面的会话日志（`--logs`）完全解耦。每次链路调用写入一个 jsonl 文件，记录请求从入口到上游的四个关键阶段，方便定位不同模型/供应商的协议转换问题。

```bash
npx @bysking/vv-switch --protocol-log              # 默认写入 ./log
npx @bysking/vv-switch --protocol-log --no-body    # 不记录请求体（只记摘要，精简体积）
npx @bysking/vv-switch --protocol-log-dir ~/logs   # 自定义目录
```

每次链路生成 `log/<时间>-<caller>-<traceId>.jsonl`，每行一个阶段：

| 阶段         | 含义               | 记录内容                                                        |
| ------------ | ------------------ | --------------------------------------------------------------- |
| `ingress`  | 客户端原始请求协议 | Claude/Codex/OpenAI 端点拿到的原始 body + headers               |
| `standard` | 转换后的标准协议   | adapter 转出的`StandardRequest`（内部统一协议，剔除原始 raw） |
| `upstream` | 中转到上游供应商   | 上游 url / headers / body + 响应 status                         |
| `egress`   | 返回客户端         | 响应 status / 耗时 / 摘要（stopReason、toolCalls、tokens）      |

- 所有阶段共用同一 `traceId`，一次链路一个文件，每个阶段立即 append（流式长请求中途崩溃也保留已记录阶段）
- `authorization` / `x-api-key` 等 header 值自动脱敏为 `<redacted>`
- `--no-body` 时各阶段 body 记为摘要（model / messages 数 / tools 数），仅保留元信息

### 10. 接口列表

| 端点                               | 说明                                       |
| ---------------------------------- | ------------------------------------------ |
| `POST /v1/messages`              | Claude Code 入口（Anthropic Messages API） |
| `POST /v1/responses`             | Codex 入口（OpenAI Responses API）         |
| `POST /v1/chat/completions`      | OpenAI 端口入口（如 VS Code Copilot）      |
| `GET /v1/models`                 | 代理到上游`/models` 端点                 |
| `GET /health`                    | 健康检查，返回`{status: "ok", version}`  |
| `POST /v1/messages/count_tokens` | Mock token 估算（Claude Code 可能调用）    |

### 11. 接入 VS Code Copilot（OpenAI 端点）

VS Code Copilot Chat 支持通过「自定义端点」接入任意 OpenAI Chat Completions 兼容服务，vv-switch 正是这样的服务。

**步骤：**

1. 在 vv-switch 配置网页（`http://localhost:4321`）→「应用配置」→「OpenAI 端点」卡片，选择一个供应商并点击「应用」
2. 编辑 VS Code 的 `chatLanguageModels.json`（macOS 路径：`~/Library/Application Support/Code/User/chatLanguageModels.json`）：

```jsonc
[
  {
    "name": "vv-switch",
    "vendor": "customendpoint",
    "apiKey": "local",                  // 若上游不校验 key，任意占位即可
    "apiType": "chat-completions",
    "models": [
      {
        "id": "vv-switch",
        "name": "vv-switch",
        "url": "http://localhost:4321/v1",  // vv-switch 本地地址，代理会拼接 /chat/completions
        "toolCalling": true,
        "vision": true,
        "maxInputTokens": 128000,
        "maxOutputTokens": 16000
      }
    ]
  }
]
```

#### 接入 CodeBuddy

CodeBuddy 也通过 OpenAI 兼容端点接入，修改 `~/.codebuddy/settings.json`：

```json
{
  "env": {
    "CODEBUDDY_BASE_URL": "http://localhost:4321/v1"
  }
}
```

3. VS Code 命令面板执行 `Developer: Reload Window` 即可生效。

> ⚠️ 注意：`chatLanguageModels.json` 里配置的 `id` / `name` 仅用于 VS Code 展示，客户端请求的 `model` 字段会被 vv-switch 忽略——**实际调用的模型由「OpenAI 端点」卡片选定的活跃供应商决定**。

## CLI 选项

```
npx @bysking/vv-switch [options]

选项:
  -p, --port <port>       监听端口（默认 4321）
  -h, --host <host>       监听地址（默认 localhost）
  --debug                 开启调试日志
  --logs                  开启日志记录与可视化
  --logs-dir <dir>        自定义日志目录路径
  --no-body               不捕获请求/响应体到会话日志和协议日志（只记摘要，精简体积）
  --protocol-log          开启协议转换链路日志（每次链路一个 jsonl，记录四阶段）
  --protocol-log-dir <dir> 自定义协议日志目录（默认 ./log）

NPM 脚本:
  pnpm start              启动服务
  pnpm startlog           启动服务并开启日志
  pnpm dev                开发模式（tsx watch + --logs）
  pnpm build              使用 esbuild 打包
  pnpm test               运行单元测试
  pnpm test:integration   运行集成测试
  pnpm typecheck          TypeScript 类型检查
```

## 配置说明

### 供应商配置（`~/.vv-switch-providers.json`）

| 字段                | 类型    | 说明                                                                                                            |
| ------------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| `id`              | string  | UUID，自动生成的唯一标识                                                                                        |
| `name`            | string  | 显示名称，如 "DeepSeek-chat"                                                                                    |
| `baseUrl`         | string  | 上游 API 基础地址                                                                                               |
| `apiKey`          | string  | API Key                                                                                                         |
| `model`           | string  | 使用的模型名称                                                                                                  |
| `protocolType`    | string  | `"chat"` 转换为 Chat Completions；`"anthropic"` 直转 Anthropic 兼容端点；`"responses"` 直转 Responses API |
| `activeForClaude` | boolean | 是否为 Claude Code 的活跃供应商                                                                                 |
| `activeForCodex`  | boolean | 是否为 OpenAI Codex 的活跃供应商                                                                                |
| `activeForOpenai` | boolean | 是否为 OpenAI 端点（`/v1/chat/completions`，如 VS Code Copilot）的活跃供应商                                  |

### 支持的协议类型对比

| 特性       | `chat` 模式                           | `anthropic` 模式                   | `responses` 模式            | `ollama` 模式       |
| ---------- | --------------------------------------- | ------------------------------------ | ----------------------------- | --------------------- |
| 上游端点   | `/chat/completions`                   | `/v1/messages`                     | `/v1/responses`             | `/api/chat`         |
| 认证方式   | `Authorization: Bearer`               | `x-api-key`                        | `Authorization: Bearer`     | 无需 / 可选 Bearer    |
| 请求转换   | Anthropic/Responses → Chat Completions | 直接透传                             | Responses API 直接透传        | Chat Completions 转换 |
| 响应转换   | Chat Completions → Anthropic/Responses | 直接透传                             | Responses API 直接透传        | Chat Completions 转换 |
| 适用提供商 | DashScope`/v1`、DeepSeek、OpenAI 等   | DashScope`/apps/anthropic`、智谱等 | 原生 Responses API 兼容提供商 | 本地 Ollama 服务      |

## 实现原理

### 整体架构

vv-switch 采用 **适配器 + Provider 插件 + 中间件管道** 的分层架构：

```
┌──────────────┐  ┌───────────────┐  ┌───────────────────────┐
│  Claude Code │  │ OpenAI Codex  │  │ OpenAI 端点(VS Code…) │
└──────┬───────┘  └───────┬───────┘  └───────────┬───────────┘
       │ /v1/messages       │ /v1/responses          │ /v1/chat/completions
       │ (Anthropic)        │ (Responses API)        │ (Chat Completions)
       ▼                    ▼                        ▼
┌──────────────────────────────────────────────────────────────┐
│                     vv-switch Proxy (4321)                    │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                    HTTP 层 (src/http/)                 │  │
│  │  routes/claude.ts · routes/codex.ts · routes/openai.ts│  │
│  └────────────────────────┬───────────────────────────────┘  │
│                           │                                  │
│  ┌────────────────────────▼───────────────────────────────┐  │
│  │              RequestRouter (src/router/)               │  │
│  │  根据请求路径选择 adapter + provider + 调用 gateway   │  │
│  └────────────────────────┬───────────────────────────────┘  │
│                           │                                  │
│  ┌────────────────────────▼───────────────────────────────┐  │
│  │              Middleware Pipeline                       │  │
│  │  auth → logging → metrics → capability-check          │  │
│  │         → rate-limit → retry                           │  │
│  └────────────────────────┬───────────────────────────────┘  │
│                           │                                  │
│  ┌───────────┐  ┌─────────▼──────────┐  ┌────────────────┐  │
│  │  Adapters │  │  Gateway (core/)   │  │   Providers    │  │
│  │           │  │                    │  │                │  │
│  │ claude/   │──│  StandardRequest   │──│ openai-        │  │
│  │ codex/    │  │  StandardResponse  │  │ compatible/    │  │
│  │ openai/   │  │  StreamEvent       │  │ anthropic/     │  │
│  │ shared/   │  │                    │  │ ollama/        │  │
│  └───────────┘  └────────────────────┘  │ openai/        │  │
│                                          └────────────────┘  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │         配置与管理 (config-server.ts + UI)             │  │
│  │  Web UI · 供应商管理 · 配置注入/还原 · SIGINT 处理    │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────────┐  │
│  │ capability/  │  │ protocol-log/ │  │ prompt-rules-    │  │
│  │ 能力探测     │  │ 协议链路日志   │  │ manager 规则管理 │  │
│  └──────────────┘  └───────────────┘  └──────────────────┘  │
└──────────────────────────────┬───────────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
        ┌──────────┐  ┌──────────────┐  ┌──────────┐
        │ DeepSeek │  │  DashScope   │  │  Ollama  │
        │ /chat    │  │  /v1 或      │  │ /api/chat│
        │          │  │ /apps/anthropic││          │
        └──────────┘  └──────────────┘  └──────────┘
```

**核心设计理念：**

1. **Adapters（客户端协议适配器）**：将不同客户端协议（Anthropic Messages / Responses / Chat Completions）统一转换为内部标准协议 `StandardRequest`
2. **Providers（上游供应商插件）**：将内部标准协议转换为各上游提供商的原生协议，目前支持 `openai-compatible`、`anthropic`、`ollama`、`openai`
3. **Standard Protocol（统一协议）**：`StandardRequest` / `StandardResponse` / `StreamEvent` 作为 adapter 与 provider 之间的中间表示
4. **Middleware Pipeline（中间件管道）**：横切关注点（鉴权、日志、指标、重试、限流、能力检查）以洋葱模型组织
5. **Capability Detection（能力探测）**：自动检测上游能力，在 NATIVE / PROXY / UNSUPPORTED 之间自动降级

### 核心模块

| 模块                                 | 职责                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| `bin/cli.ts`                       | CLI 入口，使用 Commander 解析参数，启动配置服务器                            |
| `src/config-server.ts`             | Web 配置 UI + 供应商管理 API + 配置注入/还原 + 代理路由分发                  |
| `src/http/server.ts`               | Express 应用创建，挂载所有路由                                               |
| `src/http/routes/claude.ts`        | Claude Code 入口路由（`/v1/messages`）                                     |
| `src/http/routes/codex.ts`         | OpenAI Codex 入口路由（`/v1/responses`）                                   |
| `src/http/routes/openai.ts`        | OpenAI 端点入口路由（`/v1/chat/completions`）                              |
| `src/router/request-router.ts`     | 请求路由器：选 adapter + provider + 调 gateway                               |
| `src/adapters/claude/`             | Anthropic Messages 协议适配器                                                |
| `src/adapters/codex/`              | OpenAI Responses API 协议适配器                                              |
| `src/adapters/openai/`             | OpenAI Chat Completions 协议适配器                                           |
| `src/providers/openai-compatible/` | 通用 OpenAI 兼容上游 Provider（DeepSeek、DashScope 等）                      |
| `src/providers/anthropic/`         | Anthropic 原生兼容上游 Provider（DashScope`/apps/anthropic`、智谱等）      |
| `src/providers/ollama/`            | Ollama 本地模型 Provider                                                     |
| `src/providers/openai/`            | 官方 OpenAI Provider（含 Responses API）                                     |
| `src/protocol/`                    | 统一协议定义：StandardRequest / StandardResponse / StreamEvent               |
| `src/core/gateway.ts`              | 网关层：连接 adapter 与 provider，执行中间件管道                             |
| `src/middleware/`                  | 中间件集合：auth / logging / metrics / retry / rate-limit / capability-check |
| `src/capability/`                  | 能力探测：detector / cache / registry                                        |
| `src/protocol-log/`                | 协议链路日志：四阶段记录 + 脱敏                                              |
| `src/prompt-rules-manager.ts`      | Prompt 规则管理（正则替换注入）                                              |
| `src/providers-manager.ts`         | 供应商配置持久化（`~/.vv-switch-providers.json`）                          |
| `src/log-writer.ts`                | 会话日志 JSONL 写入器                                                        |
| `src/log-viewer-html.ts`           | HTML 日志查看器生成器                                                        |
| `src/config-ui.html`               | Web 配置界面                                                                 |

### 数据流详解

#### 1. Responses API → Chat Completions 转换流

```
Codex 请求 → POST /v1/responses
  │
  ├─ extractConversation()       ← 提取对话历史（用于日志）
  │
  ├─ buildChatRequest()          ← 构建 Chat Completions 请求
  │   ├─ inputToMessages()       ← Responses input → Chat messages
  │   │   ├─ instructions        → system 消息
  │   │   ├─ function_call       → assistant tool_calls
  │   │   └─ function_call_output → tool role 消息
  │   ├─ 参数映射: max_output_tokens → max_tokens
  │   └─ tools 扁平格式 → 嵌套格式
  │
  ├─ 非流式: fetch → chatResponseToResponses() → Codex 响应
  │              └─ tool_calls → function_call output items
  │
  └─ 流式: streamChatToResponses() 生成器
              ├─ fetch 上游 SSE 流
              ├─ 解析 Chat Completions SSE chunks
              ├─ text delta → response.output_text.delta
              ├─ tool_calls → response.output_item.added
              │             + function_call_arguments.delta
              └─ finish_reason → response.function_call_arguments.done
```

#### 2. Anthropic Messages → Chat Completions 转换流（chat 模式）

```
Claude 请求 → POST /v1/messages
  │
  ├─ anthropicToChatRequest()    ← 构建 Chat Completions 请求
  │   ├─ systemToMessage()       ← system 字段 → system 消息
  │   ├─ anthropicMessagesToChatMessages()
  │   │   ├─ user content blocks → content string
  │   │   ├─ assistant tool_use → tool_calls
  │   │   └─ tool_result → tool role 消息
  │   │       （或降级为 user 消息）
  │   └─ anthropicToolsToChatTools()
  │       └─ function tools → Chat Completions tools
  │
  ├─ 非流式: fetch → chatToAnthropicResponse() → Claude 响应
  │              └─ tool_calls → tool_use content blocks
  │              └─ finish_reason → stop_reason 映射
  │
  └─ 流式: streamChatToAnthropic() 生成器
              ├─ fetch 上游 SSE 流
              ├─ content delta → content_block_delta (text_delta)
              ├─ tool_calls → content_block_start (tool_use)
              │             + input_json_delta
              └─ message_delta + message_stop
```

#### 3. Anthropic Messages → Anthropic Messages 透传流（anthropic 模式）

```
Claude 请求 → POST /v1/messages
  │
  ├─ patchModelInBody()          ← 替换 model 字段
  │
  ├─ buildMessagesUrl()          ← 智能拼接 /v1/messages 路径
  │   ├─ /v1 结尾                → /v1/messages
  │   └─ 其他                    → /v1/messages
  │
  ├─ buildAnthropicUpstreamHeaders() ← x-api-key 认证
  │
  └─ streamAnthropicToAnthropic() 生成器
              ├─ fetch 上游 SSE 流
              ├─ parseSseEvents()    ← 解析 Anthropic 格式 SSE
              ├─ message_start → 修正 id/model
              ├─ content_block_delta → text_delta 透传
              └─ 所有事件原样转发
```

### 配置注入机制

当用户在 Web UI 中点击"应用配置"时：

**Claude Code 配置注入：**

```
1. 备份 ~/.claude/settings.json 原始内容到内存
2. 写入 env 字段:
   ANTHROPIC_BASE_URL             → http://localhost:4321  (vv-switch 地址)
   ANTHROPIC_MODEL                → 供应商的 model
   ANTHROPIC_AUTH_TOKEN           → "vv-switch"
   ANTHROPIC_SMALL_FAST_MODEL     → 供应商的 model
   ANTHROPIC_DEFAULT_HAIKU_MODEL  → 供应商的 model
   ANTHROPIC_DEFAULT_SONNET_MODEL → 供应商的 model
   ANTHROPIC_DEFAULT_OPUS_MODEL   → 供应商的 model
   CLAUDE_CODE_SUBAGENT_MODEL     → 供应商的 model
3. 标记该供应商为 Claude 活跃状态
```

此后 Claude Code 发出的所有 Anthropic API 请求都会先到达 vv-switch，由 vv-switch 转换后转发到上游提供商。

**OpenAI Codex 配置注入：**

```
1. 备份 ~/.codex/config.toml 原始内容到内存
2. 修改 TOML:
   model                          → 供应商的 model
   model_provider                 → "vv-switch"
   model_providers.vv-switch:
     name                         → 供应商的 model
     base_url                     → http://localhost:4321/v1
     wire_api                     → "responses"
3. 标记该供应商为 Codex 活跃状态
```

**自动还原：**

```
Ctrl+C → SIGINT/SIGTERM 信号
  → gracefulShutdown()
    → restoreClaudeConfig(备份)    删除 vv-switch 写入的 env key，恢复原始值
    → restoreCodexConfig(备份)     删除 vv-switch provider，恢复原始 TOML
    → clearActiveFor()             清除活跃状态标记
    → process.exit(0)
```

### 请求路由与分发

`config-server` 启动时根据活跃供应商配置初始化 `RequestRouter`，请求按以下流程分发：

```
HTTP 请求到达
  │
  ├─ 按路径匹配路由（routes/claude.ts / codex.ts / openai.ts）
  │
  ├─ RequestRouter.route(request)
  │   ├─ 选择 Adapter（由入口协议决定：claude / codex / openai）
  │   ├─ 选择 Provider（由活跃供应商的 protocolType 决定）
  │   └─ 调用 Gateway 执行
  │
  └─ Gateway 中间件管道
      auth → logging → metrics → capability-check → rate-limit → retry
                                                          │
                                                          ▼
                                                    Provider 上游调用
```

**路由优先级（`/v1/chat/completions` 入口）：**

- 优先使用标记 `activeForOpenai` 的 OpenAI 端点专属供应商
- 未设置则回退到 Codex 活跃供应商
- 再回退到 Claude 活跃供应商

### URL 智能处理

`buildChatUrl()` 和 `buildMessagesUrl()` 自动适配不同格式的 baseUrl：

```
buildChatUrl("https://api.deepseek.com/v1")
  → "https://api.deepseek.com/chat/completions"

buildChatUrl("https://dashscope.aliyuncs.com/compatible-mode/v1")
  → "https://dashscope.aliyuncs.com/compatible-mode/chat/completions"

buildMessagesUrl("https://dashscope.aliyuncs.com/apps/anthropic")
  → "https://dashscope.aliyuncs.com/apps/anthropic/v1/messages"

buildMessagesUrl("https://api.deepseek.com/v1")
  → "https://api.deepseek.com/v1/messages"
```

## 项目结构

```
vv-switch/
├── bin/
│   └── cli.ts                 # CLI 入口
├── src/
│   ├── adapters/              # 客户端协议适配器（解析/序列化）
│   │   ├── claude/            #   Anthropic Messages（/v1/messages）
│   │   ├── codex/             #   OpenAI Responses（/v1/responses）
│   │   ├── openai/            #   OpenAI Chat Completions（/v1/chat/completions）
│   │   └── shared/            #   适配器共享工具
│   ├── providers/             # 上游供应商插件
│   │   ├── openai-compatible/ #   通用 OpenAI Chat Completions 兼容（DeepSeek、DashScope 等）
│   │   ├── anthropic/         #   Anthropic 原生兼容（DashScope /apps/anthropic、智谱等）
│   │   ├── ollama/            #   Ollama 本地模型
│   │   └── openai/            #   官方 OpenAI（含 Responses API）
│   ├── http/
│   │   ├── server.ts          # createApp：挂载所有路由
│   │   └── routes/            # claude / codex / openai / models / health 路由
│   ├── router/                # RequestRouter：选 adapter + provider + 调 gateway
│   ├── core/                  # 核心层：gateway / 适配器管理 / provider 管理
│   ├── protocol/              # 统一协议：StandardRequest / StandardResponse / StreamEvent
│   ├── middleware/            # 中间件管道：auth / logging / metrics / retry / rate-limit / capability-check
│   ├── capability/            # 能力探测：detector / cache / registry
│   ├── protocol-log/          # 协议转换链路日志（四阶段）
│   ├── logging/               # 日志模块
│   ├── constants/             # 常量定义
│   ├── types/                 # TypeScript 类型定义
│   ├── utils/                 # 工具函数（SSE 合并、URL 处理、内容处理等）
│   ├── config-server.ts       # Web 配置 UI + 供应商管理 API + 配置注入/还原 + 路由分发
│   ├── providers-manager.ts   # 供应商持久化管理（activeForClaude/Codex/Openai）
│   ├── prompt-rules-manager.ts # Prompt 规则管理（正则替换注入）
│   ├── log-writer.ts          # 会话日志 JSONL 写入
│   ├── log-viewer-html.ts     # HTML 日志查看器
│   └── config-ui.html         # Web 配置界面
├── test/                      # 单元测试 + 集成测试
├── dist/
│   └── cli.cjs                # 打包后的 CLI（esbuild）
├── build.js                   # 打包脚本
├── tsconfig.json              # TypeScript 配置
├── package.json
└── pnpm-lock.yaml
```

## 开发指南

### 环境要求

- Node.js >= 18
- pnpm >= 10
- TypeScript 6.x

### 本地开发

```bash
# 安装依赖
pnpm install

# 开发模式（自动重启 + 日志）
pnpm dev

# 类型检查
pnpm typecheck

# 运行测试
pnpm test
pnpm test:integration

# 打包
pnpm build
```

### 架构扩展

**新增一种客户端协议** → 在 `src/adapters/` 下添加适配器，实现 `parseRequest` 和 `serializeResponse` 两个方向的转换，注册到 adapter manager。

**新增一个上游提供商类型** → 在 `src/providers/` 下添加 provider 插件，实现 `discover()`（能力探测）、`buildRequest()`（请求转换）、`parseResponse()`（响应解析），注册到 provider registry。

**新增中间件** → 在 `src/middleware/` 下添加，实现 `(ctx, next) => Promise` 接口，在 gateway 管道中挂载。

## 常见问题 FAQ

**Q: Claude Code 应用配置后没生效？**
A: 确保 `~/.claude/settings.json` 中的 `ANTHROPIC_BASE_URL` 已被改为 vv-switch 地址。如果仍有问题，查看控制台日志确认请求是否到达代理。

**Q: 停止服务后 Claude/Codex 配置没还原？**
A: 如果进程被强制杀掉（如 `kill -9`），SIGINT 捕获会失效。此时手动删除 `~/.claude/settings.json` 中 vv-switch 写入的环境变量，或重新启动再正常 `Ctrl+C` 退出即可。

**Q: 怎么知道协议转换有没有问题？**
A: 使用 `--protocol-log` 开启协议链路日志，每次请求会生成四阶段 jsonl 文件（ingress → standard → upstream → egress），方便逐段排查。

**Q: 支持哪些模型/提供商？**
A: 理论上所有支持 OpenAI Chat Completions、Anthropic Messages 或 Responses API 的提供商都可以。已验证的包括 DeepSeek、DashScope（百炼）、智谱、Ollama、官方 OpenAI 等。

**Q: 能在公网使用吗？**
A: vv-switch 默认只监听 `localhost`，设计上是本地开发工具。如需远程使用，请自行加认证和 HTTPS 代理，不要直接暴露到公网。

**Q: `--no-body` 作用于哪些日志？**
A: 同时作用于会话日志（`--logs`）和协议日志（`--protocol-log`）。开启后不记录完整请求/响应体，只记摘要（model、消息数、tools 数等），大幅减小日志体积。
