#!/usr/bin/env node

/**
 * 模拟 Claude Code 调用 vv-switch 代理火山 Chat API 的全过程
 *
 * 模拟链路:
 *
 *   Claude Code                         vv-switch                          火山引擎
 *   ──────────                         ────────                          ────────
 *   POST /v1/messages                  1. parseClaudeRequest()
 *   (Anthropic Messages)           →   2. StandardRequest
 *                                       3. buildChatRequest()
 *                                       4. POST /chat/completions      →  GLM-5.2
 *                                       5. parseChatResponse()         ←  chat 响应
 *                                       6. StandardResponse
 *                                       7. serializeClaudeResponse()
 *   ← Anthropic Messages 响应           8. HTTP 200
 *
 * 用法:
 *   node simulate-claude-vvswitch.mjs                # 仅协议转换(离线)
 *   node simulate-claude-vvswitch.mjs --real         # + 真实 HTTP 调用火山
 *   node simulate-claude-vvswitch.mjs --stream       # 模拟流式响应
 *   node simulate-claude-vvswitch.mjs --all          # 以上全部
 */

// ── 导入 vv-switch 协议转换模块 ──────────────────────────────────
import { parseClaudeRequest } from './src/adapters/claude/parse.js';
import { serializeClaudeResponse } from './src/adapters/claude/serialize.js';
import { buildChatRequest } from './src/providers/openai-compatible/request.js';
import { parseChatResponse } from './src/providers/openai-compatible/response.js';
import { parseChatStream } from './src/providers/openai-compatible/stream.js';
import { serializeClaudeStream } from './src/adapters/claude/stream.js';

// ── 配置 ──────────────────────────────────────────────────────────
const ARK_URL = process.env.ARK_URL || 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions';
const ARK_API_KEY = process.env.ARK_API_KEY || '';
const MODEL = process.env.MODEL || 'GLM-5.2';

const ARGS = {
  real: process.argv.includes('--real'),
  stream: process.argv.includes('--stream'),
  all: process.argv.includes('--all'),
};
if (ARGS.all) { ARGS.real = true; ARGS.stream = true; }

const ctx = { id: 'sim-msg-001', defaultModel: MODEL };

// ── 工具函数 ──────────────────────────────────────────────────────
function divider(char = '═', width = 72) {
  console.log(char.repeat(width));
}

function h1(title) {
  console.log(`\n${'╔'.padEnd(73, '═')}╗`);
  console.log(`║  ${title.padEnd(68)}║`);
  console.log(`╚${'═'.repeat(72)}╝`);
}

function h2(title) {
  console.log(`\n  ▸ ${title}`);
  console.log(`  ${'─'.repeat(60)}`);
}

function pretty(obj, maxLen = 600) {
  const raw = JSON.stringify(obj, null, 2);
  if (raw.length <= maxLen) return raw;
  return raw.slice(0, maxLen) + `\n  ... (${raw.length - maxLen} chars truncated)`;
}

function box(title, lines, color = '') {
  console.log(`  ┌─ ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}┐`);
  for (const line of lines) {
    console.log(`  │ ${String(line).padEnd(68)}│`);
  }
  console.log(`  └${'─'.repeat(70)}┘`);
}

// ══════════════════════════════════════════════════════════════════
//  场景 1: 简单文本对话
// ══════════════════════════════════════════════════════════════════
async function scenarioSimpleChat(doReal, doStream) {
  h1('场景 1: 简单文本对话');

  const claudeReq = {
    model: MODEL,
    max_tokens: 100,
    messages: [{ role: 'user', content: '说"你好世界",只回四个字' }],
  };

  console.log('\n  📤 Claude 发出请求:');
  console.log('  POST /v1/messages');
  console.log(`  ${pretty(claudeReq, 300)}`);

  // Step 1: parseClaudeRequest
  h2('步骤 1: parseClaudeRequest → StandardRequest');
  const stdReq = parseClaudeRequest(claudeReq, ctx);
  console.log(`  model: ${stdReq.model}`);
  console.log(`  messages: ${stdReq.messages.length} 条`);
  console.log(`  messages[0].role: ${stdReq.messages[0].role}`);
  console.log(`  messages[0].content: ${typeof stdReq.messages[0].content === 'string' ? `"${stdReq.messages[0].content}"` : `[${stdReq.messages[0].content.length} parts]`}`);
  console.log(`  system: ${stdReq.system === null ? 'null' : `"${String(stdReq.system).slice(0, 60)}..."`}`);
  console.log(`  stream: ${stdReq.stream}`);
  console.log(`  parameters: ${pretty(stdReq.parameters, 200)}`);

  // Step 2: buildChatRequest
  h2('步骤 2: buildChatRequest → Chat Completions');
  const chatReq = buildChatRequest(stdReq, MODEL);
  console.log(`  POST /chat/completions`);
  console.log(`  ${pretty(chatReq, 500)}`);

  // 转换断言
  box('转换断言', [
    `✅ model 保留:    "${chatReq.model}"`,
    `✅ role(user):    "${chatReq.messages[0].role}"`,
    `✅ content:       "${String(chatReq.messages[0]?.content).slice(0, 50)}"`,
    `✅ max_tokens:    ${chatReq.max_tokens}`,
    `✅ stream:        ${chatReq.stream}`,
    `✅ 无多余字段:     reasoning_effort=${chatReq.reasoning_effort ?? '未设置'}`,
  ]);

  if (!doReal) return;

  // ── 真实 HTTP 调用 ──
  h2('步骤 3: 直连火山引擎 API');
  const t0 = Date.now();
  try {
    const res = await fetch(ARK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ARK_API_KEY}` },
      body: JSON.stringify(chatReq),
    });
    const elapsed = Date.now() - t0;
    const raw = await res.text();
    if (!res.ok) {
      console.log(`  ❌ HTTP ${res.status} (${elapsed}ms): ${raw.slice(0, 200)}`);
      return;
    }
    const data = JSON.parse(raw);

    // Step 4: parseChatResponse → StandardResponse
    h2('步骤 4: parseChatResponse → StandardResponse');
    const stdResp = parseChatResponse(data, { id: stdReq.id, model: MODEL });
    console.log(`  content: ${pretty(stdResp.content, 300)}`);
    console.log(`  toolCalls: ${stdResp.toolCalls.length} 个`);
    console.log(`  stopReason: ${stdResp.stopReason}`);
    console.log(`  usage: ${pretty(stdResp.usage, 200)}`);

    // Step 5: serializeClaudeResponse
    h2('步骤 5: serializeClaudeResponse → Claude Messages');
    const claudeResp = serializeClaudeResponse(stdResp, ctx);
    console.log(`  ${pretty(claudeResp, 500)}`);

    box('最终 Claude 响应', [
      `✅ type:         ${claudeResp.type}`,
      `✅ role:         ${claudeResp.role}`,
      `✅ content:      ${claudeResp.content.map(b => b.type).join(', ')}`,
      `✅ stop_reason:  ${claudeResp.stop_reason}`,
      `✅ input_tokens: ${claudeResp.usage.input_tokens}`,
      `✅ output_tokens:${claudeResp.usage.output_tokens}`,
      `✅ 耗时:          ${elapsed}ms`,
    ]);
  } catch (e) {
    console.log(`  💥 网络错误: ${e.message}`);
  }

  // ── 流式模拟 ──
  if (doStream) {
    h2('步骤 6: Stream 模式 (SSE 事件序列)');
    try {
      const streamReq = { ...chatReq, stream: true };
      const res = await fetch(ARK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ARK_API_KEY}` },
        body: JSON.stringify(streamReq),
      });
      if (!res.ok) {
        console.log(`  ❌ HTTP ${res.status}: ${(await res.text()).slice(0, 100)}`);
        return;
      }

      // parseChatStream → StreamEvent
      const eventStream = parseChatStream(res, { id: stdReq.id, model: MODEL });
      const sseStream = serializeClaudeStream(eventStream, ctx);

      console.log('  vv-switch 输出的 Claude SSE 事件:');
      let eventCount = 0;
      let fullContent = '';
      for await (const sse of sseStream) {
        console.log(`  ${sse.slice(0, 200)}${sse.length > 200 ? '...' : ''}`);
        eventCount++;
        // 提取文本内容
        const match = sse.match(/"text":"([^"]+)"/);
        if (match) fullContent += match[1];
      }
      console.log(`\n  📊 共 ${eventCount} 个 SSE 事件`);
      console.log(`  📝 聚合文本: "${fullContent}"`);
    } catch (e) {
      console.log(`  💥 流式错误: ${e.message}`);
    }
  }
}

// ══════════════════════════════════════════════════════════════════
//  场景 2: System Prompt
// ══════════════════════════════════════════════════════════════════
async function scenarioSystemPrompt(doReal) {
  h1('场景 2: System Prompt + 字符串格式');

  const claudeReq = {
    model: MODEL,
    max_tokens: 100,
    system: '你是一个中文助手，回答时保持简洁。',
    messages: [{ role: 'user', content: '1+1=?' }],
  };

  console.log('\n  📤 Claude 发出请求:');
  console.log(`  ${pretty(claudeReq, 300)}`);

  const stdReq = parseClaudeRequest(claudeReq, ctx);
  const chatReq = buildChatRequest(stdReq, MODEL);

  h2('StandardRequest.system');
  console.log(`  类型: ${typeof stdReq.system}`);
  console.log(`  内容: "${stdReq.system}"`);

  h2('Chat Completions system role');
  console.log(`  messages[0]: ${pretty(chatReq.messages[0], 200)}`);

  box('验证', [
    `✅ system string → messages[0] role=system`,
    `✅ content 正确: "${chatReq.messages[0]?.content}"`,
  ]);

  if (!doReal) return;
  const res = await fetch(ARK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ARK_API_KEY}` },
    body: JSON.stringify(chatReq),
  });
  const data = await res.json();
  const stdResp = parseChatResponse(data, { id: stdReq.id, model: MODEL });
  const claudeResp = serializeClaudeResponse(stdResp, ctx);
  const text = claudeResp.content.find(b => b.type === 'text');
  console.log(`\n  💬 模型回答: "${text?.text}"`);
  console.log(`  📊 tokens: ${stdResp.usage.inputTokens} in / ${stdResp.usage.outputTokens} out`);
}

// ══════════════════════════════════════════════════════════════════
//  场景 3: 工具调用
// ══════════════════════════════════════════════════════════════════
async function scenarioToolCall(doReal) {
  h1('场景 3: 工具调用 (bash)');

  const claudeReq = {
    model: MODEL,
    max_tokens: 500,
    messages: [{ role: 'user', content: '执行 date 命令查看系统时间' }],
    tools: [{
      name: 'bash',
      description: 'Execute a shell command',
      input_schema: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The shell command to execute' } },
        required: ['command'],
      },
    }],
  };

  console.log('\n  📤 Claude 发出请求:');
  console.log(`  ${pretty(claudeReq, 400)}`);

  const stdReq = parseClaudeRequest(claudeReq, ctx);
  const chatReq = buildChatRequest(stdReq, MODEL);

  h2('Anthropic 工具过滤');
  console.log(`  过滤前: 1 个 bash (用户自定义)`);
  console.log(`  过滤后: ${stdReq.tools.length} 个`);
  console.log(`  工具名: ${stdReq.tools.map(t => t.name).join(', ')}`);

  h2('Chat Completions tools');
  console.log(`  tools[0].type: ${chatReq.tools?.[0]?.type}`);
  console.log(`  tools[0].function.name: ${chatReq.tools?.[0]?.function?.name}`);
  console.log(`  tools[0].function.parameters: ${pretty(chatReq.tools?.[0]?.function?.parameters, 300)}`);

  box('input_schema → parameters', [
    `✅ 类型映射: input_schema → function.parameters`,
    `✅ properties/required 保留`,
    `✅ description 保留`,
  ]);

  if (!doReal) return;
  const res = await fetch(ARK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ARK_API_KEY}` },
    body: JSON.stringify(chatReq),
  });
  const raw = await res.text();
  if (!res.ok) {
    console.log(`\n  ❌ HTTP ${res.status}: ${raw.slice(0, 200)}`);
    return;
  }
  const data = JSON.parse(raw);
  const stdResp = parseChatResponse(data, { id: stdReq.id, model: MODEL });
  const claudeResp = serializeClaudeResponse(stdResp, ctx);
  const toolUse = claudeResp.content.find(b => b.type === 'tool_use');
  console.log(`\n  🛠 工具调用: ${toolUse?.name}`);
  console.log(`  📦 参数: ${pretty((toolUse)?.input, 200)}`);
  console.log(`  ⏹  stop_reason: ${claudeResp.stop_reason}`);
}

// ══════════════════════════════════════════════════════════════════
//  场景 4: 多轮对话 + tool_result
// ══════════════════════════════════════════════════════════════════
async function scenarioMultiTurn(doReal) {
  h1('场景 4: 多轮对话 (tool_use → tool_result)');

  const claudeReq = {
    model: MODEL,
    max_tokens: 500,
    messages: [
      { role: 'user', content: '用 bash 获取系统时间' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'date' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: '2026-07-03 20:00:00 CST' },
        ],
      },
      { role: 'user', content: '继续,再执行一次 uptime' },
    ],
    tools: [{
      name: 'bash',
      description: 'Execute a shell command',
      input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    }],
  };

  console.log('\n  📤 Claude 发出请求:');
  console.log(`  ${pretty(claudeReq, 500)}`);

  const stdReq = parseClaudeRequest(claudeReq, ctx);
  const chatReq = buildChatRequest(stdReq, MODEL);

  h2('消息转换详情');
  console.log('  Claude Messages → StandardRequest → Chat Completions');
  console.log('');
  for (let i = 0; i < stdReq.messages.length; i++) {
    const m = stdReq.messages[i];
    const content = typeof m.content === 'string' ? `"${m.content.slice(0, 50)}"` : `[${m.content.length} parts: ${m.content.map(p => p.type).join(', ')}]`;
    console.log(`  Standard[${i}] role=${m.role}  ${content}`);
  }
  console.log('');
  for (let i = 0; i < chatReq.messages.length; i++) {
    const m = chatReq.messages[i];
    const content = typeof m.content === 'string' ? `"${m.content.slice(0, 50)}"` : JSON.stringify(m.content).slice(0, 60);
    const extras = [];
    if (m.tool_calls) extras.push(`tc=[${m.tool_calls.map(t => t.function.name).join(',')}]`);
    if (m.tool_call_id) extras.push(`tcid=${m.tool_call_id}`);
    console.log(`  Chat[${i}] role=${m.role}  ${content}  ${extras.join(' ')}`);
  }

  box('关键转换断言', [
    `✅ tool_use → assistant role + tool_calls[]`,
    `✅ tool_result → tool role + tool_call_id`,
    `✅ user content 中的 tool_result 分离为独立 tool 消息`,
    `✅ 后续 user 消息保留为 user role`,
  ]);

  if (!doReal) return;
  const res = await fetch(ARK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ARK_API_KEY}` },
    body: JSON.stringify(chatReq),
  });
  if (!res.ok) { console.log(`\n  ❌ HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`); return; }
  const stdResp = parseChatResponse(await res.json(), { id: stdReq.id, model: MODEL });
  const claudeResp = serializeClaudeResponse(stdResp, ctx);

  console.log(`\n  💬 模型回答:`);
  for (const b of claudeResp.content) {
    if (b.type === 'text') console.log(`    📝 text: "${(b).text?.slice(0, 100)}..."`);
    if (b.type === 'tool_use') console.log(`    🛠 tool_use: ${b.name}`);
    if (b.type === 'thinking') console.log(`    🤔 thinking: "${(b).text?.slice(0, 80)}..."`);
  }
  console.log(`  ⏹  stop_reason: ${claudeResp.stop_reason}`);
}

// ══════════════════════════════════════════════════════════════════
//  场景 5: thinking 字段
// ══════════════════════════════════════════════════════════════════
async function scenarioThinking(doReal) {
  h1('场景 5: Thinking 字段映射');

  // 5a: adaptive
  console.log('\n  ┌─ 5a: thinking: { type: "adaptive" } ──────────────────┐');
  const reqA = parseClaudeRequest({
    model: MODEL, max_tokens: 100,
    thinking: { type: 'adaptive', display: 'summarized' },
    messages: [{ role: 'user', content: '比较一下 Python 和 JavaScript' }],
  }, ctx);
  const chatA = buildChatRequest(reqA, MODEL);
  console.log(`    reasoning_effort: ${chatA.reasoning_effort}`);
  console.log(`    thinking: ${JSON.stringify(chatA.thinking)}`);
  console.log(`  └${'─'.repeat(60)}┘`);

  // 5b: enabled + budget
  console.log('\n  ┌─ 5b: thinking: { type: "enabled", budget: 16000 } ────┐');
  const reqB = parseClaudeRequest({
    model: MODEL, max_tokens: 100,
    thinking: { type: 'enabled', budget_tokens: 16000 },
    messages: [{ role: 'user', content: '写一段复杂算法' }],
  }, ctx);
  const chatB = buildChatRequest(reqB, MODEL);
  console.log(`    reasoning_effort: ${chatB.reasoning_effort}`);
  console.log(`    thinking: ${JSON.stringify(chatB.thinking)}`);
  console.log(`  └${'─'.repeat(60)}┘`);

  box('thinking 映射规则', [
    `adaptive  → thinking: {type:"auto"} + reasoning_effort:"high"`,
    `enabled   → thinking: {type:"enabled"} + reasoning_effort:"high"`,
    `disabled  → 不发送 thinking 字段`,
  ]);

  // 5c: 真实调用测试 adaptive
  if (!doReal) return;

  console.log('\n  ┌─ 5c: 真实调用 adaptive ──────────────────────────────┐');
  console.log('  | (注意: 若火山不支持将自动触发 vv-switch 降级)');
  const res = await fetch(ARK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ARK_API_KEY}` },
    body: JSON.stringify(chatA),
  });
  const raw = await res.text();
  if (!res.ok) {
    console.log(`  ❌ HTTP ${res.status}: ${raw.slice(0, 150)}`);
    console.log('  ℹ  vv-switch 的 fallback 机制会剥离 thinking 后重试');
  } else {
    const stdResp = parseChatResponse(JSON.parse(raw), { id: reqA.id, model: MODEL });
    const claudeResp = serializeClaudeResponse(stdResp, ctx);
    const thinkingBlock = claudeResp.content.find(b => b.type === 'thinking');
    if (thinkingBlock) console.log(`  🤔 reasoning_content → thinking 块: "${(thinkingBlock).text?.slice(0, 100)}"`);
    const textBlock = claudeResp.content.find(b => b.type === 'text');
    if (textBlock) console.log(`  📝 text: "${(textBlock).text?.slice(0, 200)}"`);
  }
  console.log(`  └${'─'.repeat(60)}┘`);
}

// ══════════════════════════════════════════════════════════════════
//  场景 6: 响应解析 (离线模拟)
// ══════════════════════════════════════════════════════════════════
function scenarioResponseParsing() {
  h1('场景 6: Chat Completions 响应 → Claude Messages (离线)');

  const mockResponses = [
    {
      name: '纯文本响应',
      chat: {
        id: 'chatcmpl-1', model: MODEL,
        choices: [{ index: 0, message: { content: '答案是 2。' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
    },
    {
      name: '含 reasoning 的响应',
      chat: {
        id: 'chatcmpl-2', model: MODEL,
        choices: [{
          index: 0, message: { content: '42', reasoning_content: '思考: 先理解问题...' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 20, completion_tokens: 8 },
      },
    },
    {
      name: '工具调用响应(无文本)',
      chat: {
        id: 'chatcmpl-3', model: MODEL,
        choices: [{
          index: 0,
          message: {
            content: null,
            tool_calls: [{ id: 'call_bash', type: 'function', function: { name: 'bash', arguments: '{"command":"date"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 30, completion_tokens: 15 },
      },
    },
  ];

  for (const mock of mockResponses) {
    const stdResp = parseChatResponse(mock.chat, { id: 'resp-test', model: MODEL });
    const claudeResp = serializeClaudeResponse(stdResp, ctx);
    const contentTypes = claudeResp.content.map(b => b.type).join(', ');
    const text = claudeResp.content.find(b => b.type === 'text');
    console.log(`\n  测试: ${mock.name}`);
    console.log(`  choices[0].finish_reason: ${mock.chat.choices[0].finish_reason}`);
    console.log(`  stop_reason: ${claudeResp.stop_reason}`);
    console.log(`  content types: [${contentTypes}]`);
    if (text) console.log(`  text: "${(text).text?.slice(0, 80)}"`);
    console.log(`  usage: ${claudeResp.usage.input_tokens} in / ${claudeResp.usage.output_tokens} out`);
    console.log(`  ${'─'.repeat(60)}`);
  }

  box('响应映射规则', [
    `content              → type:text`,
    `reasoning_content    → type:thinking (保留在 text 之前)`,
    `tool_calls           → type:tool_use`,
    `finish_reason=stop   → stop_reason=end_turn`,
    `finish_reason=length → stop_reason=max_tokens`,
    `finish_reason=tool_calls → stop_reason=tool_use`,
  ]);
}

// ══════════════════════════════════════════════════════════════════
//  场景 7: 带 reasoning_content 流式输出
// ══════════════════════════════════════════════════════════════════
async function scenarioStreamWithReasoning(doReal, doStream) {
  if (!doReal || !doStream) return;
  h1('场景 7: 流式输出 + reasoning_content');

  const claudeReq = {
    model: MODEL, max_tokens: 500, stream: true,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: '解释一下量子计算的原理,300字以内' }],
  };

  const stdReq = parseClaudeRequest(claudeReq, ctx);
  const chatReq = buildChatRequest(stdReq, MODEL);

  console.log('  📤 发送流式请求至火山...\n');

  try {
    const res = await fetch(ARK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ARK_API_KEY}` },
      body: JSON.stringify(chatReq),
    });

    if (!res.ok) {
      console.log(`  ❌ HTTP ${res.status}: ${(await res.text()).slice(0, 150)}`);
      return;
    }

    // parseChatStream → StreamEvent → serializeClaudeStream → Claude SSE
    const eventStream = parseChatStream(res, { id: stdReq.id, model: MODEL });
    const sseStream = serializeClaudeStream(eventStream, ctx);

    let eventCount = 0;
    let textContent = '';
    let thinkingContent = '';
    let toolCallCount = 0;

    console.log('  vv-switch → Claude SSE 流:');
    for await (const sse of sseStream) {
      eventCount++;

      // 提取关键信息
      if (sse.includes('message_start')) {
        console.log(`  [${eventCount}] 📦 message_start`);
      } else if (sse.includes('content_block_start')) {
        const typeMatch = sse.match(/"type":"(\w+)"/);
        const type = typeMatch ? typeMatch[1] : '?';
        console.log(`  [${eventCount}] 🔰 content_block_start: ${type}`);
        if (type === 'tool_use') toolCallCount++;
      } else if (sse.includes('content_block_delta')) {
        const deltaType = sse.includes('"type":"text_delta"') ? 'text_delta'
          : sse.includes('"type":"thinking_delta"') ? 'thinking_delta'
          : sse.includes('"type":"signature_delta"') ? 'signature_delta'
          : '?';
        const textMatch = sse.match(/(?:text|thinking)":"([^"]+)"/);
        const delta = textMatch ? textMatch[1] : '';
        if (deltaType === 'text_delta') textContent += delta;
        if (deltaType === 'thinking_delta') thinkingContent += delta;
        if (eventCount <= 5 || !textMatch) {
          console.log(`  [${eventCount}] 📝 ${deltaType}: "${delta.slice(0, 60)}"`);
        }
      } else if (sse.includes('content_block_stop')) {
        console.log(`  [${eventCount}] ⏹ content_block_stop`);
      } else if (sse.includes('message_delta')) {
        const stopMatch = sse.match(/"stop_reason":"(\w+)"/);
        const stop = stopMatch ? stopMatch[1] : '?';
        console.log(`  [${eventCount}] 📨 message_delta: stop_reason=${stop}`);
      } else if (sse.includes('message_stop')) {
        console.log(`  [${eventCount}] 🛑 message_stop`);
      } else {
        console.log(`  [${eventCount}] ${sse.slice(0, 120)}...`);
      }
    }

    console.log(`\n  📊 统计:`);
    console.log(`     SSE 事件总数: ${eventCount}`);
    console.log(`     思考内容长度: ${thinkingContent.length} 字符`);
    console.log(`     文本内容长度: ${textContent.length} 字符`);
    console.log(`     工具调用: ${toolCallCount} 个`);
    if (thinkingContent) console.log(`     🤔 思考预览: "${thinkingContent.slice(0, 100)}..."`);
    console.log(`     📝 文本预览: "${textContent.slice(0, 100)}..."`);
  } catch (e) {
    console.log(`  💥 错误: ${e.message}`);
  }
}

// ══════════════════════════════════════════════════════════════════
//  场景 8: System 数组格式 (测试 cache_control 剥离)
// ══════════════════════════════════════════════════════════════════
function scenarioSystemArray() {
  h1('场景 8: System 数组格式 + cache_control');

  console.log('\n  ┌─ 8a: 不带 cache_control ──────────────────────────┐');
  const reqA = parseClaudeRequest({
    model: MODEL, max_tokens: 100,
    system: [
      { type: 'text', text: '规则一: 保持简洁' },
      { type: 'text', text: '规则二: 只回答核心内容' },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  }, ctx);
  console.log(`  system 类型: ${typeof reqA.system}`);
  console.log(`  system 内容: "${reqA.system}"`);
  console.log(`  ✅ 无 cache_control → 合并为字符串`);
  console.log(`  └${'─'.repeat(60)}┘`);

  console.log('\n  ┌─ 8b: 带 cache_control ───────────────────────────┐');
  const reqB = parseClaudeRequest({
    model: MODEL, max_tokens: 100,
    system: [
      { type: 'text', text: '基础规则', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '详细规则说明' },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  }, ctx);
  console.log(`  system 类型: ${typeof reqB.system}`);
  if (Array.isArray(reqB.system)) {
    for (const b of reqB.system) {
      console.log(`  block: text="${b.text?.slice(0, 40)}" cacheControl=${b.cacheControl ? JSON.stringify(b.cacheControl) : '无'}`);
    }
  }
  console.log(`  ✅ 有 cache_control → 保留为数组结构`);
  console.log(`  └${'─'.repeat(60)}┘`);

  const chatA = buildChatRequest(reqA, MODEL);
  const chatB = buildChatRequest(reqB, MODEL);
  console.log('\n  Chat Completions 始终是字符串:');
  console.log(`  8a system 内容: "${chatA.messages[0]?.content?.toString().slice(0, 80)}"`);
  console.log(`  8b system 内容: "${chatB.messages[0]?.content?.toString().slice(0, 80)}"`);
  console.log(`  ✅ cache_control 在 Chat 链路中自然丢弃`);
}

// ══════════════════════════════════════════════════════════════════
//  主流程
// ══════════════════════════════════════════════════════════════════

async function main() {
  console.log('');
  divider('═', 72);
  console.log('  vv-switch 模拟: Claude Code → 火山 Chat API 全链路');
  console.log(`  模型: ${MODEL}`);
  console.log(`  火山端点: ${ARK_URL}`);
  if (ARGS.real) console.log('  模式: 协议转换 + 真实 HTTP 调用');
  else console.log('  模式: 仅协议转换 (加 --real 启用真实调用)');
  if (ARGS.stream) console.log('  模式: 含流式 SSE 测试');
  divider('═', 72);

  // 离线测试
  scenarioResponseParsing();
  scenarioSystemArray();

  // 场景: 简单文本
  await scenarioSimpleChat(ARGS.real, ARGS.stream);

  // 场景: system prompt
  await scenarioSystemPrompt(ARGS.real);

  // 场景: 工具调用
  await scenarioToolCall(ARGS.real);

  // 场景: 多轮对话
  await scenarioMultiTurn(ARGS.real);

  // 场景: thinking
  await scenarioThinking(ARGS.real);

  // 场景: 流式 thinking
  await scenarioStreamWithReasoning(ARGS.real, ARGS.stream);

  // ── 总结 ──
  console.log('\n');
  divider('═', 72);
  console.log('  协议转换全景');
  divider('═', 72);
  console.log('');
  console.log('  Claude (Anthropic Messages)           Chat Completions (火山)');
  console.log('  ─────────────────────────              ────────────────────────');
  console.log('  messages[].role=user                   → messages[].role=user');
  console.log('  messages[].role=assistant              → messages[].role=assistant');
  console.log('  messages[].content: tool_use           → messages[].tool_calls[]');
  console.log('  messages[].content: tool_result        → messages[].role=tool');
  console.log('  system: string | Array<{text}>         → messages[0] role=system');
  console.log('  tools[].input_schema                   → tools[].function.parameters');
  console.log('  thinking: {type:"adaptive"}            → {type:"auto"} + reasoning_effort:"high"');
  console.log('  thinking: {type:"enabled",budget}      → {type:"enabled"} + reasoning_effort:"high"');
  console.log('  stream: true                           → stream: true');
  console.log('');
  console.log('  Chat Completions 响应                    Claude Messages');
  console.log('  ─────────────────                       ───────────────');
  console.log('  choices[0].message.content              → content[{type:"text"}]');
  console.log('  choices[0].message.reasoning_content    → content[{type:"thinking"}]');
  console.log('  choices[0].message.tool_calls           → content[{type:"tool_use"}]');
  console.log('  finish_reason: stop                     → stop_reason: end_turn');
  console.log('  finish_reason: length                   → stop_reason: max_tokens');
  console.log('  finish_reason: tool_calls               → stop_reason: tool_use');
  console.log('  finish_reason: content_filter           → stop_reason: stop_sequence');
  console.log('  usage.prompt_tokens                     → usage.input_tokens');
  console.log('  usage.completion_tokens                 → usage.output_tokens');
  console.log('');
  divider('═', 72);
  console.log('  完成!');
  divider('═', 72);
  console.log('');
  console.log('  使用方式:');
  console.log('    node simulate-claude-vvswitch.mjs          # 仅协议转换(离线)');
  console.log('    node simulate-claude-vvswitch.mjs --real   # + 真实 HTTP 调用');
  console.log('    node simulate-claude-vvswitch.mjs --stream # + 流式测试');
  console.log('    node simulate-claude-vvswitch.mjs --all    # 全部模式');
  console.log('');
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
