/**
 * Codex → vv-switch → DeepSeek-anthropic 多轮工具调用测试
 *
 * 协议链路: Codex (Responses API /v1/responses)
 *         → vv-switch codex adapter (StandardRequest)
 *         → anthropic provider (Anthropic Messages API /v1/messages)
 *         → https://api.deepseek.com/anthropic/v1/messages
 *
 * 测试任务:
 * 1. 获取系统时间
 * 2. 统计 README.md 行数
 * 3. 写 aa.md 并复制 aa_copy.md
 */

import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VV_SWITCH_DIR = path.resolve(__dirname, '..');

const VV_SWITCH_URL = 'http://localhost:8899/v1/responses';
const README_PATH = path.resolve(VV_SWITCH_DIR, 'README.md');
const TEST_DIR = VV_SWITCH_DIR;

// ============ 工具执行器 ============

const toolHandlers = {
  Bash: async (args) => {
    const { command } = args;
    if (!command) return { output: 'Error: command is required' };
    console.log(`  [EXEC] Bash: ${command.slice(0, 100)}`);
    try {
      const { execSync } = await import('child_process');
      const output = execSync(command, { encoding: 'utf-8', timeout: 10000 }).trim();
      return { output };
    } catch (e) {
      return { error: e.message, output: e.stdout || '' };
    }
  },

  Read: async (args) => {
    const { file_path } = args;
    console.log(`  [EXEC] Read: ${file_path}`);
    try {
      const { readFileSync } = await import('fs');
      return { output: readFileSync(file_path, 'utf-8') };
    } catch (e) {
      return { error: e.message };
    }
  },

  Write: async (args) => {
    const { file_path, content } = args;
    console.log(`  [EXEC] Write: ${file_path}`);
    try {
      const { writeFileSync } = await import('fs');
      writeFileSync(file_path, content, 'utf-8');
      return { output: `Written: ${file_path}` };
    } catch (e) {
      return { error: e.message };
    }
  },

  Edit: async (args) => {
    const { file_path, old_string, new_string } = args;
    try {
      const { readFileSync, writeFileSync } = await import('fs');
      let content = readFileSync(file_path, 'utf-8');
      if (!content.includes(old_string)) return { error: 'old_string not found' };
      writeFileSync(file_path, content.replace(old_string, new_string), 'utf-8');
      return { output: `Edited: ${file_path}` };
    } catch (e) {
      return { error: e.message };
    }
  },
};

// ============ 工具定义（Codex CLI 兼容） ============

const TOOL_DEFS = [
  {
    type: 'function',
    name: 'Bash',
    description: 'Execute a shell command.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Command to execute' } },
      required: ['command'],
    },
  },
  {
    type: 'function',
    name: 'Read',
    description: 'Read the contents of a file.',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string', description: 'Absolute path to the file' } },
      required: ['file_path'],
    },
  },
  {
    type: 'function',
    name: 'Write',
    description: 'Write content to a file.',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string' }, content: { type: 'string' } },
      required: ['file_path', 'content'],
    },
  },
  {
    type: 'function',
    name: 'Edit',
    description: 'Edit a file by finding and replacing text.',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
];

// ============ 流式响应解析 ============

async function parseStreamResponse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  const toolCalls = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      if (!part.trim()) continue;
      const dm = part.match(/data:\s*(.+)/);
      if (!dm) continue;
      const s = dm[1].trim();
      if (s === '[DONE]') break;

      try {
        const data = JSON.parse(s);
        switch (data.type) {
          case 'response.output_text.delta':
            fullText += data.delta;
            break;
          case 'response.output_item.added':
            if (data.item?.type === 'function_call') {
              toolCalls.push({
                id: data.item.id || data.item.call_id || '',
                name: data.item.name || '',
                arguments: '',
              });
            }
            break;
          case 'response.function_call_arguments.delta': {
            const tc = toolCalls.find(t => t.id === data.item_id);
            if (tc) tc.arguments += data.delta;
            break;
          }
          case 'response.function_call_arguments.done': {
            const tc = toolCalls.find(t => t.id === data.item_id);
            if (tc) tc.arguments = data.arguments;
            break;
          }
          case 'response.completed':
            return { fullText, toolCalls, usage: data.response?.usage };
          case 'response.failed':
            throw new Error(data.response?.error?.message || 'unknown error');
        }
      } catch (e) {
        if (e.message?.startsWith?.('Request failed') || e.message?.startsWith?.('Unknown')) throw e;
      }
    }
  }
  return { fullText, toolCalls };
}

// ============ API 调用 ============

async function callModel(messages, iteration) {
  const body = { input: messages, tools: TOOL_DEFS, stream: true };
  console.log(`\n--- [Iter #${iteration}] POST /v1/responses msgs=${messages.length} tools=${TOOL_DEFS.length} ---`);

  const t0 = Date.now();
  const res = await fetch(VV_SWITCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const elapsed = Date.now() - t0;

  if (res.status !== 200) {
    const err = await res.text();
    throw new Error(`HTTP ${res.status}: ${err.slice(0, 300)}`);
  }

  const result = await parseStreamResponse(res);
  console.log(`  Time: ${elapsed}ms | toolCalls=${result.toolCalls.length} | textLen=${result.fullText.length}`);

  for (const tc of result.toolCalls) {
    let args;
    try { args = JSON.parse(tc.arguments); } catch { args = tc.arguments; }
    console.log(`  => ${tc.name}(${JSON.stringify(args).slice(0, 150)})`);
  }
  if (result.usage) {
    console.log(`  Usage: in=${result.usage.input_tokens} out=${result.usage.output_tokens}`);
  }

  return result;
}

// ============ 主流程 ============

async function main() {
  console.log(`╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  Codex → vv-switch → DeepSeek-anthropic 工具调用测试    ║`);
  console.log(`║  协议链路: Responses API → Anthropic Messages API       ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝`);
  console.log(`时间: ${new Date().toISOString()}\n`);

  // 清理
  try {
    const { unlinkSync } = await import('fs');
    try { unlinkSync(`${TEST_DIR}/aa.md`); } catch {}
    try { unlinkSync(`${TEST_DIR}/aa_copy.md`); } catch {}
  } catch {}

  const taskPrompt = `
请按顺序完成以下任务，每次只调用一个工具：

1. 获取系统时间（用 Bash 执行 date）
2. 统计 '${README_PATH}' 文件行数
3. 创建 aa.md 写入 "hello world"，再复制为 aa_copy.md

完成后用文字汇总结果。
`;

  let messages = [
    { role: 'user', content: [{ type: 'input_text', text: taskPrompt }] },
  ];

  let round = 0;
  const MAX_ROUNDS = 12;

  while (round < MAX_ROUNDS) {
    round++;
    const result = await callModel(messages, round);

    if (result.toolCalls.length === 0) {
      if (result.fullText) {
        console.log(`\n  → 模型回复: "${result.fullText.slice(0, 200)}"`);
        if (round >= 2 && /完成|done|completed|finished|全部/i.test(result.fullText)) {
          console.log('\n✓ 模型确认全部完成！');
          break;
        }
        messages.push({
          role: 'user',
          content: [{ type: 'input_text', text: '继续完成未完成的任务。如果已完成请说"完成"。' }],
        });
        continue;
      }
      console.log('\n⚠ 无 tool call 也无文字，结束');
      break;
    }

    // 执行每个 tool call 并追加到消息
    for (const tc of result.toolCalls) {
      console.log(`\n  → 执行 ${tc.name}...`);
      const toolResult = await executeTool(tc);

      messages.push({
        type: 'function_call',
        call_id: tc.id,
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      });
      messages.push({
        type: 'function_call_output',
        call_id: tc.id,
        output: toolResult.output || toolResult.error || '',
      });
    }

    if (result.fullText) {
      console.log(`  → 模型文字: "${result.fullText.slice(0, 150)}"`);
    }
  }

  // 验证
  const { existsSync, readFileSync } = await import('fs');
  const aaOk = existsSync(`${TEST_DIR}/aa.md`);
  const copyOk = existsSync(`${TEST_DIR}/aa_copy.md`);
  const contentOk = aaOk ? readFileSync(`${TEST_DIR}/aa.md`, 'utf-8').trim() === 'hello world' : false;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`迭代次数: ${round}`);
  console.log(`验证:`);
  console.log(`  aa.md 存在:     ${aaOk ? '✓' : '✗'}`);
  console.log(`  aa_copy.md 存在: ${copyOk ? '✓' : '✗'}`);
  console.log(`  内容正确:       ${contentOk ? '✓' : '✗'}`);
  console.log(`\n${aaOk && copyOk && contentOk ? '全部任务通过！' : '部分任务失败'}`);

  // 清理
  try {
    const { unlinkSync } = await import('fs');
    try { unlinkSync(`${TEST_DIR}/aa.md`); } catch {}
    try { unlinkSync(`${TEST_DIR}/aa_copy.md`); } catch {}
  } catch {}
}

async function executeTool(tc) {
  const handler = toolHandlers[tc.name];
  if (!handler) return { output: `Error: No handler for "${tc.name}"` };
  let args;
  try { args = JSON.parse(tc.arguments); } catch { return { output: `Error: Invalid JSON: ${tc.arguments}` }; }
  try { return await handler(args); } catch (e) { return { output: `Error: ${e.message}` }; }
}

main().catch(e => { console.error('\n✗ 测试失败:', e.message); process.exit(1); });
