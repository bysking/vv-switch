/**
 * 日志相关类型
 */

import type { StandardToolCall } from '../protocol/standard-response.js';

export interface LogEntryBase {
  timestamp: string;
  method: string;
  endpoint: string;
  caller: string;
  model: string;
  stream: boolean;
  protocolType: string;
  inputType?: string;
  reasoningEffort?: string | null;
  conversation?: unknown;
  requestBody?: unknown;
}

export interface LogMetadata {
  inputTokens?: number;
  outputTokens?: number;
  toolCalls?: StandardToolCall[] | null;
  responseText?: string;
}
