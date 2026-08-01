/**
 * Claude 集成调试脚本
 *
 * 直接启动 vv-switch 代理服务，然后模拟 Claude Code 客户端发送请求，
 * 逐层验证：config-server 代理 → claude 路由 → Gateway → anthropic provider → 上游 API
 *
 * Usage:
 *   tsx test/claude-integration.test.ts
 *
 * 环境变量（可选覆盖）:
 *   VV_PORT            代理端口（默认 14321，避免和真实服务冲突）
 *   VV_PROVIDER_FILE   供应商配置文件（默认 .vv-switch-providers.json.example）
 */

import { spawn, type ChildProcess } from 'child_process';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// ── 配置 ───────────────────────────────────────────────────────────

const PORT = parseInt(process.env.VV_PORT || '14321', 10);
const PROVIDER_FILE = process.env.VV_PROVIDER_FILE
  ? resolve(process.env.VV_PROVIDER_FILE)
  : join(PROJECT_ROOT, '.vv-switch-providers.json.example');

// 测试用的供应商：从 example 文件中找 activeForClaude=true 的
let activeProviderModel = 'claude-sonnet-4-20250514'; // 默认值，会被覆盖

function findActiveProvider(): {
  baseUrl: string;
  apiKey: string;
  model: string;
  protocolType: string;
  name: string;
} | null {
  if (!existsSync(PROVIDER_FILE)) {
    console.error(`❌ 供应商配置文件不存在: ${PROVIDER_FILE}`);
    return null;
  }
  const providers = JSON.parse(readFileSync(PROVIDER_FILE, 'utf-8'));
  const active = providers.find((p: any) => p.activeForClaude === true);
  if (!active) {
    console.error(`❌ 配置文件中没有 activeForClaude=true 的供应商`);
    console.error(`   文件: ${PROVIDER_FILE}`);
    return null;
  }
  activeProviderModel = active.model;
  console.log(`✅ 使用供应商: ${active.name} | model=${active.model} | baseUrl=${active.baseUrl}`);
  return active;
}

// ── 启动代理 ────────────────────────────────────────────────────────

function startServer(): Promise<{ process: ChildProcess; stop: () => void }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('npx', ['tsx', 'bin/cli.ts', '--port', String(PORT), '--debug'], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) {
        child.kill('SIGTERM');
        reject(new Error('服务启动超时（30s）'));
      }
    }, 30000);

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) console.log(`  [server stdout] ${text}`);
      if (text.includes('配置服务已启动') || text.includes('Server running')) {
        if (!started) {
          started = true;
          clearTimeout(timeout);
          // 等待一下确保监听完成
          setTimeout(() => resolvePromise({
            process: child,
            stop: () => {
              child.kill('SIGTERM');
            },
          }), 500);
        }
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) console.error(`  [server stderr] ${text}`);
    });

    child.on('exit', (code) => {
      if (!started) {
        clearTimeout(timeout);
        reject(new Error(`服务异常退出，code=${code}`));
      }
    });
  });
}

// ── 等待活跃供应商配置到 settings.json ──────────────────────────────

async function waitForActiveProvider(maxWaitMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const resp = await fetch(`http://localhost:${PORT}/api/providers`);
      if (resp.ok) {
        const data = await resp.json() as any;
        if (data.activeForClaude) {
          console.log(`✅ 活跃供应商已就绪: ${data.activeForClaude.name} (${data.activeForClaude.model})`);
          return true;
        }
      }
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ── 应用供应商配置 ──────────────────────────────────────────────────

async function applyProvider(providerId: string): Promise<void> {
  console.log(`\n📡 应用供应商配置: ${providerId}`);
  const resp = await fetch(`http://localhost:${PORT}/api/providers/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId, targets: ['claude'], port: PORT }),
  });
  const data = await resp.json() as any;
  if (!data.success) {
    throw new Error(`应用供应商失败: ${data.error}`);
  }
  console.log(`✅ 供应商配置已应用`);
}

// ── 测试用例 ────────────────────────────────────────────────────────

let testsPassed = 0;
let testsFailed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✅ ${message}`);
    testsPassed++;
  } else {
    console.error(`  ❌ ${message}`);
    testsFailed++;
  }
}

// 30 秒超时 helper
function withTimeout(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error(`请求超时 ${ms}ms`)), ms);
  return controller.signal;
}

// 测试 1：健康检查
async function testHealth(): Promise<void> {
  console.log('\n── 测试 1：健康检查 GET /health ──');
  try {
    const resp = await fetch(`http://localhost:${PORT}/health`, { signal: withTimeout(30000) });
    assert(resp.ok, `GET /health 返回 ${resp.status}`);
  } catch (err) {
    assert(false, `GET /health 异常: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// 测试 2：供应商列表
async function testProviders(): Promise<void> {
  console.log('\n── 测试 2：供应商列表 GET /api/providers ──');
  try {
    const resp = await fetch(`http://localhost:${PORT}/api/providers`, { signal: withTimeout(30000) });
    assert(resp.ok, `GET /api/providers 返回 ${resp.status}`);
    const data = await resp.json() as any;
    assert(Array.isArray(data.providers), `providers 是数组, count=${data.providers?.length}`);
    if (data.activeForClaude) {
      console.log(`  活跃 Claude 供应商: ${data.activeForClaude.name} (${data.activeForClaude.model})`);
    } else {
      console.log(`  ⚠️  没有活跃的 Claude 供应商`);
    }
  } catch (err) {
    assert(false, `GET /api/providers 异常: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// 测试 3：非流式 Claude 请求
async function testNonStreamClaude(): Promise<void> {
  console.log('\n── 测试 3：非流式 POST /v1/messages ──');
  console.log(`  使用模型: ${activeProviderModel}`);
  const t0 = Date.now();
  try {
    const resp = await fetch(`http://localhost:${PORT}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'vv-switch',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: activeProviderModel, // 使用供应商配置的模型
        max_tokens: 100,
        stream: false,
        messages: [{ role: 'user', content: 'Say "hello" in one word.' }],
      }),
      signal: withTimeout(30000), // 30 秒超时
    });
    const duration = Date.now() - t0;
    assert(resp.ok, `POST /v1/messages (non-stream) 返回 ${resp.status} | ${duration}ms`);

    const text = await resp.text();
    console.log(`  响应预览: ${text.slice(0, 200)}`);

    try {
      const data = JSON.parse(text);
      assert(data.type === 'message', `响应 type=message`);
      assert(typeof data.content === 'object', `响应有 content 数组`);
      if (data.usage) {
        console.log(`  tokens: input=${data.usage.input_tokens}, output=${data.usage.output_tokens}`);
      }
    } catch {
      console.log(`  ⚠️  响应非 JSON: ${text.slice(0, 100)}`);
    }
  } catch (err) {
    assert(false, `POST /v1/messages (non-stream) 异常: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// 测试 4：流式 Claude 请求（关键！）
async function testStreamClaude(): Promise<void> {
  console.log('\n── 测试 4：流式 POST /v1/messages (stream=true) ──');
  console.log(`  使用模型: ${activeProviderModel}`);
  const t0 = Date.now();
  try {
    const resp = await fetch(`http://localhost:${PORT}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'vv-switch',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: activeProviderModel, // 使用供应商配置的模型
        max_tokens: 100,
        stream: true,
        messages: [{ role: 'user', content: 'Say "hi" in one word.' }],
      }),
      signal: withTimeout(30000), // 30 秒超时
    });
    assert(resp.ok, `POST /v1/messages (stream) 返回 ${resp.status}`);
    assert(
      resp.headers.get('content-type')?.includes('text/event-stream') === true,
      `Content-Type 包含 text/event-stream: ${resp.headers.get('content-type')}`,
    );

    // 读取 SSE 流
    const reader = resp.body?.getReader();
    if (!reader) {
      assert(false, '响应体为空，无法读取 SSE 流');
      return;
    }

    const decoder = new TextDecoder();
    let fullText = '';
    let eventCount = 0;
    let hasMessageStart = false;
    let hasMessageStop = false;
    let hasTokens = false;
    let firstChunkTime = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!firstChunkTime) firstChunkTime = Date.now() - t0;

      const chunk = decoder.decode(value, { stream: true });
      fullText += chunk;

      // 简单解析 SSE 事件
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventCount++;
          const eventType = line.slice(7).trim();
          if (eventType === 'message_start') hasMessageStart = true;
          if (eventType === 'message_stop') hasMessageStop = true;
          if (eventCount <= 5 || eventCount % 20 === 0) {
            console.log(`  📩 event #${eventCount}: ${eventType}`);
          }
        }
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'content_block_delta' && data.delta?.text) {
              hasTokens = true;
            }
            if (data.type === 'error') {
              console.error(`  ⚠️  上游错误事件: ${JSON.stringify(data).slice(0, 200)}`);
            }
          } catch {
            // ignore
          }
        }
      }
    }

    const duration = Date.now() - t0;
    console.log(`\n  📊 流式统计:`);
    console.log(`     总事件数: ${eventCount}`);
    console.log(`     首字节时间: ${firstChunkTime}ms`);
    console.log(`     总耗时: ${duration}ms`);
    console.log(`     响应长度: ${fullText.length} bytes`);

    assert(eventCount > 0, `收到 ${eventCount} 个 SSE 事件`);
    assert(hasMessageStart, `收到 message_start 事件`);
    assert(hasMessageStop, `收到 message_stop 事件`);
    assert(hasTokens, `收到文本内容 (content_block_delta)`);
    assert(firstChunkTime < 30000, `首字节时间 < 30s (${firstChunkTime}ms)`);

    // 显示最后几个事件用于调试
    const lastLines = fullText.split('\n').filter((l) => l.startsWith('event:') || l.startsWith('data:')).slice(-6);
    console.log(`  末尾事件:`);
    for (const l of lastLines) {
      console.log(`    ${l.slice(0, 120)}`);
    }
  } catch (err) {
    assert(false, `POST /v1/messages (stream) 异常: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// 测试 5：模拟 Claude Code 完整请求（带 system + 多轮对话）
async function testClaudeCodeStyle(): Promise<void> {
  console.log('\n── 测试 5：模拟 Claude Code 风格请求 ──');
  console.log(`  使用模型: ${activeProviderModel}`);
  const t0 = Date.now();
  try {
    const resp = await fetch(`http://localhost:${PORT}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'vv-switch',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({
        model: activeProviderModel, // 使用供应商配置的模型
        max_tokens: 200,
        stream: true,
        system: [
          { type: 'text', text: 'You are a helpful assistant. Keep responses very short.' },
        ],
        messages: [
          { role: 'user', content: 'What is 2+2? Answer in 3 words.' },
        ],
      }),
      signal: withTimeout(30000), // 30 秒超时
    });
    assert(resp.ok, `Claude Code 风格请求返回 ${resp.status}`);

    const reader = resp.body?.getReader();
    if (!reader) {
      assert(false, '响应体为空');
      return;
    }

    const decoder = new TextDecoder();
    let eventCount = 0;
    let fullText = '';

    // 设置读取超时
    const readTimeout = setTimeout(() => {
      console.error('  ⚠️  流读取超时（30s），可能卡住了');
      reader.cancel().catch(() => {});
    }, 30000);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      fullText += chunk;
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (line.startsWith('event: ')) eventCount++;
      }
    }
    clearTimeout(readTimeout);

    const duration = Date.now() - t0;
    assert(eventCount > 0, `收到 ${eventCount} 个 SSE 事件 | ${duration}ms`);
    assert(fullText.includes('message_stop'), `流正常结束 (含 message_stop)`);

    // 提取响应文本
    const textParts: string[] = [];
    for (const line of fullText.split('\n')) {
      if (line.startsWith('data: ')) {
        try {
          const d = JSON.parse(line.slice(6));
          if (d.type === 'content_block_delta' && d.delta?.text) {
            textParts.push(d.delta.text);
          }
        } catch {}
      }
    }
    if (textParts.length > 0) {
      console.log(`  📝 响应文本: "${textParts.join('')}"`);
    }
  } catch (err) {
    assert(false, `Claude Code 风格请求异常: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═'.repeat(60));
  console.log('  vv-switch Claude 集成调试');
  console.log(`  端口: ${PORT}`);
  console.log(`  供应商配置: ${PROVIDER_FILE}`);
  console.log('═'.repeat(60));

  // 检查供应商
  const activeProvider = findActiveProvider();
  if (!activeProvider) {
    console.error('\n请先在供应商配置文件中设置 activeForClaude: true');
    process.exit(1);
  }

  // 启动服务
  console.log('\n🚀 启动 vv-switch 服务...');
  let server: { process: ChildProcess; stop: () => void } | null = null;
  try {
    server = await startServer();
    console.log('✅ 服务已启动');

    // 等待活跃供应商
    const hasActive = await waitForActiveProvider();
    if (!hasActive) {
      // 需要手动应用
      console.log('⚠️  没有自动恢复活跃供应商，尝试手动应用...');
      const providers = JSON.parse(readFileSync(PROVIDER_FILE, 'utf-8'));
      const provider = providers.find((p: any) => p.activeForClaude === true);
      if (provider) {
        await applyProvider(provider.id);
      }
    }

    // 运行测试
    await testHealth();
    await testProviders();
    await testNonStreamClaude();
    await testStreamClaude();
    await testClaudeCodeStyle();

    // 汇总
    console.log('\n' + '═'.repeat(60));
    console.log(`  测试完成: ✅ ${testsPassed} 通过, ❌ ${testsFailed} 失败`);
    console.log('═'.repeat(60));
  } catch (err) {
    console.error(`\n❌ 测试运行异常: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) {
      console.error(err.stack.slice(0, 500));
    }
  } finally {
    if (server) {
      console.log('\n🛑 停止服务...');
      server.stop();
      // 等待进程退出
      await new Promise((r) => setTimeout(r, 1000));
    }
    process.exit(testsFailed > 0 ? 1 : 0);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
