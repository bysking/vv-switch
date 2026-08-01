#!/usr/bin/env node

/**
 * 火山引擎 GLM-5.2 chat 接入诊断测试
 *
 * 目标: 定位 "Claude → vv-switch → 火山 GLM-5.2 chat" 链路中,
 *       到底是 vv-switch 代码问题还是 GLM-5.2 模型/接口问题。
 *
 * 策略: 逐字段隔离,直连火山 /chat/completions,观察每个字段是否触发 400。
 *       再把 vv-switch 生成的完整请求体直接发给火山,定位问题字段。
 *
 * 用法:
 *   node test-volcano-glm52-chat.mjs                # 用默认 API key
 *   ARK_API_KEY=xxx node test-volcano-glm52-chat.mjs # 覆盖 key
 *   VV_SWITCH_URL=http://localhost:4321/v1/messages node test-volcano-glm52-chat.mjs  # 同时测代理
 */

// ── 配置 ────────────────────────────────────────────────────────────
const ARK_URL = process.env.ARK_URL || 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions';
const ARK_API_KEY = process.env.ARK_API_KEY || '';
const MODEL = process.env.MODEL || 'GLM-5.2';
const VV_SWITCH_URL = process.env.VV_SWITCH_URL || ''; // 可选: 经代理测

let passCount = 0;
let failCount = 0;

// ── 工具函数 ─────────────────────────────────────────────────────────
async function callArk(label, body) {
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
        const msg = data.choices?.[0]?.message;
        preview = msg?.content || JSON.stringify(msg?.tool_calls || '').slice(0, 120);
      } catch {
        preview = text.slice(0, 120);
      }
      console.log(`  ✅ [${elapsed}ms] ${label} | ${preview}`);
      passCount++;
      return { ok: true, status: res.status, body: text };
    } else {
      console.log(`  ❌ [${elapsed}ms] ${label} | HTTP ${res.status}: ${text.slice(0, 200)}`);
      failCount++;
      return { ok: false, status: res.status, body: text };
    }
  } catch (e) {
    console.log(`  💥 ${label} | ${e.message}`);
    failCount++;
    return { ok: false, error: e.message };
  }
}

function section(title) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'═'.repeat(60)}`);
}

// ── 测试用例 ─────────────────────────────────────────────────────────

async function testMinimal() {
  section('测试 1: 最小请求(仅 model + messages)— 基线');
  await callArk('minimal', {
    model: MODEL,
    messages: [{ role: 'user', content: '说"你好",只回两个字' }],
    max_tokens: 100,
  });
}

async function testStream() {
  section('测试 2: 流式请求 stream=true');
  const t0 = Date.now();
  try {
    const res = await fetch(ARK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ARK_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: '说"你好"' }],
        max_tokens: 100,
        stream: true,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.log(`  ❌ HTTP ${res.status}: ${text.slice(0, 200)}`);
      failCount++;
      return;
    }
    // 读流
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let chunkCount = 0;
    let fullText = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      fullText += chunk;
      chunkCount++;
    }
    console.log(`  ✅ [${Date.now() - t0}ms] stream | ${chunkCount} chunks | 末尾: ${fullText.slice(-100).replace(/\n/g, ' ')}`);
    passCount++;
  } catch (e) {
    console.log(`  💥 stream | ${e.message}`);
    failCount++;
  }
}

async function testReasoningEffort() {
  section('测试 3: reasoning_effort 字段(OpenAI 风格思考强度)');
  await callArk('reasoning_effort=high', {
    model: MODEL,
    messages: [{ role: 'user', content: '1+1=?' }],
    max_tokens: 100,
    reasoning_effort: 'high',
  });
}

async function testThinkingField() {
  section('测试 4: thinking 字段(百炼/Anthropic 风格)');
  await callArk('thinking.type=auto', {
    model: MODEL,
    messages: [{ role: 'user', content: '1+1=?' }],
    max_tokens: 100,
    thinking: { type: 'auto' },
  });
  await callArk('thinking.type=enabled', {
    model: MODEL,
    messages: [{ role: 'user', content: '1+1=?' }],
    max_tokens: 100,
    thinking: { type: 'enabled' },
  });
  await callArk('thinking.type=adaptive(Anthropic原样)', {
    model: MODEL,
    messages: [{ role: 'user', content: '1+1=?' }],
    max_tokens: 100,
    thinking: { type: 'adaptive' },
  });
}

async function testTools() {
  section('测试 5: 工具调用(单轮)');
  await callArk('tools+bash', {
    model: MODEL,
    messages: [{ role: 'user', content: '获取系统时间,用 bash 执行 date' }],
    max_tokens: 500,
    tools: [{
      type: 'function',
      function: {
        name: 'bash',
        description: 'Execute a shell command',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
    }],
  });
}

async function testMultiTurnToolCall() {
  section('测试 6: 多轮工具调用(messages=2+,含 assistant tool_calls + tool result)');
  // 这是 Claude Code 多轮对话的典型场景,也是 vv-switch 生成请求体的关键测试
  await callArk('multi-turn tool call', {
    model: MODEL,
    messages: [
      { role: 'user', content: '获取系统时间,用 bash 执行 date' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'bash', arguments: '{"command":"date"}' },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'Thu Jul 3 10:00:00 CST 2026',
      },
    ],
    max_tokens: 500,
    tools: [{
      type: 'function',
      function: {
        name: 'bash',
        description: 'Execute a shell command',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
    }],
  });
}

async function testAssistantNullContent() {
  section('测试 7: assistant content=null 是否被接受(隔离测试)');
  // 有的 API 要求 assistant 消息 content 不能为 null,必须是字符串
  await callArk('assistant content=null', {
    model: MODEL,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ],
    max_tokens: 100,
  });
  await callArk('assistant content="" (空串)', {
    model: MODEL,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ],
    max_tokens: 100,
  });
}

async function testFullVvSwitchBody() {
  section('测试 8: vv-switch 生成的完整请求体(含 reasoning_effort + thinking + tools)');
  // 这正是 vv-switch 会发给火山的请求体
  await callArk('vv-switch full body', {
    model: MODEL,
    messages: [
      { role: 'user', content: '获取系统时间,用 bash 执行 date' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'bash', arguments: '{"command":"date"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'Thu Jul 3 10:00:00 CST 2026' },
    ],
    stream: false,
    max_tokens: 4096,
    reasoning_effort: 'high',
    thinking: { type: 'auto' },
    tools: [{
      type: 'function',
      function: {
        name: 'bash',
        description: 'Execute a shell command',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
    }],
  });
}

async function testThroughProxy() {
  if (!VV_SWITCH_URL) {
    console.log('\n  (跳过代理测试: 未设置 VV_SWITCH_URL)');
    return;
  }
  section('测试 9: 经 vv-switch 代理(Claude /v1/messages 格式 → 火山)');
  // 发 Claude 格式请求,让 vv-switch 转成 chat 格式发火山
  const t0 = Date.now();
  try {
    const res = await fetch(VV_SWITCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'test-key',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        stream: true,
        messages: [
          { role: 'user', content: '获取系统时间,用 bash 执行 date' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'date' } }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Thu Jul 3 10:00:00 CST 2026' }],
          },
        ],
        tools: [{
          name: 'bash',
          description: 'Execute a shell command',
          input_schema: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
        }],
      }),
    });
    const text = await res.text();
    if (res.ok) {
      console.log(`  ✅ [${Date.now() - t0}ms] proxy | ${text.slice(0, 200).replace(/\n/g, ' ')}`);
      passCount++;
    } else {
      console.log(`  ❌ [${Date.now() - t0}ms] proxy | HTTP ${res.status}: ${text.slice(0, 300)}`);
      failCount++;
    }
  } catch (e) {
    console.log(`  💥 proxy | ${e.message}`);
    failCount++;
  }
}

// ── 主流程 ───────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  火山引擎 GLM-5.2 chat 接入诊断                          ║');
  console.log(`║  URL: ${ARK_URL.padEnd(46)}║`);
  console.log(`║  Model: ${MODEL.padEnd(46)}║`);
  console.log('╚══════════════════════════════════════════════════════════╝');

  await testMinimal();
  await testStream();
  await testReasoningEffort();
  await testThinkingField();
  await testTools();
  await testMultiTurnToolCall();
  await testAssistantNullContent();
  await testFullVvSwitchBody();
  await testThroughProxy();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  诊断完成: ✅ ${passCount} 通过, ❌ ${failCount} 失败`);
  console.log(`${'═'.repeat(60)}`);

  if (failCount > 0) {
    console.log('\n📋 排查建议:');
    console.log('  - 若测试 1 失败: API key 或 URL 或模型名问题(模型/网络问题)');
    console.log('  - 若测试 3 失败: 火山不接受 reasoning_effort → vv-switch 代码需屏蔽');
    console.log('  - 若测试 4 失败: 火山不接受 thinking 字段 → vv-switch 代码需屏蔽');
    console.log('  - 若测试 4 adaptive 失败但 auto 通过: 已由之前的修复处理');
    console.log('  - 若测试 6/7 失败: assistant content=null 问题 → vv-switch 代码需改空串');
    console.log('  - 若测试 8 失败但 1/5/6 都通过: 组合字段问题,看具体哪个字段');
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
