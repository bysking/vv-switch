/**
 * upstreamFetch — 包装全局 fetch，自动把上游中转阶段记录到协议日志。
 *
 * provider 在 chat / stream 的「主请求」处用它替代裸 fetch，
 * 从 request.metadata.protocolTrace 取 logger 记录 upstream phase。
 * 若无 trace（如 discover/models 等非链路调用），退化为普通 fetch。
 */

import type { StandardRequest } from '../protocol/standard-request.js';
import type { ProtocolTrace } from './protocol-logger.js';
import { extractIdentityHeaders } from '../utils/identity.js';

export async function upstreamFetch(
  request: StandardRequest,
  url: string,
  init: RequestInit,
  note?: string,
): Promise<Response> {
  const identityHeaders = extractIdentityHeaders(request);
  if (Object.keys(identityHeaders).length > 0) {
    const existing = (init.headers ?? {}) as Record<string, string>;
    init = { ...init, headers: { ...identityHeaders, ...existing } };
  }
  // 如果上游携带了 abortSignal（客户端断开时触发），把它透传给 fetch，
  // 让底层 TCP 连接立即中止，而不是等读完整个响应体才释放。
  const meta = request.metadata as { abortSignal?: AbortSignal } | undefined;
  if (meta?.abortSignal && !init.signal) {
    init = { ...init, signal: meta.abortSignal };
  }
  const t0 = Date.now();
  const response = await fetch(url, init);
  const trace = (request.metadata as { protocolTrace?: ProtocolTrace } | undefined)?.protocolTrace;
  if (trace?.logger) {
    trace.logger.upstream({
      url,
      method: init.method || 'POST',
      headers: init.headers,
      body: init.body,
      responseStatus: response.status,
      durationMs: Date.now() - t0,
      note,
    });
  }
  return response;
}
