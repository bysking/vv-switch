/**
 * 适配器共享 stop-reason 映射测试(单一权威来源)
 *
 * 锁定:同一个 StandardStopReason 在三种客户端协议下的一致映射,
 * 覆盖全部 stopReason,避免回归到之前散落、口径不一、pause_turn/refusal/error 走 default 的状态。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  toAnthropicStopReason,
  toChatFinishReason,
  toResponsesTerminal,
} from '../../src/adapters/shared/stop-reason.js';

describe('adapters/shared stop-reason 映射', () => {
  describe('toAnthropicStopReason (Anthropic Messages stop_reason)', () => {
    it('identity 映射全部已知 stopReason,error 兜底 end_turn', () => {
      assert.equal(toAnthropicStopReason('end_turn'), 'end_turn');
      assert.equal(toAnthropicStopReason('max_tokens'), 'max_tokens');
      assert.equal(toAnthropicStopReason('stop_sequence'), 'stop_sequence');
      assert.equal(toAnthropicStopReason('tool_use'), 'tool_use');
      assert.equal(toAnthropicStopReason('pause_turn'), 'pause_turn');
      assert.equal(toAnthropicStopReason('refusal'), 'refusal');
      assert.equal(toAnthropicStopReason('error'), 'end_turn');
    });
  });

  describe('toChatFinishReason (OpenAI Chat finish_reason)', () => {
    it('hasToolCalls=true 时一律 tool_calls(即便 stopReason 是 error/pause_turn)', () => {
      const reasons = ['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal', 'error'] as const;
      for (const r of reasons) {
        assert.equal(toChatFinishReason(r, true), 'tool_calls');
      }
    });

    it('无工具调用:按 stopReason 映射,pause_turn/refusal/error 落 stop(协议无对应枚举)', () => {
      assert.equal(toChatFinishReason('end_turn', false), 'stop');
      assert.equal(toChatFinishReason('max_tokens', false), 'length');
      assert.equal(toChatFinishReason('tool_use', false), 'tool_calls');
      assert.equal(toChatFinishReason('stop_sequence', false), 'stop');
      assert.equal(toChatFinishReason('pause_turn', false), 'stop');
      assert.equal(toChatFinishReason('refusal', false), 'stop');
      assert.equal(toChatFinishReason('error', false), 'stop');
    });
  });

  describe('toResponsesTerminal (OpenAI Responses status)', () => {
    it('max_tokens → incomplete + max_output_tokens', () => {
      assert.deepEqual(toResponsesTerminal('max_tokens'), {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      });
    });

    it('error → failed', () => {
      assert.deepEqual(toResponsesTerminal('error'), { status: 'failed' });
    });

    it('其余 → completed,无 incomplete_details', () => {
      const reasons = ['end_turn', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal'] as const;
      for (const r of reasons) {
        assert.deepEqual(toResponsesTerminal(r), { status: 'completed' });
      }
    });
  });
});
