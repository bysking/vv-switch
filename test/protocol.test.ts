/**
 * Protocol layer tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStandardRequest } from '../src/protocol/standard-request.js';
import { createStandardResponse } from '../src/protocol/standard-response.js';

describe('protocol/standard-request', () => {
  it('creates request with required fields and defaults', () => {
    const req = createStandardRequest({ id: 'r1', agent: 'claude', model: 'm' });
    assert.equal(req.id, 'r1');
    assert.equal(req.agent, 'claude');
    assert.equal(req.model, 'm');
    assert.equal(req.system, null);
    assert.deepEqual(req.messages, []);
    assert.deepEqual(req.tools, []);
    assert.equal(req.stream, false);
    assert.deepEqual(req.parameters, {});
    assert.deepEqual(req.capabilitiesRequired, ['chat']);
    assert.deepEqual(req.metadata, {});
  });

  it('preserves provided values', () => {
    const req = createStandardRequest({
      id: 'r2',
      agent: 'codex',
      model: 'gpt-4',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      capabilitiesRequired: ['chat', 'tool_call'],
    });
    assert.equal(req.stream, true);
    assert.equal(req.messages.length, 1);
    assert.deepEqual(req.capabilitiesRequired, ['chat', 'tool_call']);
  });
});

describe('protocol/standard-response', () => {
  it('creates response with defaults', () => {
    const resp = createStandardResponse({ id: 'r1', model: 'm' });
    assert.equal(resp.id, 'r1');
    assert.equal(resp.model, 'm');
    assert.deepEqual(resp.content, []);
    assert.deepEqual(resp.toolCalls, []);
    assert.equal(resp.stopReason, 'end_turn');
    assert.deepEqual(resp.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it('preserves usage fields', () => {
    const resp = createStandardResponse({
      id: 'r2',
      model: 'm',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    });
    assert.equal(resp.usage.inputTokens, 10);
    assert.equal(resp.usage.outputTokens, 20);
    assert.equal(resp.usage.totalTokens, 30);
  });
});
