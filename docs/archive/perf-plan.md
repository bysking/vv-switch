
# vv-switch 路由转发逻辑优化：策略模式重构方案

## Context（背景）

vv-switch 是一个 LLM API 协议转换代理，当前存在两个入口：

-**Codex 路径** (server.js)：接收 Responses API → 转换到上游协议 → 转换回 Responses API

-**Claude 路径** (anthropic-handler.js)：接收 Anthropic Messages API → 转换到上游协议 → 转换回 Messages API

**当前问题**：协议处理逻辑以 if-else 链的形式内嵌在两个文件中，添加新协议需要同时修改两处。三种上游协议 (chat / anthropic / ollama) 的处理逻辑散落在 ~200 行重复的流式/错误/日志样板代码中。

**目标**：使用策略模式，使任意客户端（Codex、Claude 或未来工具）可自由搭配任意上游协议，添加新协议只需新建一个策略文件并注册。

---

## 架构总览

```

重构前:                              重构后:

┌──────────┐  if-else               ┌──────────┐  strategy

│ server.js│──chat──┐               │ server.js│──→ Registry

│ (Codex)  │──ollama┤               │ (Codex)  │──→ getStrategy()

└──────────┘        │               └──────────┘      │

                    ▼                                  │

┌──────────┐  if-else               ┌──────────────────────────────┐

│anthropic │──chat──┤               │ src/strategies/              │

│-handler.js──anthropic┤            │  ├── chat-responses.js       │

│ (Claude) │──ollama┤               │  ├── chat-messages.js        │

└──────────┘        │               │  ├── anthropic-messages.js   │

                    ▼               │  ├── ollama-responses.js     │

              内嵌的协议逻辑          │  ├── ollama-messages.js     │

              (大量重复)              │  └── index.js (Registry)    │

                                    └──────────────────────────────┘

                                    ┌──────────────────────────────┐

                                    │ src/handler-utils.js         │

                                    │ (共享: SSE/日志/错误处理)     │

                                    └──────────────────────────────┘

```

---

## 新增文件结构

```

src/

├── strategies/                      # 新建目录

│   ├── index.js                     # 策略注册表 + 工厂函数

│   ├── chat-responses.strategy.js   # Chat → Responses API 转换 (Codex 用)

│   ├── chat-messages.strategy.js    # Chat → Messages API 转换 (Claude 用)

│   ├── anthropic-messages.strategy.js  # Anthropic → Messages (Claude 用)

│   ├── ollama-responses.strategy.js # Ollama → Responses API (Codex 用)

│   └── ollama-messages.strategy.js  # Ollama → Messages API (Claude 用)

├── handler-utils.js                 # 新建：共享处理工具函数

├── server.js                        # 重构：移除 if-else，使用策略

├── anthropic-handler.js             # 重构：移除 if-else，使用策略

└── ...（其他文件不变）

```

---

## 策略接口设计

每个策略是一个对象，实现以下统一接口：

```javascript

// 策略接口（JSDoc 定义，无 TypeScript）

/**

 * @typedef{Object}ProtocolStrategy

 * @property{string}name                              - 协议名称 'chat'|'anthropic'|'ollama'

 * @property{Function}buildUpstreamRequest             - (body, defaultModel) => upstreamBody

 * @property{Function<string>}getUpstreamUrl           - (baseUrl) => 完整上游 URL

 * @property{AsyncGenerator}executeStreaming            - (req, opts, resultRef) => SSE chunks

 * @property{Function<Promise<Object>>}executeNonStreaming - (req, opts) => {status, data}

 * @property{Function<Object>}transformResponse         - (rawData, ctx) => 输出格式响应

 * @property{Function<Promise<Object>>}fetchModels      - (baseUrl, apiKey) => 模型列表

 * @property{Function<Object>}extractLogMetadata        - (rawData) => {inputTokens, outputTokens, ...}

 */

```

---

## 分步实施计划

### Step 1：创建共享工具 `src/handler-utils.js`

提取两个文件中重复的通用逻辑：

-`setupSseHeaders(res, requestId)` — 设置 SSE 响应头

-`writeStreamLog(logEntry, logWriter, streamResult, startTime, upstreamStatus, captureBody)` — 流式日志

-`writeNonStreamingLog(logEntry, logWriter, status, duration, rawData, captureBody, extractFn)` — 非流式日志

-`emitStreamError(res, errorMessage, sseEventFn)` — 流式错误兜底

### Step 2：创建策略注册表 `src/strategies/index.js`

```javascript

constregistry = newMap();

exportfunctionregisterStrategy(strategy) { registry.set(strategy.name, strategy); }

exportfunctiongetStrategy(name) { return registry.get(name); }


// 内置策略自动注册

import'./chat-responses.strategy.js';

import'./chat-messages.strategy.js';

import'./anthropic-messages.strategy.js';

import'./ollama-responses.strategy.js';

import'./ollama-messages.strategy.js';

```

### Step 3：实现各策略文件

每个策略文件从现有代码中提取对应逻辑：

| 策略文件 | 来源 | 提取内容 |

|---------|------|---------|

| `chat-responses.strategy.js` | server.js L165-400, L800-1100 | `buildChatRequest`, `streamChatToResponses`, `chatResponseToResponses` |

| `chat-messages.strategy.js` | anthropic-handler.js L200-600, L900-1200 | `anthropicToChatRequest`, `streamChatToAnthropic`, `chatToAnthropicResponse` |

| `anthropic-messages.strategy.js` | anthropic-handler.js L700-900 | `forwardAnthropicRequest`, `streamAnthropicToAnthropic` |

| `ollama-responses.strategy.js` | server.js L400-800 | `buildOllamaRequest`, `streamOllamaToResponses`, `ollamaToResponses` |

| `ollama-messages.strategy.js` | anthropic-handler.js L600-900 | `anthropicToOllamaRequest`, `streamOllamaToAnthropic`, `forwardOllamaRequest` |

### Step 4：重构 `src/server.js`

**改动点**：

1. 导入 `getStrategy` 和 `handler-utils`

2.`POST /v1/responses` 处理逻辑：

```javascript

// 替换 ~100 行 if-else → ~20 行

conststrategy = getStrategy(protocolType);

constupstreamReq = strategy.buildUpstreamRequest(body, defaultModel);

if (stream) {

setupSseHeaders(res, respId);

conststreamResult= {};

consts= strategy.executeStreaming(upstreamReq, {model, respId, baseUrl, apiKey, reasoningEffort}, streamResult);

conststatus=awaitpipeStream(s, res);

writeStreamLog(logEntry, logWriter, streamResult, startTime, status, captureBody);

}else{

constraw=await strategy.executeNonStreaming(upstreamReq, {baseUrl, apiKey});

 res.json(strategy.transformResponse(raw.data, {model, respId, reasoningEffort}));

// logging...

}

```

3.`GET /v1/models`：使用 `strategy.fetchModels()` 替代 if-else

### Step 5：重构 `src/anthropic-handler.js`

**改动点**：

1. 导入 `getStrategy` 和 `handler-utils`

2.`POST /v1/messages` 处理逻辑：

```javascript

// 替换 if/else if/else 三分支 → 统一调用

conststrategy = getStrategy(protocolType);

constupstreamReq = strategy.buildUpstreamRequest(body, defaultModel);

if (stream) {

setupSseHeaders(res, msgId);

conststreamResult= {};

consts= strategy.executeStreaming(upstreamReq, {model, msgId, baseUrl, apiKey, headers: extraHeaders}, streamResult);

conststatus=awaitpipeStream(s, res);

writeStreamLog(logEntry, logWriter, streamResult, startTime, status, captureBody);

}else{

constraw=await strategy.executeNonStreaming(upstreamReq, {baseUrl, apiKey, headers: extraHeaders});

if (raw.error) { /* error handling */ }

 res.json(strategy.transformResponse(raw.data, {model, msgId}));

// logging...

}

```

3. 保留：`extractAnthropicConversation`、`contentBlockToString`、SSE mock 端点等辅助函数

### Step 6：更新测试

1. 在 `test/test-all.mjs` 中添加策略注册表测试
2. 更新 import 路径（如果导出的函数被移动到新文件）
3. 集成测试逻辑不变（API 行为保持一致）

---

## 关键文件清单

| 文件 | 操作 | 说明 |

|------|------|------|

| `src/strategies/index.js` | 新建 | 策略注册表 |

| `src/strategies/chat-responses.strategy.js` | 新建 | Chat 协议 (Codex) |

| `src/strategies/chat-messages.strategy.js` | 新建 | Chat 协议 (Claude) |

| `src/strategies/anthropic-messages.strategy.js` | 新建 | Anthropic 协议 (Claude) |

| `src/strategies/ollama-responses.strategy.js` | 新建 | Ollama 协议 (Codex) |

| `src/strategies/ollama-messages.strategy.js` | 新建 | Ollama 协议 (Claude) |

| `src/handler-utils.js` | 新建 | 共享 SSE/日志/错误处理 |

| `src/server.js` | 重构 | 移除 ~100 行 if-else |

| `src/anthropic-handler.js` | 重构 | 移除 ~150 行 if-else |

| `test/test-all.mjs` | 更新 | 添加策略测试，更新 import |

| `build.js` | 不变 | esbuild 自动处理新 import |

---

## 添加新协议的方式（验证可扩展性）

未来添加新协议（如 Gemini）只需：

1. 新建 `src/strategies/gemini-responses.strategy.js` 和 `gemini-messages.strategy.js`
2. 在文件中 `import { registerStrategy } from './index.js'; registerStrategy({...})`
3. 完成——无需修改 server.js 或 anthropic-handler.js

---

## 验证步骤

1.`npm test` — 确保所有现有测试通过

2. 手动测试：启动 vv-switch，用 Claude Code 和 Codex 分别连接，验证各协议正常工作
3. 检查 `npm run build` 确保 esbuild 能正确打包新文件
