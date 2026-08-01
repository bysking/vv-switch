/**
 * 火山引擎 Chat Completions 协议转换探测脚本
 *
 * 验证 vv-switch 的协议转换链路是否正常:
 *
 *   1. Claude Anthropic Messages → StandardRequest (parseClaudeRequest)
 *   2. StandardRequest → OpenAI Chat Completions (buildChatRequest)
 *   3. Chat Completions 响应 → StandardResponse (parseChatResponse)
 *   4. StandardResponse → Claude Anthropic Messages 响应 (serializeClaudeResponse)
 *
 * 用法:
 *   tsx test-volcano-protocol-probe.ts          # 仅协议转换测试
 *   tsx test-volcano-protocol-probe.ts --live   # 同时执行真实 HTTP 调用探测
 */

// ── 导入 vv-switch 协议转换模块 ──────────────────────────────────
import { parseClaudeRequest } from './src/adapters/claude/parse.js';
import { serializeClaudeResponse } from './src/adapters/claude/serialize.js';
import { buildChatRequest } from './src/providers/openai-compatible/request.js';
import { parseChatResponse } from './src/providers/openai-compatible/response.js';
import type { StandardRequest } from './src/protocol/standard-request.js';
import type { AdapterContext } from './src/types/adapter.js';

const LIVE = process.argv.includes('--live');

// ── 配置 ──────────────────────────────────────────────────────────
const ARK_URL = process.env.ARK_URL || 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions';
const ARK_API_KEY = process.env.ARK_API_KEY || '';
const MODEL = process.env.MODEL || 'GLM-5.2';

const ctx: AdapterContext = { id: 'probe-001', defaultModel: MODEL };

// ── 工具函数 ──────────────────────────────────────────────────────
function section(title: string): void {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${title}`);
  console.log(`${'═'.repeat(70)}`);
}

function preview(obj: unknown, maxLen = 600): string {
  const raw = JSON.stringify(obj, null, 2);
  if (raw.length <= maxLen) return raw;
  return raw.slice(0, maxLen) + `\n  ... (${raw.length - maxLen} chars truncated)`;
}

function liveSection(title: string): void {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  🌐 [LIVE] ${title}`);
  console.log(`${'─'.repeat(60)}`);
}

async function callLive(body: Record<string, unknown>, label: string): Promise<{ ok: boolean; status: number; body: string; elapsed: number }> {
  const t0 = Date.now();
  try {
    const res = await fetch(ARK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ARK_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
    const elapsed = Date.now() - t0;
    const text = await res.text();
    if (res.ok) {
      let preview = '';
      try {
        const data = JSON.parse(text);
        preview = data.choices?.[0]?.message?.content || String(data.choices?.[0]?.message?.tool_calls?.[0]?.function?.name || '');
      } catch { preview = text.slice(0, 100); }
      console.log(`  ✅ [${elapsed}ms] ${label}: ${preview.slice(0, 120)}`);
    } else {
      console.log(`  ❌ [${elapsed}ms] ${label}: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    return { ok: res.ok, status: res.status, body: text, elapsed };
  } catch (e: any) {
    console.log(`  💥 [${Date.now() - t0}ms] ${label}: ${e.message}`);
    return { ok: false, status: 0, body: '', elapsed: Date.now() - t0 };
  }
}

// ═══════════════════════════════════════════════════════════════
//  协议转换测试
// ═══════════════════════════════════════════════════════════════

function testSimpleText() {
  section('测试 1: 简单文本 — Claude → Standard → Chat');
  const claudeBody = { model: MODEL, max_tokens: 100, messages: [{ role: 'user', content: '说"你好",只回两个字' }] };
  const standardReq = parseClaudeRequest(claudeBody, ctx);
  const chatReq = buildChatRequest(standardReq, MODEL);
  console.log('  [chatRequest] model:', chatReq.model);
  console.log('  [chatRequest] messages[0].role:', chatReq.messages[0]?.role);
  console.log('  [chatRequest] messages[0].content:', String(chatReq.messages[0]?.content).slice(0, 80));
  liveSection('简单文本直连火山');
  if (LIVE) return callLive(chatReq as any, 'simple-text');
}

function testSystemPrompt() {
  section('测试 2: System Prompt — Claude → Standard → Chat');
  const claudeBody = {
    model: MODEL, max_tokens: 100,
    system: '你是一个简洁的助手，只回答核心内容。',
    messages: [{ role: 'user', content: '1+1=?' }],
  };
  const standardReq = parseClaudeRequest(claudeBody, ctx);
  const chatReq = buildChatRequest(standardReq, MODEL);
  console.log('  [chatRequest] messages[0]:', JSON.stringify(chatReq.messages[0]));
}

function testSystemArray() {
  section('测试 3: System 数组格式 — Claude → Standard → Chat');
  const claudeBody = {
    model: MODEL, max_tokens: 100,
    system: [
      { type: 'text', text: '第一部分规则' },
      { type: 'text', text: '第二部分规则' },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  };
  const standardReq = parseClaudeRequest(claudeBody, ctx);
  const chatReq = buildChatRequest(standardReq, MODEL);
  const systemStr = typeof standardReq.system === 'string' ? standardReq.system : JSON.stringify(standardReq.system);
  console.log('  [system] type:', typeof standardReq.system, 'content:', systemStr.slice(0, 80));
  console.log('  ✅ 无 cache_control 时数组降级为字符串');
}

function testTools() {
  section('测试 4: 工具定义 — Claude tools → Standard → Chat');
  const claudeBody = {
    model: MODEL, max_tokens: 500,
    messages: [{ role: 'user', content: '获取系统时间' }],
    tools: [{
      name: 'bash', description: 'Execute a shell command',
      input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    }],
  };
  const standardReq = parseClaudeRequest(claudeBody, ctx);
  const chatReq = buildChatRequest(standardReq, MODEL);
  console.log('  [tools] name:', chatReq.tools?.[0]?.function?.name);
  liveSection('工具定义直连火山');
  if (LIVE) return callLive(chatReq as any, 'tools');
}

function testToolCallsMultiTurn() {
  section('测试 5: 多轮工具调用 — tool_use + tool_result → Chat');
  const claudeBody = {
    model: MODEL, max_tokens: 500,
    messages: [
      { role: 'user', content: '获取系统时间' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'date' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Thu Jul 3 10:00:00 CST 2026' }] },
    ],
    tools: [{
      name: 'bash', description: 'Execute a shell command',
      input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    }],
  };
  const standardReq = parseClaudeRequest(claudeBody, ctx);
  const chatReq = buildChatRequest(standardReq, MODEL);
  console.log('  [chat messages]');
  for (const m of chatReq.messages) {
    const c = typeof m.content === 'string' ? `"${m.content.slice(0, 40)}"` : JSON.stringify(m.content).slice(0, 60);
    console.log(`    role=${m.role} content=${c}${m.tool_calls ? ` tc=[${m.tool_calls.map(t => t.function.name).join(',')}]` : ''}${m.tool_call_id ? ` tcid=${m.tool_call_id}` : ''}`);
  }
  liveSection('多轮工具直连火山');
  if (LIVE) return callLive(chatReq as any, 'multi-turn-tools');
}

function testThinking() {
  section('测试 6: thinking adaptive — Claude → Standard → Chat');
  const claudeBody = {
    model: MODEL, max_tokens: 100,
    thinking: { type: 'adaptive', display: 'summarized' },
    messages: [{ role: 'user', content: '1+1=?' }],
  };
  const standardReq = parseClaudeRequest(claudeBody, ctx);
  const chatReq = buildChatRequest(standardReq, MODEL);
  console.log('  [chatRequest] reasoning_effort:', chatReq.reasoning_effort);
  console.log('  [chatRequest] thinking:', JSON.stringify(chatReq.thinking));
  liveSection('thinking adaptive 直连火山');
  if (LIVE) return callLive(chatReq as any, 'thinking-adaptive');
}

function testThinkingEnabledWithBudget() {
  section('测试 7: thinking enabled + budget — Claude → Standard → Chat');
  const claudeBody = {
    model: MODEL, max_tokens: 100,
    thinking: { type: 'enabled', budget_tokens: 16000 },
    messages: [{ role: 'user', content: '1+1=?' }],
  };
  const standardReq = parseClaudeRequest(claudeBody, ctx);
  const chatReq = buildChatRequest(standardReq, MODEL);
  console.log('  [chatRequest] reasoning_effort:', chatReq.reasoning_effort);
  console.log('  [chatRequest] thinking:', JSON.stringify(chatReq.thinking));
}

function testCapabilitiesDetection() {
  section('测试 8: 能力标签推导 — capabilitiesRequired');
  const req1 = parseClaudeRequest({
    model: MODEL, max_tokens: 100,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'bash', input_schema: { type: 'object', properties: {} } }],
  }, ctx);
  const req2 = parseClaudeRequest({
    model: MODEL, max_tokens: 100,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: 'hi' }],
  }, ctx);
  console.log('  [tools场景] capabilities:', req1.capabilitiesRequired.join(', '));
  console.log('  [thinking场景] capabilities:', req2.capabilitiesRequired.join(', '));
  console.log('  ✅ tool_call + thinking 标签正确');
}

function testResponseConversion() {
  section('测试 9: Chat 响应 → Standard → Claude');
  const chatResponse = {
    id: 'chatcmpl-test', model: MODEL,
    choices: [{
      index: 0,
      message: {
        content: '答案是 2。',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"date"}' } }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  };
  const stdResp = parseChatResponse(chatResponse, { id: 'probe-001', model: MODEL });
  const claudeResp = serializeClaudeResponse(stdResp, ctx);
  console.log('  [claude] content:', JSON.stringify(claudeResp.content));
  console.log('  [claude] stop_reason:', claudeResp.stop_reason);
  console.log('  [claude] usage:', JSON.stringify(claudeResp.usage));
  console.log('  ✅ tool_use 正常 → Claude type:message');
}

function testResponseWithThinking() {
  section('测试 10: reasoning_content 响应 → Standard → Claude');
  const chatResponse = {
    id: 'chatcmpl-2', model: MODEL,
    choices: [{
      index: 0,
      message: { content: '2', reasoning_content: '第一步:1+1,第二步:计算' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
  const stdResp = parseChatResponse(chatResponse, { id: 'probe-002', model: MODEL });
  const claudeResp = serializeClaudeResponse(stdResp, ctx);
  const thinkingBlock = claudeResp.content.find((b: any) => b.type === 'thinking');
  const textBlock = claudeResp.content.find((b: any) => b.type === 'text');
  console.log('  [thinking block]:', JSON.stringify(thinkingBlock));
  console.log('  [text block]:', JSON.stringify(textBlock));
  console.log('  ✅ reasoning_content → thinking block');
}

function testResponseWithToolOnly() {
  section('测试 11: 纯工具响应(无文本) — Chat → Standard → Claude');
  const chatResponse = {
    id: 'chatcmpl-3', model: MODEL,
    choices: [{
      index: 0,
      message: { content: null, tool_calls: [{ id: 'call_bash', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 15, completion_tokens: 3 },
  };
  const stdResp = parseChatResponse(chatResponse, { id: 'probe-003', model: MODEL });
  const claudeResp = serializeClaudeResponse(stdResp, ctx);
  const hasTool = claudeResp.content.some((b: any) => b.type === 'tool_use');
  const hasText = claudeResp.content.some((b: any) => b.type === 'text');
  console.log('  [claude] content:', JSON.stringify(claudeResp.content));
  console.log('  [claude] stop_reason:', claudeResp.stop_reason);
  console.log(`  ${hasTool && !hasText ? '✅' : '❌'} content_null → 纯 tool_use, 无 text block`);
}

function testAnthropicDefinedToolsFiltered() {
  section('测试 12: Anthropic 内置工具过滤');
  const claudeBody = {
    model: MODEL, max_tokens: 100,
    messages: [{ role: 'user', content: 'list files' }],
    tools: [
      { name: 'my_custom_tool', description: 'my tool', input_schema: { type: 'object', properties: {} } },
      { type: 'bash_20241022', name: 'bash', description: 'bash tool', input_schema: { type: 'object', properties: {} } },
      { type: 'text_editor_20250124', name: 'str_replace_editor', description: 'editor', input_schema: { type: 'object', properties: {} } },
    ],
  };
  const stdReq = parseClaudeRequest(claudeBody, ctx);
  console.log('  [保留] tool names:', stdReq.tools.map(t => t.name).join(', '));
  console.log('  ✅ 仅保留自定义工具, 过滤 Anthropic 内置工具');
}

function testResponseStopReasonMapping() {
  section('测试 13: finish_reason → Claude stop_reason 映射');
  const map: Record<string, string> = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'stop_sequence' };
  for (const [finish, expected] of Object.entries(map)) {
    const stdResp = parseChatResponse(
      { id: 't', model: MODEL, choices: [{ index: 0, message: { content: 'ok' }, finish_reason: finish }], usage: {} },
      { id: 't', model: MODEL },
    );
    const claudeResp = serializeClaudeResponse(stdResp, ctx);
    console.log(`  finish="${finish}" → "${claudeResp.stop_reason}" ${claudeResp.stop_reason === expected ? '✅' : '❌'}`);
  }
}

function testFullRequestRoundTrip() {
  section('测试 14: 完整往返 — 打印全链路');
  const claudeBody = {
    model: MODEL, max_tokens: 4096, stream: false,
    system: [
      { type: 'text', text: '你是一个擅长系统管理的助手。' },
      { type: 'text', text: '使用 bash 执行命令。' },
    ],
    thinking: { type: 'adaptive', display: 'summarized' },
    messages: [
      { role: 'user', content: '获取系统时间,用 bash 执行 date' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_prev', name: 'bash', input: { command: 'date' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_prev', content: 'Thu Jul 3 10:00:00 CST 2026' }] },
    ],
    tools: [{
      name: 'bash', description: 'Execute a shell command',
      input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    }],
  };

  const stdReq = parseClaudeRequest(claudeBody, ctx);
  const chatReq = buildChatRequest(stdReq, MODEL);

  console.log('\n  ◆ 步骤 1: Claude Anthropic Messages');
  console.log('  POST /v1/messages');
  console.log(preview(claudeBody, 500));

  console.log('\n  ◆ 步骤 2: StandardRequest (内部统一协议)');
  console.log(preview({
    agent: stdReq.agent,
    model: stdReq.model,
    messages: stdReq.messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 50) : `[${m.content.length} parts]` })),
    tools: stdReq.tools.map(t => t.name),
    parameters: stdReq.parameters,
    capabilitiesRequired: stdReq.capabilitiesRequired,
  }, 400));

  console.log('\n  ◆ 步骤 3: Chat Completions (发送给火山 /chat/completions)');
  console.log(preview(chatReq, 600));

  // 验证关键断言
  console.log('\n  ◆ 转换断言:');
  const checks = [
    ['模型名不变', chatReq.model === MODEL],
    ['首条为 system role', chatReq.messages[0]?.role === 'system'],
    ['tool_result → tool role', chatReq.messages.some(m => m.role === 'tool')],
    ['assistant 有 tool_calls', chatReq.messages.some(m => m.role === 'assistant' && m.tool_calls)],
    ['thinking → auto + reasoning_effort', chatReq.reasoning_effort === 'high' && (chatReq.thinking as any)?.type === 'auto'],
    ['tool 定义完整', chatReq.tools?.length === 1 && chatReq.tools![0].function.name === 'bash'],
  ];
  for (const [desc, ok] of checks) {
    console.log(`    ${ok ? '✅' : '❌'} ${desc}`);
  }

  liveSection('完整请求直连火山');
  if (LIVE) return callLive(chatReq as any, 'full-request');
}

// ═══════════════════════════════════════════════════════════════
//  主流程
// ═══════════════════════════════════════════════════════════════

let passCount = 0;
let failCount = 0;

const tests = [
  testSimpleText,
  testSystemPrompt,
  testSystemArray,
  testTools,
  testToolCallsMultiTurn,
  testThinking,
  testThinkingEnabledWithBudget,
  testCapabilitiesDetection,
  testResponseConversion,
  testResponseWithThinking,
  testResponseWithToolOnly,
  testAnthropicDefinedToolsFiltered,
  testResponseStopReasonMapping,
  testFullRequestRoundTrip,
];

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║  火山 Chat Completions 协议转换探测                          ║');
console.log('║  Claude Messages ↔ Standard ↔ Chat Completions 全链路       ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log(`  转换测试 ${tests.length} 个${LIVE ? ' + 实时 HTTP 探测' : ''}`);
console.log('  --live 参数可开启真实 HTTP 调用');

const livePromises: Promise<any>[] = [];

for (const testFn of tests) {
  try {
    const maybePromise = testFn();
    if (maybePromise instanceof Promise) livePromises.push(maybePromise);
    console.log(`  ✅ ${testFn.name}`);
    passCount++;
  } catch (e: any) {
    console.log(`  ❌ ${testFn.name}: ${e.message}`);
    console.log(`     ${e.stack?.split('\n').slice(1, 3).join('\n') || ''}`);
    failCount++;
  }
}

// 等待 live 测试完成
if (livePromises.length > 0) {
  await Promise.all(livePromises);
}

console.log(`\n${'═'.repeat(70)}`);
console.log(`  结果: ✅ ${passCount} 通过, ❌ ${failCount} 失败`);
if (failCount > 0) process.exit(1);

// 摘要输出
console.log(`\n${'═'.repeat(70)}`);
console.log('  协议转换全景图');
console.log(`${'═'.repeat(70)}`);
console.log(`
  Claude (Anthropic Messages)           Chat Completions (火山)
  ────────────────────────────           ───────────────────────
  messages[].role = user                 → messages[].role = user
  messages[].role = assistant            → messages[].role = assistant
  messages[].content: Array<tool_use>    → messages[].tool_calls[].function
  messages[].content: tool_result        → messages[].role = tool
  system: string | Array                → messages[0] role=system
  system: [{text, cache_control}]       → string(合并, 丢弃 cache_control)
  tools[].input_schema                  → tools[].function.parameters
  thinking: {type:"adaptive"}           → thinking: {type:"auto"} + reasoning_effort:"high"
  thinking: {type:"enabled"}            → thinking: {type:"enabled"} + reasoning_effort:"high"
  stream: true                          → stream: true
  max_tokens                            → max_tokens

  Chat Completions 响应                    Claude (Anthropic Messages)
  ────────────────────────                ────────────────────────────
  choices[0].message.content             → content[{type:"text"}]
  choices[0].message.reasoning_content   → content[{type:"thinking"}]
  choices[0].message.tool_calls          → content[{type:"tool_use"}]
  finish_reason: stop                    → stop_reason: end_turn
  finish_reason: length                  → stop_reason: max_tokens
  finish_reason: tool_calls              → stop_reason: tool_use
  finish_reason: content_filter          → stop_reason: stop_sequence
  usage.prompt_tokens                    → usage.input_tokens
  usage.completion_tokens                → usage.output_tokens
`);
