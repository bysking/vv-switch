/**
 * Agent Adapter 接口
 *
 * Adapter 只负责客户端协议 ⇄ StandardRequest/StandardResponse/StreamEvent 的转换。
 * 不持有上游 HTTP 调用、不知道 Provider 是谁。
 */

import type { StandardRequest } from '../protocol/standard-request.js';
import type { StandardResponse } from '../protocol/standard-response.js';
import type { StreamEvent } from '../protocol/stream-events.js';

export interface AdapterContext {
  /** Request ID，用于关联日志 */
  id: string;
  /** 默认模型（当客户端 body 没指定时） */
  defaultModel?: string;
  /** 透传 headers（如 anthropic-beta） */
  headers?: Record<string, string>;
}

export interface AgentAdapter {
  /** 唯一 id，例如 "claude"、"codex"、"openai" */
  id: string;
  /** HTTP 端点路径，例如 "/v1/messages" */
  endpoint: string;
  /**
   * 解析客户端 body → StandardRequest
   */
  parseRequest(body: unknown, context: AdapterContext): StandardRequest;
  /**
   * 序列化 StandardResponse → 客户端期望的响应体
   */
  serializeResponse(response: StandardResponse, context: AdapterContext): unknown;
  /**
   * 序列化 StreamEvent 流 → 客户端 SSE 字符串流
   */
  serializeStream(
    stream: AsyncIterable<StreamEvent>,
    context: AdapterContext,
  ): AsyncIterable<string>;
}
