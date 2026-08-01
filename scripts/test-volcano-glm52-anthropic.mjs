#!/usr/bin/env node

/**
 * 火山引擎 GLM-5.2 anthropic 端点接入诊断测试
 *
 * 这是 test-volcano-glm52-chat.mjs 的对称版,测的是 Claude Code 实际走的端点。
 *
 * 关键区别:
 *   - chat 脚本测  /api/coding/v3/chat/completions  (OpenAI 格式, 配置 "火山-GLM-5.2-chat")
 *   - 本脚本测    /api/coding/v1/messages           (Anthropic 格式, 配置 "火山-GLM5.2-claude", activeForClaude:true)
 *
 * 用法:
 *   node test-volcano-glm52-anthropic.mjs
 *   ARK_API_KEY=xxx node test-volcano-glm52-anthropic.mjs
 *   VV_SWITCH_URL=http://localhost:8899/v1/messages node test-volcano-glm52-anthropic.mjs  # 同时测代理
 */

// ── 配置 ────────────────────────────────────────────────────────────
// vv-switch 对 baseUrl "https://ark.cn-beijing.volces.com/api/coding" 会拼出 /v1/messages
const ARK_URL = process.env.ARK_URL || 'https://ark.cn-beijing.volces.com/api/coding/v1/messages';
const ARK_API_KEY = process.env.ARK_API_KEY || '';
const MODEL = process.env.MODEL || 'GLM-5.2';
const VV_SWITCH_URL = process.env.VV_SWITCH_URL || '';

let passCount = 0;
let failCount = 0;

// ── 工具函数 ─────────────────────────────────────────────────────────
async function callArk(label, body, url = ARK_URL) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': ARK_API_KEY,
      },
      body: JSON.stringify(body),
    });
    const elapsed = Date.now() - t0;
    const text = await res.text();

    if (res.ok) {
      let preview = '';
      try {
        const data = JSON.parse(text);
        const blocks = data.content || [];
        preview = blocks.map((b) => b.type === 'text' ? b.text : `[${b.type}]`).join('').slice(0, 120);
      } catch {
        preview = text.slice(0, 120);
      }
      console.log(`  ✅ [${elapsed}ms] ${label} | ${preview}`);
      passCount++;
      return { ok: true, status: res.status, body: text };
    } else {
      console.log(`  ❌ [${elapsed}ms] ${label} | HTTP ${res.status}: ${text.slice(0, 250)}`);
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

// ── 测试用例(Anthropic Messages 格式)──────────────────────────────

async function testMinimal() {
  section('测试 1: 最小 anthropic 请求(model + messages + max_tokens)— 基线');
  await callArk('minimal', {
    model: MODEL,
    max_tokens: 100,
    messages: [{ role: 'user', content: '说"你好",只回两个字' }],
  });
}

async function testStream() {
  section('测试 2: 流式 stream=true');
  const t0 = Date.now();
  try {
    const res = await fetch(ARK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': ARK_API_KEY,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 100,
        stream: true,
        messages: [{ role: 'user', content: '说"你好"' }],
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.log(`  ❌ HTTP ${res.status}: ${text.slice(0, 250)}`);
      failCount++;
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let chunkCount = 0;
    let fullText = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fullText += decoder.decode(value, { stream: true });
      chunkCount++;
    }
    console.log(`  ✅ [${Date.now() - t0}ms] stream | ${chunkCount} chunks | 末尾: ${fullText.slice(-120).replace(/\n/g, ' ')}`);
    passCount++;
  } catch (e) {
    console.log(`  💥 stream | ${e.message}`);
    failCount++;
  }
}

async function testSystem() {
  section('测试 3: system 字段(Claude Code 必发长 system)');
  await callArk('system as string', {
    model: MODEL,
    max_tokens: 100,
    system: '你是一个简洁的助手,只回答核心内容。',
    messages: [{ role: 'user', content: '1+1=?' }],
  });
  await callArk('system as array', {
    model: MODEL,
    max_tokens: 100,
    system: [{ type: 'text', text: '你是一个简洁的助手。' }],
    messages: [{ role: 'user', content: '1+1=?' }],
  });
}

async function testCacheControl() {
  section('测试 4: cache_control 字段(Claude Code 必发,anthropic provider 原样透传)');
  await callArk('system + cache_control', {
    model: MODEL,
    max_tokens: 100,
    system: [{ type: 'text', text: '你是一个简洁的助手。', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: '1+1=?' }],
  });
  await callArk('tools + cache_control', {
    model: MODEL,
    max_tokens: 100,
    messages: [{ role: 'user', content: '1+1=?' }],
    tools: [{
      name: 'bash',
      description: 'Execute a shell command',
      input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      cache_control: { type: 'ephemeral' },
    }],
  });
}

async function testThinking() {
  section('测试 5: thinking 字段(Claude Code 4.6+ 默认发 adaptive)');
  // 注意: vv-switch 的 buildThinking 对 GLM-5.2 判定 isAdaptiveCapableModel=false,
  //       所以 adaptive 会被丢弃不发送。这里直连测火山端点本身是否接受。
  await callArk('thinking.type=adaptive', {
    model: MODEL,
    max_tokens: 100,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: '1+1=?' }],
  });
  await callArk('thinking.type=enabled', {
    model: MODEL,
    max_tokens: 100,
    thinking: { type: 'enabled', budget_tokens: 1024 },
    messages: [{ role: 'user', content: '1+1=?' }],
  });
}

async function testTools() {
  section('测试 6: 工具调用(单轮)');
  await callArk('tools+bash', {
    model: MODEL,
    max_tokens: 500,
    messages: [{ role: 'user', content: '获取系统时间,用 bash 执行 date' }],
    tools: [{
      name: 'bash',
      description: 'Execute a shell command',
      input_schema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    }],
  });
}

async function testMultiTurnToolCall() {
  section('测试 7: 多轮工具调用(含 assistant tool_use + tool_result)');
  await callArk('multi-turn tool call', {
    model: MODEL,
    max_tokens: 500,
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
  });
}

async function testUrlVariants() {
  section('测试 8: URL 路径探测(确认火山 anthropic 端点正确路径)');
  // vv-switch 默认拼出 /v1/messages,但火山可能用别的路径
  const variants = [
    'https://ark.cn-beijing.volces.com/api/coding/v1/messages',
    'https://ark.cn-beijing.volces.com/api/coding/messages',
    'https://ark.cn-beijing.volces.com/api/coding/v3/messages',
    'https://ark.cn-beijing.volces.com/api/coding/v3/v1/messages',
  ];
  for (const u of variants) {
    await callArk(`URL: ${u.replace('https://ark.cn-beijing.volces.com', '')}`, {
      model: MODEL,
      max_tokens: 50,
      messages: [{ role: 'user', content: 'hi' }],
    }, u);
  }
}

async function testThroughProxy() {
  if (!VV_SWITCH_URL) {
    console.log('\n  (跳过代理测试: 未设置 VV_SWITCH_URL)');
    return;
  }
  section('测试 9: 经 vv-switch 代理(Claude → 火山 anthropic)');
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
      console.log(`  ✅ [${Date.now() - t0}ms] proxy | ${text.slice(0, 250).replace(/\n/g, ' ')}`);
      passCount++;
    } else {
      console.log(`  ❌ [${Date.now() - t0}ms] proxy | HTTP ${res.status}: ${text.slice(0, 400)}`);
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
  console.log('║  火山引擎 GLM-5.2 anthropic 端点诊断                     ║');
  console.log(`║  URL: ${ARK_URL.padEnd(50)}║`);
  console.log(`║  Model: ${MODEL.padEnd(50)}║`);
  console.log('╚══════════════════════════════════════════════════════════╝');

  await testMinimal();
  await testStream();
  await testSystem();
  await testCacheControl();
  await testThinking();
  await testTools();
  await testMultiTurnToolCall();
  await testUrlVariants();
  await testThroughProxy();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  诊断完成: ✅ ${passCount} 通过, ❌ ${failCount} 失败`);
  console.log(`${'═'.repeat(60)}`);

  if (failCount > 0) {
    console.log('\n📋 排查建议:');
    console.log('  - 若测试 1 失败: URL 路径错(看测试 8)或 anthropic 端点本身不可用');
    console.log('  - 若测试 4 失败: 火山不接受 cache_control → vv-switch 需在 anthropic provider 剥离');
    console.log('  - 若测试 5 失败: 火山不接受 thinking 字段(vv-switch 对 GLM-5.2 已剥离,但直连会暴露)');
    console.log('  - 若测试 8 某路径通过: vv-switch 的 buildMessagesUrl 需改用该路径');
    console.log('  - 若测试 9 失败但 1-7 通过: vv-switch 代码 bug,看日志 UPSTREAM_ERROR 行');
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
