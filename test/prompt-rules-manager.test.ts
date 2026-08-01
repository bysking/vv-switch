import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPromptRulesToResponsesBody,
  applyPromptRulesToAnthropicBody,
  applyPromptRulesToChatBody,
  previewPromptRule,
  validatePromptRule,
  extractSections,
  inspectPromptRuleMatch,
  diffPromptRule,
} from '../src/prompt-rules-manager.js';

describe('prompt-rules-manager - Responses body rewriting', () => {
  it('rewrites instructions and string input with enabled regex rules', () => {
    const body = {
      instructions: 'System keep SECRET',
      input: 'User keep SECRET',
    };
    const rules = [{ enabled: true, target: 'all', pattern: 'SECRET', replacement: '', flags: 'g' }];

    const result = applyPromptRulesToResponsesBody(body, rules);

    assert.strictEqual(result.instructions, 'System keep ');
    assert.strictEqual(result.input, 'User keep ');
    assert.strictEqual(body.instructions, 'System keep SECRET');
  });

  it('rewrites text blocks by role and keeps tool outputs untouched', () => {
    const body = {
      input: [
        { role: 'developer', content: [{ type: 'input_text', text: 'dev SECRET' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'user SECRET' }] },
        { type: 'function_call_output', output: 'tool SECRET' },
      ],
    };
    const rules = [{ enabled: true, target: 'system', pattern: 'SECRET', replacement: 'OK', flags: 'g' }];

    const result = applyPromptRulesToResponsesBody(body, rules);

    assert.strictEqual(result.input[0].content[0].text, 'dev OK');
    assert.strictEqual(result.input[1].content[0].text, 'user SECRET');
    assert.strictEqual(result.input[2].output, 'tool SECRET');
  });
});

describe('prompt-rules-manager - Anthropic body rewriting', () => {
  it('rewrites system and message text content', () => {
    const body = {
      system: [{ type: 'text', text: 'system abc' }],
      messages: [
        { role: 'user', content: 'user abc' },
        { role: 'assistant', content: [{ type: 'text', text: 'assistant abc' }] },
      ],
    };
    const rules = [{ enabled: true, target: 'all', pattern: 'abc', replacement: 'xyz', flags: 'g' }];

    const result = applyPromptRulesToAnthropicBody(body, rules);

    assert.strictEqual(result.system[0].text, 'system xyz');
    assert.strictEqual(result.messages[0].content, 'user xyz');
    assert.strictEqual(result.messages[1].content[0].text, 'assistant xyz');
  });

  it('rewrites only system when target is system', () => {
    const body = {
      system: [{ type: 'text', text: 'system SECRET' }],
      messages: [
        { role: 'user', content: 'user SECRET' },
        { role: 'assistant', content: [{ type: 'text', text: 'assistant SECRET' }] },
      ],
    };
    const rules = [{ enabled: true, target: 'system', pattern: 'SECRET', replacement: '', flags: 'g' }];

    const result = applyPromptRulesToAnthropicBody(body, rules);

    // system 被改写, user/assistant 不变
    assert.strictEqual(result.system[0].text, 'system ');
    assert.strictEqual(result.messages[0].content, 'user SECRET');
    assert.strictEqual(result.messages[1].content[0].text, 'assistant SECRET');
  });

  it('does not rewrite non-text blocks (thinking / tool_use / tool_result)', () => {
    const body = {
      messages: [
        { role: 'assistant', content: [
          { type: 'text', text: 'text SECRET' },
          { type: 'thinking', text: 'thinking SECRET', signature: 'sig' },
          { type: 'tool_use', id: '1', name: 'my_tool', input: { key: 'SECRET' } },
        ]},
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: '1', output: 'output SECRET' },
        ]},
      ],
    };
    const rules = [{ enabled: true, target: 'all', pattern: 'SECRET', replacement: '', flags: 'g' }];

    const result = applyPromptRulesToAnthropicBody(body, rules);

    // text block 被改写
    assert.strictEqual(result.messages[0].content[0].text, 'text ');
    // thinking block 不改写
    assert.strictEqual(result.messages[0].content[1].text, 'thinking SECRET');
    // tool_use block 不改写
    assert.strictEqual(result.messages[0].content[2].input.key, 'SECRET');
    // tool_result block 不改写
    assert.strictEqual(result.messages[1].content[0].output, 'output SECRET');
  });

  it('filters out empty text blocks after rewrite', () => {
    const body = {
      system: [
        { type: 'text', text: 'KEEP' },
        { type: 'text', text: 'REMOVE', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'KEEP_TOO' },
      ],
    };
    const rules = [{ enabled: true, target: 'system', pattern: 'REMOVE', replacement: '', flags: 'g' }];

    const result = applyPromptRulesToAnthropicBody(body, rules);

    assert.strictEqual(result.system.length, 2);
    assert.strictEqual(result.system[0].text, 'KEEP');
    assert.strictEqual(result.system[1].text, 'KEEP_TOO');
  });
});

describe('prompt-rules-manager - Chat Completions body rewriting', () => {
  it('rewrites system/user/assistant messages by role', () => {
    const body = {
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'system SECRET' },
        { role: 'user', content: 'user SECRET' },
        { role: 'assistant', content: [{ type: 'text', text: 'assistant SECRET' }] },
        { role: 'tool', content: 'tool SECRET' },
      ],
    };
    const rules = [{ enabled: true, target: 'all', pattern: 'SECRET', replacement: 'OK', flags: 'g' }];

    const result = applyPromptRulesToChatBody(body, rules);

    assert.strictEqual(result.messages[0].content, 'system OK');
    assert.strictEqual(result.messages[1].content, 'user OK');
    assert.strictEqual(result.messages[2].content[0].text, 'assistant OK');
    // tool 角色不在 system/user/assistant 范围内,保持原样
    assert.strictEqual(result.messages[3].content, 'tool SECRET');
    // 原始 body 不被修改
    assert.strictEqual(body.messages[0].content, 'system SECRET');
  });

  it('only rewrites matched role when target is scoped', () => {
    const body = {
      messages: [
        { role: 'system', content: 'system abc' },
        { role: 'user', content: 'user abc' },
      ],
    };
    const rules = [{ enabled: true, target: 'system', pattern: 'abc', replacement: 'xyz', flags: 'g' }];

    const result = applyPromptRulesToChatBody(body, rules);

    assert.strictEqual(result.messages[0].content, 'system xyz');
    assert.strictEqual(result.messages[1].content, 'user abc');
  });
});

describe('prompt-rules-manager - validation and preview', () => {
  it('throws readable error for invalid regex', () => {
    assert.throws(
      () => validatePromptRule({ name: 'bad', pattern: '[' }),
      /正则表达式无效/,
    );
  });

  it('previews replacement result', () => {
    const result = previewPromptRule('hello 123', {
      name: 'digits', pattern: '\\d+', replacement: 'NUM', flags: 'g', target: 'all', enabled: true,
    });
    assert.strictEqual(result, 'hello NUM');
  });
});

describe('prompt-rules-manager - section 粒度改写', () => {
  it('extractSections 正确拆分多级标题', () => {
    const text = '# Intro\nhello\n## Details\nworld\n# End\ndone';
    const sections = extractSections(text);
    assert.strictEqual(sections.length, 3);
    assert.strictEqual(sections[0].title, 'Intro');
    assert.strictEqual(sections[0].level, 1);
    assert.strictEqual(sections[1].title, 'Details');
    assert.strictEqual(sections[1].level, 2);
    assert.strictEqual(sections[2].title, 'End');
    assert.strictEqual(sections[2].level, 1);
  });

  it('section 规则只改写匹配的 section', () => {
    const text = '# CodeGraph\nuse SECRET here\n# Other\nkeep SECRET here';
    const rules = [{
      enabled: true, target: 'all', pattern: 'SECRET', replacement: '',
      flags: 'g', section: 'CodeGraph',
    }];

    const body = { messages: [{ role: 'system', content: text }] };
    const result = applyPromptRulesToChatBody(body, rules);

    assert.ok(result.messages[0].content.includes('# CodeGraph'));
    assert.ok(result.messages[0].content.includes('use  here'));
    // Other section 的 SECRET 保留
    assert.ok(result.messages[0].content.includes('keep SECRET here'));
  });

  it('无 section 限制时全文改写', () => {
    const text = '# A\nSECRET\n# B\nSECRET';
    const rules = [{
      enabled: true, target: 'all', pattern: 'SECRET', replacement: 'X',
      flags: 'g', section: '',
    }];

    const body = { messages: [{ role: 'system', content: text }] };
    const result = applyPromptRulesToChatBody(body, rules);

    assert.strictEqual((result.messages[0].content as string).match(/X/g)?.length, 2);
    assert.strictEqual((result.messages[0].content as string).match(/SECRET/g), null);
  });
});

describe('prompt-rules-manager - 跨 block 改写 (acrossBlocks)', () => {
  it('普通规则不能跨 block 匹配,acrossBlocks 可以', () => {
    // block0 末尾 + 换行 + block1 开头 组成 "foo\nbar",只有合并后才能匹配到
    const body = {
      system: [
        { type: 'text', text: 'prefix foo' },
        { type: 'text', text: 'bar suffix' },
      ],
    };
    const normalRule = [{ enabled: true, target: 'system', pattern: 'foo\\nbar', replacement: 'HI', flags: 'g' }];
    const acrossRule = [{ enabled: true, target: 'system', pattern: 'foo\\nbar', replacement: 'HI', flags: 'g', acrossBlocks: true }];

    const resultNormal = applyPromptRulesToAnthropicBody(body, normalRule);
    const resultAcross = applyPromptRulesToAnthropicBody(body, acrossRule);

    // 普通规则:两个 block 各自改写,跨行匹配不到,内容不变
    assert.strictEqual(resultNormal.system[0].text, 'prefix foo');
    assert.strictEqual(resultNormal.system[1].text, 'bar suffix');

    // acrossBlocks 规则:合并后跨行匹配成功,总字符数减少
    const normalTotal = resultNormal.system.reduce((sum: number, b: any) => sum + b.text.length, 0);
    const acrossTotal = resultAcross.system.reduce((sum: number, b: any) => sum + b.text.length, 0);
    // 原: "prefix foo" + "bar suffix" = 20, 中间加换行扁平后 21
    // 改: "prefix HIsuffix" = 15 (按比例分配到两个 block)
    assert.ok(acrossTotal < normalTotal, `across 后字符数应减少: ${acrossTotal} < ${normalTotal}`);

    // 两个 block 合起来去掉换行应该包含 'HI'
    const combined = resultAcross.system.map((b: any) => b.text).join('');
    assert.ok(combined.includes('HI'), `合并文本应包含 HI: ${combined}`);
  });

  it('acrossBlocks 保留非文本 block 不动', () => {
    const body = {
      system: [
        { type: 'text', text: 'AAA' },
        { type: 'thinking', text: 'think AAA', signature: 'sig' },
        { type: 'text', text: 'BBB' },
      ],
    };
    const rules = [{ enabled: true, target: 'system', pattern: 'A', replacement: 'X', flags: 'g', acrossBlocks: true }];

    const result = applyPromptRulesToAnthropicBody(body, rules);

    // thinking block 保持不动
    assert.strictEqual(result.system[1].type, 'thinking');
    assert.strictEqual(result.system[1].text, 'think AAA');
  });
});

describe('prompt-rules-manager - 调试工具 (inspect / diff)', () => {
  it('inspectPromptRuleMatch 返回所有命中位置和上下文', () => {
    const text = 'hello WORLD and WORLD again';
    const rule = { name: 'test', pattern: 'WORLD', replacement: 'X', flags: 'g', target: 'all' };
    const matches = inspectPromptRuleMatch(text, rule);

    assert.strictEqual(matches.length, 2);
    assert.strictEqual(matches[0].match, 'WORLD');
    assert.strictEqual(matches[0].index, 6);
    assert.ok(matches[0].before.endsWith('hello '));
    assert.ok(matches[1].after.startsWith(' again'));
  });

  it('inspect 对无效正则返回空数组', () => {
    const matches = inspectPromptRuleMatch('hello', { name: 'bad', pattern: '[', flags: 'g' });
    assert.deepStrictEqual(matches, []);
  });

  it('diffPromptRule 返回行级 diff', () => {
    const oldText = 'line1\nline2\nline3';
    const rule = { name: 'test', pattern: 'line2', replacement: 'NEW', flags: 'g', target: 'all' };
    const diff = diffPromptRule(oldText, rule);

    // 应该包含 remove 和 add 行
    const hasRemove = diff.some(d => d.type === 'remove' && d.content === 'line2');
    const hasAdd = diff.some(d => d.type === 'add' && d.content === 'NEW');
    assert.ok(hasRemove, '应该有 remove 行');
    assert.ok(hasAdd, '应该有 add 行');
  });

  it('diff 无变化时返回 context 行', () => {
    const text = 'no change here';
    const rule = { name: 'test', pattern: 'NOT_FOUND', replacement: 'X', flags: 'g', target: 'all' };
    const diff = diffPromptRule(text, rule);

    // 无变化,全是 context
    assert.ok(diff.every(d => d.type === 'context'));
  });
});
