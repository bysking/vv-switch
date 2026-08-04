/**
 * OpenAI Responses Provider 单元测试
 *
 * 覆盖策略A:previous_response_id 透传等 Responses API 特有字段
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildResponsesRequest } from '../../src/providers/openai/request.js';
import { createStandardRequest } from '../../src/protocol/standard-request.js';

describe('providers/openai buildResponsesRequest — previous_response_id 透传', () => {
  it('metadata.previousResponseId 有值时，透传到 previous_response_id 字段', () => {
    const req = createStandardRequest({
      id: 'r',
      agent: 'codex',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      metadata: {
        previousResponseId: 'resp_abc123',
      },
    });
    const upstreamReq = buildResponsesRequest(req);
    assert.equal(upstreamReq.previous_response_id, 'resp_abc123');
  });

  it('metadata.previousResponseId 为空时，不包含 previous_response_id 字段', () => {
    const req = createStandardRequest({
      id: 'r',
      agent: 'codex',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const upstreamReq = buildResponsesRequest(req);
    assert.equal(upstreamReq.previous_response_id, undefined);
  });

  it('metadata.previousResponseId 为空字符串时，不包含 previous_response_id 字段', () => {
    const req = createStandardRequest({
      id: 'r',
      agent: 'codex',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      metadata: {
        previousResponseId: '',
      },
    });
    const upstreamReq = buildResponsesRequest(req);
    assert.equal(upstreamReq.previous_response_id, undefined);
  });
});
