/**
 * Claude Agent Adapter
 *
 * 处理 Anthropic Messages API（Claude Code 客户端使用）
 */

import type { AgentAdapter } from '../../types/adapter.js';
import { parseClaudeRequest } from './parse.js';
import { serializeClaudeResponse } from './serialize.js';
import { serializeClaudeStream } from './stream.js';
import { registerAdapter } from '../../core/adapter-manager.js';

export const claudeAdapter: AgentAdapter = {
  id: 'claude',
  endpoint: '/v1/messages',
  parseRequest: parseClaudeRequest,
  serializeResponse: serializeClaudeResponse,
  serializeStream: serializeClaudeStream,
};

registerAdapter(claudeAdapter);
