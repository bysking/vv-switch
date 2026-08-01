/**
 * openai-compatible provider: 降级工具与请求构建测试
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRejection,
  shouldFallback,
  buildFallbackOptions,
} from '../../src/providers/openai-compatible/fallback.js';
import { buildChatRequest } from '../../src/providers/openai-compatible/request.js';
import { createStandardRequest } from '../../src/protocol/standard-request.js';
import type { StandardRequestParameters, StandardMessage } from '../../src/protocol/standard-request.js';

describe('openai-compatible/fallback', () => {
  describe('classifyRejection', () => {
    it('400 + thinking 关键词 → thinking 命中', () => {
      const c = classifyRejection(400, 'thinking not supported');
      assert.equal(c.thinking, true);
      assert.equal(c.image, false);
    });

    it('400 + reasoning_effort 关键词 → thinking 命中', () => {
      const c = classifyRejection(400, 'invalid reasoning_effort');
      assert.equal(c.thinking, true);
    });

    it('422 + vision 关键词 → image 命中', () => {
      const c = classifyRejection(422, 'vision unsupported');
      assert.equal(c.image, true);
      assert.equal(c.thinking, false);
    });

    it('400 + multimodal 关键词 → image 命中', () => {
      const c = classifyRejection(400, 'multimodal input not allowed');
      assert.equal(c.image, true);
    });

    it('500 状态码不触发(即使含关键词)', () => {
      const c = classifyRejection(500, 'thinking error');
      assert.equal(c.thinking, false);
      assert.equal(c.image, false);
    });

    it('200 状态码不触发', () => {
      const c = classifyRejection(200, 'thinking');
      assert.equal(c.thinking, false);
    });

    it('400 但无相关关键词 → 都不命中', () => {
      const c = classifyRejection(400, 'invalid api key');
      assert.equal(c.thinking, false);
      assert.equal(c.image, false);
    });

    it('大小写不敏感', () => {
      const c = classifyRejection(400, 'THINKING not allowed');
      assert.equal(c.thinking, true);
    });
  });

  describe('shouldFallback', () => {
    it('命中 thinking → true', () => {
      assert.equal(shouldFallback(400, 'thinking unsupported'), true);
    });
    it('5xx → false', () => {
      assert.equal(shouldFallback(500, 'thinking'), false);
    });
    it('400 无关 → false', () => {
      assert.equal(shouldFallback(400, 'rate limit'), false);
    });
  });

  describe('buildFallbackOptions', () => {
    it('thinking 命中 → stripThinking', () => {
      const o = buildFallbackOptions({ thinking: true, image: false });
      assert.equal(o.stripThinking, true);
      assert.equal(o.stripImages, false);
    });
    it('两者命中 → 都剥', () => {
      const o = buildFallbackOptions({ thinking: true, image: true });
      assert.equal(o.stripThinking, true);
      assert.equal(o.stripImages, true);
    });
  });
});

describe('openai-compatible/request buildChatRequest', () => {
  function makeReq(parameters: StandardRequestParameters = {}, messages?: StandardMessage[]) {
    return createStandardRequest({
      id: 'r1',
      agent: 'claude',
      model: 'ark-code-latest',
      messages: messages ?? [{ role: 'user', content: 'hi' }],
      parameters,
    });
  }

  describe('thinking 透传', () => {
    it('enabled → reasoning_effort=high + 原字段', () => {
      const req = makeReq({ thinking: { type: 'enabled', budgetTokens: 10240 } });
      const built = buildChatRequest(req, 'm');
      assert.equal(built.reasoning_effort, 'high');
      assert.deepEqual(built.thinking, { type: 'enabled', budget_tokens: 10240 });
    });

    it('adaptive → reasoning_effort=high + thinking.type=auto(百炼兼容)', () => {
      const req = makeReq({ thinking: { type: 'adaptive', display: 'summarized' } });
      const built = buildChatRequest(req, 'm');
      assert.equal(built.reasoning_effort, 'high');
      // adaptive 映射为 auto(百炼等 OpenAI-compatible 上游不接受 adaptive),display 丢弃
      assert.deepEqual(built.thinking, { type: 'auto' });
    });

    it('disabled → 不传 reasoning_effort 与 thinking', () => {
      const req = makeReq({ thinking: { type: 'disabled' } });
      const built = buildChatRequest(req, 'm');
      assert.equal(built.reasoning_effort, undefined);
      assert.equal(built.thinking, undefined);
    });

    it('boolean true → enabled', () => {
      const req = makeReq({ thinking: true });
      const built = buildChatRequest(req, 'm');
      assert.equal(built.reasoning_effort, 'high');
      assert.deepEqual(built.thinking, { type: 'enabled' });
    });

    it('reasoningEffort 优先于 thinking 映射', () => {
      const req = makeReq({ thinking: { type: 'enabled' }, reasoningEffort: 'low' });
      const built = buildChatRequest(req, 'm');
      assert.equal(built.reasoning_effort, 'low');
    });

    it('仅有 reasoningEffort,无 thinking 字段', () => {
      const req = makeReq({ reasoningEffort: 'medium' });
      const built = buildChatRequest(req, 'm');
      assert.equal(built.reasoning_effort, 'medium');
      assert.equal(built.thinking, undefined);
    });
  });

  describe('stripThinking 降级', () => {
    it('stripThinking=true 时 thinking 与 reasoning_effort 都不传', () => {
      const req = makeReq({ thinking: { type: 'enabled' }, reasoningEffort: 'high' });
      const built = buildChatRequest(req, 'm', { stripThinking: true });
      assert.equal(built.reasoning_effort, undefined);
      assert.equal(built.thinking, undefined);
    });
  });

  describe('stripImages 降级', () => {
    function makeImageReq() {
      return createStandardRequest({
        id: 'r1',
        agent: 'claude',
        model: 'm',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '看这张图' },
              { type: 'image', url: 'data:image/png;base64,xxx' },
            ],
          },
        ],
      });
    }

    it('默认:image part 转为 image_url', () => {
      const built = buildChatRequest(makeImageReq(), 'm');
      const content = built.messages[0].content as Array<Record<string, unknown>>;
      assert.ok(Array.isArray(content));
      assert.ok(content.some((p) => p.type === 'image_url'));
    });

    it('stripImages=true:image 替换为占位文本,无 image_url', () => {
      const built = buildChatRequest(makeImageReq(), 'm', { stripImages: true });
      const content = built.messages[0].content as Array<Record<string, unknown>>;
      assert.ok(Array.isArray(content));
      assert.equal(content.find((p) => p.type === 'image_url'), undefined);
      assert.ok(
        content.some((p) => p.type === 'text' && String(p.text).includes('[image omitted')),
      );
    });
  });
});
