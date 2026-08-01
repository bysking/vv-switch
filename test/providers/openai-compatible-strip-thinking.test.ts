/**
 * openai-compatible provider: thinking 试错学习缓存测试
 *
 * 验证：
 * - 5xx（火山 500 InternalServiceError）→ 剥离 thinking 重试成功后记忆
 * - 400+"boolean"（deepseek V3.2 期望布尔值）→ 剥离 thinking 重试成功后记忆
 * - 学习后后续请求首次即剥离
 * - 剥离重试仍失败则不学习
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { openAICompatibleProvider } from '../../src/providers/openai-compatible/index.js';
import {
  clearLearnedStripThinking,
  getLearnedStripThinking,
} from '../../src/providers/openai-compatible/strip-thinking-cache.js';
import { createStandardRequest } from '../../src/protocol/standard-request.js';
import type { ProviderConfig } from '../../src/types/provider.js';

const config: ProviderConfig = {
  baseUrl: 'https://volcano.test/v3',
  apiKey: 'sk-test',
  model: 'GLM-5.2',
  protocolType: 'chat',
};

function makeChatRequest() {
  return createStandardRequest({
    id: 'r1',
    agent: 'claude',
    model: 'GLM-5.2',
    messages: [{ role: 'user', content: 'hi' }],
    parameters: { thinking: { type: 'enabled' } },
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function bodyHasThinking(init: RequestInit): boolean {
  if (typeof init.body !== 'string') return false;
  try {
    const body = JSON.parse(init.body);
    return body.reasoning_effort !== undefined || body.thinking !== undefined;
  } catch {
    return false;
  }
}

const ERR_500 = { error: { code: 'InternalServiceError', message: 'Service has some internal Error' } };
const ERR_400_BOOL = { code: 20015, message: 'Input should be a valid boolean', data: null };
const OK_200 = {
  id: 'cmpl-1',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

describe('openai-compatible thinking 试错学习', () => {
  let fetchMock: ReturnType<typeof mock.method> | undefined;

  beforeEach(() => {
    clearLearnedStripThinking();
  });

  afterEach(() => {
    fetchMock?.mock.restore();
    fetchMock = undefined;
  });

  /* ── 5xx 路径 ── */

  it('500 → 剥离 thinking 重试 200 → 学习并返回结果', async () => {
    let call = 0;
    fetchMock = mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
      call++;
      return bodyHasThinking(init) ? jsonResponse(500, ERR_500) : jsonResponse(200, OK_200);
    });

    const res = await openAICompatibleProvider.chat(makeChatRequest(), config);

    assert.equal(call, 2, '应调用 2 次 fetch：首次带 thinking 500，剥离后 200');
    assert.equal(getLearnedStripThinking(config), true, '应学习到需剥离 thinking');
    assert.ok(res, '应返回响应');
  });

  it('学习后再次请求 → 首次即剥离，只调 1 次 fetch', async () => {
    let call = 0;
    fetchMock = mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
      call++;
      return bodyHasThinking(init) ? jsonResponse(500, ERR_500) : jsonResponse(200, OK_200);
    });

    // 第一次：带 thinking 500 → 剥离 200 → 学习（2 次 fetch）
    await openAICompatibleProvider.chat(makeChatRequest(), config);
    assert.equal(getLearnedStripThinking(config), true, '第一次应已学习');
    assert.equal(call, 2);

    // 第二次：已学习 → 首次即剥离（仅 1 次 fetch，且 body 不带 thinking）
    let secondBodies = 0;
    fetchMock.mock.restore();
    fetchMock = mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
      secondBodies++;
      assert.equal(bodyHasThinking(init), false, '学习后首次请求不应带 thinking');
      return jsonResponse(200, OK_200);
    });
    await openAICompatibleProvider.chat(makeChatRequest(), config);
    assert.equal(secondBodies, 1, '学习后只调 1 次 fetch');
  });

  it('剥离重试也 500 → 不学习，抛 ProviderUnavailable', async () => {
    let call = 0;
    fetchMock = mock.method(globalThis, 'fetch', async (_url: string, _init: RequestInit) => {
      call++;
      return jsonResponse(500, ERR_500);
    });

    await assert.rejects(
      openAICompatibleProvider.chat(makeChatRequest(), config),
      /Upstream error 500/,
    );
    assert.equal(call, 2, '应尝试 2 次（首次 + 剥离重试）');
    assert.equal(getLearnedStripThinking(config), false, '剥离重试失败不应学习');
  });

  /* ── 400 + "boolean" 路径 ── */

  it('400+"boolean" → 剥离 thinking 重试 200 → 学习并返回结果', async () => {
    let call = 0;
    fetchMock = mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
      call++;
      return bodyHasThinking(init) ? jsonResponse(400, ERR_400_BOOL) : jsonResponse(200, OK_200);
    });

    const res = await openAICompatibleProvider.chat(makeChatRequest(), config);

    assert.equal(call, 2, '应调用 2 次 fetch：首次带 thinking 400，剥离后 200');
    assert.equal(getLearnedStripThinking(config), true, '应学习到需剥离 thinking');
    assert.ok(res, '应返回响应');
  });

  it('400+"boolean" 剥离重试也 400 → 不学习，抛 ProviderUnavailable', async () => {
    let call = 0;
    fetchMock = mock.method(globalThis, 'fetch', async (_url: string, _init: RequestInit) => {
      call++;
      return jsonResponse(400, ERR_400_BOOL);
    });

    await assert.rejects(
      openAICompatibleProvider.chat(makeChatRequest(), config),
      /Upstream error 400/,
    );
    assert.equal(call, 2, '应尝试 2 次（首次 + 剥离重试）');
    assert.equal(getLearnedStripThinking(config), false, '剥离重试失败不应学习');
  });

  /* ── 400 无 "boolean" 关键词不受影响 ── */

  it('400 无 boolean 关键词 → 不触发学习，透传报错', async () => {
    fetchMock = mock.method(globalThis, 'fetch', async (_url: string, _init: RequestInit) => {
      return jsonResponse(400, { error: 'rate limit exceeded' });
    });

    await assert.rejects(
      openAICompatibleProvider.chat(makeChatRequest(), config),
      /Upstream error 400/,
    );
    assert.equal(getLearnedStripThinking(config), false, '不应学习');
  });
});
