/**
 * Codex Agent Adapter
 *
 * 处理 OpenAI Responses API（Codex 客户端使用）
 */

import type { AgentAdapter } from '../../types/adapter.js';
import { parseCodexRequest } from './parse.js';
import { serializeCodexResponse } from './serialize.js';
import { serializeCodexStream } from './stream.js';
import { registerAdapter } from '../../core/adapter-manager.js';

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  endpoint: '/v1/responses',
  parseRequest: parseCodexRequest,
  serializeResponse: serializeCodexResponse,
  serializeStream: serializeCodexStream,
};

registerAdapter(codexAdapter);
