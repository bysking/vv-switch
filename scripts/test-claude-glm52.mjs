#!/usr/bin/env node

/**
 * Claude → vv-switch → 火山引擎 GLM-5.2-chat 工具调用测试
 *
 * 协议链路: Claude (Messages API /v1/messages)
 *         → vv-switch claude adapter
 *         → chat provider (OpenAI Chat API)
 *         → 火山引擎 GLM-5.2-chat
 *
 * 测试任务:
 * 1. 获取系统时间
 * 2. 统计 README.md 行数
 * 3. 写 aa.md 并复制 aa_copy.md
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const VV_SWITCH_URL = process.env.VV_SWITCH_URL || 'http://localhost:8899/v1/messages';
const VV_SWITCH_KEY = process.env.VV_SWITCH_KEY || 'test-key';
const MODEL = process.env.MODEL || 'glm-5-2-chat';
const TEST_DIR = process.env.TEST_DIR || './vv-switch';
const README_PATH = `${TEST_DIR}/README.md`;

// ============ 工具定义（Claude 格式） ============

const TOOLS = [
  {
    name: 'bash',
    description: 'Execute a shell command and return its output.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute'
        }
      },
      required: ['command']
    }
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The absolute path to the file to read'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Write content to a file.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The absolute path to the file to write'
        },
        content: {
          type: 'string',
          description: 'The content to write to the file'
        }
      },
      required: ['path', 'content']
    }
  }
];

// ============ 工具执行器 ============

const toolHandlers = {
  bash: async (args) => {
    const { command } = args;
    console.log(`  [EXEC] bash: ${command.slice(0, 100)}`);
    try {
      const output = execSync(command, { encoding: 'utf-8', timeout: 10000, cwd: TEST_DIR });
      return { success: true, output: output.trim() };
    } catch (e) {
      return { success: false, error: e.message, output: e.stdout || '' };
    }
  },

  read_file: async (args) => {
    const { path } = args;
    console.log(`  [EXEC] read_file: ${path}`);
    try {
      const content = readFileSync(path, 'utf-8');
      return { success: true, content };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  write_file: async (args) => {
    const { path, content } = args;
    console.log(`  [EXEC] write_file: ${path}`);
    try {
      writeFileSync(path, content, 'utf-8');
      return { success: true, message: `File written: ${path}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};

// ============ 流式响应解析 ============

async function parseStreamResponse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  const toolCalls = [];
  let currentToolCall = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const dataStr = line.slice(6).trim();
      if (dataStr === '[DONE]') break;

      try {
        const data = JSON.parse(dataStr);

        // Claude 流式响应格式
        switch (data.type) {
          case 'content_block_start':
            if (data.content_block?.type === 'tool_use') {
              currentToolCall = {
                id: data.content_block.id,
                name: data.content_block.name,
                input: {}
              };
              toolCalls.push(currentToolCall);
            }
            break;

          case 'content_block_delta':
            if (data.delta?.type === 'text_delta') {
              fullText += data.delta.text;
            } else if (data.delta?.type === 'input_json_delta' && currentToolCall) {
              // 累积 JSON 输入
              if (!currentToolCall._inputStr) currentToolCall._inputStr = '';
              currentToolCall._inputStr += data.delta.partial_json;
            }
            break;

          case 'content_block_stop':
            if (currentToolCall && currentToolCall._inputStr) {
              try {
                currentToolCall.input = JSON.parse(currentToolCall._inputStr);
              } catch (e) {
                console.error('  [WARN] Failed to parse tool input:', currentToolCall._inputStr);
              }
              delete currentToolCall._inputStr;
              currentToolCall = null;
            }
            break;

          case 'message_delta':
            // 消息级别的更新（如 stop_reason）
            break;

          case 'message_stop':
            // 消息完成
            break;
        }
      } catch (e) {
        console.error('  [WARN] Parse error:', e.message);
      }
    }
  }

  return {
    text: fullText,
    toolCalls: toolCalls.map(tc => ({
      id: tc.id,
      name: tc.name,
      input: tc.input
    }))
  };
}

// ============ API 调用 ============

async function callClaude(messages, iteration) {
  const body = {
    model: MODEL,
    messages,
    tools: TOOLS,
    max_tokens: 4096,
    stream: true
  };

  console.log(`\n--- [Iter #${iteration}] POST /v1/messages msgs=${messages.length} tools=${TOOLS.length} ---`);

  const t0 = Date.now();
  const res = await fetch(VV_SWITCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': VV_SWITCH_KEY
    },
    body: JSON.stringify(body)
  });

  const elapsed = Date.now() - t0;

  if (res.status !== 200) {
    const err = await res.text();
    throw new Error(`HTTP ${res.status}: ${err.slice(0, 300)}`);
  }

  const result = await parseStreamResponse(res);
  console.log(`  Time: ${elapsed}ms | toolCalls=${result.toolCalls.length} | textLen=${result.text.length}`);

  for (const tc of result.toolCalls) {
    console.log(`  => ${tc.name}(${JSON.stringify(tc.input).slice(0, 150)})`);
  }

  return result;
}

// ============ 主流程 ============

async function main() {
  console.log(`╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  Claude → vv-switch → 火山引擎 GLM-5.2-chat 工具调用测试  ║`);
  console.log(`║  协议链路: Messages API → OpenAI Chat API              ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝`);
  console.log(`时间: ${new Date().toISOString()}`);
  console.log(`Model: ${MODEL}`);
  console.log(`URL: ${VV_SWITCH_URL}\n`);

  // 清理测试文件
  try {
    unlinkSync(`${TEST_DIR}/aa.md`);
    unlinkSync(`${TEST_DIR}/aa_copy.md`);
  } catch {}

  const taskPrompt = `
请按顺序完成以下任务，每次只调用一个工具：

1. 获取系统时间（用 bash 执行 date 命令）
2. 统计 '${README_PATH}' 文件行数（用 bash 执行 wc -l 命令）
3. 创建文件 aa.md，内容写入 "hello world"
4. 复制 aa.md 为 aa_copy.md（用 bash 执行 cp 命令）

完成后用文字汇总所有结果。
`;

  let messages = [
    { role: 'user', content: taskPrompt }
  ];

  let round = 0;
  const MAX_ROUNDS = 15;

  while (round < MAX_ROUNDS) {
    round++;
    const result = await callClaude(messages, round);

    // 如果没有工具调用，检查是否完成
    if (result.toolCalls.length === 0) {
      if (result.text) {
        console.log(`\n  → 模型回复: "${result.text.slice(0, 200)}"`);
        if (round >= 2 && /完成|done|completed|finished|全部/i.test(result.text)) {
          console.log('\n✓ 模型确认全部完成！');
          break;
        }
        messages.push({
          role: 'user',
          content: '继续完成未完成的任务。如果已完成请说"完成"。'
        });
        continue;
      }
      console.log('\n⚠ 无 tool call 也无文字，结束');
      break;
    }

    // 添加工具调用到消息历史
    for (const tc of result.toolCalls) {
      console.log(`\n  → 执行 ${tc.name}...`);
      const handler = toolHandlers[tc.name];
      let toolResult;

      if (handler) {
        toolResult = await handler(tc.input);
      } else {
        toolResult = { success: false, error: `Unknown tool: ${tc.name}` };
      }

      // Claude 格式：工具调用和结果
      messages.push({
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.input
          }
        ]
      });

      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: tc.id,
            content: JSON.stringify(toolResult)
          }
        ]
      });
    }

    if (result.text) {
      console.log(`  → 模型文字: "${result.text.slice(0, 150)}"`);
    }
  }

  // 验证结果
  const aaExists = existsSync(`${TEST_DIR}/aa.md`);
  const copyExists = existsSync(`${TEST_DIR}/aa_copy.md`);
  let aaContent = '';
  let copyContent = '';

  try {
    if (aaExists) aaContent = readFileSync(`${TEST_DIR}/aa.md`, 'utf-8');
    if (copyExists) copyContent = readFileSync(`${TEST_DIR}/aa_copy.md`, 'utf-8');
  } catch {}

  const aaCorrect = aaContent === 'hello world';
  const copyCorrect = copyContent === 'hello world';

  console.log(`\n${'='.repeat(60)}`);
  console.log(`迭代次数: ${round}`);
  console.log(`验证:`);
  console.log(`  aa.md 存在:        ${aaExists ? '✓' : '✗'}`);
  console.log(`  aa.md 内容正确:    ${aaCorrect ? '✓' : '✗'}`);
  console.log(`  aa_copy.md 存在:   ${copyExists ? '✓' : '✗'}`);
  console.log(`  aa_copy.md 正确:   ${copyCorrect ? '✓' : '✗'}`);

  const allPassed = aaExists && aaCorrect && copyExists && copyCorrect;
  console.log(`\n${allPassed ? '✓ 全部任务通过！' : '✗ 部分任务失败'}`);

  // 清理测试文件
  try {
    unlinkSync(`${TEST_DIR}/aa.md`);
    unlinkSync(`${TEST_DIR}/aa_copy.md`);
  } catch {}

  if (!allPassed) {
    process.exit(1);
  }
}

main().catch(e => {
  console.error('\n✗ 测试失败:', e.message);
  console.error(e.stack);
  process.exit(1);
});
