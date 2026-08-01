/**
 * Model capabilities: 验证能力配置勾选/取消后,上游请求参数是否按预期变化
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildChatRequest } from '../../src/providers/openai-compatible/request.js';
import { buildAnthropicRequest } from '../../src/providers/anthropic/request.js';
import { buildOllamaRequest } from '../../src/providers/ollama/request.js';
import { buildResponsesRequest } from '../../src/providers/openai/request.js';
import { createStandardRequest } from '../../src/protocol/standard-request.js';
import type { ProviderConfig, ModelCapabilities } from '../../src/types/provider.js';
import type { StandardRequestParameters, StandardMessage } from '../../src/protocol/standard-request.js';
import { tokenCfg } from '../../src/constants/index.js';

function makeConfig(overrides?: Partial<ModelCapabilities>): ProviderConfig {
  return {
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'test-model',
    modelCapabilities: {
      thinking: true,
      vision: false,
      audio: false,
      video: false,
      functionCalling: true,
      contextWindow: 1048576,
      maxOutputTokens: 0,
      promptCache: false,
      ...overrides,
    },
  };
}

function makeReq(parameters: StandardRequestParameters = {}, messages?: StandardMessage[]) {
  return createStandardRequest({
    id: 'r1',
    agent: 'claude',
    model: 'test-model',
    messages: messages ?? [{ role: 'user', content: 'hi' }],
    parameters,
  });
}

// ── openai-compatible (Chat Completions) ───────────────────────

describe('openai-compatible/request buildChatRequest — model capabilities', () => {
  describe('thinking=false', () => {
    it('不传 reasoning_effort 与 thinking 字段', () => {
      const req = makeReq({ thinking: { type: 'enabled' }, reasoningEffort: 'high' });
      const built = buildChatRequest(req, 'test-model', undefined, makeConfig({ thinking: false }));
      assert.equal(built.reasoning_effort, undefined);
      assert.equal(built.thinking, undefined);
    });
  });

  describe('thinking=true (默认)', () => {
    it('正常传递 thinking 与 reasoning_effort', () => {
      const req = makeReq({ thinking: { type: 'enabled' }, reasoningEffort: 'high' });
      const built = buildChatRequest(req, 'test-model', undefined, makeConfig({ thinking: true }));
      assert.equal(built.reasoning_effort, 'high');
      assert.deepEqual(built.thinking, { type: 'enabled' });
    });
  });

  describe('vision=false', () => {
    it('图片被替换为占位文本', () => {
      const req = createStandardRequest({
        id: 'r1', agent: 'claude', model: 'test-model',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '看这张图' },
            { type: 'image', url: 'data:image/png;base64,xxx' },
          ],
        }],
      });
      const built = buildChatRequest(req, 'test-model', undefined, makeConfig({ vision: false }));
      const content = built.messages[0].content as Array<Record<string, unknown>>;
      assert.equal(content.find((p: any) => p.type === 'image_url'), undefined);
      assert.ok(content.some((p: any) => p.type === 'text' && String(p.text).includes('[image omitted')));
    });
  });

  describe('vision=true', () => {
    it('图片保留为 image_url', () => {
      const req = createStandardRequest({
        id: 'r1', agent: 'claude', model: 'test-model',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '看这张图' },
            { type: 'image', url: 'data:image/png;base64,xxx' },
          ],
        }],
      });
      const built = buildChatRequest(req, 'test-model', undefined, makeConfig({ vision: true }));
      const content = built.messages[0].content as Array<Record<string, unknown>>;
      assert.ok(content.some((p: any) => p.type === 'image_url'));
    });
  });

  describe('functionCalling=false', () => {
    it('不传 tools 数组', () => {
      const req = createStandardRequest({
        id: 'r1', agent: 'claude', model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'get_weather', description: '获取天气', parameters: { type: 'object', properties: {} } }],
      });
      const built = buildChatRequest(req, 'test-model', undefined, makeConfig({ functionCalling: false }));
      assert.equal(built.tools, undefined);
    });
  });

  describe('functionCalling=true (默认)', () => {
    it('正常传递 tools', () => {
      const req = createStandardRequest({
        id: 'r1', agent: 'claude', model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'get_weather', description: '获取天气', parameters: { type: 'object', properties: {} } }],
      });
      const built = buildChatRequest(req, 'test-model', undefined, makeConfig({ functionCalling: true }));
      assert.ok(built.tools && built.tools.length > 0);
      assert.equal(built.tools[0].function.name, 'get_weather');
    });
  });

  describe('max_tokens 输出预算(防止上游默认值过小导致截断/中断)', () => {
    it('流式且客户端未指定 → 兜底 64000', () => {
      const req = createStandardRequest({
        id: 'r1', agent: 'claude', model: 'm', stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      });
      const built = buildChatRequest(req, 'm', undefined, makeConfig());
      assert.equal(built.max_tokens, tokenCfg.max);
    });

    it('非流式且客户端未指定 → 兜底 16000', () => {
      const req = createStandardRequest({
        id: 'r1', agent: 'claude', model: 'm', stream: false,
        messages: [{ role: 'user', content: 'hi' }],
      });
      const built = buildChatRequest(req, 'm', undefined, makeConfig());
      assert.equal(built.max_tokens, tokenCfg.min);
    });

    it('客户端显式值在范围内被尊重', () => {
      const built = buildChatRequest(makeReq({ maxTokens: 8000 }), 'm', undefined, makeConfig());
      assert.equal(built.max_tokens, 8000);
    });

    it('maxOutputTokens 封顶(模型真实输出上限)', () => {
      const built = buildChatRequest(
        makeReq({ maxTokens: tokenCfg.max }), 'm', undefined, makeConfig({ maxOutputTokens: 16000 }),
      );
      assert.equal(built.max_tokens, tokenCfg.min);
    });

    it('contextWindow 封顶(不向小窗口模型发超大值,防 400)', () => {
      const built = buildChatRequest(
        makeReq({ maxTokens: tokenCfg.max }), 'm', undefined,
        makeConfig({ contextWindow: 32000, maxOutputTokens: 0 }),
      );
      assert.equal(built.max_tokens, 32000);
    });

    it('默认值同样受 contextWindow 封顶(默认窗口小于兜底时)', () => {
      const req = createStandardRequest({
        id: 'r1', agent: 'claude', model: 'm', stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      });
      const built = buildChatRequest(req, 'm', undefined, makeConfig({ contextWindow: 8000 }));
      assert.equal(built.max_tokens, 8000);
    });
  });
});

// ── anthropic ────────────────────────────────────────────────

describe('anthropic/request buildAnthropicRequest — model capabilities', () => {
  describe('thinking=false', () => {
    it('不传 thinking 参数', () => {
      const req = makeReq({ thinking: { type: 'enabled', budgetTokens: 10240 } });
      const built = buildAnthropicRequest(req, 'test-model', makeConfig({ thinking: false }));
      assert.equal(built.thinking, undefined);
    });
  });

  describe('thinking=true (默认)', () => {
    it('正常传递 thinking', () => {
      const req = makeReq({ thinking: { type: 'enabled', budgetTokens: 10240 } });
      const built = buildAnthropicRequest(req, 'test-model', makeConfig({ thinking: true }));
      assert.ok(built.thinking);
    });
  });

  describe('functionCalling=false', () => {
    it('不传 tools', () => {
      const req = createStandardRequest({
        id: 'r1', agent: 'claude', model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'get_weather', description: '获取天气', parameters: { type: 'object', properties: {} } }],
      });
      const built = buildAnthropicRequest(req, 'test-model', makeConfig({ functionCalling: false }));
      assert.equal(built.tools, undefined);
    });
  });

  describe('functionCalling=true (默认)', () => {
    it('正常传递 tools', () => {
      const req = createStandardRequest({
        id: 'r1', agent: 'claude', model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'get_weather', description: '获取天气', parameters: { type: 'object', properties: {} } }],
      });
      const built = buildAnthropicRequest(req, 'test-model', makeConfig({ functionCalling: true }));
      assert.ok(built.tools && built.tools.length > 0);
    });
  });

  describe('promptCache=false', () => {
    it('system 数组中的 cache_control 被剥离', () => {
      const req = createStandardRequest({
        id: 'r1', agent: 'claude', model: 'test-model',
        system: [
          { type: 'text', text: 'system prompt part 1', cacheControl: { type: 'ephemeral' } as const },
          { type: 'text', text: 'system prompt part 2' },
        ] as const,
        messages: [{ role: 'user', content: 'hi' }],
      });
      const built = buildAnthropicRequest(req, 'test-model', makeConfig({ promptCache: false }));
      if (built.system && Array.isArray(built.system)) {
        for (const block of built.system as Array<{ type: string; text: string; cache_control?: unknown }>) {
          assert.equal(block.cache_control, undefined, `block "${block.text}" should not have cache_control`);
        }
      }
    });
  });

  describe('promptCache=true', () => {
    it('system 数组中的 cache_control 被保留', () => {
      const req = createStandardRequest({
        id: 'r1', agent: 'claude', model: 'test-model',
        system: [
          { type: 'text', text: 'system prompt part 1', cacheControl: { type: 'ephemeral' } as const },
          { type: 'text', text: 'system prompt part 2' },
        ] as const,
        messages: [{ role: 'user', content: 'hi' }],
      });
      const built = buildAnthropicRequest(req, 'test-model', makeConfig({ promptCache: true }));
      if (built.system && Array.isArray(built.system)) {
        const blocks = built.system as Array<{ type: string; text: string; cache_control?: { type: string } }>;
        assert.equal(blocks[0].cache_control?.type, 'ephemeral');
        assert.equal(blocks[1].cache_control, undefined);
      }
    });
  });

  describe('maxOutputTokens', () => {
    it('cap max_tokens 到 maxOutputTokens', () => {
      const req = createStandardRequest({
        id: 'r1', agent: 'claude', model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
        parameters: { maxTokens: tokenCfg.max },
      });
      const built = buildAnthropicRequest(req, 'test-model', makeConfig({ maxOutputTokens: 16000 }));
      assert.equal(built.max_tokens, 16000);
    });

    it('maxOutputTokens=0 时不限制', () => {
      const req = createStandardRequest({
        id: 'r1', agent: 'claude', model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
        parameters: { maxTokens: tokenCfg.max },
      });
      const built = buildAnthropicRequest(req, 'test-model', makeConfig({ maxOutputTokens: 0 }));
      assert.equal(built.max_tokens, tokenCfg.max);
    });
  });
});

// ── ollama ──────────────────────────────────────────────────

describe('ollama/request buildOllamaRequest — model capabilities', () => {
  describe('thinking=false', () => {
    it('不传 think 字段', () => {
      const req = makeReq({ thinking: true });
      const built = buildOllamaRequest(req, 'test-model', makeConfig({ thinking: false }));
      assert.equal(built.think, undefined);
    });
  });

  describe('thinking=true (默认)', () => {
    it('正常传递 think=true', () => {
      const req = makeReq({ thinking: true });
      const built = buildOllamaRequest(req, 'test-model', makeConfig({ thinking: true }));
      assert.equal(built.think, true);
    });
  });

  describe('functionCalling=false', () => {
    it('不传 tools', () => {
      const req = createStandardRequest({
        id: 'r1', agent: 'claude', model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'get_weather', description: '获取天气', parameters: { type: 'object', properties: {} } }],
      });
      const built = buildOllamaRequest(req, 'test-model', makeConfig({ functionCalling: false }));
      assert.equal(built.tools, undefined);
    });
  });

  describe('functionCalling=true (默认)', () => {
    it('正常传递 tools', () => {
      const req = createStandardRequest({
        id: 'r1', agent: 'claude', model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'get_weather', description: '获取天气', parameters: { type: 'object', properties: {} } }],
      });
      const built = buildOllamaRequest(req, 'test-model', makeConfig({ functionCalling: true }));
      assert.ok(built.tools && built.tools.length > 0);
    });
  });
});

// ── openai (Responses API) ──────────────────────────────────

describe('openai/request buildResponsesRequest — model capabilities', () => {
  describe('thinking=false', () => {
    it('不传 reasoning 参数', () => {
      const req = makeReq({ reasoningEffort: 'high' });
      const built = buildResponsesRequest(req, 'test-model', makeConfig({ thinking: false }));
      assert.equal(built.reasoning, undefined);
    });
  });

  describe('thinking=true (默认)', () => {
    it('正常传递 reasoning', () => {
      const req = makeReq({ reasoningEffort: 'high' });
      const built = buildResponsesRequest(req, 'test-model', makeConfig({ thinking: true }));
      assert.deepEqual(built.reasoning, { effort: 'high' });
    });
  });

  describe('functionCalling=false', () => {
    it('不传 tools', () => {
      const req = createStandardRequest({
        id: 'r1', agent: 'claude', model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'get_weather', description: '获取天气', parameters: { type: 'object', properties: {} } }],
      });
      const built = buildResponsesRequest(req, 'test-model', makeConfig({ functionCalling: false }));
      assert.equal(built.tools, undefined);
    });
  });

  describe('functionCalling=true (默认)', () => {
    it('正常传递 tools', () => {
      const req = createStandardRequest({
        id: 'r1', agent: 'claude', model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'get_weather', description: '获取天气', parameters: { type: 'object', properties: {} } }],
      });
      const built = buildResponsesRequest(req, 'test-model', makeConfig({ functionCalling: true }));
      assert.ok(built.tools && built.tools.length > 0);
    });
  });
});
