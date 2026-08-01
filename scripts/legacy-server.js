/**
 * vv-switch - OpenAI Responses API 转 Chat Completions 代理
 *
 * 一个轻量级代理，将 OpenAI Responses API (/v1/responses) 请求转换为
 * Chat Completions (/v1/chat/completions) 请求，并将响应转换回来。
 * 支持流式和非流式模式、函数调用、推理内容以及多轮工具对话。
 *
 * 这使得使用 Responses API 的工具（如 OpenAI Codex）能够与任何
 * 兼容 Chat Completions 的 API 提供商配合使用。
 */

import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 配置 ──────────────────────────────────────────────────────────────────

const UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL || '请在.env配置地址';
const UPSTREAM_API_KEY = process.env.UPSTREAM_API_KEY || '请在.env配置密钥';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || '请在.env配置模型';
const HOST = process.env.HOST || 'localhost';
const PORT = parseInt(process.env.PORT, 10) || 4321;
const DEBUG = ['1', 'true', 'yes'].includes((process.env.DEBUG || '').toLowerCase());

const VERSION = '0.1.0';

// ── 日志 ──────────────────────────────────────────────────────────────────

const log = {
  debug: (...args) => DEBUG && console.log(`[${getCurrentTime()}] [DEBUG]`, ...args),
  info: (...args) => console.log(`[${getCurrentTime()}] [INFO]`, ...args),
  warn: (...args) => console.warn(`[${getCurrentTime()}] [WARN]`, ...args),
  error: (...args) => console.error(`[${getCurrentTime()}] [ERROR]`, ...args),
};

// ── 辅助函数 ──────────────────────────────────────────────────────────────

/**
 * 获取当前时间字符串（精确到时分秒）
 * @returns {string} 格式化的时间字符串，如 "2026-06-12 14:30:45"
 */
function getCurrentTime() {
  const now = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function makeId(prefix = 'resp') {
  return `${prefix}_${uuidv4().replace(/-/g, '').slice(0, 24)}`;
}

function sse(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

// ── 将 Responses API input 转换为 Chat Completions messages ────────────────

function inputToMessages(body) {
  const { instructions, input = '' } = body;
  const messages = [];

  if (instructions) {
    messages.push({ role: 'system', content: instructions });
  }

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return messages;
  }

  if (!Array.isArray(input)) {
    return messages;
  }

  // 将连续的 function_call 项合并到单个 assistant 消息中
  let pendingToolCalls = [];

  function flushToolCalls() {
    if (pendingToolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [...pendingToolCalls],
      });
      pendingToolCalls = [];
    }
  }

  for (const item of input) {
    if (typeof item === 'string') {
      flushToolCalls();
      messages.push({ role: 'user', content: item });
      continue;
    }

    if (typeof item !== 'object' || item === null) {
      continue;
    }

    const itemType = item.type || '';

    // Responses API function_call → Chat Completions assistant tool_calls
    if (itemType === 'function_call') {
      pendingToolCalls.push({
        id: item.call_id || item.id || '',
        type: 'function',
        function: {
          name: item.name || '',
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}),
        },
      });
      continue;
    }

    // Responses API function_call_output → Chat Completions tool 角色消息
    if (itemType === 'function_call_output') {
      flushToolCalls();
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || '',
        content: item.output || '',
      });
      continue;
    }

    // 普通消息 (user / assistant / system / developer)
    flushToolCalls();
    let role = item.role || 'user';
    if (role === 'developer') {
      role = 'system';
    }

    let content = item.content || '';
    if (Array.isArray(content)) {
      const parts = [];
      for (const c of content) {
        if (typeof c === 'object' && c !== null) {
          const cType = c.type || '';
          if (cType === 'input_text') {
            parts.push(c.text || '');
          } else if (cType === 'input_image') {
            parts.push('[image]');
          } else {
            parts.push(c.text || String(c));
          }
        }
      }
      content = parts.join('\n');
    }

    messages.push({ role, content });
  }

  flushToolCalls();
  return messages;
}

// ── 从 Responses API body 构建 Chat Completions 请求 ─────────────────

function buildChatRequest(body) {
  const req = {
    model: body.model || DEFAULT_MODEL,
    messages: inputToMessages(body),
    stream: body.stream || false,
  };

  if (body.temperature != null) {
    req.temperature = body.temperature;
  }
  if (body.max_output_tokens != null) {
    req.max_tokens = body.max_output_tokens;
  }
  if (body.top_p != null) {
    req.top_p = body.top_p;
  }

  // 转换 reasoning：Responses API 使用 {effort, summary}，Chat Completions 使用 reasoning_effort
  const reasoning = body.reasoning;
  if (reasoning && typeof reasoning === 'object' && reasoning.effort) {
    req.reasoning_effort = reasoning.effort;
  }

  // 转换 tools：Responses API 使用扁平格式，Chat Completions 使用嵌套格式
  if (body.tools && body.tools.length > 0) {
    const tools = [];
    for (const t of body.tools) {
      if (t.type !== 'function') continue;

      let fn;
      if ('function' in t) {
        // 已经是 Chat Completions 格式
        fn = t.function;
      } else {
        // Responses API 扁平格式
        fn = t;
      }

      tools.push({
        type: 'function',
        function: {
          name: fn.name || '',
          description: fn.description || '',
          parameters: fn.parameters || {},
        },
      });
    }

    if (tools.length > 0) {
      req.tools = tools;
    }
  }

  return req;
}

// ── 将 Chat Completions 响应转换为 Responses API 响应 ────────────────

function chatResponseToResponses(chatResp, model, respId, reasoningEffort = null) {
  const choice = (chatResp.choices || [{}])[0];
  const message = choice.message || {};
  const contentText = message.content || '';

  const outputItem = {
    id: makeId('msg'),
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [
      {
        type: 'output_text',
        text: contentText,
        annotations: [],
      },
    ],
  };

  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      const fn = tc.function || {};
      outputItem.content.push({
        type: 'function_call',
        id: tc.id || makeId('call'),
        call_id: tc.id || makeId('call'),
        name: fn.name || '',
        arguments: fn.arguments || '{}',
      });
    }
  }

  const usage = chatResp.usage || {};

  return {
    id: respId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model,
    output: [outputItem],
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
    },
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: reasoningEffort || 'medium', summary: 'auto' },
    text: { format: { type: 'text' } },
    tools: [],
    truncation: 'disabled',
  };
}

// ── 流式处理：Chat Completions SSE → Responses API SSE ────────────────────

async function* streamChatToResponses(chatReq, model, respId, reasoningEffort = null) {
  const created = Math.floor(Date.now() / 1000);
  const msgId = makeId('msg');

  let fullText = '';
  let totalInput = 0;
  let totalOutput = 0;
  let outputIndex = 0;
  let msgClosed = false;

  const activeToolCalls = new Map();
  const completedToolCalls = [];

  function* closeMsgItem() {
    if (msgClosed) return;
    msgClosed = true;

    const contentPart = { type: 'output_text', text: fullText, annotations: [] };

    yield sse({
      type: 'response.content_part.done',
      output_index: 0,
      content_index: 0,
      part: contentPart,
    });
    yield sse({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [contentPart],
      },
    });
    outputIndex = 1;
  }

  // response.created / response.in_progress
  const emptyResponse = {
    id: respId,
    object: 'response',
    created_at: created,
    status: 'in_progress',
    model,
    output: [],
    usage: null,
  };
  yield sse({ type: 'response.created', response: emptyResponse });
  yield sse({ type: 'response.in_progress', response: emptyResponse });

  // output_item.added + content_part.added 用于消息
  yield sse({
    type: 'response.output_item.added',
    output_index: 0,
    item: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      status: 'in_progress',
      content: [],
    },
  });
  yield sse({
    type: 'response.content_part.added',
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] },
  });

  // 发起上游请求
  const headers = {
    'Authorization': `Bearer ${UPSTREAM_API_KEY}`,
    'Content-Type': 'application/json',
  };

  const response = await fetch(`${UPSTREAM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(chatReq),
  });

  log.info('Upstream status: %d', response.status);

  if (!response.ok) {
    const errorBody = await response.text();
    log.error('Upstream error: %s', errorBody.slice(0, 500));
    yield sse({
      type: 'response.failed',
      response: {
        id: respId,
        status: 'failed',
        error: { code: 'server_error', message: errorBody.slice(0, 200) },
      },
    });
    yield 'data: [DONE]\n\n';
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const dataStr = line.slice(6).trim();
      if (dataStr === '[DONE]') {
        log.debug('Stream DONE, text_len=%d tool_calls=%d', fullText.length, completedToolCalls.length);
        continue;
      }

      let chunk;
      try {
        chunk = JSON.parse(dataStr);
      } catch {
        continue;
      }

      const choices = chunk.choices || [];
      if (choices.length === 0) {
        const u = chunk.usage;
        if (u) {
          totalInput = u.prompt_tokens || 0;
          totalOutput = u.completion_tokens || 0;
        }
        continue;
      }

      const delta = choices[0].delta || {};
      const finishReason = choices[0].finish_reason;

      // 推理内容
      const reasoning = delta.reasoning_content || '';
      if (reasoning) {
        yield sse({
          type: 'response.reasoning_text.delta',
          item_id: msgId,
          output_index: 0,
          content_index: 0,
          delta: reasoning,
        });
      }

      // 文本内容
      const text = delta.content || '';
      if (text) {
        fullText += text;
        yield sse({
          type: 'response.output_text.delta',
          item_id: msgId,
          output_index: 0,
          content_index: 0,
          delta: text,
        });
      }

      // 工具调用
      if (delta.tool_calls && delta.tool_calls.length > 0) {
        for (const tc of delta.tool_calls) {
          const tcIndex = tc.index ?? 0;
          const tcId = tc.id;
          const fn = tc.function || {};

          if (tcId && ![...activeToolCalls.values()].some(t => t.id === tcId)) {
            for (const ev of closeMsgItem()) {
              yield ev;
            }

            activeToolCalls.set(tcIndex, {
              id: tcId,
              name: fn.name || '',
              arguments: fn.arguments || '',
            });
            log.debug('Tool call started: %s id=%s', fn.name, tcId);

            yield sse({
              type: 'response.output_item.added',
              output_index: outputIndex + tcIndex,
              item: {
                id: tcId,
                type: 'function_call',
                call_id: tcId,
                name: fn.name || '',
                arguments: '',
                status: 'in_progress',
              },
            });
          } else if (activeToolCalls.has(tcIndex)) {
            const argsDelta = fn.arguments || '';
            const tcInfo = activeToolCalls.get(tcIndex);
            tcInfo.arguments += argsDelta;
            yield sse({
              type: 'response.function_call_arguments.delta',
              item_id: tcInfo.id,
              output_index: outputIndex + tcIndex,
              delta: argsDelta,
            });
          }
        }
      }

      if (finishReason === 'tool_calls') {
        for (const ev of closeMsgItem()) {
          yield ev;
        }

        const sortedIndices = [...activeToolCalls.keys()].sort((a, b) => a - b);
        for (const tcIndex of sortedIndices) {
          const tcInfo = activeToolCalls.get(tcIndex);
          completedToolCalls.push(tcInfo);
          yield sse({
            type: 'response.function_call_arguments.done',
            item_id: tcInfo.id,
            output_index: outputIndex + tcIndex,
            arguments: tcInfo.arguments,
          });
          yield sse({
            type: 'response.output_item.done',
            output_index: outputIndex + tcIndex,
            item: {
              id: tcInfo.id,
              type: 'function_call',
              call_id: tcInfo.id,
              name: tcInfo.name,
              arguments: tcInfo.arguments,
              status: 'completed',
            },
          });
        }
        activeToolCalls.clear();
      }

      const u = chunk.usage;
      if (u) {
        totalInput = u.prompt_tokens || 0;
        totalOutput = u.completion_tokens || 0;
      }
    }
  }

  // 如果文本消息仍未关闭，则关闭
  for (const ev of closeMsgItem()) {
    yield ev;
  }

  // 完成任何剩余的工具调用
  const sortedIndices = [...activeToolCalls.keys()].sort((a, b) => a - b);
  for (const tcIndex of sortedIndices) {
    const tcInfo = activeToolCalls.get(tcIndex);
    if (!completedToolCalls.includes(tcInfo)) {
      completedToolCalls.push(tcInfo);
      yield sse({
        type: 'response.function_call_arguments.done',
        item_id: tcInfo.id,
        output_index: outputIndex + tcIndex,
        arguments: tcInfo.arguments,
      });
      yield sse({
        type: 'response.output_item.done',
        output_index: outputIndex + tcIndex,
        item: {
          id: tcInfo.id,
          type: 'function_call',
          call_id: tcInfo.id,
          name: tcInfo.name,
          arguments: tcInfo.arguments,
          status: 'completed',
        },
      });
    }
  }

  // 构建最终输出项
  const outputItems = [];
  if (fullText) {
    outputItems.push({
      id: msgId,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: fullText, annotations: [] }],
    });
  }
  for (const tc of completedToolCalls) {
    outputItems.push({
      id: tc.id,
      type: 'function_call',
      call_id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
      status: 'completed',
    });
  }

  yield sse({
    type: 'response.completed',
    response: {
      id: respId,
      object: 'response',
      created_at: created,
      status: 'completed',
      model,
      output: outputItems,
      usage: {
        input_tokens: totalInput,
        output_tokens: totalOutput,
        total_tokens: totalInput + totalOutput,
      },
      parallel_tool_calls: true,
      previous_response_id: null,
      reasoning: { effort: reasoningEffort || 'medium', summary: 'auto' },
      text: { format: { type: 'text' } },
      tools: [],
      truncation: 'disabled',
    },
  });

  yield 'data: [DONE]\n\n';
}

// ── Express 应用 ────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// ── 端点 ──────────────────────────────────────────────────────────────────

app.post('/v1/responses', async (req, res) => {
  const body = req.body;
  const model = body.model || DEFAULT_MODEL;
  const stream = body.stream || false;
  const respId = makeId('resp');

  const reasoning = body.reasoning;
  const reasoningEffort = reasoning && typeof reasoning === 'object' ? reasoning.effort : null;

  log.info(
    'Request: model=%s stream=%s input_type=%s reasoning_effort=%s',
    model, stream, typeof body.input, reasoningEffort,
  );

  const chatReq = buildChatRequest(body);
  log.debug(
    'Chat request: stream=%s msgs=%d model=%s tools=%d reasoning_effort=%s',
    chatReq.stream,
    chatReq.messages?.length || 0,
    chatReq.model,
    chatReq.tools?.length || 0,
    chatReq.reasoning_effort,
  );

  if (stream) {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Request-Id': respId,
    });

    const stream = streamChatToResponses(chatReq, model, respId, reasoningEffort);
    for await (const chunk of stream) {
      res.write(chunk);
    }
    res.end();
    return;
  }

  // 非流式
  try {
    const headers = {
      'Authorization': `Bearer ${UPSTREAM_API_KEY}`,
      'Content-Type': 'application/json',
    };

    const response = await fetch(`${UPSTREAM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(chatReq),
    });

    const chatResp = await response.json();
    res.json(chatResponseToResponses(chatResp, model, respId, reasoningEffort));
  } catch (error) {
    log.error('Non-streaming error: %s', error.message);
    res.status(500).json({ error: { message: error.message } });
  }
});

app.get('/v1/models', async (req, res) => {
  try {
    const response = await fetch(`${UPSTREAM_BASE_URL}/models`, {
      headers: { 'Authorization': `Bearer ${UPSTREAM_API_KEY}` },
    });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    log.error('Models error: %s', error.message);
    res.status(500).json({ error: { message: error.message } });
  }
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: VERSION });
});

// ── 主入口 ───────────────────────────────────────────────────────────────────

if (!UPSTREAM_BASE_URL) {
  log.error('UPSTREAM_BASE_URL environment variable is required');
  process.exit(1);
}
if (!UPSTREAM_API_KEY) {
  log.error('UPSTREAM_API_KEY environment variable is required');
  process.exit(1);
}

log.info(`Starting vv-switch v${VERSION} on ${HOST}:${PORT}`);
log.info(`Upstream: ${UPSTREAM_BASE_URL}`);

app.listen(PORT, HOST, () => {
  log.info(`Server running on http://${HOST}:${PORT}`);
});
