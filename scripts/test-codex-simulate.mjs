/**
 * Codex 多轮工具调用模拟测试
 *
 * 模拟 Codex CLI 通过 vv-switch 调用 deepseek-v4-flash 完成 test.md 任务：
 * 1. 获取系统当前时间
 * 2. 统计 README.md 行数
 * 3. 新建 aa.md 写入 hello world 并复制 aa_copy.md
 *
 * 流程：发送请求 → 接收 tool calls → 本地执行 → 返回结果 → ... → 完成
 */

import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VV_SWITCH_DIR = path.resolve(__dirname, '..');

const VV_SWITCH_URL = 'http://localhost:8899/v1/responses';
const TEST_MD_PATH = path.resolve(VV_SWITCH_DIR, 'test.md');
const README_MD_PATH = path.resolve(VV_SWITCH_DIR, 'README.md');

// ============ 工具执行器 ============

const toolHandlers = {
  Bash: async (args) => {
    const { command } = args;
    if (!command) return { error: 'command is required' };
    console.log(`  [EXEC] Bash: ${command}`);
    try {
      const { execSync } = await import('child_process');
      const output = execSync(command, { encoding: 'utf-8', timeout: 10000 }).trim();
      console.log(`  [RESULT] (${output.length} chars)`);
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
      const content = readFileSync(file_path, 'utf-8');
      console.log(`  [RESULT] (${content.length} chars)`);
      return { output: content };
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
      console.log(`  [RESULT] written ${content.length} chars`);
      return { output: `File written successfully: ${file_path}` };
    } catch (e) {
      return { error: e.message };
    }
  },

  Edit: async (args) => {
    const { file_path, old_string, new_string } = args;
    console.log(`  [EXEC] Edit: ${file_path}`);
    try {
      const { readFileSync, writeFileSync } = await import('fs');
      let content = readFileSync(file_path, 'utf-8');
      if (!content.includes(old_string)) {
        return { error: `old_string not found in ${file_path}` };
      }
      content = content.replace(old_string, new_string);
      writeFileSync(file_path, content, 'utf-8');
      console.log(`  [RESULT] edit applied`);
      return { output: `File edited successfully: ${file_path}` };
    } catch (e) {
      return { error: e.message };
    }
  },
};

// ============ 工具定义（与 Codex CLI 一致） ============

const TOOL_DEFS = [
  {
    type: 'function',
    name: 'Bash',
    description: 'Execute a shell command. Use this for running commands, scripts, or any shell operations.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The shell command to execute' } },
      required: ['command'],
    },
  },
  {
    type: 'function',
    name: 'Read',
    description: 'Read the contents of a file at the given path.',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string', description: 'Absolute path to the file' } },
      required: ['file_path'],
    },
  },
  {
    type: 'function',
    name: 'Write',
    description: 'Write content to a file at the given path.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to write to' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    type: 'function',
    name: 'Edit',
    description: 'Edit a file by finding and replacing text.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file' },
        old_string: { type: 'string', description: 'Text to find and replace' },
        new_string: { type: 'string', description: 'Text to replace with' },
      },
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
  const toolCalls = []; // { id, name, arguments, outputIndex }

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
                outputIndex: data.output_index,
              });
            }
            break;
          case 'response.function_call_arguments.delta':
            const existing = toolCalls.find(t => t.id === data.item_id);
            if (existing) existing.arguments += data.delta;
            break;
          case 'response.function_call_arguments.done':
            const doneCall = toolCalls.find(t => t.id === data.item_id);
            if (doneCall) doneCall.arguments = data.arguments;
            break;
          case 'response.completed':
            // Use the final output if available
            if (data.response?.output) {
              // Update tool calls from completed output
              for (const item of data.response.output) {
                if (item.type === 'function_call') {
                  const match = toolCalls.find(t => t.id === item.id || t.id === item.call_id);
                  if (match) match.arguments = item.arguments;
                }
              }
            }
            return { fullText, toolCalls, usage: data.response?.usage };
          case 'response.failed':
            throw new Error(`Request failed: ${data.response?.error?.message || 'unknown error'}`);
        }
      } catch (e) {
        if (e.message?.startsWith('Request failed:')) throw e;
        // skip parse errors
      }
    }
  }
  return { fullText, toolCalls };
}

async function parseJsonResponse(response) {
  const body = await response.json();
  if (response.status !== 200) {
    throw new Error(`Request failed (${response.status}): ${body.error?.message || JSON.stringify(body)}`);
  }

  const fullText = body.output?.filter(o => o.type === 'message')
    .map(m => m.content?.map?.(c => c.text).join('') || '').join('') || '';

  const toolCalls = body.output?.filter(o => o.type === 'function_call').map(fc => ({
    id: fc.id || fc.call_id,
    name: fc.name,
    arguments: fc.arguments,
    outputIndex: body.output.indexOf(fc),
  })) || [];

  return { fullText, toolCalls, usage: body.usage };
}

// ============ API 调用 ============

async function callModel(messages, stream = true) {
  // 构建 Responses API 请求体
  const body = {
    input: messages,
    tools: TOOL_DEFS,
    stream,
  };

  console.log(`\n--- Sending request (stream=${stream}, messages=${messages.length}, tools=${TOOL_DEFS.length}) ---`);

  const startTime = Date.now();
  const response = await fetch(VV_SWITCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const elapsed = Date.now() - startTime;
  console.log(`Response: status=${response.status} time=${elapsed}ms`);

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`HTTP ${response.status}: ${err.slice(0, 300)}`);
  }

  const result = stream ? await parseStreamResponse(response) : await parseJsonResponse(response);

  // 记录 tool calls
  if (result.toolCalls.length > 0) {
    console.log(`Model returned ${result.toolCalls.length} tool call(s):`);
    for (const tc of result.toolCalls) {
      let parsedArgs;
      try { parsedArgs = JSON.parse(tc.arguments); } catch { parsedArgs = tc.arguments; }
      console.log(`  - ${tc.name}(${JSON.stringify(parsedArgs).slice(0, 200)})`);
    }
  }
  if (result.fullText) {
    console.log(`Model text: "${result.fullText.slice(0, 200)}"`);
  }
  if (result.usage) {
    console.log(`Usage: ${JSON.stringify(result.usage)}`);
  }

  return result;
}

// ============ 构建消息 ============

function buildToolResultMessage(toolCall, toolOutput) {
  return {
    type: 'function_call_output',
    call_id: toolCall.id,
    output: typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput),
  };
}

function buildToolCallItems(toolCalls) {
  return toolCalls.map(tc => ({
    type: 'function_call',
    call_id: tc.id,
    id: tc.id,
    name: tc.name,
    arguments: tc.arguments,
    status: 'completed',
  }));
}

// ============ 执行工具 ============

async function executeTool(tc) {
  const handler = toolHandlers[tc.name];
  if (!handler) {
    return { output: `Error: No tool handler for "${tc.name}"` };
  }

  let args;
  try {
    args = JSON.parse(tc.arguments);
  } catch {
    return { output: `Error: Invalid JSON arguments: ${tc.arguments}` };
  }

  try {
    return await handler(args);
  } catch (e) {
    return { output: `Error: ${e.message}` };
  }
}

// ============ 主流程 ============

async function simulateCodex(maxIterations = 10) {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║      Codex 多轮工具调用模拟测试                          ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`测试时间: ${new Date().toISOString()}`);
  console.log(`vv-switch: ${VV_SWITCH_URL}\n`);

  const taskDescription = `
请完成以下任务列表，按顺序执行：

1. 获取系统当前时间（使用 Bash 工具执行 date 命令）
2. 统计 '${README_MD_PATH}' 这个文件有多少行内容
3. 新建文件 aa.md 写入 "hello world"，然后复制一份 aa_copy.md

注意：
- 每次只调用一个工具，完成后继续下一个任务
- 全部完成后，用文字告诉我所有任务已完成
`;

  // 清理上一次测试残留
  try {
    const { unlinkSync } = await import('fs');
    try { unlinkSync(path.resolve(VV_SWITCH_DIR, 'aa.md')); } catch {}
    try { unlinkSync(path.resolve(VV_SWITCH_DIR, 'aa_copy.md')); } catch {}
  } catch {}

  let messages = [
    { role: 'user', content: [{ type: 'input_text', text: taskDescription }] },
  ];

  let iteration = 0;
  let completedTasks = [];

  while (iteration < maxIterations) {
    iteration++;
    console.log(`\n━━━━━━━━━━━━━━━━━ 迭代 #${iteration} ━━━━━━━━━━━━━━━━━`);

    const result = await callModel(messages, true);

    for (const tc of result.toolCalls) {
      console.log(`\n  → 执行工具: ${tc.name}...`);
      const toolResult = await executeTool(tc);
      console.log(`  → 结果: ${JSON.stringify(toolResult).slice(0, 300)}`);

      // 添加这次 tool call 和结果到消息中
      messages.push({
        type: 'function_call',
        call_id: tc.id,
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      });
      messages.push(buildToolResultMessage(tc, toolResult.output || toolResult.error));
    }

    // 记录文本输出（如果有）
    if (result.fullText) {
      console.log(`\n  → 模型回复: "${result.fullText.slice(0, 300)}"`);
    }

    // 检查是否完成
    if (result.toolCalls.length === 0) {
      if (result.fullText) {
        // 模型用文字回复了，说明任务可能已完成
        console.log('\n✓ 模型给出了文字回复，尝试结束。');
        // 再送一轮确认是否还有更多操作
        if (iteration >= 3 && result.fullText.toLowerCase().includes('完成')) {
          console.log('\n✓ 模型确认所有任务已完成！');
          break;
        }
        // 追加消息让模型继续
        messages.push({
          role: 'user',
          content: [{ type: 'input_text', text: '请继续完成剩余的任务。如果你已经全部完成了，请明确告诉我。' }],
        });
      } else {
        // 没有 tool call 也没有文字，异常情况
        console.log('\n⚠ 模型没有返回 tool call 也没有文字，尝试结束。');
        break;
      }
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`总共迭代: ${iteration}`);
  console.log(`消息历史长度: ${messages.length}`);

  // 检查测试结果
  const { existsSync } = await import('fs');
  const aaExists = existsSync(path.resolve(VV_SWITCH_DIR, 'aa.md'));
  const copyExists = existsSync(path.resolve(VV_SWITCH_DIR, 'aa_copy.md'));
  console.log(`\n验证结果:`);
  console.log(`  aa.md 存在: ${aaExists ? '✓' : '✗'}`);
  console.log(`  aa_copy.md 存在: ${copyExists ? '✓' : '✗'}`);
  if (aaExists) {
    const { readFileSync } = await import('fs');
    const content = readFileSync(path.resolve(VV_SWITCH_DIR, 'aa.md'), 'utf-8');
    console.log(`  aa.md 内容: ${content.trim()}`);
    console.log(`  aa.md 内容正确: ${content.trim() === 'hello world' ? '✓' : '✗'}`);
  }

  return { iteration, messages, aaExists, copyExists };
}

// ============ 运行 ============

simulateCodex().catch(e => {
  console.error('\n✗ 测试失败:', e.message);
  process.exit(1);
});
