/**
 * OpenAI Agent Adapter
 *
 * 处理 OpenAI Chat Completions API（VS Code Copilot 自定义端点等直连客户端使用）。
 * 入口：POST /v1/chat/completions
 */

import type { AgentAdapter } from '../../types/adapter.js';
import { parseOpenAIRequest } from './parse.js';
import { serializeOpenAIResponse } from './serialize.js';
import { serializeOpenAIStream } from './stream.js';
import { registerAdapter } from '../../core/adapter-manager.js';

export const openaiAdapter: AgentAdapter = {
  id: 'openai',
  endpoint: '/v1/chat/completions',
  parseRequest: parseOpenAIRequest,
  serializeResponse: serializeOpenAIResponse,
  serializeStream: serializeOpenAIStream,
};

registerAdapter(openaiAdapter);
