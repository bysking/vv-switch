/**
 * Tests for utils/sse-merge — collapse raw SSE bytes back into a structured summary.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSseToSummary } from '../src/utils/sse-merge.js';

test('sse-merge/claude', async (t) => {
  await t.test('merges hello-world stream into responseText', () => {
    const sse =
      'event: message_start\n' +
      'data: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","content":[],"model":"GLM-5.2","usage":{"input_tokens":7,"output_tokens":0},"stop_reason":null,"stop_sequence":null}}\n\n' +
      'event: content_block_start\n' +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello! "}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"👋 How can I help you"}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" today?"}}\n\n' +
      'event: content_block_stop\n' +
      'data: {"type":"content_block_stop","index":0}\n\n' +
      'event: message_delta\n' +
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":15}}\n\n' +
      'event: message_stop\n' +
      'data: {"type":"message_stop"}\n\n';

    const s = mergeSseToSummary(sse, 'claude');
    assert.equal(s.responseText, 'Hello! 👋 How can I help you today?');
    assert.equal(s.toolCalls.length, 0);
    assert.equal(s.stopReason, 'end_turn');
    assert.equal(s.usage?.outputTokens, 15);
    assert.equal(s.usage?.inputTokens, 7);
  });

  await t.test('captures tool_use blocks', () => {
    const sse =
      'event: content_block_start\n' +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"search","input":{}}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"foo\\"}"}}\n\n' +
      'event: content_block_stop\n' +
      'data: {"type":"content_block_stop","index":0}\n\n';
    const s = mergeSseToSummary(sse, 'claude');
    assert.equal(s.toolCalls.length, 1);
    assert.equal(s.toolCalls[0].name, 'search');
    assert.equal(s.toolCalls[0].arguments, '{"q":"foo"}');
  });

  await t.test('empty input yields empty summary', () => {
    const s = mergeSseToSummary('', 'claude');
    assert.equal(s.responseText, '');
    assert.equal(s.eventCount, 0);
  });
});

test('sse-merge/codex', async (t) => {
  await t.test('concatenates output_text deltas and captures usage', () => {
    const sse =
      'event: response.created\n' +
      'data: {"type":"response.created","response":{"id":"r_1"}}\n\n' +
      'event: response.output_text.delta\n' +
      'data: {"type":"response.output_text.delta","delta":"Hello"}\n\n' +
      'event: response.output_text.delta\n' +
      'data: {"type":"response.output_text.delta","delta":" world"}\n\n' +
      'event: response.completed\n' +
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":2}}}\n\n';
    const s = mergeSseToSummary(sse, 'codex');
    assert.equal(s.responseText, 'Hello world');
    assert.equal(s.usage?.inputTokens, 3);
    assert.equal(s.usage?.outputTokens, 2);
    assert.equal(s.stopReason, 'completed');
  });

  await t.test('captures function call arguments', () => {
    const sse =
      'event: response.output_item.added\n' +
      'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","name":"do_x"}}\n\n' +
      'event: response.function_call_arguments.delta\n' +
      'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"a\\":1"}\n\n' +
      'event: response.function_call_arguments.delta\n' +
      'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"}"}\n\n';
    const s = mergeSseToSummary(sse, 'codex');
    assert.equal(s.toolCalls.length, 1);
    assert.equal(s.toolCalls[0].name, 'do_x');
    assert.equal(s.toolCalls[0].arguments, '{"a":1}');
  });
});
